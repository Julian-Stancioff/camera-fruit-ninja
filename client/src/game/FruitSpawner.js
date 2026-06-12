// Timed fruit spawner with a difficulty curve. Launches from below the bottom edge
// with an upward velocity that arcs the fruit into view (screen space, y down).
import { FRUIT_TYPES } from "../rendering/fruitFactory.js";

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export class FruitSpawner {
  constructor() {
    this.timer = 0;
    this.nextIn = 0.8;
  }

  // Interval shrinks as score climbs (1100ms → ~480ms by score ~60).
  _interval(score) {
    const t = Math.min(1, score / 60);
    return rand(0.95, 1.25) * (1.1 - 0.62 * t);
  }

  /** Advance time; return an array of spawn specs (possibly empty). */
  update(dt, score, w, h, gravity) {
    this.timer += dt;
    if (this.timer < this.nextIn) return [];
    this.timer = 0;
    this.nextIn = this._interval(score);
    return this._wave(score, w, h, gravity);
  }

  _wave(score, w, h, gravity) {
    const count = Math.random() < 0.5 ? 1 : Math.random() < 0.8 ? 2 : 3;
    const bombChance = Math.min(0.18, 0.06 + score / 600);
    const baseR = Math.min(w, h) * 0.055;
    const specs = [];
    let bombs = 0;
    for (let i = 0; i < count; i++) {
      let type = pick(FRUIT_TYPES);
      // Allow at most one bomb per wave, never the very first spawns.
      if (score > 4 && bombs === 0 && Math.random() < bombChance) { type = "bomb"; bombs++; }
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
