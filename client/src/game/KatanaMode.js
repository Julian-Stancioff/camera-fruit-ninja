// Katana mode: the ?tipprobe harness, verbatim, with the game drawn on top.
//
// The probe (src/debug/tipProbe.js) is the ONE thing proven to track the real sword on
// the real camera. Four game integrations died by "improving" its tracking — rAF timing,
// smoothing, re-enrolls, confidence gates, a 1.8x mapping gain. So the tracking path
// below is a line-for-line copy of the probe: 60ms setInterval, 192x108 work canvas,
// one enroll, detect(px, SW, SH, model, prev) with prev threaded, nothing else.
// Fruit, trail, and score are painted onto the SAME 6x canvas the probe uses, so the
// tip maps to game space as (x*Z, y*Z) — exactly the probe's crosshair math, no gain.
import * as detector from "../tracking/detectTip.js";
import { FruitSpawner } from "./FruitSpawner.js";
import { ScoreManager } from "./ScoreManager.js";
import { segmentHitsCircle } from "./slice.js";

const SW = 192, SH = 108, Z = 6;
const W = SW * Z, H = SH * Z;
const TRAIL_MS = 150;               // same fade as the fingertip trail in main.js
const GRAVITY = H * 1.8;            // same floaty arc as Game.js

// Flat 2D palette instead of the three.js meshes — fewer moving parts on this canvas.
const LOOKS = {
  watermelon: { skin: "#2f7a2a", flesh: "#ff5a6a", juice: "#ff3b53" },
  apple:      { skin: "#e22b2b", flesh: "#fff2d6", juice: "#f6d36b" },
  orange:     { skin: "#ff8c1a", flesh: "#ffa83a", juice: "#ff9b2f" },
  lemon:      { skin: "#ffd93b", flesh: "#fff07a", juice: "#ffe34a" },
  strawberry: { skin: "#e83a4e", flesh: "#ff7d86", juice: "#ff3b53" },
  kiwi:       { skin: "#6b4a28", flesh: "#88c540", juice: "#9ad84f" },
  pineapple:  { skin: "#e8b23a", flesh: "#ffe27a", juice: "#ffd24a" },
};

export function startKatanaMode(video, onExit) {
  document.querySelectorAll(".katana-rig").forEach((e) => e.remove());
  const rig = document.createElement("div");
  rig.className = "katana-rig";
  rig.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:#07070b;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:flex-start;gap:10px;padding:12px 0 40px;overflow:auto;" +
    "font:800 clamp(18px,2.6vw,34px) system-ui;color:#fff;text-align:center";
  rig.innerHTML =
    '<div class="km-msg" style="padding:0 20px">Starting…</div>' +
    '<div class="km-sub" style="font-size:0.55em;font-weight:600;color:#8fe3ff"></div>' +
    '<canvas class="km-cv" style="border-radius:12px;max-width:92vw;height:auto"></canvas>' +
    '<div style="display:flex;gap:14px">' +
    '<button class="km-replay" hidden style="font:800 18px system-ui;padding:10px 22px;border-radius:10px;border:0;background:#3fae3a;color:#fff;cursor:pointer">Play again</button>' +
    '<button class="km-exit" style="font:800 18px system-ui;padding:10px 22px;border-radius:10px;border:0;background:#333;color:#fff;cursor:pointer">Exit</button>' +
    "</div>";
  document.body.appendChild(rig);

  const msgEl = rig.querySelector(".km-msg"), subEl = rig.querySelector(".km-sub");
  const say = (m, s) => { msgEl.textContent = m; subEl.textContent = s; };

  const view = rig.querySelector(".km-cv");
  view.width = W; view.height = H;
  const vg = view.getContext("2d");
  const work = document.createElement("canvas");
  work.width = SW; work.height = SH;
  const wg = work.getContext("2d", { willReadFrequently: true });

  const grab = () => { wg.drawImage(video, 0, 0, SW, SH); return wg.getImageData(0, 0, SW, SH).data; };
  let model = null;                 // enrolled after the sword-down warm-up, then never again
  let prev = null;

  // ---- game state ----
  const spawner = new FruitSpawner();
  const scores = new ScoreManager();
  let fruits = [], halves = [], splats = [];
  const trail = [];
  let prevTip = null;
  let playing = false;
  let lastT = 0;
  let loop = 0;
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  const teardown = () => { clearInterval(loop); timers.forEach(clearTimeout); rig.remove(); };
  rig.querySelector(".km-exit").addEventListener("click", () => { teardown(); onExit && onExit(); });
  // Replay restarts the whole flow, warm-up included — the room may have changed, and the
  // sword must be down when the background is learned or it gets absorbed into it.
  rig.querySelector(".km-replay").addEventListener("click", () => { teardown(); startKatanaMode(video, onExit); });

  const sliceFx = (f, look) => {
    // Two skin-colored halves fly apart along the cut; a juice splat fades behind.
    for (const dir of [-1, 1]) {
      halves.push({
        x: f.x, y: f.y, vx: f.vx + dir * 140, vy: f.vy - 60, r: f.radius,
        rot: Math.random() * Math.PI, vr: dir * 5, life: 0.7, look,
      });
    }
    splats.push({ x: f.x, y: f.y, r: f.radius * 0.8, life: 0.5, juice: look.juice });
  };

  const drawFruit = (f) => {
    const look = LOOKS[f.type] || LOOKS.apple;
    vg.save();
    vg.fillStyle = look.skin;
    vg.beginPath(); vg.arc(f.x, f.y, f.radius, 0, Math.PI * 2); vg.fill();
    vg.strokeStyle = "rgba(0,0,0,0.35)"; vg.lineWidth = 3; vg.stroke();
    vg.fillStyle = "rgba(255,255,255,0.35)";
    vg.beginPath(); vg.arc(f.x - f.radius * 0.35, f.y - f.radius * 0.35, f.radius * 0.28, 0, Math.PI * 2); vg.fill();
    vg.restore();
  };

  const drawHalf = (h) => {
    vg.save();
    vg.globalAlpha = Math.max(0, h.life / 0.7);
    vg.translate(h.x, h.y); vg.rotate(h.rot);
    vg.fillStyle = h.look.flesh;
    vg.beginPath(); vg.arc(0, 0, h.r, 0, Math.PI); vg.closePath(); vg.fill();
    vg.strokeStyle = h.look.skin; vg.lineWidth = 6; vg.stroke();
    vg.restore();
  };

  const drawSplat = (s) => {
    vg.save();
    vg.globalAlpha = Math.max(0, s.life / 0.5) * 0.6;
    vg.fillStyle = s.juice;
    vg.beginPath(); vg.arc(s.x, s.y, s.r * (1 + (0.5 - s.life) * 2), 0, Math.PI * 2); vg.fill();
    vg.restore();
  };

  // Trail + tip dot copied from main.js drawTrail/drawTip: white-hot core, warm glow.
  const drawTrail = (now) => {
    if (trail.length < 2) return;
    vg.save();
    vg.lineCap = "round"; vg.lineJoin = "round";
    vg.shadowColor = "rgba(255, 246, 216, 0.9)";
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      const k = Math.max(0, 1 - (now - b.t) / TRAIL_MS);
      vg.shadowBlur = 18 * k;
      vg.lineWidth = 3 + 22 * k;
      vg.strokeStyle = `rgba(255, 250, 230, ${0.18 + 0.78 * k})`;
      vg.beginPath(); vg.moveTo(a.x, a.y); vg.lineTo(b.x, b.y); vg.stroke();
    }
    vg.restore();
  };
  const drawTipDot = (p, r = 11) => {
    if (!p) return;
    vg.save();
    vg.shadowColor = "rgba(255, 210, 74, 0.95)"; vg.shadowBlur = 26;
    vg.fillStyle = "#fff6d8";
    vg.beginPath(); vg.arc(p.x, p.y, r, 0, Math.PI * 2); vg.fill();
    vg.restore();
  };

  const drawHud = () => {
    vg.save();
    vg.font = "800 34px system-ui";
    vg.textBaseline = "top";
    vg.fillStyle = "#fff";
    vg.shadowColor = "rgba(0,0,0,0.8)"; vg.shadowBlur = 6;
    vg.textAlign = "left";
    vg.fillText(`SCORE ${scores.score}`, 16, 12);
    vg.font = "600 20px system-ui";
    vg.fillText(`best ${scores.best}`, 16, 52);
    vg.textAlign = "right"; vg.font = "800 34px system-ui";
    for (let i = 0; i < 3; i++) {
      vg.fillStyle = i < 3 - scores.strikes ? "#ff2d55" : "rgba(255,255,255,0.25)";
      vg.fillText("✕", W - 16 - i * 36, 12);
    }
    vg.restore();
  };

  const gameOver = () => {
    playing = false;
    fruits = []; // physics stops with play — a leftover fruit would hang mid-air forever
    say("GAME OVER", `score ${scores.score} — best ${scores.best}`);
    rig.querySelector(".km-replay").hidden = false;
  };

  const tick = () => {
    // --- tracking: verbatim from tipProbe.js, do not touch ---
    const px = grab();
    let hit = null;
    try { hit = detector.detect(px, SW, SH, model, prev); } catch { hit = null; }
    prev = hit;

    vg.imageSmoothingEnabled = false;
    vg.drawImage(work, 0, 0, view.width, view.height);
    // --- end verbatim tracking ---

    const now = performance.now();
    const dt = Math.min(0.15, (now - lastT) / 1000);
    lastT = now;

    // Same-canvas mapping: 1:1 with the probe's crosshair, no gain, no mirror flip.
    const tip = hit ? { x: hit.x * Z, y: hit.y * Z } : null;

    if (playing) {
      for (const spec of spawner.update(dt, scores.score, W, H, GRAVITY)) {
        // ponytail: bombs dropped — not asked for; add a bomb branch here if wanted.
        if (spec.type !== "bomb") fruits.push(spec);
      }
      fruits = fruits.filter((f) => {
        f.vy += GRAVITY * dt; f.x += f.vx * dt; f.y += f.vy * dt;
        if (tip && prevTip &&
            segmentHitsCircle(prevTip.x, prevTip.y, tip.x, tip.y, f.x, f.y, f.radius)) {
          scores.recordSlice(now);
          sliceFx(f, LOOKS[f.type] || LOOKS.apple);
          return false;
        }
        if (f.vy > 0 && f.y - f.radius > H + 80) { scores.recordMiss(); return false; }
        return true;
      });
      if (scores.dead) gameOver();
    }
    halves = halves.filter((h) => {
      h.vy += GRAVITY * dt; h.x += h.vx * dt; h.y += h.vy * dt;
      h.rot += h.vr * dt; h.life -= dt;
      return h.life > 0;
    });
    splats = splats.filter((s) => (s.life -= dt) > 0);

    for (const s of splats) drawSplat(s);
    for (const f of fruits) drawFruit(f);
    for (const h of halves) drawHalf(h);

    if (tip) trail.push({ x: tip.x, y: tip.y, t: now });
    while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();
    drawTrail(now);
    drawTipDot(tip);
    prevTip = tip;

    if (hit) {
      // The probe's crosshair, kept on top — the player asked to keep seeing it.
      const x = hit.x * Z, y = hit.y * Z;
      vg.strokeStyle = "#ff2d55"; vg.lineWidth = 3;
      vg.beginPath(); vg.arc(x, y, 20, 0, Math.PI * 2); vg.stroke();
      vg.beginPath();
      vg.moveTo(x - 34, y); vg.lineTo(x + 34, y);
      vg.moveTo(x, y - 34); vg.lineTo(x, y + 34);
      vg.stroke();
    }
    drawHud();
  };

  // Warm-up: the detector learns "background" at enroll, so the sword must be OUT of
  // frame then — a raised sword would be absorbed and become invisible to it.
  say("Keep your sword DOWN", "learning your room…");
  later(2000, () => {
    model = detector.enroll([grab()], SW, SH);
    lastT = performance.now();
    loop = setInterval(tick, 60);
    say("Raise your sword!", "get ready…");
    later(1500, () => {
      let n = 3;
      const step = () => {
        if (n === 0) { say("", ""); playing = true; return; }
        say(String(n--), "slice the fruit!");
        later(1000, step);
      };
      step();
    });
  });
}
