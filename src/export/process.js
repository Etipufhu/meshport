import { getBounds, simplify, prune } from '@gltf-transform/functions';
import { MeshportError } from '../errors.js';

const UNIT_FACTOR = { m: 1, cm: 100, mm: 1000 };
const MODE_TRIANGLES = 4;

function bad(message, hint) {
  return new MeshportError(message, hint, 'bad-input');
}

// Checks the options up front so nothing is half-applied when a value is nonsense.
function validate(o) {
  if (o.upAxis !== undefined && !['y', 'z'].includes(o.upAxis)) {
    throw bad(`Unknown up axis "${o.upAxis}".`, 'Use "y" or "z".');
  }
  if (o.unit !== undefined && !(o.unit in UNIT_FACTOR)) {
    throw bad(`Unknown unit "${o.unit}".`, 'Use "m", "cm" or "mm".');
  }
  if (o.scale !== undefined && !(typeof o.scale === 'number' && Number.isFinite(o.scale) && o.scale > 0)) {
    throw bad('Scale must be a number above zero.', 'Try 1 for the original size.');
  }
  if (o.decimate !== undefined && !(typeof o.decimate === 'number' && o.decimate >= 0 && o.decimate <= 1)) {
    throw bad('Decimate must be a ratio between 0 and 1.', 'For example 0.5 keeps about half of the triangles.');
  }
  if (o.maxTexture !== undefined && !(Number.isInteger(o.maxTexture) && o.maxTexture > 0)) {
    throw bad('Max texture size must be a whole number above zero.', 'For example 1024 or 2048.');
  }
}

function countTriangles(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== MODE_TRIANGLES) continue;
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      n += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
    }
  }
  return n;
}

async function decimateDoc(doc, ratio) {
  if (ratio >= 1 || !countTriangles(doc)) return;
  let MeshoptSimplifier;
  try {
    ({ MeshoptSimplifier } = await import('meshoptimizer'));
    await MeshoptSimplifier.ready;
  } catch (err) {
    throw new MeshportError('The mesh simplifier could not be loaded.', 'Reinstall dependencies with npm install.', 'missing-dependency');
  }
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: true }));
  await doc.transform(prune({ keepAttributes: true, keepLeaves: true, keepExtras: true }));
}

async function resizeTextures(doc, max) {
  const textures = doc.getRoot().listTextures();
  if (!textures.length) return;
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (err) {
    throw new MeshportError(
      'Texture resizing needs the "sharp" package, which could not be loaded.',
      'Run npm install in the meshport folder, or leave the texture size limit off.',
      'missing-dependency',
    );
  }
  for (const tex of textures) {
    const image = tex.getImage();
    if (!image) continue;
    const mime = tex.getMimeType();
    let meta;
    try {
      meta = await sharp(image).metadata();
    } catch {
      continue; // an image sharp cannot read is left alone
    }
    if (!meta.width || !meta.height || (meta.width <= max && meta.height <= max)) continue;
    let pipe = sharp(image).resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
    if (mime === 'image/jpeg') pipe = pipe.jpeg({ quality: 90 });
    else if (mime === 'image/webp') pipe = pipe.webp({ quality: 90 });
    else pipe = pipe.png();
    const out = await pipe.toBuffer();
    tex.setImage(new Uint8Array(out));
  }
}

// Applies the optional export tweaks to `doc` (mutates and returns it). Everything is off
// by default. Transforms go into one wrapper node above the scene content, so models with
// many nodes, animations or skins keep working.
export async function applyOptions(doc, options = {}) {
  const o = options || {};
  validate(o);

  // Mesh work first, while the vertex data is still in its original space.
  if (o.decimate !== undefined) await decimateDoc(doc, o.decimate);
  if (o.maxTexture !== undefined) await resizeTextures(doc, o.maxTexture);

  const factor = (o.scale ?? 1) * UNIT_FACTOR[o.unit ?? 'm'];
  const rotate = o.upAxis === 'z';
  if (!rotate && factor === 1 && !o.center && !o.ground) return doc;

  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  if (!scene) return doc;

  const wrapper = doc.createNode('meshport-root');
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    wrapper.addChild(child);
  }
  scene.addChild(wrapper);
  // Y-up to Z-up is a quarter turn around X.
  if (rotate) wrapper.setRotation([Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  if (factor !== 1) wrapper.setScale([factor, factor, factor]);

  if (o.center || o.ground) {
    const up = rotate ? 2 : 1;
    const { min, max } = getBounds(scene);
    if (![...min, ...max].every(Number.isFinite)) return doc;
    const t = [0, 0, 0];
    if (o.center) {
      // Center on the floor plane, which is X/Z for Y-up and X/Y for Z-up.
      for (let k = 0; k < 3; k++) if (k !== up) t[k] = -(min[k] + max[k]) / 2;
    }
    if (o.ground) t[up] = -min[up];
    wrapper.setTranslation(t);
  }
  return doc;
}
