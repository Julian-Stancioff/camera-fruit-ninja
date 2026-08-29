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
let bladeSeen = null;            // the blade as detected, normalized cam coords, for the PiP
let bladeConf = 1;               // detector confidence; low means we are coasting on prediction
let bladeSamplesPrev = null;     // previous frame's sample points along the blade
let paused = false, pauseStart = 0;       // pause / quit-to-menu
const oppTrail = [];

// Tunable feel — overridable via URL (?gain=2.2&mincut=1.0&beta=0.02&debug) so we
// can dial it in on the live site without a redeploy.
const PARAMS = new URLSearchParams(location.search);
const DEBUG = PARAMS.has("debug");
// ?katdebug — lets a remote session watch katana tracking on the REAL camera: it logs
// the detector's state at 4Hz and keeps the last ~1.5s of downscaled frames so they can
// be pulled out and replayed offline. Every fix so far has been tuned against a guessed
// synthetic room and then failed in the real one; this is how we tune against the truth.
const KATDEBUG = PARAMS.has("katdebug");
let dbgCanvas = null, dbgCtx = null, lastKatLog = 0, lastKatGrab = 0;
const dbgFrames = [];
function katDebugCapture(now) {
  if (now - lastKatGrab < 90) return;   // ~11Hz: 16 frames covers ~1.5s
  lastKatGrab = now;
  if (!dbgCtx) {
    dbgCanvas = document.createElement("canvas");
    dbgCanvas.width = 192; dbgCanvas.height = 108;
    dbgCtx = dbgCanvas.getContext("2d", { willReadFrequently: true });
  }
  try {
    dbgCtx.drawImage(video, 0, 0, 192, 108);
    dbgFrames.push(dbgCanvas.toDataURL("image/png"));
    if (dbgFrames.length > 16) dbgFrames.shift();
  } catch { /* undecoded frame */ }
}
// Pulled by the remote session to replay this exact camera offline.
window.__katGrab = () => dbgFrames.slice();
window.__katInfo = () => ({ frames: dbgFrames.length, mode: bladeMode, playing: inActiveGame() });
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
    // Blade length CAP, as a fraction of screen height (×2.2 in clampBlade). The
    // on-screen blade is the real mapped sword; the cap just stops a sword held close
    // to the camera sweeping the whole screen and slicing everything at once.
    bladeLen: clamp(s.bladeLen ?? 0.2, 0.1, 0.35),
  };
}
function saveSettings() { localStorage.setItem("fn_settings", JSON.stringify(settings)); }
// More smoothing → lower cutoff + lower beta (smoother, slightly more lag).
function smoothingParams(s) { return { minCutoff: lerp(2.0, 0.8, s), beta: lerp(0.045, 0.004, s) }; }
// Object mode feeds an already-stabilised blade through these filters, so smoothing it as
// heavily as a raw fingertip only buys lag. A much larger beta lets a swing through while
// leaving a resting blade just as steady.
function objectSmoothing(s) { const p = smoothingParams(s); return { minCutoff: p.minCutoff, beta: p.beta * 6 }; }

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
// Object mode tracks a full segment: the grip runs through cursorFX/FY above, the tip
// through its own pair — both ends smoothed, or the blade jitters end-over-end.
// Push the current smoothing settings into the live filters, using the livelier
// object-mode curve while a physical blade is driving them.
function applySmoothing() {
  const p = bladeMode === "object" ? objectSmoothing(settings.smoothing) : smoothingParams(settings.smoothing);
  for (const f of [cursorFX, cursorFY, tipFX, tipFY]) { f.minCutoff = p.minCutoff; f.beta = p.beta; }
}
const tipFX = new OneEuroFilter(30, _sp.minCutoff, _sp.beta);
const tipFY = new OneEuroFilter(30, _sp.minCutoff, _sp.beta);

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
// The blade IS the detected segment: both endpoints go through mapPoint (gain +
// selfie mirror) exactly like a fingertip, so swinging the sword across the frame
// moves the whole blade — and the tip dot — across the screen. (The old synthetic
// blade mapped only the grip and rebuilt the tip from angle × a fixed length, which
// is why the dot barely travelled sideways.) The one piece of synthesis left is a
// length cap: mapPoint's gain can stretch a sword held close to the camera across
// the whole screen, and a blade that long slices everything at once. #set-blade
// drives the cap. Trimming takes the HILT side — the dot must stay on the real tip.
function clampBlade(grip, tip) {
  const maxL = settings.bladeLen * 2.2 * window.innerHeight; // ponytail: 2.2 tuned by eye; expose if reach feels wrong
  const dx = grip.x - tip.x, dy = grip.y - tip.y;
  const L = Math.hypot(dx, dy);
  if (L <= maxL) return { grip, tip };
  const k = maxL / L;
  return { grip: { x: tip.x + dx * k, y: tip.y + dy * k }, tip };
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
    startVideoFrames();
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
  applySmoothing();
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
  applySmoothing();
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
  $("kat-status").textContent = "Hold your blade up \u2694";
  $("kat-sub").textContent = "Looking for it\u2026";
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
      // Mapped — straight into the countdown, no approval click.
      katGate.locked = true;
      objectBlade.accept(cand);
      exitKatana();
      startSolo();
      return;
    } else {
      $("kat-sub").textContent = "Point it up, clear of your body";
    }
  }

  if (KATDEBUG) {
    katDebugCapture(now);
    if (now - lastKatLog > 250) {
      lastKatLog = now;
      console.log("[kat] " + JSON.stringify({ phase: "searching", seen: objectBlade.lastSeen ? 1 : 0 }));
    }
  }
  octx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawKatanaPreview(katCand);
  if (objectBlade.lastSeen) drawBladeOnPip(objectBlade.lastSeen, video);
}

// Dots along the detected blade, mapped onto a camera element. Same white light the
// game uses, so what shows on the feed is exactly what cuts.
function drawBladeOnPip(ends, videoEl) {
  const rect = videoEl.getBoundingClientRect();
  if (rect.width < 4) return;
  const vw = videoEl.videoWidth || 1280, vh = videoEl.videoHeight || 720;
  const a = mapToCam(ends[0].x, ends[0].y, rect, vw, vh);
  const b = mapToCam(ends[1].x, ends[1].y, rect, vw, vh);
  octx.save();
  octx.lineCap = "round";
  octx.strokeStyle = "rgba(255,250,230,0.55)"; octx.lineWidth = 2;
  octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  octx.shadowColor = "rgba(255, 210, 74, 0.95)"; octx.fillStyle = "#fff6d8";
  for (let i = 0; i <= 5; i++) {
    const k = i / 5;
    octx.shadowBlur = 12;
    octx.beginPath();
    octx.arc(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, i === 5 ? 7 : 3.5, 0, Math.PI * 2);
    octx.fill();
  }
  octx.restore();
}

function drawKatanaPreview(cand) {
  const rect = video.getBoundingClientRect();
  if (rect.width < 4) return;
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  octx.save();
  octx.lineCap = "round";
  if (cand) {
    const g = mapToCam(cand.gripNorm.x, cand.gripNorm.y, rect, vw, vh);
    const t = mapToCam(cand.tipNorm.x, cand.tipNorm.y, rect, vw, vh);
    octx.shadowColor = "#8fe3ff"; octx.shadowBlur = 18;
    octx.strokeStyle = "#8fe3ff"; octx.lineWidth = 6;
    octx.beginPath(); octx.moveTo(g.x, g.y); octx.lineTo(t.x, t.y); octx.stroke();
    octx.fillStyle = "#fff";
    octx.beginPath(); octx.arc(t.x, t.y, 7, 0, Math.PI * 2); octx.fill();
  }
  octx.restore();
}

$("kat-accept").addEventListener("click", () => {
  if (!katCand) return;
  objectBlade.accept(katCand);
  exitKatana();
  startSolo();
});
$("kat-deny").addEventListener("click", () => {
  katGate.locked = false; katCand = null;
  objectBlade.rescan();
  $("kat-actions").hidden = true;
  $("kat-status").textContent = "Try again \u2694";
  $("kat-sub").textContent = "Move it against a clearer part of the room";
});
$("kat-skip").addEventListener("click", () => {
  bladeMode = "hand";
  exitKatana();
  startSolo();
});

// ============================ hand-confirmation "ready" gate ============================
// Before a match: show the camera big, draw the live hand skeleton in colour, and
// only proceed once the required hand(s) are seen for ~0.6s. needHands 2 (split)
// requires one hand on each side; otherwise any one hand.
function enterReady({ needHands, label, sub, onConfirmed }) {
  readyGate = { needHands, onConfirmed, okSince: 0, done: false };
  readyResult = null;                 // clear stale detection from a previous gate
  const p = video.play && video.play(); // ensure the stream is advancing
  if (p && p.catch) p.catch(() => {});
  $("webcam").classList.remove("pip-left");
  $("webcam").classList.add("cam-ready");
  $("webcam").classList.remove("cam-off");
  $("webcam2").hidden = true;
  overlay.classList.add("overlay-top");
  $("ready-status").innerHTML = label;
  $("ready-sub").textContent = sub || "";
  $("ready-screen").hidden = false;
}
function exitReady() {
  readyGate = null;
  lastVideoTime = -1; lastDetectTs = 0; // force the game loop to re-detect cleanly
  $("webcam").classList.remove("cam-ready");
  // overlay stays at overlay-top so the in-game PiP hand-mapping draws above the camera
  $("ready-screen").hidden = true;
}

function readyTick(now) {
  // Detect every frame here (self-contained, no shared guard) so the gate always
  // re-acquires the hand — even on the 2nd, 3rd… game.
  if (video.readyState >= 2) readyResult = tracker.detect(video, now);
  const hands = readyResult?.present ? readyResult.hands : [];
  let okNow;
  if (readyGate.needHands === 2) {
    let l = false, r = false;
    for (const h of hands) { const mx = 1 - h.x; if (mx < 0.5) l = true; else r = true; }
    okNow = l && r;
    $("ready-sub").textContent = okNow ? "✓ Both hands detected!" : "Each player: hold one hand up in view";
  } else {
    okNow = hands.length >= 1;
    $("ready-sub").textContent = okNow ? "✓ Hand detected!" : "Hold your hand up in view";
  }
  if (okNow) { if (!readyGate.okSince) readyGate.okSince = now; }
  else readyGate.okSince = 0;

  if (okNow && readyGate.okSince && now - readyGate.okSince > 600 && !readyGate.done) {
    readyGate.done = true;
    readyGate.onConfirmed();
    return;
  }
  // draw
  octx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawReadyDots(readyResult);
}

function mapToCam(nx, ny, rect, vw, vh) {
  const s = Math.max(rect.width / vw, rect.height / vh);
  const dispW = vw * s, dispH = vh * s;
  const localX = nx * dispW + (rect.width - dispW) / 2; // unmirrored within rect
  return { x: rect.left + (rect.width - localX), y: rect.top + ny * dispH + (rect.height - dispH) / 2 };
}
function drawReadyDots(result) {
  if (!result?.present) return;
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  for (const hand of (result.allLandmarks || [])) {
    const mx = 1 - hand[8].x;
    const color = readyGate.needHands === 2 ? (mx < 0.5 ? "#ff5a5a" : "#5aa0ff") : "#ffd24a";
    octx.save();
    octx.strokeStyle = color; octx.fillStyle = color; octx.lineWidth = 3; octx.globalAlpha = 0.92;
    octx.shadowColor = color; octx.shadowBlur = 8;
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = mapToCam(hand[a].x, hand[a].y, rect, vw, vh), pb = mapToCam(hand[b].x, hand[b].y, rect, vw, vh);
      octx.beginPath(); octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y); octx.stroke();
    }
    for (let i = 0; i < hand.length; i++) {
      const p = mapToCam(hand[i].x, hand[i].y, rect, vw, vh);
      octx.beginPath(); octx.arc(p.x, p.y, i === 8 ? 7 : 4, 0, Math.PI * 2); octx.fill();
    }
    octx.restore();
  }
}

// ---------- loop ----------
// rAF render loop → smooth 60fps fruit + trail. Hand detection runs only on a new
// camera frame (~30fps) via the currentTime guard inside tick(), so the game never
// looks choppy even though the camera is 30fps.
// requestVideoFrameCallback fires when a camera frame is actually presented, and hands
// back its timing. That is strictly better than watching video.currentTime from inside the
// rAF loop: no frame is ever missed or processed twice, and metadata.presentationTime tells
// us how stale the frame already is when we get it — the pipeline latency that makes a fast
// blade trail. Falls back to the currentTime check where the API is missing.
let vfcPending = false, vfcLatency = 0, lastVfc = 0;
function startVideoFrames() {
  if (!video.requestVideoFrameCallback) return;
  const onFrame = (now, meta) => {
    vfcPending = true;
    lastVfc = now;
    if (meta && meta.presentationTime) vfcLatency = Math.max(0, Math.min(150, now - meta.presentationTime));
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}
// If the callback ever stops arriving — a paused element, a swapped stream, a browser
// quirk — detection would silently never run again and the game would look frozen. Fall
// back to the old currentTime check rather than trusting one API to keep firing.
function vfcHealthy(now) { return !!video.requestVideoFrameCallback && now - lastVfc < 500; }
window.__katLatency = () => vfcLatency;

function startLoop() {
  const onRaf = (now) => { if (!running) return; tick(now); requestAnimationFrame(onRaf); };
  requestAnimationFrame(onRaf);
}

function tick(now) {
  const dt = lastTickTs ? Math.min((now - lastTickTs) / 1000, 0.05) : 0.016;
  lastTickTs = now;

  if (katGate) { katanaTick(now); return; }  // object-enrolment gate owns the frame
  if (readyGate) { readyTick(now); return; } // hand-confirmation gate owns the frame

  // Paused (solo & split only) — hold the frame: keep painting but advance nothing.
  // Versus can't freeze a live networked match, so it keeps running under its overlay.
  if (paused && mode !== "versus") {
    if (mode === "split") splitGame?.render(); else if (scene) scene.render();
    drawOverlay(now);
    return;
  }

  let segment = null, splitSegLeft = null, splitSegRight = null;
  const freshFrame = vfcHealthy(now)
    ? vfcPending
    : (video.readyState >= 2 && video.currentTime !== lastVideoTime);
  if (injectedResult || (video.readyState >= 2 && freshFrame)) {
    vfcPending = false;
    lastVideoTime = video.currentTime;
    const dtMs = lastDetectTs ? now - lastDetectTs : 33;
    const freq = dtMs > 0 ? 1000 / dtMs : 30;
    lastDetectTs = now;

    if (bladeMode === "object") {
      // Katana mode watches the OBJECT and nothing else — the hand model never runs,
      // which also hands the frame back the ~10ms MediaPipe was costing. mainLock is
      // reused purely as presence bookkeeping so the lost-hint and the fruit slowdown
      // keep working unchanged; it holds no landmarks here.
      const ob = objectBlade.update(video, dtMs);
      bladeSeen = ob ? ob.endsNorm : null;
      bladeConf = ob ? (ob.conf ?? 1) : 0;
      if (KATDEBUG) {
        katDebugCapture(now);
        if (now - lastKatLog > 250) {
          lastKatLog = now;
          console.log("[kat] " + JSON.stringify(ob
            ? { found: 1, deg: +(ob.angle * 180 / Math.PI).toFixed(1), conf: +(ob.conf || 0).toFixed(2),
                ends: ob.endsNorm.map((e) => [+e.x.toFixed(3), +e.y.toFixed(3)]) }
            : { found: 0 }));
        }
      }
      updateLock(mainLock, ob ? { x: ob.gripNorm.x, y: ob.gripNorm.y, lm: null } : null);
      if (ob) {
        // Map the REAL endpoints — each one individually through mapPoint, never one
        // point plus a rotated offset, or the mirror breaks the geometry.
        const rawG = mapPoint(ob.endsNorm[0].x, ob.endsNorm[0].y);
        const rawT = mapPoint(ob.endsNorm[1].x, ob.endsNorm[1].y);
        if (misses >= 2) { cursorFX.reset(); cursorFY.reset(); tipFX.reset(); tipFY.reset(); bladeSamplesPrev = null; }
        misses = 0;
        const cur = { x: cursorFX.filter(rawG.x, freq), y: cursorFY.filter(rawG.y, freq) };
        const tip = { x: tipFX.filter(rawT.x, freq), y: tipFY.filter(rawT.y, freq) };
        bladeLine = clampBlade(cur, tip);
        const samples = bladeSamples(bladeLine);
        // One segment per point along the blade — Game gates each on its own speed.
        if (bladeSamplesPrev) {
          segment = samples.map((b, i) =>
            ({ a: bladeSamplesPrev[i], b, speed: bladeSpeed(bladeSamplesPrev[i], b, dtMs) }));
        }
        bladeSamplesPrev = samples;
        trail.push({ x: bladeLine.tip.x, y: bladeLine.tip.y, t: now });
        bladePrev = cur; bladeCur = cur;
      } else {
        misses++;
        if (misses <= COAST_FRAMES && bladeLine) trail.push({ x: bladeLine.tip.x, y: bladeLine.tip.y, t: now });
        else {
          cursorFX.reset(); cursorFY.reset(); tipFX.reset(); tipFY.reset();
          bladePrev = null; bladeCur = null;
          bladeLine = null; bladeSamplesPrev = null;
        }
      }
      updateHandHint(now);
      lastResult = { present: false, landmarks: [] }; // nothing to draw a skeleton from
    } else {
    const result = injectedResult || tracker.detect(video, now);
    if (DEBUG) updateHud(result, now);
    lastResult = result;

    if (mode === "split") {
      const segs = handleSplitHands(result, now, dtMs, freq);
      splitSegLeft = segs.l; splitSegRight = segs.r;
    } else {
      const blade = pickLockedHand(result, mainLock, null);
      updateLock(mainLock, blade);
      if (blade) {
        lastRawBlade = blade;
        const raw = mapPoint(blade.x, blade.y);
        // Reacquire after a multi-frame gap: snap the filter to the new point and
        // don't form a slice segment this frame (avoids a ghost slice across the gap).
        if (misses >= 2) { cursorFX.reset(); cursorFY.reset(); bladePrev = null; }
        misses = 0;
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
        // coast through brief MediaPipe dropouts instead of dropping the blade.
        misses++;
        if (misses <= COAST_FRAMES && bladeCur) {
          trail.push({ x: bladeCur.x, y: bladeCur.y, t: now });
        } else {
          cursorFX.reset(); cursorFY.reset();
          bladePrev = null; bladeCur = null;
        }
      }
    }
    updateHandHint(now);
    }
  }
  while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();

  // Solo: count-up timer + music that intensifies with time/score.
  if (mode === "solo" && game && game.playing) {
    const el = (now - soloStartTs) / 1000;
    $("solo-timer").textContent = formatTime(el);
    if (now - lastMusicTs > 400) {
      music.setIntensity(Math.min(1, el / 90 + game.score.score / 500));
      lastMusicTs = now;
    }
  }

  // Ease slow factors every frame, then drive the game with per-side dt scaling so
  // fruit slow to a crawl on whichever side just lost its hand.
  easeSlow(mainLock); easeSlow(splitSide.left); easeSlow(splitSide.right);
  if (mode === "split") {
    if (splitGame) { splitGame.update(dt, splitSegLeft, splitSegRight, splitSide.left.slow, splitSide.right.slow); splitGame.render(); }
  } else {
    if (controller) controller.update(dt * mainLock.slow, segment);
    if (scene) scene.render();
  }
  drawOverlay(now);
}

let lastResult = { present: false, landmarks: [] };
let injectedResult = null; // test hook: forces a synthetic detection result when set
function updateHud(result, now) {
  const d = now - lastFrameTs;
  lastFrameTs = now;
  if (d > 0) fps = fps ? fps * 0.9 + (1000 / d) * 0.1 : 1000 / d;
  $("hud-fps").textContent = `${Math.round(fps)} fps`;
  const t = $("hud-track");
  if (result.present) { t.textContent = "● tracked"; t.className = "hud-pill ok"; }
  else { t.textContent = "● searching…"; t.className = "hud-pill lost"; }
}

// "Bring your hand back" prompt — solo/versus centered, split per-side. Driven purely
// by the lock's presence, so it vanishes the instant the hand is detected again (and
// only reappears if the hand disappears once more).
function updateHandHint() {
  if (mode === "split") {
    $("hand-hint").classList.remove("show");
    const playing = !!splitGame?.playing;
    $("hand-hint-l").classList.toggle("show", playing && splitSide.left.lost);
    $("hand-hint-r").classList.toggle("show", playing && splitSide.right.lost);
  } else {
    $("hand-hint-l").classList.remove("show");
    $("hand-hint-r").classList.remove("show");
    $("hand-hint").textContent = bladeMode === "object" ? "⚔ Bring your blade back" : "✋ Bring your hand back";
    $("hand-hint").classList.toggle("show", inActiveGame() && mainLock.lost);
  }
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
    settings.smoothing = parseFloat(smooth.value);
    applySmoothing();
    saveSettings(); upd();
  };
  const bladeEl = $("set-blade");
  const updBlade = () => { $("set-blade-val").textContent = `${Math.round(settings.bladeLen * 100)}%`; };
  bladeEl.value = settings.bladeLen;
  updBlade();
  bladeEl.oninput = () => { settings.bladeLen = parseFloat(bladeEl.value); saveSettings(); updBlade(); };
  $("set-reset").onclick = () => {
    sens.value = 1.8; smooth.value = 0.6; bladeEl.value = 0.2;
    sens.oninput(); smooth.oninput(); bladeEl.oninput();
  };
  // music volume sliders (separate menu / in-game); moving either previews it live
  const menuv = $("set-menuvol"), gamev = $("set-gamevol");
  menuv.value = localStorage.getItem("fn_menu_vol") ?? "0.7";
  gamev.value = localStorage.getItem("fn_game_vol") ?? "0.7";
  const updVols = () => {
    $("set-menuvol-val").textContent = `${Math.round(menuv.value * 100)}%`;
    $("set-gamevol-val").textContent = `${Math.round(gamev.value * 100)}%`;
  };
  updVols();
  menuv.oninput = () => { localStorage.setItem("fn_menu_vol", menuv.value); music.setVolume(parseFloat(menuv.value)); updVols(); };
  gamev.oninput = () => { localStorage.setItem("fn_game_vol", gamev.value); music.setVolume(parseFloat(gamev.value)); updVols(); };
  $("settings-btn").onclick = () => { $("settings-panel").hidden = !$("settings-panel").hidden; };

  // background theme picker
  const applyBg = (theme) => {
    $("dojo").className = `bg-${theme}`;
    document.querySelectorAll("#bg-options .bg-opt").forEach((b) =>
      b.classList.toggle("sel", b.dataset.bg === theme));
    localStorage.setItem("fn_bg", theme);
  };
  document.querySelectorAll("#bg-options .bg-opt").forEach((b) =>
    (b.onclick = () => applyBg(b.dataset.bg)));
  applyBg(localStorage.getItem("fn_bg") || "dojo");
}
wireSettings();
renderLevel();

$("mode-split").addEventListener("click", startSplit);

// ---------- 2D overlay: blade trail + debug skeleton ----------
function drawOverlay(now) {
  octx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (mode === "split") {
    drawSplitOverlay(now);
    if (splitGame?.playing) {
      if (splitSide.left.present) drawHandOnPip(splitSide.left.landmarks, $("webcam"), "rgba(255,150,150,0.7)", "#ff5a5a");
      if (splitSide.right.present) drawHandOnPip(splitSide.right.landmarks, $("webcam2"), "rgba(150,190,255,0.7)", "#5aa0ff");
    }
    return;
  }
  if (showSkeleton && lastResult.present) drawSkeleton(lastResult.landmarks);
  if (mode === "versus") drawOppTrail(now);
  drawTrail(now);
  if (bladeMode === "object" && bladeLine) {
    // Same white fingertip light as hand mode, one per cutting point along the blade —
    // biggest at the tip so it reads as a blade rather than a row of dots.
    const pts = bladeSamples(bladeLine);
    for (let i = 0; i < pts.length - 1; i++) drawTip(pts[i], 5 + i);
    drawTip(bladeLine.tip, 11);
  } else drawTip(bladeCur);
  // The blade as the camera sees it, drawn on the PiP — the "is it mapped?" readout,
  // and the object-mode equivalent of the hand skeleton.
  if (bladeMode === "object" && bladeSeen) drawBladeOnPip(bladeSeen, $("webcam"));
  if (inActiveGame() && mainLock.present && mainLock.landmarks)
    drawHandOnPip(mainLock.landmarks, $("webcam"), "rgba(255,236,180,0.7)", "#ffd24a");
}

// Draw a hand's 21 landmarks onto a camera PiP (full skeleton faint + the index
// finger to the tip emphasized — the "blade" finger). landmarks are normalized to
// the full camera frame; mapToCam handles the PiP's cover-scale + mirror.
function drawHandOnPip(landmarks, videoEl, baseColor, indexColor) {
  if (!landmarks || !videoEl) return;
  const rect = videoEl.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;
  const vw = videoEl.videoWidth || 1280, vh = videoEl.videoHeight || 720;
  octx.save();
  octx.lineCap = "round"; octx.lineJoin = "round";
  octx.strokeStyle = baseColor; octx.fillStyle = baseColor; octx.lineWidth = 2; octx.globalAlpha = 0.9;
  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = mapToCam(landmarks[a].x, landmarks[a].y, rect, vw, vh);
    const pb = mapToCam(landmarks[b].x, landmarks[b].y, rect, vw, vh);
    octx.beginPath(); octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y); octx.stroke();
  }
  for (let i = 0; i < landmarks.length; i++) {
    const p = mapToCam(landmarks[i].x, landmarks[i].y, rect, vw, vh);
    octx.beginPath(); octx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); octx.fill();
  }
  octx.strokeStyle = indexColor; octx.fillStyle = indexColor; octx.lineWidth = 3.5;
  octx.shadowColor = indexColor; octx.shadowBlur = 7;
  for (const [a, b] of [[5, 6], [6, 7], [7, 8]]) {
    const pa = mapToCam(landmarks[a].x, landmarks[a].y, rect, vw, vh);
    const pb = mapToCam(landmarks[b].x, landmarks[b].y, rect, vw, vh);
    octx.beginPath(); octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y); octx.stroke();
  }
  const tip = mapToCam(landmarks[8].x, landmarks[8].y, rect, vw, vh);
  octx.beginPath(); octx.arc(tip.x, tip.y, 5, 0, Math.PI * 2); octx.fill();
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
