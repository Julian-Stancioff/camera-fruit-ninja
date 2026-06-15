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
const G_NORM = 1.8;          // normalized gravity (units/s^2), shared with clients — a touch faster fall
const COUNTDOWN_MS = 3000;
const DURATION_MS = 90000;   // 90-second match
const COMBO_WINDOW = 800;    // ms: consecutive slices within this window chain into a combo
// Penalties escalate as the match goes on — a late bomb or a dropped fruit hurts
// far more than an early one, so blindly sweeping side-to-side stops being viable.
const bombPenalty = (elapsed) => Math.min(18, 3 + Math.floor(elapsed / 12) * 2); // 3 → 18
const missPenalty = (elapsed) => Math.min(5, 1 + Math.floor(elapsed / 20));      // 1 → 5

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
const clamp01 = (v) => Math.min(1, Math.max(0, v));

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
  const now = Date.now();
  const elapsed = (now - room.startAt) / 1000;
  const t = Math.min(1, elapsed / 75);

  // Mostly single fruit so the screen stays readable (no end-game flood). Every so
  // often a tight CLUSTER of 2–3 arrives that one well-aimed swipe can chain into a
  // combo — the skill is spotting and lining it up. Difficulty otherwise comes from
  // speed, varied angles and harsh penalties, not from spamming fruit.
  const cluster = elapsed > 4 && Math.random() < 0.3 + 0.12 * t;
  const count = cluster ? (Math.random() < 0.35 ? 3 : 2) : 1;
  const clusterCx = rand(0.3, 0.7);

  // Bombs arrive early (by time): eligible from ~4s, likely within 5–10s, and
  // guaranteed by ~9s if the dice haven't produced one. Never inside a cluster.
  const bombEligible = elapsed > 4;
  const bombChance = Math.min(0.3, 0.22 + elapsed / 200);
  const forceBomb = bombEligible && !room.bombSpawned && elapsed > 6.5;

  const fruits = [];
  let bombs = 0;
  for (let i = 0; i < count; i++) {
    let type = pick(FRUITS);
    if (!cluster && bombEligible && bombs === 0 && ((forceBomb && i === 0) || Math.random() < bombChance)) {
      type = "bomb"; bombs++; room.bombSpawned = true;
    }

    let nx, vx, rise;
    if (cluster) {
      // launch together from one zone so a single swipe can catch them all
      nx = clamp01(clusterCx + rand(-0.07, 0.07));
      vx = rand(-0.04, 0.04);
      rise = rand(0.56, 0.72) + 0.14 * t;
    } else if (Math.random() < 0.4) {
      // "cross-court" launch from near an edge that arcs diagonally across the
      // screen — so you can't just sweep left↔right to clear everything.
      const fromLeft = Math.random() < 0.5;
      nx = fromLeft ? rand(0.05, 0.18) : rand(0.82, 0.95);
      vx = (fromLeft ? 1 : -1) * rand(0.16, 0.3);
      rise = rand(0.5, 0.7) + 0.18 * t;
    } else {
      nx = rand(0.18, 0.82);
      vx = ((0.5 - nx) / 0.5) * rand(0.05, 0.13) + rand(-0.06, 0.06);
      rise = rand(0.5, 0.7) + 0.18 * t;              // climbs higher (= faster) as the match goes on
    }

    const vy = -Math.sqrt(2 * G_NORM * rise);        // upward launch (normalized)
    const radius = type === "watermelon" ? 0.085 : type === "bomb" ? 0.066 : rand(0.05, 0.068);
    const id = (room.seq++).toString(36);
    const lifetime = (-2 * vy / G_NORM) * 1000;      // ms aloft (symmetric arc back to spawn height)
    room.fruits.set(id, { type, expireAt: now + lifetime + 200 });
    fruits.push({ id, type, nx, ny: 1.12, vx, vy, radius, spawnTs: now });
  }
  io.to(room.code).emit("spawn", { fruits });
}

// Self-scheduling spawn loop so the cadence can speed up slightly over the match
// (1.0s → ~0.72s) without flooding the screen.
function scheduleSpawn(room) {
  if (room.status !== "playing") return;
  spawnWave(room);
  const t = Math.min(1, (Date.now() - room.startAt) / 1000 / 75);
  room.spawnTimer = setTimeout(() => scheduleSpawn(room), 1000 - 280 * t);
}

// Any non-bomb fruit that nobody sliced before it fell off-screen costs BOTH players
// escalating points — letting fruit drop now actively hurts you. (Bombs you let fall
// are good, so they just expire silently.)
function sweepMissed(room) {
  if (room.status !== "playing") return;
  const now = Date.now();
  const elapsed = (now - room.startAt) / 1000;
  for (const [id, fruit] of room.fruits) {
    if (now < fruit.expireAt) continue;
    room.fruits.delete(id);
    if (fruit.type === "bomb") continue;
    const pen = missPenalty(elapsed);
    room.players.forEach((p) => { p.score = Math.max(0, p.score - pen); p.combo = 0; });
    io.to(room.code).emit("missed", { fruitId: id, penalty: pen, scores: scores(room) });
  }
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
    room.bombSpawned = false;
    scheduleSpawn(room);
    room.sweepTimer = setInterval(() => sweepMissed(room), 250);
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
  clearTimeout(room.spawnTimer);
  clearInterval(room.sweepTimer);
  clearInterval(room.tickTimer);
  const s = scores(room);
  const winner = s[0] === s[1] ? -1 : s[0] > s[1] ? 0 : 1;
  io.to(room.code).emit("over", { scores: s, winner });
}

function resetRoom(room) {
  clearTimeout(room.spawnTimer);
  clearInterval(room.sweepTimer);
  clearInterval(room.tickTimer);
  room.fruits = new Map();
  room.seq = 0;
  // rematch: keep both ready, reset score + combo state
  room.players.forEach((p) => { p.score = 0; p.ready = true; p.combo = 0; p.lastSliceAt = 0; });
  room.status = "waiting";
}

io.on("connection", (socket) => {
  socket.on("create", ({ name } = {}, cb) => {
    const code = newCode();
    const room = {
      code, status: "waiting", players: [], fruits: new Map(), seq: 0,
      startAt: 0, endAt: 0, spawnTimer: null, sweepTimer: null, tickTimer: null,
    };
    rooms.set(code, room);
    room.players.push({ id: socket.id, name: (name || "Player 1").slice(0, 16), score: 0, ready: false, combo: 0, lastSliceAt: 0 });
    socket.data.room = code; socket.data.idx = 0;
    socket.join(code);
    cb?.({ ok: true, code, you: 0 });
  });

  socket.on("join", ({ code, name } = {}, cb) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "No game with that code." });
    if (room.players.length >= 2) return cb?.({ ok: false, error: "That game is full." });
    room.players.push({ id: socket.id, name: (name || "Player 2").slice(0, 16), score: 0, ready: false, combo: 0, lastSliceAt: 0 });
    socket.data.room = room.code; socket.data.idx = 1;
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, you: 1, players: room.players.map((p) => p.name) });
    // Both present → ask each client to confirm its player's hand before starting.
    io.to(room.code).emit("readyCheck", { players: room.players.map((p) => p.name) });
  });

  socket.on("ready", () => {
    const room = roomFor(socket);
    if (!room) return;
    const p = room.players[socket.data.idx];
    if (p) p.ready = true;
    if (room.players.length === 2 && room.players.every((x) => x.ready)) startMatch(room);
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
    const now = Date.now();
    let combo = 0, gained = 0;
    if (fruit.type === "bomb") {
      p.score = Math.max(0, p.score - bombPenalty((now - room.startAt) / 1000));
      p.combo = 0;
    } else {
      // Chain slices into a combo; combos add escalating points (mirrors solo).
      p.combo = (now - (p.lastSliceAt || 0) <= COMBO_WINDOW) ? p.combo + 1 : 1;
      p.lastSliceAt = now;
      combo = p.combo;
      gained = 1 + (combo >= 2 ? combo : 0);
      p.score += gained;
    }
    io.to(room.code).emit("sliced", {
      fruitId, by: socket.data.idx, type: fruit.type, combo, gained, scores: scores(room),
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
    clearTimeout(room.spawnTimer);
    clearInterval(room.sweepTimer);
    clearInterval(room.tickTimer);
    rooms.delete(room.code);
  });
});

httpServer.listen(PORT, () => console.log(`[mp] listening on :${PORT}`));
