// Live tip-tracking probe: ?tipprobe
//
// Every katana fix so far was tuned against a synthetic room and then failed in the real
// one. This runs the REAL detector against the REAL camera, walks the player through a
// fixed set of poses, draws where the detector thinks the tip is so a human can see at a
// glance whether it is on the blade, and prints a summary to screenshot back.
//
// Loaded dynamically and only when the flag is present, so it costs a normal round nothing.
import * as detector from "../tracking/detectTip.js";

const SW = 192, SH = 108, Z = 6;
const STAGES = [
  { key: "still-up", secs: 6, msg: "Hold the sword STILL, tip pointing UP", sub: "Keep it in view, don't move" },
  { key: "still-diag", secs: 6, msg: "Hold it STILL, angled DIAGONALLY", sub: "Tip up and to one side" },
  { key: "slow", secs: 7, msg: "Swing SLOWLY side to side", sub: "Big, lazy arcs" },
  { key: "fast", secs: 7, msg: "Swing FAST", sub: "Hard as you like" },
  { key: "gone", secs: 6, msg: "Put the sword DOWN, out of the camera", sub: "Just you in frame" },
  { key: "raise", secs: 6, msg: "Raise the sword back UP", sub: "Hold it steady again" },
];

export function runTipProbe(video) {
  document.querySelectorAll(".probe-rig").forEach((e) => e.remove());
  const rig = document.createElement("div");
  rig.className = "probe-rig";
  rig.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:#07070b;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:flex-start;gap:10px;padding:12px 0 40px;overflow:auto;font:800 clamp(18px,2.6vw,34px) system-ui;color:#fff;text-align:center";
  rig.innerHTML =
    '<div id="probe-msg" style="padding:0 20px">Starting…</div>' +
    '<div id="probe-sub" style="font-size:0.55em;font-weight:600;color:#8fe3ff"></div>' +
    '<canvas id="probe-cv" style="border-radius:12px;max-width:92vw;height:auto"></canvas>' +
    '<div id="probe-read" style="font-size:0.5em;font-weight:600;color:#ffd24a"></div>' +
    '<pre id="probe-out" style="display:none;font:600 13px ui-monospace,monospace;color:#cfe;text-align:left;' +
    'background:#000;padding:14px;border-radius:10px;max-height:none"></pre>';
  document.body.appendChild(rig);

  const view = document.getElementById("probe-cv");
  view.width = SW * Z; view.height = SH * Z;
  const vg = view.getContext("2d");
  const work = document.createElement("canvas");
  work.width = SW; work.height = SH;
  const wg = work.getContext("2d", { willReadFrequently: true });

  const grab = () => { wg.drawImage(video, 0, 0, SW, SH); return wg.getImageData(0, 0, SW, SH).data; };
  let model = detector.enroll([grab()], SW, SH);
  let prev = null;
  let stage = null;
  const rows = [];

  const tick = () => {
    const px = grab();
    let hit = null;
    try { hit = detector.detect(px, SW, SH, model, prev); } catch { hit = null; }
    prev = hit;

    vg.imageSmoothingEnabled = false;
    vg.drawImage(work, 0, 0, view.width, view.height);
    if (hit) {
      // Crosshair on the detector's answer, so the player can see instantly whether it is
      // on the blade or on their own head.
      const x = hit.x * Z, y = hit.y * Z;
      vg.strokeStyle = "#ff2d55"; vg.lineWidth = 3;
      vg.beginPath(); vg.arc(x, y, 20, 0, Math.PI * 2); vg.stroke();
      vg.beginPath();
      vg.moveTo(x - 34, y); vg.lineTo(x + 34, y);
      vg.moveTo(x, y - 34); vg.lineTo(x, y + 34);
      vg.stroke();
    }
    document.getElementById("probe-read").textContent = hit
      ? `tip = (${Math.round(hit.x)}, ${Math.round(hit.y)})   q ${hit.quality.toFixed(2)}`
      : "NOTHING FOUND";
    if (stage) stage.samples.push(hit ? { x: hit.x, y: hit.y } : null);
  };
  const loop = setInterval(tick, 60);

  const summarise = (s) => {
    const got = s.samples.filter(Boolean);
    const pct = Math.round((got.length / Math.max(1, s.samples.length)) * 100);
    if (!got.length) return `${s.key.padEnd(11)} found   0%   —`;
    const mx = got.reduce((a, p) => a + p.x, 0) / got.length;
    const my = got.reduce((a, p) => a + p.y, 0) / got.length;
    // Spread says whether it sat on one thing or wandered — a lock on a still head reads
    // as a tight cluster in the wrong place, which the mean alone would not reveal.
    const sd = Math.sqrt(got.reduce((a, p) => a + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / got.length);
    return `${s.key.padEnd(11)} found ${String(pct).padStart(3)}%   mean (${mx.toFixed(0)},${my.toFixed(0)})   spread ${sd.toFixed(1)}px`;
  };

  let i = 0;
  const next = () => {
    if (i >= STAGES.length) {
      clearInterval(loop);
      document.getElementById("probe-msg").textContent = "Done — screenshot this";
      document.getElementById("probe-sub").textContent = "send it back and I'll read the numbers";
      const out = document.getElementById("probe-out");
      out.style.display = "block";
      out.textContent =
        `frame ${SW}x${SH}\n` + rows.map(summarise).join("\n") +
        "\n\nA 'found' near 100% with a tight spread in the WRONG place means it locked\n" +
        "onto something that is not the blade. 'gone' should be near 0%.";
      return;
    }
    const st = STAGES[i++];
    stage = { key: st.key, samples: [] };
    rows.push(stage);
    let left = st.secs;
    const msg = document.getElementById("probe-msg"), sub = document.getElementById("probe-sub");
    const paint = () => { msg.textContent = st.msg; sub.textContent = `${st.sub}   —   ${left}s`; };
    paint();
    const cd = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(cd); next(); } else paint();
    }, 1000);
  };

  // A beat to let the player read the first instruction before recording starts.
  document.getElementById("probe-msg").textContent = "Get your sword ready…";
  document.getElementById("probe-sub").textContent = "starting in 3s";
  setTimeout(next, 3000);
}
