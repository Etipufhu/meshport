import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { getBounds } from '@gltf-transform/functions';
import { applyOptions } from '../src/export/process.js';
import { cleanForBlender, getCleanStats, describeDocument } from '../src/export/clean.js';
import { MeshportError } from '../src/errors.js';
import { buildQuad } from './helpers.js';

function bounds(doc) {
  return getBounds(doc.getRoot().listScenes()[0]);
}

// Moves the quad away from the origin: x 2..3, y 5..6.
function offsetQuad() {
  const doc = buildQuad();
  doc.getRoot().listNodes()[0].setTranslation([2, 5, 0]);
  return doc;
}

function gridDoc(n = 20) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const pos = [];
  const uv = [];
  const nor = [];
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      pos.push(x, Math.sin(x * 0.3) * Math.cos(y * 0.3) * 0.5, y);
      uv.push(x / n, y / n);
      nor.push(0, 1, 0);
    }
  }
  const idx = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const mat = doc.createMaterial('m');
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(pos)))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(nor)))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setBuffer(buffer).setArray(new Float32Array(uv)))
    .setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array(idx)))
    .setMaterial(mat);
  const node = doc.createNode('grid').setMesh(doc.createMesh('grid').addPrimitive(prim));
  doc.createScene().addChild(node);
  return doc;
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} should be close to ${b}`);

test('defaults change nothing', async () => {
  const doc = offsetQuad();
  await applyOptions(doc);
  const { min, max } = bounds(doc);
  assert.deepEqual([min[0], max[1]], [2, 6]);
});

test('ground lifts the lowest point to y=0', async () => {
  const doc = offsetQuad();
  await applyOptions(doc, { ground: true });
  const { min } = bounds(doc);
  near(min[1], 0);
  near(min[0], 2);
});

test('center moves the box middle to origin on X/Z only', async () => {
  const doc = offsetQuad();
  await applyOptions(doc, { center: true });
  const { min, max } = bounds(doc);
  near((min[0] + max[0]) / 2, 0);
  near((min[2] + max[2]) / 2, 0);
  near(min[1], 5);
});

test('scale and unit multiply the size', async () => {
  const doc = buildQuad();
  await applyOptions(doc, { scale: 2, unit: 'cm' });
  const { min, max } = bounds(doc);
  near(max[0] - min[0], 200);
  near(max[1] - min[1], 200);
});

test('upAxis z turns Y-up data into Z-up', async () => {
  const doc = buildQuad();
  // The quad lies in X/Y with height 1 along Y; after the turn that height is along Z.
  await applyOptions(doc, { upAxis: 'z', ground: true });
  const { min, max } = bounds(doc);
  near(max[2] - min[2], 1);
  near(min[2], 0);
  near(max[1] - min[1], 0);
});

test('decimate cuts triangles toward the ratio and keeps material, UVs, normals', async () => {
  const doc = gridDoc(20);
  const before = describeDocument(doc).triangles;
  assert.equal(before, 800);
  await applyOptions(doc, { decimate: 0.25 });
  const after = describeDocument(doc).triangles;
  assert.ok(after < before * 0.5, `expected a big cut, got ${after}`);
  assert.ok(after > 0);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.ok(prim.getMaterial());
  assert.ok(prim.getAttribute('TEXCOORD_0'));
  assert.ok(prim.getAttribute('NORMAL'));
});

test('maxTexture downsizes big textures and keeps png', async () => {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { return; }
  const png = await sharp({ create: { width: 256, height: 128, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
  const doc = buildQuad();
  const tex = doc.createTexture('big').setImage(new Uint8Array(png)).setMimeType('image/png');
  doc.getRoot().listMaterials()[0].setBaseColorTexture(tex);
  await applyOptions(doc, { maxTexture: 64 });
  const meta = await sharp(Buffer.from(tex.getImage())).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 64);
  assert.equal(meta.height, 32);
  assert.equal(tex.getMimeType(), 'image/png');
});

test('nonsense options throw bad-input', async () => {
  for (const opts of [{ scale: -1 }, { scale: 0 }, { decimate: 1.5 }, { decimate: -0.1 }, { maxTexture: 0 }, { maxTexture: 12.5 }, { upAxis: 'x' }, { unit: 'km' }]) {
    await assert.rejects(applyOptions(buildQuad(), opts), (err) => err instanceof MeshportError && err.code === 'bad-input');
  }
});

test('getCleanStats reports removed junk and merges, and is empty without cleanup', async () => {
  const doc = buildQuad();
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const buffer = doc.getRoot().listBuffers()[0];
  // A repeated copy of the first corner and an unused far-away vertex.
  prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 90, 90, 90])));
  prim.setAttribute('NORMAL', null).setAttribute('TEXCOORD_0', null);
  prim.setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2, 4, 2, 3])));
  await cleanForBlender(doc);
  const stats = getCleanStats(doc);
  assert.equal(stats.merged, 1);
  assert.equal(stats.vertices, 2);
  assert.equal(stats.triangles, 0);
  assert.equal(stats.lines, 0);

  const plain = buildQuad();
  await cleanForBlender(plain, { cleanup: false });
  assert.equal(getCleanStats(plain), undefined);
});
