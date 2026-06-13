// Three.js scene in SCREEN-PIXEL space: an orthographic camera mapped so world
// (x,y) == screen (x,y) with y pointing DOWN. That makes the fingertip (tracked
// in screen px) and the fruit live in the exact same coordinate system, so slice
// collision is a plain 2D test while the fruit still render as lit 3D meshes.
import * as THREE from "three";

// Shared lighting for the punchy glossy fruit look.
export function addLights(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  scene.add(new THREE.HemisphereLight(0xfff3d8, 0x3a2a14, 0.55));
  const key = new THREE.DirectionalLight(0xfff4e0, 1.5);
  key.position.set(-0.5, -0.9, 1).multiplyScalar(100);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9ab8ff, 0.45);
  fill.position.set(0.7, 0.5, 0.6).multiplyScalar(100);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.9);
  rim.position.set(0.2, 0.6, -1).multiplyScalar(100);
  scene.add(rim);
}

export class Scene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0); // transparent → background shows through
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
    this.camera.position.z = 100;
    addLights(this.scene);
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.left = 0; this.camera.right = w;
    this.camera.top = 0; this.camera.bottom = h;
    this.camera.updateProjectionMatrix();
    this.w = w; this.h = h;
  }

  add(obj) { this.scene.add(obj); }
  remove(obj) { this.scene.remove(obj); }
  render() {
    // Reset to full-frame (split mode may have left a viewport/scissor set).
    this.renderer.autoClear = true;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.w, this.h);
    this.renderer.render(this.scene, this.camera);
  }
}

// One half of a split screen: its own sub-scene + camera, rendered into the
// left or right viewport of the SHARED renderer. World coords are local
// (0..halfWidth × 0..height, y-down) so each half is an independent board.
export class HalfScene {
  constructor(renderer, side) {
    this.renderer = renderer;
    this.side = side; // "left" | "right"
    this.scene = new THREE.Scene();
    addLights(this.scene);
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
    this.camera.position.z = 100;
    this.resize();
  }
  resize() {
    this.w = Math.floor(window.innerWidth / 2);
    this.h = window.innerHeight;
    this.camera.left = 0; this.camera.right = this.w;
    this.camera.top = 0; this.camera.bottom = this.h;
    this.camera.updateProjectionMatrix();
  }
  add(obj) { this.scene.add(obj); }
  remove(obj) { this.scene.remove(obj); }
  render() {
    const W = window.innerWidth, H = window.innerHeight, hw = Math.floor(W / 2);
    const x = this.side === "left" ? 0 : hw;
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(x, 0, hw, H);
    this.renderer.setScissor(x, 0, hw, H);
    this.renderer.render(this.scene, this.camera);
  }
}
