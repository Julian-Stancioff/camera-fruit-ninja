// Timed fruit spawner with a difficulty curve. Launches from below the bottom edge
// with an upward velocity that arcs the fruit into view (screen space, y down).
import { FRUIT_TYPES } from "../rendering/fruitFactory.js";

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export class FruitSpawner {
  constructor() {
    this.timer = 0;
    this.nextIn = 1.3; // gentle start — give the player a moment to orient
    this.elapsed = 0;       // seconds since the spawner started (drives bomb timing)
    this.bombSpawned = false;
  }

  // Interval shrinks as score climbs: slow start (~1.7s) → busy (~0.55s) by score ~70.
  _interval(score) {
    const t = Math.min(1, score / 70);
    return rand(0.9, 1.1) * (1.7 - 1.15 * t);
  }

  /** Advance time; return an array of spawn specs (possibly empty). */
  update(dt, score, w, h, gravity) {
    this.elapsed += dt;
    this.timer += dt;
    if (this.timer < this.nextIn) return [];
    this.timer = 0;
    this.nextIn = this._interval(score);
    return this._wave(score, w, h, gravity);
  }

  _wave(score, w, h, gravity) {
    // Fruit-per-wave grows with score: ~1 early, up to ~5 late.
    const t = Math.min(1, score / 80);
    const maxCount = 1 + Math.round(4 * t); // 1 → 5
    let count = 1;
    for (let k = 1; k < maxCount; k++) if (Math.random() < 0.4 + 0.3 * t) count++;

    // Bombs arrive early — by TIME, not score: eligible from ~4s, likely within the
    // first 5–10s, and guaranteed by ~9s if the dice haven't produced one yet.
    const bombEligible = this.elapsed > 4;
    const bombChance = Math.min(0.3, 0.22 + this.elapsed / 200);
    const forceBomb = bombEligible && !this.bombSpawned && this.elapsed > 6.5;
    const baseR = Math.min(w, h) * 0.064;
    const specs = [];
    let bombs = 0;
    for (let i = 0; i < count; i++) {
      let type = pick(FRUIT_TYPES);
      // At most one bomb per wave.
      if (bombEligible && bombs === 0 && ((forceBomb && i === 0) || Math.random() < bombChance)) {
        type = "bomb"; bombs++; this.bombSpawned = true;
      }
      const radius = type === "watermelon" ? baseR * 1.35
        : type === "bomb" ? baseR * 1.0 : baseR * rand(0.82, 1.05);

      const x = rand(w * 0.12, w * 0.88);
      // Aim drift toward the centre so fruit stay on screen.
      const vx = ((w / 2 - x) / (w / 2)) * rand(60, 200) + rand(-90, 90);
      const rise = rand(0.58, 0.86) * h;       // how high it should climb
      const vy = -Math.sqrt(2 * gravity * rise); // upward launch
      specs.push({ type, x, y: h + radius + 10, vx, vy, radius });
    }
    return specs;
  }
}
