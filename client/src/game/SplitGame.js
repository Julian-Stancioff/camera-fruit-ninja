// Same-screen 2-player split-screen. Two independent score-only boards (left &
// right), each driven by one tracked hand, sharing the renderer via HalfScene.
// 3-minute timer, no lives: slice = points (+combos), missed fruit / bombs lose
// points, highest score at time-up wins.
import { Fruit } from "./Fruit.js";
import { FruitSpawner } from "./FruitSpawner.js";
import { segmentHitsCircle } from "./slice.js";
import { HalfScene } from "../rendering/scene.js";
import { Effects } from "../rendering/effects.js";

const SPEED_GATE = 180;
const HIT_MARGIN = 1.3;
const MISS_PENALTY = 2;
const BOMB_PENALTY = 5;
const DURATION_MS = 180000; // 3 minutes

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
    this.spawner = new FruitSpawner();
    this.score = 0;
    this._recent = [];
  }
  update(dt, segment, now, spawn) {
    const w = this.scene.w, h = this.scene.h, gravity = h * 1.8;
    dt = Math.min(dt, 0.05);
    if (spawn) {
      for (const spec of this.spawner.update(dt, this.score, w, h, gravity)) {
        const f = new Fruit(spec.type, spec);
        this.scene.add(f.mesh);
        this.fruits.push(f);
      }
    }
    const slicing = segment && segment.speed > SPEED_GATE;
    for (let i = this.fruits.length - 1; i >= 0; i--) {
      const f = this.fruits[i];
      f.update(dt, gravity);
      if (slicing && !f.sliced &&
          segmentHitsCircle(segment.a.x, segment.a.y, segment.b.x, segment.b.y, f.x, f.y, f.radius * HIT_MARGIN)) {
        f.sliced = true;
        this.scene.remove(f.mesh);
        this.fruits.splice(i, 1);
        const dx = segment.b.x - segment.a.x, dy = segment.b.y - segment.a.y, len = Math.hypot(dx, dy) || 1;
        if (f.isBomb) {
          this.effects.explode(f);
          this.score = Math.max(0, this.score - BOMB_PENALTY);
        } else {
          this.effects.sliceBurst(f, { x: dx / len, y: dy / len });
          this._recent = this._recent.filter((t) => now - t < 600);
          this._recent.push(now);
          const combo = this._recent.length;
          this.score += 1 + (combo >= 2 ? combo : 0);
        }
        continue;
      }
      if (f.isOffScreen(h)) {
        this.scene.remove(f.mesh);
        this.fruits.splice(i, 1);
        if (spawn && !f.sliced && !f.isBomb) this.score = Math.max(0, this.score - MISS_PENALTY);
      }
    }
    this.effects.update(dt, gravity, h);
  }
}

export class SplitGame {
  constructor(renderer, cb = {}) {
    this.renderer = renderer;
    this.cb = cb;
    this.left = new Half(new HalfScene(renderer, "left"));
    this.right = new Half(new HalfScene(renderer, "right"));
    this.playing = false;
    this.endAt = 0;
    this._over = false;
  }

  start() {
    this.left.reset();
    this.right.reset();
    this._over = false;
    this.playing = true;
    this.endAt = performance.now() + DURATION_MS;
  }

  get durationMs() { return DURATION_MS; }

  update(dt, segLeft, segRight) {
    const now = performance.now();
    const spawn = this.playing;
    this.left.update(dt, this.playing ? segLeft : null, now, spawn);
    this.right.update(dt, this.playing ? segRight : null, now, spawn);
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
