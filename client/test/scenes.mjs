// Ground-truth scenes for the katana detector bench: node client/test/bench.mjs
//
// Everything is synthesised from a seeded LCG — no image files, no Math.random — so a
// run is byte-identical every time and the truth is analytic rather than annotated.
// The blade is filled by an exact point-in-oriented-rectangle test, so the geometry in
// `truth` IS the geometry in the pixels; there is no antialiasing and therefore no
// half-covered edge pixel to argue about.
//
// Each scene breaks one assumption on purpose. Read the comment above each one before
// blaming a detector for its score there.

const W = 192, H = 108;   // the size the game scans at
const HALFW = 2;          // a real katana is ~5px wide at this scale
const N_ENROLL = 8, N_TRACK = 12;

const lerp = (a, b, f) => a + (b - a) * f;
const rad = (d) => (d * Math.PI) / 180;

// Same LCG the ObjectBlade self-check uses. Re-seeded per frame so frames are
// independent samples of the same room, not one frozen noise field.
const rng = (seed) => {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
};

// ---------------------------------------------------------------- backgrounds

// A real room is never a flat fill: it has a light gradient and sensor noise. A
// constant background would let a detector pass on a scene no camera produces.
function wall(p, rnd, col) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const s = 0.86 + 0.0009 * x + 0.0016 * y + rnd() * 0.025;
      p[i] = col[0] * s; p[i + 1] = col[1] * s; p[i + 2] = col[2] * s; p[i + 3] = 255;
    }
  }
}

function rect(p, x0, y0, x1, y1, col) {
  for (let y = Math.max(0, y0 | 0); y <= Math.min(H - 1, y1 | 0); y++) {
    for (let x = Math.max(0, x0 | 0); x <= Math.min(W - 1, x1 | 0); x++) {
      const i = (y * W + x) * 4;
      p[i] = col[0]; p[i + 1] = col[1]; p[i + 2] = col[2]; p[i + 3] = 255;
    }
  }
}

// Bookshelf: dozens of long vertical spine edges and three long horizontal board
// edges. This is a line detector's nightmare — every decoy here is straighter and
// higher-contrast than the blade.
// `fixed` is re-seeded identically for every frame of a scene, so the furniture holds
// still and only the sensor noise moves. Re-rolling the spines per frame would make the
// whole room shimmer and hand a motion-cue detector nothing but noise.
function shelf(p, rnd, fixed) {
  wall(p, rnd, [96, 92, 86]);
  for (let s = 0; s < 3; s++) {
    const top = 4 + s * 35, bot = top + 26;
    for (let x = 3; x < W - 3;) {
      const w = 3 + Math.floor(fixed() * 6);
      const g = 45 + fixed() * 165;
      rect(p, x, top, x + w - 1, bot, [g, g * (0.6 + fixed() * 0.5), g * (0.5 + fixed() * 0.6)]);
      x += w + 1;
    }
    rect(p, 0, bot + 1, W - 1, bot + 4, [52, 44, 36]); // board
  }
}

// The player's torso: one big blob of a colour that is nothing like a wall or a blade.
function torso(p, cx, cy, rx, ry, col) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x - cx) / rx, v = (y - cy) / ry;
      if (u * u + v * v > 1) continue;
      const i = (y * W + x) * 4, s = 0.9 + 0.2 * (1 - u * u);  // fabric shading
      p[i] = col[0] * s; p[i + 1] = col[1] * s; p[i + 2] = col[2] * s;
    }
  }
}

// ---------------------------------------------------------------- the object

// u = distance along the axis from the centre, v = distance across. `shade` reads the
// pixel it is about to overwrite, which is what lets steel sit a couple of RGB units
// off whatever is behind it.
function fillBar(p, pose, shade, mark) {
  const dx = Math.cos(pose.angle), dy = Math.sin(pose.angle), half = pose.len / 2;
  const r = Math.ceil(half + HALFW) + 1;
  for (let y = Math.max(0, Math.floor(pose.cy - r)); y <= Math.min(H - 1, Math.ceil(pose.cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(pose.cx - r)); x <= Math.min(W - 1, Math.ceil(pose.cx + r)); x++) {
      const ax = x - pose.cx, ay = y - pose.cy;
      const u = ax * dx + ay * dy, v = -ax * dy + ay * dx;
      if (Math.abs(u) > half || Math.abs(v) > HALFW) continue;
      const i = (y * W + x) * 4;
      shade(p, i, u, v);
      if (mark) mark[y * W + x] = 1;
    }
  }
}

// ~`travel` px of motion smeared across the exposure. Painting overlapping copies would
// leave the last copy's hard edge, so accumulate coverage and blend the average in once.
function fillBarBlur(p, pose, shade, travelAngle, travel, steps = 9) {
  const acc = new Float32Array(W * H * 3), cov = new Float32Array(W * H);
  const tx = Math.cos(travelAngle), ty = Math.sin(travelAngle);
  for (let k = 0; k < steps; k++) {
    const f = k / (steps - 1) - 0.5;
    const sub = Uint8ClampedArray.from(p), m = new Uint8Array(W * H);
    fillBar(sub, { ...pose, cx: pose.cx + f * travel * tx, cy: pose.cy + f * travel * ty }, shade, m);
    for (let q = 0; q < W * H; q++) {
      if (!m[q]) continue;
      acc[q * 3] += sub[q * 4]; acc[q * 3 + 1] += sub[q * 4 + 1]; acc[q * 3 + 2] += sub[q * 4 + 2];
      cov[q] += 1;
    }
  }
  for (let q = 0; q < W * H; q++) {
    if (!cov[q]) continue;
    const a = cov[q] / steps, i = q * 4;
    for (let c = 0; c < 3; c++) p[i + c] = p[i + c] * (1 - a) + (acc[q * 3 + c] / cov[q]) * a;
  }
}

// Matte wood: its own colour, well clear of any wall, with grain along the stick.
const wood = (p, i, u) => {
  const g = 1 + 0.07 * Math.sin(u / 5);
  p[i] = 126 * g; p[i + 1] = 88 * g; p[i + 2] = 54 * g;
};

// Mirror finish over a plain wall. The blade reflects the room, so its body lands
// within ~2 RGB units of the wall it covers and only a hairline edge and a travelling
// specular band separate them. Any model that enrols a colour on frame 0 is stale by
// frame 5, because `phase` walks the highlight from hilt to tip across the sequence.
const steelOnWall = (phase) => (p, i, u, v) => {
  const spec = 170 * Math.exp(-((u - phase) ** 2) / 200);
  const d = 2 + (Math.abs(v) > HALFW - 1 ? -5 : 0) + spec;
  p[i] += d; p[i + 1] += d; p[i + 2] += d * 1.02;
};

// Mirror finish over clutter. A mirror reflects the ROOM, not the bookshelf behind it,
// so here the body is an absolute smooth value near the clutter's own mean — no average
// contrast to grab, but it does break the clutter's texture. Copying the background
// through the blade would have been physically wrong and undetectable by anything.
const steelReflect = (phase, base) => (p, i, u, v) => {
  const spec = 170 * Math.exp(-((u - phase) ** 2) / 200);
  const g = base + 6 * Math.sin(u / 11) + (Math.abs(v) > HALFW - 1 ? -8 : 0) + spec;
  p[i] = g; p[i + 1] = g * 1.01; p[i + 2] = g * 1.04;
};

// ---------------------------------------------------------------- truth

// Liang-Barsky against the frame rect.
function clip(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [pp, qq] of [[-dx, a[0]], [dx, W - 1 - a[0]], [-dy, a[1]], [dy, H - 1 - a[1]]]) {
    if (pp === 0) { if (qq < 0) return null; continue; }
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

// Truth is the VISIBLE segment. Clipping it to the frame is the honest call: a detector
// cannot see the part of the blade that is off-camera, so scoring it against the full
// geometry would just mark every detector 40% short on the clipped scene.
function truthOf(pose) {
  const dx = Math.cos(pose.angle), dy = Math.sin(pose.angle), h = pose.len / 2;
  const seg = clip([pose.cx - dx * h, pose.cy - dy * h], [pose.cx + dx * h, pose.cy + dy * h]);
  if (!seg) return null;
  const [[x0, y0], [x1, y1]] = seg;
  return { ends: seg, angle: Math.atan2(y1 - y0, x1 - x0), len: Math.hypot(x1 - x0, y1 - y0) };
}

// ---------------------------------------------------------------- assembly

// a0/a1 in degrees, c0/c1 are [x,y]. Enrolment paths sweep much wider than tracking
// paths because enrolment frames are the player WAVING the thing at the camera.
const path = (a0, a1, c0, c1, len) => (f) => ({
  angle: rad(lerp(a0, a1, f)), cx: lerp(c0[0], c1[0], f), cy: lerp(c0[1], c1[1], f), len,
});

function build({ name, seed, bg, draw, wave, track }) {
  const run = (poseAt, count) => {
    const frames = [], truth = [];
    for (let k = 0; k < count; k++) {
      const rnd = rng(seed + k * 7919);   // sensor noise: fresh every frame
      const p = new Uint8ClampedArray(W * H * 4);
      bg(p, rnd, rng(seed));              // the room itself: identical every frame
      const pose = poseAt && poseAt(count > 1 ? k / (count - 1) : 0);
      if (pose) draw(p, pose, k / Math.max(1, count - 1));
      frames.push(p);
      truth.push(pose ? truthOf(pose) : null);
    }
    return { frames, truth };
  };
  const e = run(wave, N_ENROLL), t = run(track, N_TRACK);
  return { name, SW: W, SH: H, enrollFrames: e.frames, frames: t.frames, truth: t.truth };
}

// The highlight sweeps hilt→tip over the sequence, so it is never in the same place twice.
const sweepSpec = (shadeFor) => (p, pose, f) => fillBar(p, pose, shadeFor(lerp(-pose.len / 2, pose.len / 2, f)));

export function scenes() {
  return [
    // 1. The easy baseline: a matte stick that owns a colour nothing else in frame has.
    build({
      name: "stick-matte", seed: 101,
      bg: (p, r) => wall(p, r, [188, 192, 198]),
      draw: (p, pose) => fillBar(p, pose, wood),
      wave: path(-75, 10, [78, 58], [112, 48], 72),
      track: path(-25, 30, [104, 50], [88, 58], 72),
    }),

    // 2. THE case that matters: mirror steel on a plain wall. Body within a couple of
    //    RGB units of the wall, appearance changing every frame as the specular travels.
    build({
      name: "steel-plain", seed: 202,
      bg: (p, r) => wall(p, r, [150, 152, 158]),
      draw: sweepSpec(steelOnWall),
      wave: path(-70, 15, [80, 56], [110, 50], 78),
      track: path(-20, 35, [102, 52], [90, 56], 78),
    }),

    // 3. The same invisible blade buried in decoy lines. Every book spine is a longer,
    //    straighter, higher-contrast edge than the object we actually want.
    build({
      name: "steel-clutter", seed: 303,
      bg: (p, r, f) => shelf(p, r, f),
      draw: sweepSpec((ph) => steelReflect(ph, 118)),
      wave: path(-65, 20, [82, 56], [108, 50], 78),
      track: path(-35, 25, [100, 54], [92, 54], 78),
    }),

    // 4. Blade crossing the player's torso: a huge blob of a third colour behind it, so
    //    the blade's own flanks change halfway along its length.
    build({
      name: "torso-cross", seed: 404,
      bg: (p, r) => { wall(p, r, [176, 180, 186]); torso(p, 96, 100, 60, 45, [72, 40, 46]); },
      draw: sweepSpec(steelOnWall),
      wave: path(-60, 20, [86, 66], [106, 62], 80),
      track: path(-30, 10, [96, 62], [92, 64], 80),
    }),

    // 5. Motion blur: ~15px of travel across the exposure, roughly across the axis, so
    //    the blade fattens into a soft parallelogram. Aspect-ratio thresholds die here.
    build({
      name: "motion-blur", seed: 505,
      bg: (p, r) => wall(p, r, [188, 192, 198]),
      draw: (p, pose) => fillBarBlur(p, pose, wood, pose.angle + rad(70), 15),
      wave: path(-70, 5, [80, 58], [110, 50], 72),
      track: path(-25, 25, [100, 52], [90, 56], 72),
    }),

    // 6. One endpoint off-camera. Truth is the visible segment and it shrinks and grows
    //    frame to frame, so anything that assumes a fixed blade length drifts.
    build({
      name: "clipped", seed: 606,
      bg: (p, r) => wall(p, r, [188, 192, 198]),
      draw: (p, pose) => fillBar(p, pose, wood),
      wave: path(-20, 25, [146, 58], [168, 50], 96),
      track: path(-10, 20, [150, 54], [172, 50], 96),
    }),

    // 7. No object at all, in the busiest room we have. Truth is null on every frame:
    //    a detector that hallucinates here is worse than one that misses.
    build({
      name: "empty", seed: 707,
      bg: (p, r, f) => { shelf(p, r, f); torso(p, 96, 100, 60, 45, [72, 40, 46]); },
      draw: () => {},
      wave: null,
      track: null,
    }),
  ];
}
