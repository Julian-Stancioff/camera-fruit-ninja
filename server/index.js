// Authoritative Socket.io server for competitive 1v1 Camera Fruit Ninja.
//
// Design: the server owns the fruit stream — it generates spawns in NORMALIZED
// coordinates and broadcasts them so both clients render the exact same fruit at
// the same relative positions. Each client tracks its own hand locally (no video
// ever touches the network) and emits a "slice" when its blade crosses a fruit.
// The server is authoritative on who claims each fruit and on the score, so the
// two players genuinely race for the same fruit with no way to cheat the count.
import { createServer } from "http";
import { Server } from "socket.io";

const PORT = process.env.PORT || 2567;
const G_NORM = 1.5;          // normalized gravity (units/s^2), shared with clients
const COUNTDOWN_MS = 3000;
const DURATION_MS = 90000;   // 90-second match
const BOMB_PENALTY = 3;

const httpServer = createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Camera Fruit Ninja multiplayer server");
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

/** code -> room */
const rooms = new Map();
const FRUITS = ["watermelon", "apple", "orange", "lemon", "strawberry", "kiwi", "pineapple"];
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];

function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let c;
  do { c = Array.from({ length: 4 }, () => A[(Math.random() * A.length) | 0]).join(""); }
  while (rooms.has(c));
  return c;
}

function roomFor(socket) { return rooms.get(socket.data.room); }
function scores(room) { return room.players.map((p) => p.score); }

function spawnWave(room) {
  const elapsed = (Date.now() - room.startAt) / 1000;
  const t = Math.min(1, elapsed / 60);
  const maxCount = 1 + Math.round(2 * t);            // 1 → 3 per wave
  let count = 1;
  for (let k = 1; k < maxCount; k++) if (Math.random() < 0.45 + 0.25 * t) count++;

  const fruits = [];
  let bombs = 0;
  for (let i = 0; i < count; i++) {
    let type = pick(FRUITS);
    if (elapsed > 6 && bombs === 0 && Math.random() < 0.12) { type = "bomb"; bombs++; }
    const nx = rand(0.12, 0.88);
    const rise = rand(0.55, 0.82);
    const vy = -Math.sqrt(2 * G_NORM * rise);        // upward launch (normalized)
    const vx = ((0.5 - nx) / 0.5) * rand(0.05, 0.16) + rand(-0.08, 0.08);
    const radius = type === "watermelon" ? 0.085 : type === "bomb" ? 0.066 : rand(0.052, 0.07);
    const id = (room.seq++).toString(36);
    const fruit = { id, type, nx, ny: 1.12, vx, vy, radius, spawnTs: Date.now() };
    room.fruits.set(id, { type });
    fruits.push(fruit);
  }
  io.to(room.code).emit("spawn", { fruits });
}

function startMatch(room) {
  room.status = "countdown";
  io.to(room.code).emit("start", {
    countdownMs: COUNTDOWN_MS, durationMs: DURATION_MS, gravity: G_NORM,
    players: room.players.map((p) => p.name),
  });
  setTimeout(() => {
    if (room.status !== "countdown") return;
    room.status = "playing";
    room.startAt = Date.now();
    room.endAt = room.startAt + DURATION_MS;
    room.spawnTimer = setInterval(() => {
      if (room.status === "playing") spawnWave(room);
    }, 850);
    room.tickTimer = setInterval(() => {
      const timeLeft = Math.max(0, room.endAt - Date.now());
      io.to(room.code).emit("tick", { timeLeftMs: timeLeft, scores: scores(room) });
      if (timeLeft <= 0) endMatch(room);
    }, 1000);
  }, COUNTDOWN_MS);
}

function endMatch(room) {
  if (room.status === "over") return;
  room.status = "over";
  clearInterval(room.spawnTimer);
  clearInterval(room.tickTimer);
  const s = scores(room);
  const winner = s[0] === s[1] ? -1 : s[0] > s[1] ? 0 : 1;
  io.to(room.code).emit("over", { scores: s, winner });
}

function resetRoom(room) {
  clearInterval(room.spawnTimer);
  clearInterval(room.tickTimer);
  room.fruits = new Map();
  room.seq = 0;
  room.players.forEach((p) => (p.score = 0));
  room.status = "waiting";
}

io.on("connection", (socket) => {
  socket.on("create", ({ name } = {}, cb) => {
    const code = newCode();
    const room = {
      code, status: "waiting", players: [], fruits: new Map(), seq: 0,
      startAt: 0, endAt: 0, spawnTimer: null, tickTimer: null,
    };
    rooms.set(code, room);
    room.players.push({ id: socket.id, name: (name || "Player 1").slice(0, 16), score: 0 });
    socket.data.room = code; socket.data.idx = 0;
    socket.join(code);
    cb?.({ ok: true, code, you: 0 });
  });

  socket.on("join", ({ code, name } = {}, cb) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "No game with that code." });
    if (room.players.length >= 2) return cb?.({ ok: false, error: "That game is full." });
    room.players.push({ id: socket.id, name: (name || "Player 2").slice(0, 16), score: 0 });
    socket.data.room = room.code; socket.data.idx = 1;
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, you: 1, players: room.players.map((p) => p.name) });
    startMatch(room); // both present → begin
  });

  socket.on("blade", ({ nx, ny }) => {
    if (socket.data.room) socket.to(socket.data.room).emit("oppBlade", { nx, ny });
  });

  socket.on("slice", ({ fruitId }) => {
    const room = roomFor(socket);
    if (!room || room.status !== "playing") return;
    const fruit = room.fruits.get(fruitId);
    if (!fruit) return;                 // already claimed by the opponent (or gone)
    room.fruits.delete(fruitId);
    const p = room.players[socket.data.idx];
    if (fruit.type === "bomb") p.score = Math.max(0, p.score - BOMB_PENALTY);
    else p.score += 1;
    io.to(room.code).emit("sliced", {
      fruitId, by: socket.data.idx, type: fruit.type, scores: scores(room),
    });
  });

  socket.on("rematch", () => {
    const room = roomFor(socket);
    if (!room || room.players.length < 2) return;
    resetRoom(room);
    startMatch(room);
  });

  socket.on("disconnect", () => {
    const room = roomFor(socket);
    if (!room) return;
    socket.to(room.code).emit("oppLeft");
    clearInterval(room.spawnTimer);
    clearInterval(room.tickTimer);
    rooms.delete(room.code);
  });
});

httpServer.listen(PORT, () => console.log(`[mp] listening on :${PORT}`));
