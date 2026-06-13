// Client-side controller for a competitive 1v1 match. Reuses the same Scene,
// Effects, Fruit and blade machinery as solo play, but the fruit stream comes from
// the authoritative server (normalized coords → local pixels) and scoring is
// server-confirmed. Local slices are predicted instantly for feel; the score only
// moves when the server says so.
import { Fruit } from "../game/Fruit.js";
import { segmentHitsCircle } from "../game/slice.js";

const SPEED_GATE = 280;
const HIT_MARGIN = 1.18;

export class NetGame {
  constructor(scene, effects, socket, you, cb = {}) {
    this.scene = scene;
    this.effects = effects;
    this.socket = socket;
    this.you = you;          // 0 or 1
    this.cb = cb;
    this.fruits = new Map(); // netId -> Fruit
    this.localSliced = new Set();
    this.gravityNorm = 1.5;
    this.scores = [0, 0];
    this.playing = false;

    socket.on("spawn", ({ fruits }) => this._spawn(fruits));
    socket.on("sliced", (d) => this._onSliced(d));
    socket.on("tick", (d) => { this.scores = d.scores; cb.onTick?.(d); });
    socket.on("over", (o) => { this.playing = false; cb.onOver?.(o); });
    socket.on("oppBlade", (b) => cb.onOppBlade?.(b));
    socket.on("oppLeft", () => { this.playing = false; cb.onOppLeft?.(); });
  }

  begin(gravityNorm) { this.gravityNorm = gravityNorm || this.gravityNorm; this.playing = true; }

  _spawn(list) {
    const W = this.scene.w, H = this.scene.h, M = Math.min(W, H);
    for (const f of list) {
      const spec = {
        x: f.nx * W, y: f.ny * H, vx: f.vx * W, vy: f.vy * H, radius: f.radius * M,
      };
      const fruit = new Fruit(f.type, spec);
      fruit.netId = f.id;
      this.scene.add(fruit.mesh);
      this.fruits.set(f.id, fruit);
    }
  }

  update(dt, segment) {
    const H = this.scene.h, gravity = this.gravityNorm * H;
    dt = Math.min(dt, 0.05);
    const slicing = this.playing && segment && segment.speed > SPEED_GATE;

    for (const [id, f] of this.fruits) {
      f.update(dt, gravity);
      if (slicing && !this.localSliced.has(id) &&
          segmentHitsCircle(segment.a.x, segment.a.y, segment.b.x, segment.b.y, f.x, f.y, f.radius * HIT_MARGIN)) {
        // Predict the cut locally for instant feel; score arrives from the server.
        this.localSliced.add(id);
        const dx = segment.b.x - segment.a.x, dy = segment.b.y - segment.a.y, len = Math.hypot(dx, dy) || 1;
        if (f.isBomb) this.effects.explode(f); else this.effects.sliceBurst(f, { x: dx / len, y: dy / len });
        this.scene.remove(f.mesh);
        this.fruits.delete(id);
        this.socket.emit("slice", { fruitId: id });
        continue;
      }
      if (f.isOffScreen(H)) { this.scene.remove(f.mesh); this.fruits.delete(id); }
    }
    this.effects.update(dt, gravity, H);
  }

  _onSliced({ fruitId, by, type, scores }) {
    this.scores = scores;
    this.cb.onScores?.(scores);
    const f = this.fruits.get(fruitId); // opponent claimed one we still had
    if (f) {
      if (f.isBomb) this.effects.explode(f); else this.effects.sliceBurst(f);
      this.scene.remove(f.mesh);
      this.fruits.delete(fruitId);
    }
  }

  clear() {
    for (const f of this.fruits.values()) this.scene.remove(f.mesh);
    this.fruits.clear();
    this.localSliced.clear();
    this.effects.clear();
  }
}
