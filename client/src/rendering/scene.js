// Three.js scene in SCREEN-PIXEL space: an orthographic camera mapped so world
// (x,y) == screen (x,y) with y pointing DOWN. That makes the fingertip (tracked
// in screen px) and the fruit live in the exact same coordinate system, so slice
// collision is a plain 2D test while the fruit still render as lit 3D meshes.
import * as THREE from "three";

export class Scene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0); // transparent → dojo background shows through
    this.scene = new THREE.Scene();

    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
    this.camera.position.z = 100;

    // Lighting tuned for glossy fruit highlights.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xfff4e0, 1.15);
    key.position.set(-0.4, -0.8, 1).multiplyScalar(100); // from upper-left, toward camera
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(0.6, 0.5, 0.6).multiplyScalar(100);
    this.scene.add(fill);

    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    // left=0,right=w,top=0,bottom=h → world y increases downward (screen space).
    this.camera.left = 0; this.camera.right = w;
    this.camera.top = 0; this.camera.bottom = h;
    this.camera.updateProjectionMatrix();
    this.w = w; this.h = h;
  }

  add(obj) { this.scene.add(obj); }
  remove(obj) { this.scene.remove(obj); }
  render() { this.renderer.render(this.scene, this.camera); }
}
