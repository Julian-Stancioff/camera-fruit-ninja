// Camera Fruit Ninja — conductor. Wires camera + hand tracking + Three.js game +
// effects + 2D blade-trail overlay + HUD/screens into one loop.
import { HandTracker } from "./tracking/HandTracker.js";
import { Scene } from "./rendering/scene.js";
import { Effects } from "./rendering/effects.js";
import { Game } from "./game/Game.js";
import { Fruit } from "./game/Fruit.js";
import { bladeSpeed } from "./game/slice.js";
import { OneEuroFilter } from "./tracking/OneEuroFilter.js";
import { ObjectBlade } from "./tracking/ObjectBlade.js";
import { addXP, getXP, levelFor, levelProgress, nextLevel } from "./game/belts.js";
import { connect } from "./net/net.js";
import { NetGame } from "./net/NetGame.js";
import { SplitGame } from "./game/SplitGame.js";
import * as sfx from "./audio/sfx.js";
import * as music from "./audio/music.js";

const $ = (id) => document.getElementById(id);
const video = $("webcam");
const overlay = $("overlay");
const octx = overlay.getContext("2d");

const tracker = new HandTracker({ numHands: 2 }); // 2 enables split-screen; solo/versus use hand[0]
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
let soloStartTs = 0, lastMusicTs = 0;
let readyGate = null, readyResult = null; // hand-confirmation gate before a match

// Katana / object blade: the player holds a real sword (or a stick, a bottle, anything)
// and it becomes the blade. Kept as a separate flag from `mode` so every solo code path
// — timer, music, pause, replay — works untouched; only the blade's source changes.
let bladeMode = "hand";          // "hand" | "object"
const objectBlade = new ObjectBlade();
let katGate = null, katCand = null;
let bladeLine = null;            // {grip, tip} in screen px, object mode only
let bladeSamplesPrev = null;     // previous frame's sample points along the blade
let paused = false, pauseStart = 0;       // pause / quit-to-menu
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
    // Blade length as a fraction of screen height. Deliberately NOT the object's true
    // size — a true-to-scale sword sweeps half the screen and slices everything. This
    // keeps a katana's reach in the same ballpark as a hand swipe.
    bladeLen: clamp(s.bladeLen ?? 0.2, 0.1, 0.35),
  };
}
function saveSettings() { localStorage.setItem("fn_settings", JSON.stringify(settings)); }
// More smoothing → lower cutoff + lower beta (smoother, slightly more lag).
function smoothingParams(s) { return { minCutoff: lerp(2.0, 0.8, s), beta: lerp(0.045, 0.004, s) }; }

const settings = loadSettings();
let GAIN_X = settings.sensitivity, GAIN_Y = settings.sensitivity;

// blade state (screen px)
let bladePrev = null, bladeCur = null;
let lastRawBlade = null;        // last chosen fingertip (normalized) — keeps the blade locked to ONE hand
let lastHandTs = 0, lastDetectTs = 0;
let misses = 0;                 // consecutive frames MediaPipe found no hand
const COAST_FRAMES = 8;         // ~250ms: hold the blade through brief dropouts
const trail = [];
const TRAIL_MS = 150;

// Hand LOCK: keep the blade glued to the initially-chosen hand and ignore stray
// hands that wander into frame; detect when the chosen hand leaves so we can prompt
// ("bring your hand back") and slow the fruit until it's re-acquired.
const LOST_FRAMES = 8;          // detect-frames with no hand → declare it "lost"
const SLOW_LOST = 0.12;         // fruit crawl to ~stopped while the hand is gone
const SLOW_EASE = 0.18;         // per-frame easing of the slow factor
const mainLock = { lockPos: null, landmarks: null, present: false, lostFrames: 0, lost: false, slow: 1 };
function resetLock(l) { l.lockPos = null; l.landmarks = null; l.present = false; l.lostFrames = 0; l.lost = false; l.slow = 1; }
const _sp = smoothingParams(settings.smoothing);
const cursorFX = new OneEuroFilter(30, _sp.minCutoff, _sp.beta);
const cursorFY = new OneEuroFilter(30, _sp.minCutoff, _sp.beta);

// split-screen (2 players, 2 hands) state — one object per side
let splitGame = null;
const SPLIT_GAIN = 1.35;
const splitSide = {
  left:  { fx: new OneEuroFilter(30, _sp.minCutoff, _sp.beta), fy: new OneEuroFilter(30, _sp.minCutoff, _sp.beta), prev: null, cur: null, miss: 0, trail: [], lockPos: null, landmarks: null, present: false, lostFrames: 0, lost: false, slow: 1 },
  right: { fx: new OneEuroFilter(30, _sp.minCutoff, _sp.beta), fy: new OneEuroFilter(30, _sp.minCutoff, _sp.beta), prev: null, cur: null, miss: 0, trail: [], lockPos: null, landmarks: null, present: false, lostFrames: 0, lost: false, slow: 1 },
};

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
  splitGame?.resize();
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

// Tracker runs with numHands:2 (for split-screen). Pick the hand to control a blade,
// LOCKED onto the previously-chosen hand by proximity so a stray hand that wanders
// into frame can't hijack the blade. region: null = whole frame (solo/versus);
// "left"/"right" = a split half. Returns {x,y,lm} (lm = that hand's 21 landmarks).
function nearest(cands, to) {
  if (!to) return cands[0];
  let best = cands[0], bd = Infinity;
  for (const c of cands) { const d = (c.x - to.x) ** 2 + (c.y - to.y) ** 2; if (d < bd) { bd = d; best = c; } }
  return best;
}
function pickLockedHand(result, lock, region) {
  const hands = result.present ? result.hands : [];
  const all = result.allLandmarks || [];
  const cands = [];
  for (let i = 0; i < hands.length; i++) {
    const h = hands[i];
    if (region) { const mx = 1 - h.x; if (region === "left" ? mx >= 0.5 : mx < 0.5) continue; }
    cands.push({ x: h.x, y: h.y, lm: all[i] || null });
  }
  if (!cands.length) return null;
  // one hand (or no lock yet / re-acquiring) → take it; multiple → stick to the lock
  return nearest(cands, lock.lockPos);
}
// Advance a lock's presence bookkeeping from the chosen hand (or null this frame).
function updateLock(lock, chosen) {
  if (chosen) { lock.lockPos = { x: chosen.x, y: chosen.y }; lock.landmarks = chosen.lm; lock.present = true; lock.lostFrames = 0; lock.lost = false; }
  else { lock.present = false; lock.lostFrames++; if (lock.lostFrames >= LOST_FRAMES) lock.lost = true; }
}
function easeSlow(lock) { lock.slow += ((lock.lost ? SLOW_LOST : 1) - lock.slow) * SLOW_EASE; }

// ---------- object blade geometry (screen px) ----------
// Screen-space blade from the grip: fixed length along the tracked angle. The camera
// image is mirrored on screen, so the angle mirrors with it.
function bladeFrom(grip, camAngle) {
  const a = Math.PI - camAngle;
  const L = settings.bladeLen * window.innerHeight;
  return { grip, tip: { x: grip.x + Math.cos(a) * L, y: grip.y + Math.sin(a) * L } };
}
// Cut with the blade from mid-shaft to tip. The hilt end is your fist — letting it cut
// would slice fruit you never swung at. Each sample is speed-gated on its own downstream,
// so a wrist-whip cuts with the fast tip while the near-still base does not.
const BLADE_T0 = 0.35, BLADE_SAMPLES = 6;
function bladeSamples({ grip, tip }) {
  const out = [];
  for (let i = 0; i < BLADE_SAMPLES; i++) {
    const t = BLADE_T0 + (1 - BLADE_T0) * (i / (BLADE_SAMPLES - 1));
    out.push({ x: grip.x + (tip.x - grip.x) * t, y: grip.y + (tip.y - grip.y) * t });
  }
  return out;
}

// ---------- music helpers (separate menu / in-game volumes) ----------
const menuVol = () => { const v = parseFloat(localStorage.getItem("fn_menu_vol") ?? "0.7"); return isNaN(v) ? 0.7 : v; };
const gameVol = () => { const v = parseFloat(localStorage.getItem("fn_game_vol") ?? "0.7"); return isNaN(v) ? 0.7 : v; };
function musicMenu() { music.start(); music.setVolume(menuVol()); }
function musicGame() { music.start(); music.setVolume(gameVol()); }
// Game over: music stops and stays stopped until a new game / the home screen.
function musicGameOver() { music.stop(); sfx.gameover(); }

// Start music on the very first interaction (audio needs a gesture) — at the menu.
let musicStarted = false;
function kickMusic() {
  if (musicStarted) return;
  musicStarted = true;
  music.resume();
  musicMenu();
}
document.addEventListener("pointerdown", kickMusic, { once: true });
document.addEventListener("keydown", kickMusic, { once: true });

// ---------- start ----------
$("start-btn").addEventListener("click", start);
$("again-btn").addEventListener("click", () => {
  $("gameover").hidden = true;
  if (mode === "versus") { netGame.clear(); socket.emit("rematch"); } // music restarts on server 'start'
  else if (mode === "split") { splitGame.clear(); musicGame(); runCountdown(3, () => { splitGame.start(); setPauseBtn(true); }); }
  else { resetHud(); musicGame(); game.reset(); game.start(); }
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
    musicMenu();
    $("start-screen").classList.add("gone");
    overlay.classList.add("overlay-top"); // keep trail + PiP hand-mapping above the camera PiP
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
  onStart() { soloStartTs = performance.now(); setPauseBtn(true); },
  onSlice({ comboSize, gained, score }) {
    setScore(score);
    sfx.slice();
    if (comboSize >= 2) { showCombo(comboSize, gained); sfx.combo(comboSize); }
  },
  // A lost life from a missed fruit or a sliced bomb (3 strikes = over).
  onStrike(strikesLeft, cause) {
    renderStrikes(strikesLeft, true);
    flashBad();
    if (cause === "bomb") sfx.bomb(); else sfx.miss();
  },
  onGameOver({ reason, score, best }) {
    music.stop();    // music stops on game over…
    sfx.gameover();  // …and the descending "nuh-nuh-nuh" sting plays
    setPauseBtn(false);
    showSoloGameOver(reason, score, best);
  },
};

function setScore(s) { $("score").textContent = s; }
function resetHud() { setScore(0); renderStrikes(3); }

// XP / level (belts). Level-ups happen on the game-over screen, never mid-game.
function renderLevel() {
  const xp = getXP(), lv = levelFor(xp), nxt = nextLevel(xp);
  const pct = Math.round(levelProgress(xp) * 100);
  $("home-belt-chip").style.background = lv.color;
  $("home-level-name").textContent = `Level ${lv.level} · ${lv.name} Belt`;
  $("home-xp-fill").style.width = `${pct}%`;
  $("home-xp-sub").textContent = nxt ? `${xp} XP · ${nxt.xp - xp} to ${nxt.name} Belt` : `${xp} XP · max rank`;
  $("mode-rank").innerHTML = `<span class="belt-chip" style="width:18px;height:18px;background:${lv.color}"></span> Level ${lv.level} · ${lv.name} Belt`;
}

function showSoloGameOver(reason, score, best) {
  $("over-title").textContent = "Game Over";
  $("over-reason").textContent = reason === "bomb"
    ? "💥 Too many strikes — watch the bombs!" : "Out of lives — three fruit got past you.";
  $("over-score").textContent = score; $("over-score-lbl").textContent = "Score";
  $("over-best").textContent = best; $("over-best-lbl").textContent = "Best";

  // Bank XP from the score and show progression / level-up.
  const beforeXP = getXP(), beforeLv = levelFor(beforeXP).level;
  const afterXP = addXP(score), afterLv = levelFor(afterXP);
  const leveledUp = afterLv.level > beforeLv;
  $("over-progress").hidden = false;
  $("over-belt-chip").style.background = afterLv.color;
  $("over-level-name").textContent = `Level ${afterLv.level} · ${afterLv.name} Belt`;
  $("over-xp-gain").textContent = `+${score} XP`;
  const lu = $("over-levelup");
  lu.hidden = !leveledUp;
  if (leveledUp) lu.textContent = `🥋 LEVEL UP — ${afterLv.name} Belt!`;
  const nxt = nextLevel(afterXP);
  $("over-xp-sub").textContent = nxt ? `${afterXP} XP · ${nxt.xp - afterXP} to ${nxt.name} Belt` : `${afterXP} XP · max rank`;
  // animate the bar from the old % to the new %
  $("over-xp-fill").style.transition = "none";
  $("over-xp-fill").style.width = `${Math.round(levelProgress(beforeXP) * 100)}%`;
  renderLevel();
  $("again-btn").textContent = "Play again";
  $("menu-btn").hidden = false;
  setTimeout(() => {
    $("gameover").hidden = false;
    requestAnimationFrame(() => {
      $("over-xp-fill").style.transition = "width 0.8s ease";
      $("over-xp-fill").style.width = `${leveledUp ? 100 : Math.round(levelProgress(afterXP) * 100)}%`;
    });
    if (leveledUp) sfx.combo(5);
  }, 700);
}

// Three Xs; lost ones fill in left→right. With animateNew, the newest lost X pops.
function renderStrikes(n, animateNew = false) {
  $("strikes").innerHTML = Array.from({ length: 3 }, (_, i) =>
    `<span class="strike${i >= n ? " lost" : ""}">✕</span>`).join("");
  if (animateNew) {
    const lost = $("strikes").querySelectorAll(".strike.lost");
    lost[lost.length - 1]?.classList.add("justlost");
  }
}
function showCombo(n, gained) {
  const el = $("combo");
  el.textContent = `${n}× COMBO   +${gained}!`;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
}
function formatTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function flashBad() {
  overlay.classList.remove("flash-bad");
  void overlay.offsetWidth;
  overlay.classList.add("flash-bad");
}

// ============================ mode select + versus ============================
function showModeScreen() {
  renderLevel();
  musicMenu();
  $("mode-screen").hidden = false;
}
function setHudMode(m) {
  const twoP = m === "versus" || m === "split";
  $("score").hidden = twoP;
  $("strikes").hidden = twoP;
  $("solo-timer").hidden = m !== "solo";
  $("versus-hud").hidden = !twoP;
}
function startSolo() {
  mode = "solo";
  $("mode-screen").hidden = true;
  $("game-hud").hidden = false;
  setHudMode("solo");
  if (!game) game = new Game(scene, effects, callbacks);
  controller = game;
  resetLock(mainLock);
  resetHud();
  musicGame();
  // Object mode already confirmed the blade on the katana screen — go straight in.
  if (bladeMode === "object") { runCountdown(3, () => { game.reset(); game.start(); }); return; }
  enterReady({
    needHands: 1,
    label: "Show your hand to the camera ✋",
    onConfirmed: () => { exitReady(); runCountdown(3, () => { game.reset(); game.start(); }); },
  });
}
$("mode-solo").addEventListener("click", () => { bladeMode = "hand"; startSolo(); });
$("mode-versus").addEventListener("click", () => openVersus());

function openVersus(autoCode) {
  mode = "versus";
  bladeMode = "hand"; // networked + split modes stay on the fingertip
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
  socket.on("readyCheck", ({ players }) => enterVersusReady(players));
  socket.on("start", onMatchStart);
}
// Both players present → confirm each player's hand, then tell the server we're ready.
function enterVersusReady(players) {
  oppName = (players && players[1 - you]) || "Opponent";
  $("versus-screen").hidden = true;
  $("game-hud").hidden = false;
  setHudMode("versus");
  resetLock(mainLock);
  enterReady({
    needHands: 1,
    label: "Show your hand to get ready ✋",
    onConfirmed: () => {
      readyGate.done = true; // keep the gate showing your hand while we wait
      socket.emit("ready");
      $("ready-status").textContent = "✓ You're ready!";
      $("ready-sub").textContent = "Waiting for your opponent's hand…";
    },
  });
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
  exitReady(); // both players confirmed their hands
  oppName = (s.players && s.players[1 - you]) || "Opponent";
  $("vs-opp-name").textContent = oppName;
  $("versus-screen").hidden = true;
  $("gameover").hidden = true;
  $("game-hud").hidden = false;
  setHudMode("versus");
  musicGame();
  resetVersusHud(s.durationMs);
  runCountdown(Math.max(1, Math.round((s.countdownMs || 3000) / 1000)), () => { netGame.begin(s.gravity); setPauseBtn(true); });
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
  onCombo: (n, gained) => { showCombo(n, gained); sfx.combo(n); },
  onBomb: () => flashBad(),
  onMissed: () => { flashBad(); sfx.miss(); },
  onOver: ({ scores, winner }) => { addXP(scores[you] || 0); showVersusResult(scores, winner, false); },
  onOppBlade: (b) => pushOppBlade(b),
  onOppLeft: () => showVersusResult(netGame ? netGame.scores : [0, 0], null, true),
};
function updateVersusScores(scores) {
  if (!scores) return;
  $("vs-you-score").textContent = scores[you];
  $("vs-opp-score").textContent = scores[1 - you];
}
function showVersusResult(scores, winner, oppLeft) {
  music.stop(); // music stops at the end of a match
  const youS = scores[you], oppS = scores[1 - you];
  let title, reason;
  if (oppLeft) { title = "Opponent left"; reason = "They disconnected — you win by default."; }
  else if (winner === -1) { title = "Tie game!"; reason = "Dead even — rematch?"; }
  else if (winner === you) { title = "You win! 🏆"; reason = "Nice slicing."; sfx.combo(5); }
  else { title = "You lose"; reason = "Get 'em next round."; sfx.gameover(); }
  setPauseBtn(false);
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
  exitKatana();
  mode = "solo";
  bladeMode = "hand";
  $("gameover").hidden = true;
  $("again-btn").textContent = "Play again";
  $("menu-btn").hidden = true;
  $("over-score-lbl").textContent = "Score"; $("over-best-lbl").textContent = "Best";
  $("game-hud").hidden = true;
  setPauseBtn(false);
  setHudMode("solo");
  endSplitView();
  showModeScreen();
}

// ============================ pause / quit-to-menu ============================
// Solo & split truly freeze (timer + sim + music). Versus can't pause a live
// networked match, so its overlay only offers leave-or-keep-playing.
function setPauseBtn(v) { $("pause-btn").hidden = !v; }
function inActiveGame() {
  return (mode === "solo" && game?.playing) ||
         (mode === "split" && splitGame?.playing) ||
         (mode === "versus" && netGame?.playing);
}
function pauseGame() {
  if (paused || readyGate || katGate || !inActiveGame()) return;
  paused = true; pauseStart = performance.now();
  const versus = mode === "versus";
  $("pause-versus-note").hidden = !versus;
  $("pause-resume").textContent = versus ? "Keep playing" : "Resume";
  $("pause-title").textContent = versus ? "Menu" : "Paused";
  if (!versus) music.stop();         // freeze the soundtrack while truly paused
  $("pause-screen").hidden = false;
}
function resumeGame() {
  if (!paused) return;
  const delta = performance.now() - pauseStart;
  if (mode === "solo") soloStartTs += delta;            // don't let the timer jump
  if (mode === "split" && splitGame) { splitGame.endAt += delta; splitGame.startAt += delta; }
  paused = false;
  $("pause-screen").hidden = true;
  if (mode !== "versus") musicGame();
}
function quitToMenu() {
  paused = false;
  $("pause-screen").hidden = true;
  if (mode === "solo" && game) game.playing = false;
  if (mode === "split" && splitGame) splitGame.playing = false;
  backToMenu();                       // tears down the socket in versus
}
$("pause-btn").addEventListener("click", pauseGame);
$("pause-resume").addEventListener("click", resumeGame);
$("pause-quit").addEventListener("click", quitToMenu);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.target.tagName === "INPUT") return;
  if (paused) resumeGame(); else pauseGame();
});

// ============================ split-screen (same-screen 2P) ============================
const splitCallbacks = {
  onTick: ({ timeLeftMs, scores }) => {
    const sec = Math.ceil(timeLeftMs / 1000);
    const t = $("vs-timer"); t.textContent = formatTime(sec); t.classList.toggle("low", sec <= 10);
    $("vs-you-score").textContent = scores[0];
    $("vs-opp-score").textContent = scores[1];
  },
  onOver: ({ scores, winner }) => showSplitResult(scores, winner),
};

function startSplit() {
  mode = "split";
  bladeMode = "hand";
  controller = null; // split is driven directly in tick()
  $("mode-screen").hidden = true;
  $("gameover").hidden = true;
  $("game-hud").hidden = false;
  setHudMode("split");
  musicGame();
  if (!splitGame) splitGame = new SplitGame(scene.renderer, splitCallbacks);
  for (const k of ["left", "right"]) {
    const s = splitSide[k]; s.prev = s.cur = null; s.miss = 0; s.trail.length = 0; s.fx.reset(); s.fy.reset(); resetLock(s);
  }
  $("vs-you-name").textContent = "Player 1";
  $("vs-opp-name").textContent = "Player 2";
  $("vs-you-score").textContent = "0"; $("vs-opp-score").textContent = "0";
  $("vs-timer").textContent = formatTime(splitGame.durationMs / 1000);
  enterReady({
    needHands: 2,
    label: "Both players — show a hand ✋",
    sub: "Player 1 (red) on the left, Player 2 (blue) on the right",
    onConfirmed: () => {
      exitReady();
      // two camera PiPs (P1 bottom-left, P2 bottom-right)
      $("webcam").classList.add("pip-left");
      const w2 = $("webcam2"); w2.srcObject = video.srcObject; w2.hidden = false; w2.play?.();
      runCountdown(3, () => { splitGame.start(); setPauseBtn(true); });
    },
  });
}
function endSplitView() {
  $("webcam").classList.remove("pip-left");
  $("webcam2").hidden = true;
}
function showSplitResult(scores, winner) {
  addXP(Math.max(scores[0], scores[1]));
  setPauseBtn(false);
  musicGameOver();
  $("over-title").textContent = winner === -1 ? "Tie game!" : `Player ${winner + 1} wins! 🏆`;
  $("over-reason").textContent = `Final score — P1 ${scores[0]} · P2 ${scores[1]}`;
  $("over-score").textContent = scores[0]; $("over-score-lbl").textContent = "Player 1";
  $("over-best").textContent = scores[1]; $("over-best-lbl").textContent = "Player 2";
  $("over-progress").hidden = true;
  $("again-btn").textContent = "Rematch";
  $("menu-btn").hidden = false;
  $("gameover").hidden = false;
}

// raw fingertip (normalized) → local pixels of its half (0..W/2 × 0..H)
function mapHalf(hand, side) {
  const W = window.innerWidth, H = window.innerHeight, hw = W / 2;
  const mx = 1 - hand.x; // mirrored full-frame x
  let lf = side === "left" ? mx / 0.5 : (mx - 0.5) / 0.5;
  lf = Math.min(1, Math.max(0, lf));
  const gx = Math.min(1, Math.max(0, 0.5 + (lf - 0.5) * SPLIT_GAIN));
  const gy = Math.min(1, Math.max(0, 0.5 + (hand.y - 0.5) * SPLIT_GAIN));
  return { x: gx * hw, y: gy * H };
}

// Update one side's smoothed blade + lock; returns its slice segment (local) or null.
function updateSplitSide(s, side, chosen, now, dtMs, freq) {
  const off = side === "right" ? Math.floor(window.innerWidth / 2) : 0;
  updateLock(s, chosen);
  let seg = null;
  if (chosen) {
    const raw = mapHalf(chosen, side);
    if (s.miss >= 2) { s.fx.reset(); s.fy.reset(); s.prev = null; }
    s.miss = 0;
    const cur = { x: s.fx.filter(raw.x, freq), y: s.fy.filter(raw.y, freq) };
    if (s.prev) seg = { a: s.prev, b: cur, speed: bladeSpeed(s.prev, cur, dtMs) };
    s.trail.push({ x: cur.x + off, y: cur.y, t: now }); // full-screen for drawing
    s.prev = cur; s.cur = cur;
  } else {
    s.miss++;
    if (s.miss <= COAST_FRAMES && s.cur) s.trail.push({ x: s.cur.x + off, y: s.cur.y, t: now });
    else { s.fx.reset(); s.fy.reset(); s.prev = null; s.cur = null; }
  }
  while (s.trail.length && now - s.trail[0].t > TRAIL_MS) s.trail.shift();
  return seg;
}

// Each side locks onto a hand in its own half (mirrored x), ignoring stray hands.
function handleSplitHands(result, now, dtMs, freq) {
  return {
    l: updateSplitSide(splitSide.left, "left", pickLockedHand(result, splitSide.left, "left"), now, dtMs, freq),
    r: updateSplitSide(splitSide.right, "right", pickLockedHand(result, splitSide.right, "right"), now, dtMs, freq),
  };
}

// ============================ katana / object enrolment ============================
// Hold the object up; we scan for it every frame and, once the detection holds steady,
// offer Approve / Deny. Approving stores the object's appearance AND its angle offset
// from the hand — that offset is what lets tracking fall back to the hand's own
// orientation on the frames where a mirror-finish blade vanishes into the background.
function startKatana() {
  bladeMode = "object";
  $("mode-screen").hidden = true;
  objectBlade.reset();
  objectBlade.load();      // seed with the last approved object, if any
  enterKatana();
}
$("mode-katana").addEventListener("click", startKatana);

function enterKatana() {
  katGate = { locked: false };
  katCand = null;
  const p = video.play && video.play();
  if (p && p.catch) p.catch(() => {});
  $("webcam").classList.remove("pip-left", "cam-off");
  $("webcam").classList.add("cam-ready");
  $("webcam2").hidden = true;
  overlay.classList.add("overlay-top");
  objectBlade.rescan();
  $("kat-actions").hidden = true;
  $("kat-status").textContent = "Wave your blade \u2694";
  $("kat-sub").textContent = "Swing it side to side so we can pick it out";
  $("katana-screen").hidden = false;
}

function exitKatana() {
  if (!katGate) return;
  katGate = null; katCand = null;
  lastVideoTime = -1; lastDetectTs = 0; // force a clean re-detect in the game loop
  $("webcam").classList.remove("cam-ready");
  $("katana-screen").hidden = true;
}

function katanaTick(now) {
  if (!katGate.locked && video.readyState >= 2) {
    // scan() buffers frames and only commits once it has seen enough movement — the
    // wave is what separates the blade from every other long edge in the room.
    const cand = objectBlade.scan(video);
    if (cand) {
      katCand = cand;
      katGate.locked = true;
      $("kat-status").textContent = "Found it \u2014 is this your blade?";
      $("kat-sub").textContent = "The line should sit along the whole blade";
      $("kat-actions").hidden = false;
    } else {
      const pct = Math.round(objectBlade.scanProgress * 100);
      $("kat-sub").textContent = pct < 100
        ? `Keep waving\u2026 ${pct}%`
        : "Nothing long enough found \u2014 try a clearer background";
    }
  }

  octx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawKatanaPreview(katCand);
}

function drawKatanaPreview(cand) {
  const rect = video.getBoundingClientRect();
  if (rect.width < 4) return;
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  octx.save();
  octx.lineCap = "round";
  if (cand) {
    // Same white points you'll play with, drawn on the camera view — so what you
    // approve is literally what cuts.
    const g = mapToCam(cand.gripNorm.x, cand.gripNorm.y, rect, vw, vh);
    const t = mapToCam(cand.tipNorm.x, cand.tipNorm.y, rect, vw, vh);
    octx.shadowColor = "rgba(255, 210, 74, 0.95)";
    octx.fillStyle = "#fff6d8";
    for (let i = 0; i < BLADE_SAMPLES; i++) {
      const k = BLADE_T0 + (1 - BLADE_T0) * (i / (BLADE_SAMPLES - 1));
      const x = g.x + (t.x - g.x) * k, y = g.y + (t.y - g.y) * k;
      octx.shadowBlur = 18;
      octx.beginPath(); octx.arc(x, y, i === BLADE_SAMPLES - 1 ? 10 : 4 + i, 0, Math.PI * 2); octx.fill();
    }
  }
  octx.restore();
}

// two blade trails (P1 yellow / P2 blue) + a center divider
function drawSplitOverlay(now) {
  const W = window.innerWidth, H = window.innerHeight;
  ribbonTrail(splitSide.left.trail, now, "rgba(255,250,230,", "rgba(255,210,74,0.95)");
  ribbonTrail(splitSide.right.trail, now, "rgba(170,220,255,", "rgba(120,200,255,0.95)");
  octx.save();
  octx.strokeStyle = "rgba(255,255,255,0.28)"; octx.lineWidth = 2;
  octx.setLineDash([10, 10]);
  octx.beginPath(); octx.moveTo(W / 2, 0); octx.lineTo(W / 2, H); octx.stroke();
  octx.restore();
}
function ribbonTrail(tr, now, body, tipColor) {
  if (tr.length >= 2) {
    octx.save(); octx.lineCap = "round"; octx.lineJoin = "round"; octx.shadowColor = tipColor;
    for (let i = 1; i < tr.length; i++) {
      const a = tr[i - 1], b = tr[i], k = Math.max(0, 1 - (now - b.t) / TRAIL_MS);
      octx.shadowBlur = 16 * k; octx.lineWidth = 3 + 18 * k;
      octx.strokeStyle = `${body}${0.18 + 0.78 * k})`;
      octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
    }
    octx.restore();
  }
  const p = tr[tr.length - 1];
  if (p) { octx.save(); octx.shadowColor = tipColor; octx.shadowBlur = 22; octx.fillStyle = "#fff";
    octx.beginPath(); octx.arc(p.x, p.y, 10, 0, Math.PI * 2); octx.fill(); octx.restore(); }
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

function drawTip(p, r = 11) {
  if (!p) return;
  octx.save();
  octx.shadowColor = "rgba(255, 210, 74, 0.95)"; octx.shadowBlur = 26;
  octx.fillStyle = "#fff6d8";
  octx.beginPath(); octx.arc(p.x, p.y, r, 0, Math.PI * 2); octx.fill();
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
    get splitGame() { return splitGame; },
    get you() { return you; },
    get readyActive() { return !!readyGate; },
    forceReady() { if (readyGate && !readyGate.done) { readyGate.done = true; readyGate.onConfirmed(); } },
    // inject a synthetic detection (hands = [{x,y}, …] in normalized cam coords; []/null = no hand)
    setHands(hands) {
      const mk = (h) => Array.from({ length: 21 }, (_, i) => (i === 8 ? { x: h.x, y: h.y, z: 0 } : { x: h.x + (i - 8) * 0.004, y: h.y + (i - 8) * 0.012, z: 0 }));
      injectedResult = (hands && hands.length)
        ? { present: true, blade: hands[0], hands: hands.map((h) => ({ x: h.x, y: h.y })), landmarks: mk(hands[0]), allLandmarks: hands.map(mk), handedness: null }
        : { present: false, blade: null, hands: [], landmarks: [], allLandmarks: [], handedness: null };
    },
    clearHands() { injectedResult = null; },
    get mainLock() { return mainLock; },
    get splitLocks() { return { left: splitSide.left, right: splitSide.right }; },
    splitSpawn(side, type) {
      const half = splitGame[side];
      const r = Math.min(half.scene.w, half.scene.h) * 0.06;
      const f = new Fruit(type, { x: half.scene.w / 2, y: half.scene.h / 2, vx: 0, vy: 0, radius: r });
      half.scene.add(f.mesh); half.fruits.push(f);
      return { x: f.x, y: f.y };
    },
    splitSwipe(side, x0, y0, x1, y1) {
      splitGame[side].update(0.016, { a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, speed: 6000 }, performance.now(), false, 0, 1);
    },
    splitState() {
      return { playing: splitGame.playing, left: splitGame.left.score, right: splitGame.right.score, hw: splitGame.left.scene.w };
    },
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
