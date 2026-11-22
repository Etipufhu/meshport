import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanForBlender } from '../src/export/clean.js';
import { exportDocument } from '../src/export/index.js';
import { toObj } from '../src/export/obj.js';
import { readGlb, getIO } from '../src/export/io.js';
import { MeshportError } from '../src/errors.js';
import { buildQuad, compressedGlb } from './helpers.js';

test('compressed GLB comes out without meshopt or quantization', async () => {
  const input = await compressedGlb();
  const before = await readGlb(input);
  assert.ok(before.getRoot().listExtensionsUsed().some((e) => e.extensionName === 'EXT_meshopt_compression'), 'test file should be compressed');

  const doc = await cleanForBlender(before);
  const io = await getIO();
  const out = Buffer.from(await io.writeBinary(doc));
  const json = JSON.parse(out.subarray(20, 20 + out.readUInt32LE(12)).toString('utf8'));
  const used = json.extensionsUsed || [];
  assert.ok(!used.includes('EXT_meshopt_compression'));
  assert.ok(!used.includes('KHR_mesh_quantization'));

  const check = await readGlb(out);
  const pos = check.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION');
  assert.equal(pos.getComponentType(), 5126, 'positions are plain float32');
  assert.equal(pos.getCount(), 4);
});

test('cleanup removes lines, degenerate and paper-thin triangles and unused vertices', async () => {
  const doc = buildQuad();
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  // Add 3 extra vertices: a far-away one, and a point in the middle of an edge (collinear).
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 500, 500, 0, 0.5, 0, 0, 0.25, 0, 0]);
  const buffer = doc.getRoot().listBuffers()[0];
  prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(pos));
  prim.setAttribute('NORMAL', null).setAttribute('TEXCOORD_0', null);
  prim.setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3, 0, 1, 1, 0, 5, 6, 0, 1, 4])));
  // Triangles: 2 good, 1 repeated corner, 1 collinear (zero area), 1 huge sliver (0,1 -> 500,500 is real area, kept).
  const line = doc.createPrimitive().setMode(1).setAttribute('POSITION', prim.getAttribute('POSITION'));
  doc.getRoot().listMeshes()[0].addPrimitive(line);

  const doc2 = await cleanForBlender(doc);
  const prims = doc2.getRoot().listMeshes()[0].listPrimitives();
  assert.equal(prims.length, 1, 'line primitive is gone');
  const out = prims[0];
  assert.equal(out.getIndices().getCount(), 9, 'two quad triangles plus the one with real area');
  assert.equal(out.getAttribute('POSITION').getCount(), 5, 'unused vertices are dropped');
});

// A quad made of two triangles with 6 separate vertices (nothing shared), starting at x.
function unweldedQuad(x, noise = 0, uvShift = 0) {
  const p = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
  const pos = [];
  const nor = [];
  const uv = [];
  p.forEach(([u, v], i) => {
    pos.push(x + u + (i === 3 ? noise : 0), v, 0);
    nor.push(0, 0, 1);
    uv.push(u + (i >= 3 ? uvShift : 0), v);
  });
  return { pos, nor, uv };
}

function docFromQuads(quads) {
  const doc = buildQuad();
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const buffer = doc.getRoot().listBuffers()[0];
  const cat = (key) => quads.flatMap((q) => q[key]);
  const acc = (type, arr) => doc.createAccessor().setType(type).setBuffer(buffer).setArray(new Float32Array(arr));
  prim.setAttribute('POSITION', acc('VEC3', cat('pos')))
    .setAttribute('NORMAL', acc('VEC3', cat('nor')))
    .setAttribute('TEXCOORD_0', acc('VEC2', cat('uv')))
    .setIndices(null);
  return { doc, prim };
}

test('merge by distance welds a part to itself', async () => {
  const { doc } = docFromQuads([unweldedQuad(0, 1e-7)]);
  await cleanForBlender(doc);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.equal(prim.getAttribute('POSITION').getCount(), 4, '6 loose corners become 4 shared vertices');
  assert.equal(prim.getIndices().getCount(), 6);
});

test('merge by distance never joins separate parts, even when they almost touch', async () => {
  // Second quad starts 1e-6 away from the first one's right edge: far inside the merge distance.
  const { doc } = docFromQuads([unweldedQuad(0), unweldedQuad(1 + 1e-6)]);
  await cleanForBlender(doc);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.equal(prim.getAttribute('POSITION').getCount(), 8, 'each quad welds inside itself only: 4 + 4');
  assert.equal(prim.getIndices().getCount(), 12);
});

test('merge by distance keeps UV seams', async () => {
  const { doc } = docFromQuads([unweldedQuad(0, 0, 0.5)]);
  await cleanForBlender(doc);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.equal(prim.getAttribute('POSITION').getCount(), 6, 'corners with different UVs stay split');
});

test('cleanup leaves a clean model untouched', async () => {
  const doc = await cleanForBlender(buildQuad());
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.equal(prim.getAttribute('POSITION').getCount(), 4);
  assert.equal(prim.getIndices().getCount(), 6);
  assert.ok(prim.getAttribute('NORMAL') && prim.getAttribute('TEXCOORD_0'));
});

test('readGlb rejects files that are not GLB', async () => {
  await assert.rejects(() => readGlb(Buffer.from('hello world, not a glb')), (e) => e instanceof MeshportError && e.code === 'bad-file');
});

test('OBJ export has the right counts and flips V', () => {
  const { files } = toObj(buildQuad({ withTexture: true }), 'quad');
  const obj = files.find((f) => f.name === 'quad.obj').data.toString();
  assert.equal(obj.split('\n').filter((l) => l.startsWith('v ')).length, 4);
  assert.equal(obj.split('\n').filter((l) => l.startsWith('f ')).length, 2);
  assert.match(obj, /vt 0 1\n/, 'V is flipped for OBJ');
  const mtl = files.find((f) => f.name === 'quad.mtl').data.toString();
  assert.match(mtl, /map_Kd textures\/red_baseColor\.png/);
  assert.ok(files.some((f) => f.name === 'textures/red_baseColor.png'));
});

test('exportDocument writes into a fresh folder per model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meshport-'));
  const a = await exportDocument(buildQuad(), { name: 'My Model', formats: ['glb', 'obj'], outDir: dir, credit: 'by someone' });
  const b = await exportDocument(buildQuad(), { name: 'My Model', formats: ['glb'], outDir: dir });
  assert.equal(a.folder, 'My Model');
  assert.equal(b.folder, 'My Model-2');
  const names = a.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['CREDITS.txt', 'My Model.glb', 'My Model.mtl', 'My Model.obj']);
  assert.equal(a.stats.triangles, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test('exportDocument refuses unknown formats and empty models', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meshport-'));
  await assert.rejects(() => exportDocument(buildQuad(), { name: 'x', formats: ['xyz'], outDir: dir }), MeshportError);
  const { Document } = await import('@gltf-transform/core');
  await assert.rejects(() => exportDocument(new Document(), { name: 'empty', formats: ['glb'], outDir: dir }), (e) => e.code === 'empty-model');
  assert.deepEqual(await fs.readdir(dir), [], 'no leftover folder after a failure');
  await fs.rm(dir, { recursive: true, force: true });
});
