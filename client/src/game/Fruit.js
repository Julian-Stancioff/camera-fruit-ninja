// A flying fruit (or bomb). Physics run in screen pixels with y pointing DOWN, so
// gravity is +y and an upward launch is negative vy. The 3D mesh is parked at the
// same (x,y) and tumbles for visual life.
import { makeWhole, fruitMeta } from "../rendering/fruitFactory.js";

export class Fruit {
  constructor(type, { x, y, vx, vy, radius }) {
    this.type = type;
    this.isBomb = type === "bomb";
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.radius = radius;
    this.sliced = false;
    this.scored = false;
    this.meta = fruitMeta(type);

    this.mesh = makeWhole(type);
    this.mesh.scale.multiplyScalar(radius);
    this.mesh.position.set(x, y, 0);
    this.rot = {
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      z: (Math.random() - 0.5) * 3,
    };
    this.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
  }

  update(dt, gravity) {
    this.vy += gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.mesh.position.set(this.x, this.y, 0);
    this.mesh.rotation.x += this.rot.x * dt;
    this.mesh.rotation.y += this.rot.y * dt;
    this.mesh.rotation.z += this.rot.z * dt;
    // Flicker the bomb spark.
    if (this.isBomb) {
      const spark = this.mesh.getObjectByName("spark");
      if (spark) spark.visible = Math.random() > 0.3;
    }
  }

  isOffScreen(h) {
    return this.y - this.radius > h + 80;
  }
}
