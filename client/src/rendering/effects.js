// Transient 3D effects: fruit halves flying apart + juice particle bursts +
// bomb explosion. Self-managed lifetimes; expired objects leave the scene.
import * as THREE from "three";
import { makeHalves } from "./fruitFactory.js";

const rand = (a, b) => a + Math.random() * (b - a);

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this._juiceGeo = new THREE.SphereGeometry(1, 6, 6);
  }

  _spawn(mesh, opts) {
    this.scene.add(mesh);
    this.items.push({
      mesh, t: 0, life: 1, vx: 0, vy: 0,
      rx: 0, ry: 0, rz: 0, shrink: false, baseScale: 1, gravity: true, ...opts,
    });
  }

  sliceBurst(fruit) {
    // Two halves fly apart along the slice.
    const halves = makeHalves(fruit.type);
    halves.forEach((g, i) => {
      g.scale.multiplyScalar(fruit.radius);
      g.position.set(fruit.x, fruit.y, 0);
      const dir = i === 0 ? 1 : -1;
      this._spawn(g, {
        life: 1.4,
        vx: fruit.vx + dir * rand(130, 280),
        vy: fruit.vy - rand(20, 120),
        rx: rand(-3, 3), ry: rand(-3, 3), rz: dir * rand(2, 6),
      });
    });
    this._juice(fruit.x, fruit.y, fruit.meta.juice, 16, fruit.vx);
  }

  explode(fruit) {
    this._juice(fruit.x, fruit.y, 0x2a2a2a, 16, 0, 520);
    this._juice(fruit.x, fruit.y, 0xff7a1a, 18, 0, 600);
    this._juice(fruit.x, fruit.y, 0xffd24a, 10, 0, 680);
  }

  _juice(x, y, color, n, drift = 0, speed = 420) {
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(this._juiceGeo, new THREE.MeshBasicMaterial({ color }));
      const s = rand(3, 9);
      m.scale.setScalar(s);
      m.position.set(x, y, 1);
      const ang = rand(0, Math.PI * 2), sp = rand(0.4, 1) * speed;
      this._spawn(m, {
        life: rand(0.35, 0.7),
        vx: Math.cos(ang) * sp + drift * 0.3,
        vy: Math.sin(ang) * sp - rand(40, 160),
        shrink: true, baseScale: s,
      });
    }
  }

  update(dt, gravity, h) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.gravity) it.vy += gravity * dt;
      it.mesh.position.x += it.vx * dt;
      it.mesh.position.y += it.vy * dt;
      it.mesh.rotation.x += it.rx * dt;
      it.mesh.rotation.y += it.ry * dt;
      it.mesh.rotation.z += it.rz * dt;
      if (it.shrink) {
        const k = Math.max(0, 1 - it.t / it.life);
        it.mesh.scale.setScalar(it.baseScale * k);
      }
      if (it.t >= it.life || it.mesh.position.y > h + 160) {
        this.scene.remove(it.mesh);
        this.items.splice(i, 1);
      }
    }
  }

  clear() {
    for (const it of this.items) this.scene.remove(it.mesh);
    this.items = [];
  }
}
