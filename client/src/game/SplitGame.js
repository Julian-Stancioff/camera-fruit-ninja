// Same-screen 2-player split-screen. Two independent score-only boards (left &
// right), each driven by one tracked hand, sharing the renderer via HalfScene.
// 3-minute timer, no lives. Difficulty is TIME-based and tactical: mostly single
// fruit (no flood) with occasional combo clusters and cross-court angles; missed
// fruit and bombs cost escalating points the longer the match runs. Each side can
// independently slow down (when its player's hand leaves the camera).
import { Fruit } from "./Fruit.js";
import { segmentHitsCircle } from "./slice.js";
import { HalfScene } from "../rendering/scene.js";
import { Effects } from "../rendering/effects.js";
import { FRUIT_TYPES } from "../rendering/fruitFactory.js";

const SPEED_GATE = 180;
const HIT_MARGIN = 1.3;
const DURATION_MS = 180000; // 3 minutes
const COMBO_MS = 600;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Penalties escalate over the match so letting fruit drop is genuinely costly.
const missPenalty = (sec) => 3 + Math.floor(sec / 20); // 3 → 12 over 3 min
const bombPenalty = (sec) => 5 + Math.floor(sec / 30); // 5 → 11 over 3 min

class Half {
  constructor(halfScene) {
    this.scene = halfScene;
    this.effects = new Effects(halfScene);
    this.reset();
  }
  reset() {
    for (const f of (this.fruits || [])) this.scene.remove(f.mesh);
    this.fruits = [];
    this.effects.clear();
    this.score = 0;
    this._recent = [];
    this.spawnTimer = 0;
    this.nextIn = 1.2;
  }

  _interval(t) { return rand(0.9, 1.1) * (1.25 - 0.45 * t); } // 1.25s → 0.8s

  _wave(t, w, h, gravity) {
    const baseR = Math.min(w, h) * 0.064;
    // Mostly single fruit; sometimes a tight 2–3 cluster (a combo opportunity).
    const cluster = t > 0.03 && Math.random() < 0.25 + 0.15 * t;
    const count = cluster ? (Math.random() < 0.35 ? 3 : 2) : 1;
    const clusterCx = rand(0.3, 0.7);
    const specs = [];
    let bombs = 0;
    for (let i = 0; i < count; i++) {
      let type = pick(FRUIT_TYPES);
      if (!cluster && t > 0.03 && bombs === 0 && Math.random() < 0.05 + 0.08 * t) { type = "bomb"; bombs++; }
      const radius = type === "watermelon" ? baseR * 1.35 : type === "bomb" ? baseR : baseR * rand(0.82, 1.05);
      let x, vx;
      if (cluster) {
        x = clamp(clusterCx + rand(-0.07, 0.07), 0.08, 0.92) * w;
        vx = rand(-40, 40);
      } else if (Math.random() < 0.33) {
        // cross-court launch from a side edge so sweeping straight across misses
        const fromLeft = Math.random() < 0.5;
        x = (fromLeft ? rand(0.05, 0.18) : rand(0.82, 0.95)) * w;
        vx = (fromLeft ? 1 : -1) * rand(120, 260);
      } else {
        x = rand(0.18, 0.82) * w;
        vx = ((w / 2 - x) / (w / 2)) * rand(40, 140) + rand(-60, 60);
      }
      const rise = (rand(0.5, 0.7) + 0.14 * t) * h;
      const vy = -Math.sqrt(2 * gravity * rise);
      specs.push({ type, x, y: h + radius + 10, vx, vy, radius });
    }
    return specs;
  }

  // slow ∈ [0,1] scales this side's physics + pauses spawns/penalties when low
  // (its player's hand left the camera).
  update(dt, segment, now, spawn, elapsedSec, slow) {
    const w = this.scene.w, h = this.scene.h, gravity = h * 1.8;
    const t = Math.min(1, elapsedSec / 120);
    const realDt = Math.min(dt, 0.05);
    const dtc = realDt * slow;
    const live = slow > 0.5; // hand present enough to play normally

    if (spawn && live) {
      this.spawnTimer += realDt;
      if (this.spawnTimer >= this.nextIn) {
        this.spawnTimer = 0; this.nextIn = this._interval(t);
        for (const spec of this._wave(t, w, h, gravity)) {
          const f = new Fruit(spec.type, spec);
          this.scene.add(f.mesh); this.fruits.push(f);
        }
      }
    }

    const slicing = segment && segment.speed > SPEED_GATE;
    const missPen = missPenalty(elapsedSec), bombPen = bombPenalty(elapsedSec);
    for (let i = this.fruits.length - 1; i >= 0; i--) {
      const f = this.fruits[i];
      f.update(dtc, gravity);
      if (slicing && !f.sliced &&
          segmentHitsCircle(segment.a.x, segment.a.y, segment.b.x, segment.b.y, f.x, f.y, f.radius * HIT_MARGIN)) {
        f.sliced = true;
        this.scene.remove(f.mesh);
        this.fruits.splice(i, 1);
        const dx = segment.b.x - segment.a.x, dy = segment.b.y - segment.a.y, len = Math.hypot(dx, dy) || 1;
        if (f.isBomb) {
          this.effects.explode(f);
          this.score = Math.max(0, this.score - bombPen);
        } else {
          this.effects.sliceBurst(f, { x: dx / len, y: dy / len });
          this._recent = this._recent.filter((tt) => now - tt < COMBO_MS);
          this._recent.push(now);
          const combo = this._recent.length;
          this.score += 1 + (combo >= 2 ? combo : 0);
        }
        continue;
      }
      if (f.isOffScreen(h)) {
        this.scene.remove(f.mesh);
        this.fruits.splice(i, 1);
        // Only penalize a real drop during live play — never while the hand is gone.
        if (spawn && live && !f.sliced && !f.isBomb) this.score = Math.max(0, this.score - missPen);
      }
    }
    this.effects.update(dtc, gravity, h);
  }
}

export class SplitGame {
  constructor(renderer, cb = {}) {
    this.renderer = renderer;
    this.cb = cb;
    this.left = new Half(new HalfScene(renderer, "left"));
    this.right = new Half(new HalfScene(renderer, "right"));
    this.playing = false;
    this.startAt = 0;
    this.endAt = 0;
    this._over = false;
  }

  start() {
    this.left.reset();
    this.right.reset();
    this._over = false;
    this.playing = true;
    this.startAt = performance.now();
    this.endAt = this.startAt + DURATION_MS;
  }

  get durationMs() { return DURATION_MS; }

  update(dt, segLeft, segRight, slowLeft = 1, slowRight = 1) {
    const now = performance.now();
    const spawn = this.playing;
    const elapsed = this.playing ? (now - this.startAt) / 1000 : 0;
    this.left.update(dt, this.playing ? segLeft : null, now, spawn, elapsed, slowLeft);
    this.right.update(dt, this.playing ? segRight : null, now, spawn, elapsed, slowRight);
    if (this.playing) {
      const left = Math.max(0, this.endAt - now);
      this.cb.onTick?.({ timeLeftMs: left, scores: [this.left.score, this.right.score] });
      if (left <= 0 && !this._over) {
        this._over = true;
        this.playing = false;
        const s = [this.left.score, this.right.score];
        const winner = s[0] === s[1] ? -1 : s[0] > s[1] ? 0 : 1;
        this.cb.onOver?.({ scores: s, winner });
      }
    }
  }

  render() {
    const r = this.renderer;
    r.autoClear = false;
    r.setScissorTest(false);
    r.setViewport(0, 0, window.innerWidth, window.innerHeight);
    r.clear();
    this.left.scene.render();
    this.right.scene.render();
    r.autoClear = true;
  }

  resize() { this.left.scene.resize(); this.right.scene.resize(); }
  clear() { this.left.reset(); this.right.reset(); }
}
