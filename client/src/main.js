// Camera Fruit Ninja — conductor. Wires camera + hand tracking + Three.js game +
// effects + 2D blade-trail overlay + HUD/screens into one loop.
import { HandTracker } from "./tracking/HandTracker.js";
import { Scene } from "./rendering/scene.js";
import { Effects } from "./rendering/effects.js";
import { Game } from "./game/Game.js";
import { Fruit } from "./game/Fruit.js";
import { bladeSpeed } from "./game/slice.js";
import { OneEuroFilter } from "./tracking/OneEuroFilter.js";
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
let misses = 0;                 // consecutive frames MediaPipe found no hand
const COAST_FRAMES = 8;         // ~250ms: hold the blade through brief dropouts
const trail = [];
const TRAIL_MS = 150;
const _sp = smoothingParams(settings.smoothing);
const cursorFX = new OneEuroFilter(30, _sp.minCutoff, _sp.beta);
const cursorFY = new OneEuroFilter(30, _sp.minCutoff, _sp.beta);

// split-screen (2 players, 2 hands) state — one object per side
let splitGame = null;
const SPLIT_GAIN = 1.35;
const splitSide = {
  left:  { fx: new OneEuroFilter(30, _sp.minCutoff, _sp.beta), fy: new OneEuroFilter(30, _sp.minCutoff, _sp.beta), prev: null, cur: null, miss: 0, trail: [] },
  right: { fx: new OneEuroFilter(30, _sp.minCutoff, _sp.beta), fy: new OneEuroFilter(30, _sp.minCutoff, _sp.beta), prev: null, cur: null, miss: 0, trail: [] },
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

// ---------- start ----------
$("start-btn").addEventListener("click", start);
$("again-btn").addEventListener("click", () => {
  $("gameover").hidden = true;
  if (mode === "versus") { netGame.clear(); socket.emit("rematch"); }
  else if (mode === "split") { splitGame.clear(); music.setIntensity(0.6); runCountdown(3, () => splitGame.start()); }
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
    music.resume();
    music.setMuted(localStorage.getItem("fn_music") === "off");
    music.start();
    music.setIntensity(0.22);
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
  onStart() { soloStartTs = performance.now(); music.setIntensity(0); },
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
    sfx.gameover();
    music.setIntensity(0.15);
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
  music.setIntensity(0.22);
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
  music.setIntensity(0.6);
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
  endSplitView();
  showModeScreen();
}

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
  controller = null; // split is driven directly in tick()
  $("mode-screen").hidden = true;
  $("gameover").hidden = true;
  $("game-hud").hidden = false;
  setHudMode("split");
  music.setIntensity(0.6);
  if (!splitGame) splitGame = new SplitGame(scene.renderer, splitCallbacks);
  // two camera PiPs (P1 bottom-left, P2 bottom-right)
  $("webcam").classList.add("pip-left");
  const w2 = $("webcam2"); w2.srcObject = video.srcObject; w2.hidden = false; w2.play?.();
  // reset per-side state
  for (const k of ["left", "right"]) {
    const s = splitSide[k]; s.prev = s.cur = null; s.miss = 0; s.trail.length = 0; s.fx.reset(); s.fy.reset();
  }
  $("vs-you-name").textContent = "Player 1";
  $("vs-opp-name").textContent = "Player 2";
  $("vs-you-score").textContent = "0"; $("vs-opp-score").textContent = "0";
  $("vs-timer").textContent = formatTime(splitGame.durationMs / 1000);
  runCountdown(3, () => splitGame.start());
}
function endSplitView() {
  $("webcam").classList.remove("pip-left");
  $("webcam2").hidden = true;
}
function showSplitResult(scores, winner) {
  addXP(Math.max(scores[0], scores[1]));
  music.setIntensity(0.2);
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

// Update one side's smoothed blade; returns its slice segment (local coords) or null.
function updateSplitSide(s, side, hand, now, dtMs, freq) {
  const off = side === "right" ? Math.floor(window.innerWidth / 2) : 0;
  let seg = null;
  if (hand) {
    const raw = mapHalf(hand, side);
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

// Assign the two detected hands to sides by mirrored x; update both; return segments.
function handleSplitHands(result, now, dtMs, freq) {
  const hands = result.present ? result.hands : [];
  let leftHand = null, rightHand = null;
  for (const h of hands) {
    const mx = 1 - h.x;
    if (mx < 0.5) { if (!leftHand) leftHand = h; }
    else if (!rightHand) rightHand = h;
  }
  return {
    l: updateSplitSide(splitSide.left, "left", leftHand, now, dtMs, freq),
    r: updateSplitSide(splitSide.right, "right", rightHand, now, dtMs, freq),
  };
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

  let segment = null, splitSegLeft = null, splitSegRight = null;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const dtMs = lastDetectTs ? now - lastDetectTs : 33;
    const freq = dtMs > 0 ? 1000 / dtMs : 30;
    lastDetectTs = now;

    const result = tracker.detect(video, now);
    if (DEBUG) updateHud(result, now);
    lastResult = result;

    if (mode === "split") {
      const segs = handleSplitHands(result, now, dtMs, freq);
      splitSegLeft = segs.l; splitSegRight = segs.r;
    } else if (result.present && result.blade) {
      const raw = mapPoint(result.blade.x, result.blade.y);
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
      // v2: coast through brief MediaPipe dropouts instead of dropping the blade
      // (the #1 cause of "it works then it won't"). Hold the last position for a
      // few frames so momentary losses are invisible; only truly drop after that.
      misses++;
      if (misses <= COAST_FRAMES && bladeCur) {
        trail.push({ x: bladeCur.x, y: bladeCur.y, t: now }); // keep the blade alive
      } else {
        cursorFX.reset(); cursorFY.reset();
        bladePrev = null; bladeCur = null;
      }
    }
    updateHandHint(now);
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

  if (mode === "split") {
    if (splitGame) { splitGame.update(dt, splitSegLeft, splitSegRight); splitGame.render(); }
  } else {
    if (controller) controller.update(dt, segment);
    if (scene) scene.render();
  }
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
  // music on/off
  const musicOn = localStorage.getItem("fn_music") !== "off";
  $("set-music").checked = musicOn;
  $("set-music").onchange = (e) => {
    localStorage.setItem("fn_music", e.target.checked ? "on" : "off");
    music.setMuted(!e.target.checked);
  };
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
  if (mode === "split") { drawSplitOverlay(now); return; }
  if (showSkeleton && lastResult.present) drawSkeleton(lastResult.landmarks);
  if (mode === "versus") drawOppTrail(now);
  drawTrail(now);
  drawTip();
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
    get splitGame() { return splitGame; },
    get you() { return you; },
    splitSpawn(side, type) {
      const half = splitGame[side];
      const r = Math.min(half.scene.w, half.scene.h) * 0.06;
      const f = new Fruit(type, { x: half.scene.w / 2, y: half.scene.h / 2, vx: 0, vy: 0, radius: r });
      half.scene.add(f.mesh); half.fruits.push(f);
      return { x: f.x, y: f.y };
    },
    splitSwipe(side, x0, y0, x1, y1) {
      splitGame[side].update(0.016, { a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, speed: 6000 }, performance.now(), false);
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
