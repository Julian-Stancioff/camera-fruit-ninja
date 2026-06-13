// Transient 3D effects: fruit halves flying apart + a big juice spray (biased
// along the blade) + a bright slice flash + bomb explosion.
// Particle materials are POOLED per color (no per-slice allocation) to keep GC
// pauses from freezing the game during heavy combo slicing.
import * as THREE from "three";
import { makeHalves } from "./fruitFactory.js";

const rand = (a, b) => a + Math.random() * (b - a);

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this._blobGeo = new THREE.SphereGeometry(1, 6, 6);
    this._dropGeo = new THREE.SphereGeometry(1, 5, 4);
    this._matCache = new Map(); // color -> shared MeshBasicMaterial
  }

  _mat(color) {
    let m = this._matCache.get(color);
    if (!m) { m = new THREE.MeshBasicMaterial({ color }); this._matCache.set(color, m); }
    return m;
  }

  _spawn(mesh, opts) {
    this.scene.add(mesh);
    this.items.push({
      mesh, t: 0, life: 1, vx: 0, vy: 0, rx: 0, ry: 0, rz: 0,
      shrink: false, flash: false, baseScale: 1, gravity: true, ...opts,
    });
  }

  /** @param dir {x,y} normalized blade direction (or null) — juice sprays along it. */
  sliceBurst(fruit, dir) {
    const halves = makeHalves(fruit.type);
    halves.forEach((g, i) => {
      g.scale.multiplyScalar(fruit.radius);
      g.position.set(fruit.x, fruit.y, 0);
      const s = i === 0 ? 1 : -1;
      this._spawn(g, {
        life: 1.5,
        vx: fruit.vx + s * rand(150, 320), vy: fruit.vy - rand(30, 150),
        rx: rand(-4, 4), ry: rand(-4, 4), rz: s * rand(3, 7),
      });
    });
    this._juice(fruit.x, fruit.y, fruit.meta.juice, 26, dir, fruit.vx);
    this._flash(fruit.x, fruit.y, fruit.radius * 1.5, 0xffffff, 0.8);
  }

  explode(fruit) {
    this._juice(fruit.x, fruit.y, 0x2a2a2a, 18, null, 0, 560);
    this._juice(fruit.x, fruit.y, 0xff7a1a, 24, null, 0, 660);
    this._juice(fruit.x, fruit.y, 0xffd24a, 14, null, 0, 760);
    this._flash(fruit.x, fruit.y, fruit.radius * 2.2, 0xffae3a, 0.95);
  }

  _flash(x, y, r, color, opacity) {
    const m = new THREE.Mesh(this._blobGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity }));
    m.position.set(x, y, 3);
    this._spawn(m, { life: 0.18, gravity: false, flash: true, baseScale: r * 0.5 });
    m.scale.setScalar(r * 0.5);
  }

  _juice(x, y, color, n, dir, drift = 0, speed = 480) {
    const mat = this._mat(color);
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(Math.random() < 0.5 ? this._blobGeo : this._dropGeo, mat);
      const s = rand(3, 12);
      m.scale.setScalar(s);
      m.position.set(x, y, 1);
      const sp = rand(0.35, 1) * speed;
      let vx, vy;
      if (dir) {
        // spray mostly along the cut, with a perpendicular fan — "juice shooting out"
        vx = dir.x * sp * rand(0.6, 1.5) + (-dir.y) * rand(-200, 200);
        vy = dir.y * sp * rand(0.6, 1.5) + (dir.x) * rand(-200, 200);
      } else {
        const ang = rand(0, Math.PI * 2);
        vx = Math.cos(ang) * sp; vy = Math.sin(ang) * sp;
      }
      this._spawn(m, {
        life: rand(0.4, 0.85), vx: vx + drift * 0.3, vy: vy - rand(40, 160),
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
      const k = Math.max(0, 1 - it.t / it.life);
      if (it.flash) { it.mesh.scale.setScalar(it.baseScale * (1 + (1 - k) * 2)); it.mesh.material.opacity = 0.9 * k; }
      else if (it.shrink) it.mesh.scale.setScalar(it.baseScale * k);
      if (it.t >= it.life || it.mesh.position.y > h + 180) {
        this.scene.remove(it.mesh);
        if (it.flash) it.mesh.material.dispose(); // flash mats are unique; pooled juice mats are kept
        this.items.splice(i, 1);
      }
    }
  }

  clear() {
    for (const it of this.items) {
      this.scene.remove(it.mesh);
      if (it.flash) it.mesh.material.dispose();
    }
    this.items = [];
  }
}
