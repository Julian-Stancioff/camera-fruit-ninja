// Head-to-head referee for the katana detectors: node client/test/bench.mjs
// Imports every detector that exists, runs the shared contract over every scene, and
// prints raw numbers. It picks no winner — that call is the orchestrator's.
import { scenes } from "./scenes.mjs";

const CANDIDATES = [
  ["blob", "../src/tracking/detectBlob.js"],
  ["ridge", "../src/tracking/detectRidge.js"],
  ["blade", "../src/tracking/detectBlade.js"],
];

const DETECT_MS = 4, ENROLL_MS = 150;   // the contract's budgets, flagged with * below

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const L = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);

// An axis has no head or tail, so 179° off is really 1° off. Fold before averaging or
// every near-perfect frame that happens to flip ends reads as a catastrophic failure.
function axisErr(a, b) {
  const d = ((Math.abs(a - b) * 180) / Math.PI) % 180;
  return d > 90 ? 180 - d : d;
}

const ok = (r) => r && [r.cx, r.cy, r.angle, r.len].every(Number.isFinite) &&
  Array.isArray(r.ends) && r.ends.length === 2 && r.ends.flat().every(Number.isFinite);

const detectors = [];
for (const [id, rel] of CANDIDATES) {
  try {
    const m = await import(new URL(rel, import.meta.url));
    if (typeof m.enroll !== "function" || typeof m.detect !== "function") throw new Error("no enroll/detect export");
    detectors.push({ id, name: m.NAME || id, m });
  } catch (e) {
    console.log(`MISSING  ${L(id, 7)} ${rel}  (${String(e.message).split("\n")[0].slice(0, 60)})`);
  }
}
if (!detectors.length) { console.log("\nno detectors to score."); process.exit(0); }
console.log(`scoring ${detectors.map((d) => d.id).join(", ")}`);

const all = scenes();
const rows = new Map(detectors.map((d) => [d.id, []]));

// V8 compiles a detector's hot loops on its first few calls. Without this the very
// first scene is charged for the JIT and reads as a budget violation — a referee that
// reports warmup as a real cost is publishing a lie. Discarded, nothing is scored here.
for (const d of detectors) {
  try {
    const m = d.m.enroll(all[0].enrollFrames, all[0].SW, all[0].SH);
    for (let k = 0; k < 3; k++) for (const f of all[0].frames) d.m.detect(f, all[0].SW, all[0].SH, m, null);
  } catch { /* it still gets scored below, with its errors counted there */ }
}

for (const sc of all) {
  const live = sc.truth.filter(Boolean).length;
  console.log(`\n== ${sc.name}  ${sc.SW}x${sc.SH}, ${sc.frames.length} frames, truth ${live ? "present" : "NULL"}`);
  for (const d of detectors) {
    // enroll runs once in production, but a single sample here is at the mercy of one
    // GC pause, so take the median of three and keep the last model.
    let model = null, err = 0;
    const eMs = [];
    for (let k = 0; k < 3; k++) {
      const t0 = process.hrtime.bigint();
      try { model = d.m.enroll(sc.enrollFrames, sc.SW, sc.SH); } catch (e) { if (!k) err++; }
      eMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const enrollMs = med(eMs);

    const ang = [], lenPct = [], pos = [], ms = [];
    let miss = 0, fp = 0, prev = null;
    for (let k = 0; k < sc.frames.length; k++) {
      const truth = sc.truth[k];
      let r = null;
      const s = process.hrtime.bigint();
      try { r = d.m.detect(sc.frames[k], sc.SW, sc.SH, model, prev); } catch (e) { err++; }
      ms.push(Number(process.hrtime.bigint() - s) / 1e6);
      if (r && !ok(r)) err++;   // a malformed result is a bug, not a detection
      if (!truth) { if (r) fp++; continue; }          // any non-null here is a false positive
      if (!ok(r)) { miss++; continue; }
      prev = r;                                        // contract: prev is the last ACCEPTED result
      ang.push(axisErr(r.angle, truth.angle));
      lenPct.push((100 * Math.abs(r.len - truth.len)) / truth.len);
      const tc = [(truth.ends[0][0] + truth.ends[1][0]) / 2, (truth.ends[0][1] + truth.ends[1][1]) / 2];
      pos.push(Math.hypot(r.cx - tc[0], r.cy - tc[1]));
    }

    const row = {
      scene: sc.name, live,
      ang: med(ang), worst: ang.length ? Math.max(...ang) : NaN, len: med(lenPct),
      miss: live ? (100 * miss) / live : NaN,
      fp: live ? NaN : (100 * fp) / sc.frames.length,
      fpN: fp, n: sc.frames.length, pos: med(pos), ms: med(ms), enrollMs, err,
      raw: { ang, lenPct, miss, live },
    };
    rows.get(d.id).push(row);
    console.log(live
      ? `  ${L(d.id, 7)} ang ${R(num(row.ang, 1), 5)}/${R(num(row.worst, 1), 5)}deg  len ${R(num(row.len, 1), 5)}%  miss ${R(num(row.miss, 0), 3)}%  pos ${R(num(row.pos, 1), 5)}px  ${num(row.ms, 2)}ms  enroll ${num(enrollMs, 0)}ms${err ? `  ERR ${err}` : ""}`
      : `  ${L(d.id, 7)} FALSE POSITIVES ${fp}/${sc.frames.length} = ${num(row.fp, 0)}%   ${num(row.ms, 2)}ms  enroll ${num(enrollMs, 0)}ms${err ? `  ERR ${err}` : ""}`);
  }
}

const HEAD = `${L("scene", 15)}${R("ang", 6)}${R("worst", 6)}${R("len%", 7)}${R("miss%", 6)}${R("fp%", 6)}${R("pos", 6)}${R("ms", 7)}${R("enroll", 8)}`;
console.log(`\n\nSUMMARY  ang/worst = median & max axis error in degrees, ms = median per detect()`);
console.log(`         * = over the contract budget (detect ${DETECT_MS}ms, enroll ${ENROLL_MS}ms)`);
for (const d of detectors) {
  console.log(`\n-- ${d.id} (${d.name}) ${"-".repeat(Math.max(0, 57 - d.id.length - d.name.length))}`);
  console.log(HEAD);
  for (const r of rows.get(d.id)) {
    console.log(L(r.scene, 15) + R(num(r.ang), 6) + R(num(r.worst), 6) + R(num(r.len), 7) +
      R(num(r.miss, 0), 6) + R(r.live ? "-" : num(r.fp, 0), 6) + R(num(r.pos), 6) +
      R(num(r.ms, 2) + (r.ms > DETECT_MS ? "*" : ""), 7) + R(num(r.enrollMs, 0) + (r.enrollMs > ENROLL_MS ? "*" : ""), 8));
  }
}

console.log("");
for (const d of detectors) {
  const rs = rows.get(d.id);
  const ang = rs.flatMap((r) => r.raw.ang), len = rs.flatMap((r) => r.raw.lenPct);
  const live = rs.reduce((s, r) => s + r.raw.live, 0), miss = rs.reduce((s, r) => s + r.raw.miss, 0);
  const fpN = rs.filter((r) => !r.live).reduce((s, r) => s + r.fpN, 0);
  const fpFrames = rs.filter((r) => !r.live).reduce((s, r) => s + r.n, 0);
  const overD = rs.filter((r) => r.ms > DETECT_MS).length, overE = rs.filter((r) => r.enrollMs > ENROLL_MS).length;
  console.log(`${L(d.id, 7)} ang ${num(med(ang))}deg | len ${num(med(len))}% | miss ${num((100 * miss) / live, 0)}% ` +
    `| FP ${fpN}/${fpFrames} = ${num((100 * fpN) / fpFrames, 0)}% | ${num(med(rs.map((r) => r.ms)), 2)}ms ` +
    `| over budget ${overD}/${rs.length} detect, ${overE}/${rs.length} enroll | errors ${rs.reduce((s, r) => s + r.err, 0)}`);
}
