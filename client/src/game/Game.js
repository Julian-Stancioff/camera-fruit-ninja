// Single-player Classic game logic. Lives in screen-pixel space alongside the
// fingertip blade. Owns fruit, spawner, score, and effects; reports events via
// callbacks so the UI layer stays separate.
import { Fruit } from "./Fruit.js";
import { FruitSpawner } from "./FruitSpawner.js";
import { ScoreManager } from "./ScoreManager.js";
import { segmentHitsCircle } from "./slice.js";

const SPEED_GATE = 280; // px/s: deliberate (even gentle) cuts register; smooth cursor avoids false cuts at rest
const HIT_MARGIN = 1.18; // forgiving slice radius (camera tracking isn't pixel-perfect)

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
    this.playing = true;
    this.cb.onStart?.();
  }

  _clearFruits() {
    for (const f of this.fruits) this.scene.remove(f.mesh);
    this.fruits = [];
  }

  /**
   * @param dt seconds since last frame
   * @param segment {a:{x,y}, b:{x,y}, speed}|null — fingertip motion this frame
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

    const slicing = this.playing && segment && segment.speed > SPEED_GATE;

    for (let i = this.fruits.length - 1; i >= 0; i--) {
      const f = this.fruits[i];
      f.update(dt, gravity);

      if (slicing && !f.sliced &&
          segmentHitsCircle(segment.a.x, segment.a.y, segment.b.x, segment.b.y, f.x, f.y, f.radius * HIT_MARGIN)) {
        this._slice(f, i);
        continue;
      }

      if (f.isOffScreen(h)) {
        this.scene.remove(f.mesh);
        this.fruits.splice(i, 1);
        if (this.playing && !f.sliced && !f.isBomb) this._miss();
      }
    }

    this.effects.update(dt, gravity, h);
  }

  _slice(fruit, idx) {
    fruit.sliced = true;
    this.scene.remove(fruit.mesh);
    this.fruits.splice(idx, 1);

    if (fruit.isBomb) {
      this.effects.explode(fruit);
      this.playing = false;
      this.cb.onBomb?.(fruit);
      this._gameOver("bomb");
      return;
    }
    this.effects.sliceBurst(fruit);
    const { comboSize, gained } = this.score.recordSlice(performance.now());
    this.cb.onSlice?.({ fruit, comboSize, gained, score: this.score.score });
  }

  _miss() {
    const strikes = this.score.recordMiss();
    this.cb.onMiss?.(strikes);
    if (this.score.dead) this._gameOver("strikes");
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
