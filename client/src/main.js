// Camera Fruit Ninja — conductor. Wires camera + hand tracking + Three.js game +
// effects + 2D blade-trail overlay + HUD/screens into one loop.
import { HandTracker } from "./tracking/HandTracker.js";
import { Scene } from "./rendering/scene.js";
import { Effects } from "./rendering/effects.js";
import { Game } from "./game/Game.js";
import { Fruit } from "./game/Fruit.js";
import { bladeSpeed } from "./game/slice.js";
import { OneEuroFilter } from "./tracking/OneEuroFilter.js";
import { addSlices, getTotal, beltFor, beltProgress } from "./game/belts.js";
import { connect } from "./net/net.js";
import { NetGame } from "./net/NetGame.js";
import * as sfx from "./audio/sfx.js";

const $ = (id) => document.getElementById(id);
const video = $("webcam");
const overlay = $("overlay");
const octx = overlay.getContext("2d");

const tracker = new HandTracker({ numHands: 1 });
let scene, effects, game;
let running = false;
let lastVideoTime = -1;
let lastTickTs = 0;
let fps = 0, lastFrameTs = 0;
let showSkeleton = false;

// multiplayer state
let mode = "solo";          // "solo" | "versus"
let controller = null;       // active game controller (Game or NetGame)
let socket = null, netGame = null, you = 0, oppName = "Opponent";
let lastBladeEmit = 0;
const oppTrail = [];

// Tunable feel — overridable via URL (?gain=2.2&mincut=1.0&beta=0.02&debug) so we
// can dial it in on the live site without a redeploy.
const PARAMS = new URLSearchParams(location.search);
const DEBUG = PARAMS.has("debug");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Player-tunable feel, persisted to localStorage and adjustable in-game (gear).
// Sensitivity = gain (reach + speed). Smoothing 0..1 maps to 1€ filter params.
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("fn_settings") || "{}"); } catch { /* ignore */ }
  const urlGain = parseFloat(PARAMS.get("gain"));
  return {
    sensitivity: clamp(!isNaN(urlGain) ? urlGain : (s.sensitivity ?? 1.8), 1.2, 3.0),
    smoothing: clamp(s.smoothing ?? 0.6, 0, 1),
  };
}
function saveSettings() { localStorage.setItem("fn_settings", JSON.stringify(settings)); }
// More smoothing → lower cutoff + lower beta (smoother, slightly more lag).
function smoothingParams(s) { return { minCutoff: lerp(2.0, 0.8, s), beta: lerp(0.045, 0.004, s) }; }

const settings = loadSettings();
let GAIN_X = settings.sensitivity, GAIN_Y = settings.sensitivity;

// blade state (screen px)
let bladePrev = null, bladeCur = null;
let lastHandTs = 0, lastDetectTs = 0;
const trail = [];
const TRAIL_MS = 150;
const _sp = smoothingParams(settings.smoothing);
const cursorFX = new OneEuroFilter(30, _sp.minCutoff, _sp.beta);
const cursorFY = new OneEuroFilter(30, _sp.minCutoff, _sp.beta);

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17],
];

// ---------- sizing ----------
let dpr = 1;
function resizeAll() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.round(window.innerWidth * dpr);
  overlay.height = Math.round(window.innerHeight * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scene?.resize();
}
window.addEventListener("resize", resizeAll);

// normalized fingertip (0..1 in the camera frame) → screen px.
// The webcam is just a small PiP now, so the blade is a free cursor: we apply a
// centered gain so a comfortable hand range covers the whole screen (reach the
// edges, feels faster), then mirror x for the selfie view.
function mapPoint(nx, ny) {
  const cw = window.innerWidth, ch = window.innerHeight;
  const gx = Math.min(1, Math.max(0, 0.5 + (nx - 0.5) * GAIN_X));
  const gy = Math.min(1, Math.max(0, 0.5 + (ny - 0.5) * GAIN_Y));
  return { x: (1 - gx) * cw, y: gy * ch };
}

// ---------- start ----------
$("start-btn").addEventListener("click", start);
$("again-btn").addEventListener("click", () => {
  $("gameover").hidden = true;
  if (mode === "versus") { netGame.clear(); socket.emit("rematch"); }
  else { resetHud(); game.reset(); game.start(); }
});
$("menu-btn").addEventListener("click", backToMenu);
$("toggle-skeleton").addEventListener("change", (e) => (showSkeleton = e.target.checked));
$("toggle-camera").addEventListener("change", (e) => video.classList.toggle("cam-off", !e.target.checked));

async function start() {
  const btn = $("start-btn");
  btn.disabled = true;
  setNote("Requesting camera…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    await new Promise((res) => (video.onloadedmetadata = res));
    await video.play();

    setNote("Loading hand-tracking model…");
    const delegate = await tracker.init();
    $("hud-delegate").textContent = `${delegate}`;

    scene = new Scene($("game-canvas"));
    effects = new Effects(scene);
    resizeAll();

    sfx.resume();
    $("start-screen").classList.add("gone");
    if (DEBUG) $("hud").hidden = false; // dev HUD only with ?debug
    running = true;
    startLoop();

    // Route to mode select, or auto-join a shared link (?join=CODE).
    const joinCode = (new URLSearchParams(location.search).get("join") || "").toUpperCase();
    if (joinCode) openVersus(joinCode); else showModeScreen();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    setNote(err?.name === "NotAllowedError"
      ? "Camera permission was denied. Allow camera access and try again."
      : `Could not start: ${err?.message || err}`, true);
  }
}

function setNote(t, isError = false) {
  const n = $("start-note");
  n.textContent = t;
  n.classList.toggle("error", isError);
}

// ---------- game callbacks → UI ----------
const callbacks = {
  onSlice({ comboSize, score }) {
    setScore(score);
    sfx.slice();
    const total = addSlices(1);
    const b = beltFor(total);
    if (b.name !== currentBelt) { currentBelt = b.name; showBeltToast(b); sfx.combo(4); }
    renderBelt();
    if (comboSize >= 3) { showCombo(comboSize); sfx.combo(comboSize); }
  },
  onMiss(strikes) { renderStrikes(strikes); flashBad(); sfx.miss(); },
  onBomb() { flashBad(); sfx.bomb(); },
  onGameOver({ reason, score, best }) {
    sfx.gameover();
    $("over-title").textContent = "Game Over";
    $("over-reason").textContent = reason === "bomb" ? "💥 You sliced a bomb!" : "You ran out of lives.";
    $("over-score").textContent = score; $("over-score-lbl").textContent = "Score";
    $("over-best").textContent = best; $("over-best-lbl").textContent = "Best";
    $("again-btn").textContent = "Play again";
    $("menu-btn").hidden = false;
    setTimeout(() => { $("gameover").hidden = false; }, 700);
  },
};

function setScore(s) { $("score").textContent = s; }
function resetHud() { setScore(0); renderStrikes(3); renderBelt(); }

let currentBelt = beltFor(getTotal()).name;
function renderBelt() {
  const t = getTotal(), b = beltFor(t);
  $("belt-dot").style.background = b.color;
  $("belt-name").textContent = `${b.name} Belt`;
  $("belt-fill").style.width = `${Math.round(beltProgress(t) * 100)}%`;
}
function showBeltToast(b) {
  const el = $("belt-toast");
  el.textContent = `🥋 ${b.name} Belt!`;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
}
function renderStrikes(n) {
  let html = "";
  for (let i = 0; i < 3; i++) html += `<span class="strike${i >= n ? " lost" : ""}">✕</span>`;
  $("strikes").innerHTML = html;
}
function showCombo(n) {
  const el = $("combo");
  el.textContent = `${n}  COMBO!`;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
}
function flashBad() {
  overlay.classList.remove("flash-bad");
  void overlay.offsetWidth;
  overlay.classList.add("flash-bad");
}

// ============================ mode select + versus ============================
function showModeScreen() {
  $("mode-rank").textContent = `🥋 ${beltFor(getTotal()).name} Belt`;
  $("mode-screen").hidden = false;
}
function setHudMode(m) {
  const versus = m === "versus";
  $("score").hidden = versus;
  $("strikes").hidden = versus;
  $("belt").hidden = versus;
  $("versus-hud").hidden = !versus;
}
function startSolo() {
  mode = "solo";
  $("mode-screen").hidden = true;
  $("game-hud").hidden = false;
  setHudMode("solo");
  if (!game) game = new Game(scene, effects, callbacks);
  controller = game;
  resetHud();
  game.reset();
  game.start();
}
$("mode-solo").addEventListener("click", startSolo);
$("mode-versus").addEventListener("click", () => openVersus());

function openVersus(autoCode) {
  mode = "versus";
  $("mode-screen").hidden = true;
  $("versus-screen").hidden = false;
  $("vs-choose").hidden = false;
  $("vs-wait").hidden = true;
  hideVsError();
  if (autoCode) { $("vs-code").value = autoCode; doJoin(autoCode); }
}
$("vs-create").addEventListener("click", doCreate);
$("vs-join-btn").addEventListener("click", () => doJoin(($("vs-code").value || "").trim().toUpperCase()));
$("vs-code").addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(($("vs-code").value || "").trim().toUpperCase()); });
$("vs-back").addEventListener("click", () => { teardownSocket(); $("versus-screen").hidden = true; showModeScreen(); });
$("vs-copy").addEventListener("click", () => {
  navigator.clipboard?.writeText($("vs-link").value).then(() => { $("vs-copy").textContent = "✓ Copied!"; });
});
function showVsError(msg) { const e = $("vs-error"); e.textContent = msg; e.hidden = false; }
function hideVsError() { $("vs-error").hidden = true; }

function ensureSocket() {
  if (socket) return;
  socket = connect();
  socket.on("connect_error", () => showVsError("Can't reach the game server — try again."));
  socket.on("start", onMatchStart);
}
function makeNetGame() { netGame = new NetGame(scene, effects, socket, you, netCallbacks); controller = netGame; }

function doCreate() {
  hideVsError(); ensureSocket();
  socket.emit("create", {}, (res) => {
    if (!res?.ok) return showVsError(res?.error || "Could not create the game.");
    you = res.you; makeNetGame(); showWaiting(res.code);
  });
}
function doJoin(code) {
  if (!code || code.length < 4) return showVsError("Enter the 4-letter game code.");
  hideVsError(); ensureSocket();
  socket.emit("join", { code }, (res) => {
    if (!res?.ok) return showVsError(res?.error || "Could not join that game.");
    you = res.you; makeNetGame(); // match begins via the 'start' event
  });
}
function showWaiting(code) {
  $("vs-choose").hidden = true;
  $("vs-wait").hidden = false;
  $("vs-code-display").textContent = code;
  $("vs-link").value = `${location.origin}/?join=${code}`;
  $("vs-copy").textContent = "📋 Copy link";
}

function onMatchStart(s) {
  oppName = (s.players && s.players[1 - you]) || "Opponent";
  $("vs-opp-name").textContent = oppName;
  $("versus-screen").hidden = true;
  $("gameover").hidden = true;
  $("game-hud").hidden = false;
  setHudMode("versus");
  resetVersusHud(s.durationMs);
  runCountdown(Math.max(1, Math.round((s.countdownMs || 3000) / 1000)), () => netGame.begin(s.gravity));
}
function resetVersusHud(durationMs) {
  $("vs-you-score").textContent = "0";
  $("vs-opp-score").textContent = "0";
  const sec = Math.round((durationMs || 90000) / 1000);
  const t = $("vs-timer"); t.textContent = sec; t.classList.remove("low");
  oppTrail.length = 0;
}
function runCountdown(n, done) {
  const el = $("countdown"), num = $("countdown-num");
  el.hidden = false;
  let i = n;
  const step = () => {
    if (i <= 0) { el.hidden = true; done(); return; }
    num.textContent = i; num.style.animation = "none"; void num.offsetWidth; num.style.animation = "";
    i--; setTimeout(step, 1000);
  };
  step();
}
const netCallbacks = {
  onTick: ({ timeLeftMs, scores }) => {
    const sec = Math.ceil(timeLeftMs / 1000);
    const t = $("vs-timer"); t.textContent = sec; t.classList.toggle("low", sec <= 10);
    updateVersusScores(scores);
  },
  onScores: (scores) => updateVersusScores(scores),
  onOver: ({ scores, winner }) => showVersusResult(scores, winner, false),
  onOppBlade: (b) => pushOppBlade(b),
  onBelt: (b) => { if (b.name !== currentBelt) { currentBelt = b.name; showBeltToast(b); } },
  onOppLeft: () => showVersusResult(netGame ? netGame.scores : [0, 0], null, true),
};
function updateVersusScores(scores) {
  if (!scores) return;
  $("vs-you-score").textContent = scores[you];
  $("vs-opp-score").textContent = scores[1 - you];
}
function showVersusResult(scores, winner, oppLeft) {
  const youS = scores[you], oppS = scores[1 - you];
  let title, reason;
  if (oppLeft) { title = "Opponent left"; reason = "They disconnected — you win by default."; }
  else if (winner === -1) { title = "Tie game!"; reason = "Dead even — rematch?"; }
  else if (winner === you) { title = "You win! 🏆"; reason = "Nice slicing."; sfx.combo(5); }
  else { title = "You lose"; reason = "Get 'em next round."; sfx.gameover(); }
  $("over-title").textContent = title;
  $("over-reason").textContent = reason;
  $("over-score").textContent = youS; $("over-score-lbl").textContent = "You";
  $("over-best").textContent = oppS; $("over-best-lbl").textContent = oppName;
  $("again-btn").textContent = oppLeft ? "New game" : "Rematch";
  $("menu-btn").hidden = false;
  $("gameover").hidden = false;
}
function teardownSocket() {
  if (socket) { socket.disconnect(); socket = null; }
  if (netGame) { netGame.clear(); netGame = null; }
  controller = null;
}
function backToMenu() {
  teardownSocket();
  mode = "solo";
  $("gameover").hidden = true;
  $("again-btn").textContent = "Play again";
  $("menu-btn").hidden = true;
  $("over-score-lbl").textContent = "Score"; $("over-best-lbl").textContent = "Best";
  $("game-hud").hidden = true;
  setHudMode("solo");
  showModeScreen();
}

// ---------- loop ----------
// rAF render loop → smooth 60fps fruit + trail. Hand detection runs only on a new
// camera frame (~30fps) via the currentTime guard inside tick(), so the game never
// looks choppy even though the camera is 30fps.
function startLoop() {
  const onRaf = (now) => { if (!running) return; tick(now); requestAnimationFrame(onRaf); };
  requestAnimationFrame(onRaf);
}

function tick(now) {
  const dt = lastTickTs ? Math.min((now - lastTickTs) / 1000, 0.05) : 0.016;
  lastTickTs = now;

  let segment = null;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const dtMs = lastDetectTs ? now - lastDetectTs : 33;
    const freq = dtMs > 0 ? 1000 / dtMs : 30;
    lastDetectTs = now;

    const result = tracker.detect(video, now);
    if (DEBUG) updateHud(result, now);
    lastResult = result;

    if (result.present && result.blade) {
      const raw = mapPoint(result.blade.x, result.blade.y);
      // Smooth in pixel space: clean cursor → clean slice segments → reliable cuts.
      const cur = { x: cursorFX.filter(raw.x, freq), y: cursorFY.filter(raw.y, freq) };
      if (bladePrev) segment = { a: bladePrev, b: cur, speed: bladeSpeed(bladePrev, cur, dtMs) };
      trail.push({ x: cur.x, y: cur.y, t: now });
      bladePrev = cur; bladeCur = cur; lastHandTs = now;
      // Versus: stream our fingertip to the opponent (~20Hz), normalized.
      if (mode === "versus" && netGame?.playing && socket && now - lastBladeEmit > 50) {
        socket.emit("blade", { nx: cur.x / window.innerWidth, ny: cur.y / window.innerHeight });
        lastBladeEmit = now;
      }
    } else {
      cursorFX.reset(); cursorFY.reset();
      bladePrev = null; bladeCur = null;
    }
    updateHandHint(now);
  }
  while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();

  if (controller) controller.update(dt, segment);
  if (scene) scene.render();
  drawOverlay(now);
}

let lastResult = { present: false, landmarks: [] };
function updateHud(result, now) {
  const d = now - lastFrameTs;
  lastFrameTs = now;
  if (d > 0) fps = fps ? fps * 0.9 + (1000 / d) * 0.1 : 1000 / d;
  $("hud-fps").textContent = `${Math.round(fps)} fps`;
  const t = $("hud-track");
  if (result.present) { t.textContent = "● tracked"; t.className = "hud-pill ok"; }
  else { t.textContent = "● searching…"; t.className = "hud-pill lost"; }
}

// Centered prompt when the camera can't see a hand mid-game.
function updateHandHint(now) {
  const show = game && game.playing && now - lastHandTs > 700;
  $("hand-hint").classList.toggle("show", show);
}

// ---------- settings panel (live feel tuning) ----------
function wireSettings() {
  const sens = $("set-sens"), smooth = $("set-smooth");
  const upd = () => {
    $("set-sens-val").textContent = (+sens.value).toFixed(1) + "×";
    $("set-smooth-val").textContent = Math.round(smooth.value * 100) + "%";
  };
  sens.value = settings.sensitivity;
  smooth.value = settings.smoothing;
  upd();
  sens.oninput = () => {
    GAIN_X = GAIN_Y = parseFloat(sens.value);
    settings.sensitivity = GAIN_X; saveSettings(); upd();
  };
  smooth.oninput = () => {
    const sp = smoothingParams(parseFloat(smooth.value));
    cursorFX.minCutoff = cursorFY.minCutoff = sp.minCutoff;
    cursorFX.beta = cursorFY.beta = sp.beta;
    settings.smoothing = parseFloat(smooth.value); saveSettings(); upd();
  };
  $("set-reset").onclick = () => {
    sens.value = 1.8; smooth.value = 0.6; sens.oninput(); smooth.oninput();
  };
  $("settings-btn").onclick = () => { $("settings-panel").hidden = !$("settings-panel").hidden; };
}
wireSettings();
$("start-rank").textContent = `🥋 Your rank: ${beltFor(getTotal()).name} Belt`;

// ---------- 2D overlay: blade trail + debug skeleton ----------
function drawOverlay(now) {
  octx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (showSkeleton && lastResult.present) drawSkeleton(lastResult.landmarks);
  if (mode === "versus") drawOppTrail(now);
  drawTrail(now);
  drawTip();
}

// opponent's ghost blade (blue) in versus
function pushOppBlade(b) {
  oppTrail.push({ x: b.nx * window.innerWidth, y: b.ny * window.innerHeight, t: performance.now() });
}
function drawOppTrail(now) {
  while (oppTrail.length && now - oppTrail[0].t > TRAIL_MS) oppTrail.shift();
  if (oppTrail.length < 2) return;
  octx.save();
  octx.lineCap = "round"; octx.lineJoin = "round"; octx.shadowColor = "rgba(120,200,255,0.9)";
  for (let i = 1; i < oppTrail.length; i++) {
    const a = oppTrail[i - 1], b = oppTrail[i];
    const k = Math.max(0, 1 - (now - b.t) / TRAIL_MS);
    octx.shadowBlur = 14 * k; octx.lineWidth = 2 + 14 * k;
    octx.strokeStyle = `rgba(150,210,255,${0.12 + 0.7 * k})`;
    octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  }
  const p = oppTrail[oppTrail.length - 1];
  octx.shadowBlur = 16; octx.fillStyle = "#9ad2ff";
  octx.beginPath(); octx.arc(p.x, p.y, 8, 0, Math.PI * 2); octx.fill();
  octx.restore();
}

function drawTrail(now) {
  if (trail.length < 2) return;
  octx.save();
  octx.lineCap = "round"; octx.lineJoin = "round";
  octx.shadowColor = "rgba(255, 246, 216, 0.9)";
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i];
    const k = Math.max(0, 1 - (now - b.t) / TRAIL_MS);
    octx.shadowBlur = 18 * k;
    octx.lineWidth = 3 + 22 * k;
    octx.strokeStyle = `rgba(255, 250, 230, ${0.18 + 0.78 * k})`;
    octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  }
  octx.restore();
}

function drawTip() {
  if (!bladeCur) return;
  octx.save();
  octx.shadowColor = "rgba(255, 210, 74, 0.95)"; octx.shadowBlur = 26;
  octx.fillStyle = "#fff6d8";
  octx.beginPath(); octx.arc(bladeCur.x, bladeCur.y, 11, 0, Math.PI * 2); octx.fill();
  octx.restore();
}

function drawSkeleton(landmarks) {
  octx.save();
  octx.strokeStyle = "rgba(120, 220, 255, 0.8)";
  octx.fillStyle = "rgba(255, 255, 255, 0.9)";
  octx.lineWidth = 2;
  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = mapPoint(landmarks[a].x, landmarks[a].y);
    const pb = mapPoint(landmarks[b].x, landmarks[b].y);
    octx.beginPath(); octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y); octx.stroke();
  }
  for (let i = 0; i < landmarks.length; i++) {
    const p = mapPoint(landmarks[i].x, landmarks[i].y);
    octx.beginPath(); octx.arc(p.x, p.y, i === 8 ? 6 : 3, 0, Math.PI * 2); octx.fill();
  }
  octx.restore();
}

// ---------- test hook (only when ?test is present; harmless otherwise) ----------
if (new URLSearchParams(location.search).has("test")) {
  window.__fn = {
    get game() { return game; },
    get scene() { return scene; },
    get effects() { return effects; },
    get mode() { return mode; },
    get socket() { return socket; },
    get netGame() { return netGame; },
    get you() { return you; },
    netSliceFirst() {
      const id = netGame?.fruits.keys().next().value;
      if (id != null && socket) { socket.emit("slice", { fruitId: id }); return id; }
      return null;
    },
    spawn(type, x, y) {
      const r = Math.min(scene.w, scene.h) * 0.06;
      const f = new Fruit(type, { x: x ?? scene.w / 2, y: y ?? scene.h / 2, vx: 0, vy: 0, radius: r });
      scene.add(f.mesh); game.fruits.push(f);
      return { x: f.x, y: f.y, type: f.type, radius: f.radius };
    },
    swipe(x0, y0, x1, y1) {
      game.update(0.016, { a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, speed: 6000 });
    },
    step(dt = 0.016) { game.update(dt, null); },
    state() {
      return {
        score: game.score.score, strikes: game.score.strikes,
        fruits: game.fruits.length, playing: game.playing, effects: effects.items.length,
        gameoverShown: !$("gameover").hidden,
      };
    },
  };
}
