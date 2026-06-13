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
  resetHud();
  game.reset();
  game.start();
});
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
    game = new Game(scene, effects, callbacks);
    resizeAll();

    sfx.resume();
    $("start-screen").classList.add("gone");
    $("game-hud").hidden = false;
    if (DEBUG) $("hud").hidden = false; // dev HUD only with ?debug
    resetHud();
    running = true;
    game.start();
    startLoop();
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
    $("over-reason").textContent = reason === "bomb" ? "💥 You sliced a bomb!" : "You ran out of lives.";
    $("over-score").textContent = score;
    $("over-best").textContent = best;
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
    } else {
      cursorFX.reset(); cursorFY.reset();
      bladePrev = null; bladeCur = null;
    }
    updateHandHint(now);
  }
  while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();

  if (game) game.update(dt, segment);
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
  drawTrail(now);
  drawTip();
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
