// 3D preview. Loaded on demand so the rest of the page works even if WebGL is missing.
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/addons/loaders/GLTFLoader.js';
import { OrbitControls } from '/vendor/addons/controls/OrbitControls.js';

let current = null;

export function closePreview() {
  if (!current) return;
  const c = current;
  current = null;
  c.dead = true;
  cancelAnimationFrame(c.raf);
  c.ro.disconnect();
  c.controls.dispose();
  c.scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v && v.isTexture) { v.dispose(); v.source?.data?.close?.(); }
      m.dispose();
    }
  });
  c.renderer.dispose();
  c.renderer.forceContextLoss();
  c.renderer.domElement.remove();
}

// Shows the model at `url` inside `stage`. Returns { setWireframe(bool) }.
export async function openPreview(stage, url, onStatus = () => {}) {
  closePreview();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const c = { renderer, scene, camera, controls, dead: false, raf: 0, ro: null };
  current = c;

  const resize = () => {
    const w = stage.clientWidth || 300;
    const h = stage.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  c.ro = new ResizeObserver(resize);
  c.ro.observe(stage);
  resize();

  const loop = () => {
    if (c.dead) return;
    c.raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  onStatus('Loading model...');
  const gltf = await new GLTFLoader().loadAsync(url);
  if (c.dead) return null;
  const model = gltf.scene;
  scene.add(model);

  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) { onStatus('This file has nothing to show.'); return { setWireframe() {} }; }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 1e-6);

  const grid = new THREE.GridHelper(r * 4, 20, 0x888888, 0x555555);
  grid.position.set(sphere.center.x, box.min.y, sphere.center.z);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  const dist = r / Math.sin((camera.fov * Math.PI) / 360);
  camera.near = r / 100;
  camera.far = r * 100;
  camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(dist * 1.1));
  camera.updateProjectionMatrix();
  controls.target.copy(sphere.center);
  controls.update();
  onStatus('Drag to rotate, scroll to zoom, right-drag to move.');

  return {
    setWireframe(on) {
      model.traverse((o) => {
        for (const m of [].concat(o.material || [])) m.wireframe = on;
      });
    },
  };
}
