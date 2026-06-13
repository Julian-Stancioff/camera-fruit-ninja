// Original procedural arcade music — fully synthesized in Web Audio (no samples,
// no copyrighted material). Layers and tempo build with setIntensity(0..1):
// quiet bass+arp at rest → driving drums + lead at full intensity. A lookahead
// scheduler keeps timing tight ("two clocks" pattern).
let ctx = null, master = null, comp = null;
let playing = false, intensity = 0, volume = 0.7;
const MAX_GAIN = 0.55; // volume 1.0 → this master gain
let timer = null, nextTime = 0, step = 0;
const LOOKAHEAD = 0.12, TICK_MS = 25;

// i–VI–III–VII in A minor — chord roots (bass, Hz) + chord tones (mid octave).
const PROG = [
  { bass: 55.00, notes: [220.00, 261.63, 329.63] }, // Am: A C E
  { bass: 43.65, notes: [174.61, 220.00, 261.63] }, // F:  F A C
  { bass: 65.41, notes: [261.63, 329.63, 392.00] }, // C:  C E G
  { bass: 49.00, notes: [196.00, 246.94, 293.66] }, // G:  G B D
];

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    comp = ctx.createDynamicsCompressor();
    master = ctx.createGain(); master.gain.value = 0;
    master.connect(comp); comp.connect(ctx.destination);
  }
  return ctx;
}

export function resume() { ac().resume?.(); }
export function setIntensity(x) { intensity = Math.max(0, Math.min(1, x)); }
export function setVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.linearRampToValueAtTime(playing ? volume * MAX_GAIN : 0, ac().currentTime + 0.2);
}
export function getVolume() { return volume; }

function tone(type, freq, t, dur, peak) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.03);
}
function kick(t) {
  const o = ctx.createOscillator(); o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
  o.connect(g).connect(master); o.start(t); o.stop(t + 0.18);
}
function noise(t, dur, hp, peak) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = b;
  const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp;
  const g = ctx.createGain(); g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(master); s.start(t);
}

function scheduleStep(s, t) {
  const I = intensity, bar = Math.floor(s / 16) % 4, chord = PROG[bar], st = s % 16;
  if (st % 4 === 0) kick(t);                          // four-on-floor
  if (I > 0.55 && st === 10) kick(t);                 // extra kick when intense
  if (I > 0.3 && (st === 4 || st === 12)) noise(t, 0.12, 1800, 0.22 * Math.min(1, I + 0.3)); // snare
  if (I > 0.2 && st % 2 === 1) noise(t, 0.03, 8000, 0.05 + 0.06 * I);   // hats
  if (I > 0.65 && st % 2 === 0) noise(t, 0.025, 9000, 0.05 * I);
  if (st === 0 || st === 8) tone("triangle", chord.bass, t, 0.5, 0.32); // bass
  if (I > 0.4) tone("square", chord.notes[s % chord.notes.length], t, 0.12, 0.045 + 0.05 * I); // arp
  if (I > 0.72 && st % 8 === 6) tone("sawtooth", chord.notes[s % chord.notes.length] * 2, t, 0.22, 0.05 * I); // lead
}

function loop() {
  const now = ac().currentTime;
  const stepDur = 60 / (96 + intensity * 64) / 4; // 96→160 BPM, 16th notes
  while (nextTime < now + LOOKAHEAD) {
    scheduleStep(step, nextTime);
    nextTime += stepDur; step++;
  }
}

export function start() {
  ac();
  if (playing) return;
  playing = true; step = 0; nextTime = ctx.currentTime + 0.1;
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.linearRampToValueAtTime(volume * MAX_GAIN, ctx.currentTime + 0.6);
  timer = setInterval(loop, TICK_MS);
}
export function stop() {
  playing = false;
  if (timer) clearInterval(timer);
  timer = null;
  if (master) master.gain.linearRampToValueAtTime(0, ac().currentTime + 0.3);
}
