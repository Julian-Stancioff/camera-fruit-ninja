// Procedural 3D fruit + bomb meshes (no external models). Each builder returns a
// THREE.Group sized to ~unit radius; the game scales it to the desired pixel size.
// Glossy MeshPhong materials sell the "3D fruit" look under the scene lighting.
import * as THREE from "three";

function canvasTexture(draw, size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---- textures ----
const watermelonTex = () => canvasTexture((x, s) => {
  x.fillStyle = "#3a8a32"; x.fillRect(0, 0, s, s);
  x.strokeStyle = "#1f5e1c"; x.lineWidth = s * 0.05;
  for (let i = 0; i < 12; i++) {
    x.beginPath();
    const cx = (i / 12) * s;
    x.moveTo(cx, 0);
    x.bezierCurveTo(cx + s * 0.04, s * 0.33, cx - s * 0.04, s * 0.66, cx, s);
    x.stroke();
  }
});
const orangeTex = (base, spec) => canvasTexture((x, s) => {
  x.fillStyle = base; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 1400; i++) {
    x.fillStyle = spec;
    x.globalAlpha = Math.random() * 0.5;
    x.beginPath();
    x.arc(Math.random() * s, Math.random() * s, Math.random() * 1.6 + 0.4, 0, 7);
    x.fill();
  }
  x.globalAlpha = 1;
});
const strawberryTex = () => canvasTexture((x, s) => {
  x.fillStyle = "#d51e23"; x.fillRect(0, 0, s, s);
  x.fillStyle = "#ffe08a";
  for (let i = 0; i < 90; i++) {
    const px = Math.random() * s, py = Math.random() * s;
    x.beginPath(); x.ellipse(px, py, s * 0.012, s * 0.022, Math.random() * 3, 0, 7); x.fill();
  }
});
const pineappleTex = () => canvasTexture((x, s) => {
  x.fillStyle = "#d99a2b"; x.fillRect(0, 0, s, s);
  x.strokeStyle = "#a86a16"; x.lineWidth = s * 0.02;
  for (let i = -s; i < s; i += s * 0.11) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i + s, s); x.stroke();
    x.beginPath(); x.moveTo(i + s, 0); x.lineTo(i, s); x.stroke();
  }
});
const kiwiTex = () => orangeTex("#7a5230", "#3d2a18");

function glossy(opts) {
  // brighter, tighter highlight = juicier, more 3D-looking fruit
  return new THREE.MeshPhongMaterial({ shininess: 95, specular: 0x666666, ...opts });
}

// type config: builder + the flesh/juice colors used by slicing effects
export const FRUIT_TYPES = ["watermelon", "apple", "orange", "lemon", "strawberry", "kiwi", "pineapple"];

const STEM = () => {
  const g = new THREE.Group();
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.07, 0.35, 8),
    glossy({ color: 0x6b4a2b }));
  stem.position.y = 1.0;
  g.add(stem);
  const leaf = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 10, 6),
    glossy({ color: 0x3fae3a }));
  leaf.scale.set(1.4, 0.25, 0.9);
  leaf.position.set(0.18, 1.08, 0);
  g.add(leaf);
  return g;
};

const CROWN = (color = 0x3fae3a) => {
  const g = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.7, 6), glossy({ color }));
    const a = (i / 7) * Math.PI * 2;
    spike.position.set(Math.cos(a) * 0.18, 1.05 + Math.random() * 0.15, Math.sin(a) * 0.18);
    spike.rotation.z = -Math.cos(a) * 0.5;
    spike.rotation.x = Math.sin(a) * 0.5;
    g.add(spike);
  }
  return g;
};

const META = {
  watermelon: { flesh: 0xff5a6a, juice: 0xff3b53, r: 1.15 },
  apple:      { flesh: 0xfff2d6, juice: 0xf6d36b, r: 0.95 },
  orange:     { flesh: 0xffa83a, juice: 0xff9b2f, r: 0.95 },
  lemon:      { flesh: 0xfff07a, juice: 0xffe34a, r: 0.9 },
  strawberry: { flesh: 0xff7d86, juice: 0xff3b53, r: 0.9 },
  kiwi:       { flesh: 0x88c540, juice: 0x9ad84f, r: 0.85 },
  pineapple:  { flesh: 0xffe27a, juice: 0xffd24a, r: 1.05 },
  bomb:       { flesh: 0x222222, juice: 0x444444, r: 1.0 },
};

export function fruitMeta(type) { return META[type]; }

function body(type) {
  switch (type) {
    case "watermelon": {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 32), glossy({ map: watermelonTex() }));
      return m;
    }
    case "apple": {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 36, 28), glossy({ color: 0xe22b2b }));
      m.scale.set(1, 0.92, 1);
      g.add(m, STEM());
      return g;
    }
    case "orange":
      return new THREE.Mesh(new THREE.SphereGeometry(1, 36, 28), glossy({ map: orangeTex("#ff9b1f", "#c96e10") }));
    case "lemon": {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 36, 28), glossy({ map: orangeTex("#ffd21f", "#d9a300") }));
      m.scale.set(0.82, 1.12, 0.82);
      return m;
    }
    case "strawberry": {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.9, 28), glossy({ map: strawberryTex() }));
      m.rotation.x = Math.PI; m.position.y = -0.1;
      g.add(m, CROWN());
      return g;
    }
    case "kiwi":
      return new THREE.Mesh(new THREE.SphereGeometry(1, 30, 24), glossy({ map: kiwiTex(), shininess: 8 }));
    case "pineapple": {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 26), glossy({ map: pineappleTex() }));
      m.scale.set(0.85, 1.18, 0.85);
      g.add(m, CROWN(0x4a9b2f));
      return g;
    }
    case "bomb": {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 26),
        new THREE.MeshPhongMaterial({ color: 0x161616, shininess: 120, specular: 0xaaaaaa }));
      g.add(m);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.3, 12), glossy({ color: 0x444444 }));
      cap.position.y = 1.0; g.add(cap);
      const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), glossy({ color: 0x7a5a30 }));
      fuse.position.set(0.1, 1.35, 0); fuse.rotation.z = -0.4; g.add(fuse);
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd24a }));
      spark.position.set(0.22, 1.6, 0); spark.name = "spark"; g.add(spark);
      return g;
    }
    default:
      return new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), glossy({ color: 0xff4444 }));
  }
}

/** A whole fruit/bomb mesh, scaled so its visual radius ≈ 1. */
export function makeWhole(type) {
  const g = new THREE.Group();
  g.add(body(type));
  const r = META[type]?.r ?? 1;
  g.scale.setScalar(1 / r);
  return g;
}

/** Two half meshes (rind hemisphere + flat flesh cap) that fly apart on slice. */
export function makeHalves(type) {
  const meta = META[type] ?? META.apple;
  const rindColor = type === "watermelon" ? 0x2f7a2a
    : type === "kiwi" ? 0x6b4a28
    : type === "bomb" ? 0x161616 : null;
  const make = (sign) => {
    const g = new THREE.Group();
    const hemi = new THREE.Mesh(
      new THREE.SphereGeometry(1, 28, 20, 0, Math.PI),
      glossy(rindColor != null ? { color: rindColor } : { color: 0xffffff, map: body(type).material?.map || null }));
    // Use the same body material where possible for color fidelity.
    const src = body(type);
    const srcMat = (src.material || src.children?.[0]?.material);
    if (srcMat) hemi.material = srcMat;
    hemi.rotation.y = sign > 0 ? 0 : Math.PI;
    const cap = new THREE.Mesh(new THREE.CircleGeometry(1, 28),
      glossy({ color: meta.flesh, shininess: 20 }));
    cap.rotation.y = sign > 0 ? -Math.PI / 2 : Math.PI / 2;
    cap.position.x = sign * 0.01;
    g.add(hemi, cap);
    g.scale.setScalar(1 / (meta.r ?? 1));
    return g;
  };
  return [make(1), make(-1)];
}
