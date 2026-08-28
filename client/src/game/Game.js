// Single-player Classic game logic. Lives in screen-pixel space alongside the
// fingertip blade. Owns fruit, spawner, score, and effects; reports events via
// callbacks so the UI layer stays separate.
import { Fruit } from "./Fruit.js";
import { FruitSpawner } from "./FruitSpawner.js";
import { ScoreManager } from "./ScoreManager.js";
import { segmentHitsCircle } from "./slice.js";

const SPEED_GATE = 180; // px/s: even a gentle swipe registers (forgiving)
const HIT_MARGIN = 1.3;  // generous slice radius (camera tracking isn't pixel-perfect)

export class Game {
  constructor(scene, effects, callbacks = {}) {
    this.scene = scene;
    this.effects = effects;
    this.cb = callbacks;
    this.score = new ScoreManager();
    this.spawner = new FruitSpawner();
    this.fruits = [];
    this.playing = false;
  }

  start() {
    this._clearFruits();
    this.effects.clear();
    this.score.reset();
    this.spawner = new FruitSpawner();
    this._over = false;
    this._lastStrike = 0;
    this.playing = true;
    this.cb.onStart?.();
  }

  _clearFruits() {
    for (const f of this.fruits) this.scene.remove(f.mesh);
    this.fruits = [];
  }

  /**
   * @param dt seconds since last frame
   * @param segment {a:{x,y}, b:{x,y}, speed}|Array|null — blade motion this frame.
   *   Katana mode passes an ARRAY, one entry per sample point along the blade. Each
   *   entry is gated on its OWN speed, so a wrist-whip cuts with the tip while the
   *   near-stationary base does not.
   */
  update(dt, segment) {
    const w = this.scene.w, h = this.scene.h;
    const gravity = h * 1.8; // a touch floatier → more hang time, easier to cut
    dt = Math.min(dt, 0.05); // clamp big hitches so physics stay sane

    if (this.playing) {
      for (const spec of this.spawner.update(dt, this.score.score, w, h, gravity)) {
        const f = new Fruit(spec.type, spec);
        this.scene.add(f.mesh);
        this.fruits.push(f);
      }
    }

    const blades = this.playing && segment
      ? (Array.isArray(segment) ? segment : [segment]).filter((s) => s && s.speed > SPEED_GATE)
      : [];

    for (let i = this.fruits.length - 1; i >= 0; i--) {
      const f = this.fruits[i];
      f.update(dt, gravity);

      // First gated segment that reaches the fruit cuts it, and the juice sprays along
      // that same segment — the part of the blade that actually swung is what cuts.
      const hit = !f.sliced && blades.find((s) =>
        segmentHitsCircle(s.a.x, s.a.y, s.b.x, s.b.y, f.x, f.y, f.radius * HIT_MARGIN));
      if (hit) {
        const dx = hit.b.x - hit.a.x, dy = hit.b.y - hit.a.y;
        const len = Math.hypot(dx, dy) || 1;
        this._slice(f, i, { x: dx / len, y: dy / len });
        continue;
      }

      if (f.isOffScreen(h)) {
        this.scene.remove(f.mesh);
        this.fruits.splice(i, 1);
        if (this.playing && !f.sliced && !f.isBomb) this._strike("miss");
      }
    }

    this.effects.update(dt, gravity, h);
  }

  _slice(fruit, idx, dir) {
    fruit.sliced = true;
    this.scene.remove(fruit.mesh);
    this.fruits.splice(idx, 1);

    if (fruit.isBomb) {
      this.effects.explode(fruit);
      this._strike("bomb"); // bomb costs a strike now — not instant death
      return;
    }
    this.effects.sliceBurst(fruit, dir);
    const { comboSize, gained } = this.score.recordSlice(performance.now());
    this.cb.onSlice?.({ fruit, comboSize, gained, score: this.score.score });
  }

  // A lost life from either a missed fruit or a sliced bomb. 3 strikes = over.
  // A short grace window after any hit prevents cascade losses (you don't lose two
  // lives at once when several fruit are falling together).
  _strike(cause) {
    const now = performance.now();
    if (this._lastStrike && now - this._lastStrike < 1200) return;
    this._lastStrike = now;
    const strikes = this.score.recordMiss();
    this.cb.onStrike?.(strikes, cause);
    if (this.score.dead) this._gameOver(cause);
  }

  _gameOver(reason) {
    if (!this._over) {
      this._over = true;
      this.playing = false;
      this.cb.onGameOver?.({ reason, score: this.score.score, best: this.score.best });
    }
  }

  // reset the one-shot game-over guard when a fresh game starts
  reset() { this._over = false; }
}
