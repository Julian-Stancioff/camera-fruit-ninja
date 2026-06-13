// Procedural sound effects via Web Audio — no audio files to ship. Each call
// synthesizes a short sound. Must be unlocked from a user gesture (resume()).
let ctx = null;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

export function resume() {
  ac().resume?.();
}

function noiseBuffer(dur) {
  const c = ac();
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function env(node, gain, attack, dur) {
  const c = ac(), t = c.currentTime;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  node.connect(g).connect(c.destination);
  return g;
}

export function slice() {
  const c = ac(), t = c.currentTime;
  // swish (filtered noise)
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(0.2);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.setValueAtTime(2200, t);
  bp.frequency.exponentialRampToValueAtTime(500, t + 0.2);
  bp.Q.value = 0.9;
  src.connect(bp); env(bp, 0.55, 0.004, 0.22); src.start();
  // wet "squelch" — a quick downward sine blip for juicy impact
  const o = c.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(620, t);
  o.frequency.exponentialRampToValueAtTime(160, t + 0.13);
  env(o, 0.32, 0.005, 0.15); o.start(); o.stop(t + 0.16);
}

export function combo(n = 3) {
  const c = ac();
  for (let i = 0; i < Math.min(n, 5); i++) {
    const o = c.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(520 + i * 130, c.currentTime + i * 0.05);
    const g = env(o, 0.25, 0.01, 0.18 + i * 0.05);
    o.start(c.currentTime + i * 0.05);
    o.stop(c.currentTime + i * 0.05 + 0.2);
    void g;
  }
}

export function bomb() {
  const c = ac();
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(0.6);
  const lp = c.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.setValueAtTime(900, c.currentTime);
  lp.frequency.exponentialRampToValueAtTime(80, c.currentTime + 0.5);
  src.connect(lp);
  env(lp, 0.9, 0.005, 0.6);
  src.start();
  const o = c.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(120, c.currentTime);
  o.frequency.exponentialRampToValueAtTime(40, c.currentTime + 0.5);
  env(o, 0.5, 0.005, 0.6);
  o.start(); o.stop(c.currentTime + 0.6);
}

export function miss() {
  const c = ac();
  const o = c.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(300, c.currentTime);
  o.frequency.exponentialRampToValueAtTime(140, c.currentTime + 0.25);
  env(o, 0.25, 0.01, 0.28);
  o.start(); o.stop(c.currentTime + 0.3);
}

export function gameover() {
  const c = ac();
  // descending "nuh-nuh-nuhhh" sting: three falling notes, last one held + wobbly.
  const notes = [392, 311, 220];
  notes.forEach((f, i) => {
    const start = c.currentTime + i * 0.26;
    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f, start);
    o.frequency.exponentialRampToValueAtTime(f * 0.97, start + 0.24); // slight droop
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 1400;
    const dur = i === notes.length - 1 ? 0.7 : 0.24;
    o.connect(lp);
    env(lp, 0.32, 0.01, dur);
    o.start(start); o.stop(start + dur + 0.05);
  });
}
