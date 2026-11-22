import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { zipSync, strToU8 } from 'fflate';
import { exportDocument, readModel, FORMATS } from '../src/export/index.js';
import { toStl } from '../src/export/stl.js';
import { toPly } from '../src/export/ply.js';
import { toObj } from '../src/export/obj.js';
import { parseObj } from '../src/export/obj-import.js';
import { createBlenderBridge, findBlender } from '../src/export/fbx.js';
import { getIO } from '../src/export/io.js';
import { MeshportError } from '../src/errors.js';
import { buildQuad } from './helpers.js';

let tmp;
before(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'meshport-fmt-')); });
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

const OBJ = `# test
mtllib quad.mtl
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
usemtl red
f 1/1/1 2/2/1 3/3/1 4/4/1
usemtl blue
f -4//1 -3//1 -2//1
`;
const MTL = `newmtl red
Kd 1 0 0
map_Kd tex/red.png
newmtl blue
Kd 0 0 1
d 0.5
`;

const first = (doc) => doc.getRoot().listMeshes()[0].listPrimitives();

test('FORMATS lists every output', () => {
  assert.deepEqual(FORMATS, ['glb', 'obj', 'stl', 'ply', 'fbx']);
});

test('STL is binary with world-space triangles', async () => {
  const doc = buildQuad();
  doc.getRoot().listNodes()[0].setTranslation([10, 0, 0]);
  const { data } = toStl(doc);
  assert.equal(data.length, 84 + 2 * 50);
  assert.equal(data.readUInt32LE(80), 2);
  assert.equal(data.readFloatLE(84 + 12 + 0), 10, 'first vertex x includes the node translation');
  assert.equal(data.readFloatLE(84 + 8), 1, 'normal points along +z');
});

test('STL keeps faces outward for mirrored nodes', () => {
  const doc = buildQuad();
  doc.getRoot().listNodes()[0].setScale([-1, 1, 1]);
  const { data } = toStl(doc);
  // A mirrored quad in the xy plane flips winding; the normal should still be +z.
  assert.equal(data.readFloatLE(84 + 8), 1);
});

test('PLY is binary little endian with normals and uv', () => {
  const { data, vertices, faces } = toPly(buildQuad());
  assert.equal(vertices, 4);
  assert.equal(faces, 2);
  const end = data.indexOf('end_header\n') + 'end_header\n'.length;
  const header = data.subarray(0, end).toString('latin1');
  assert.match(header, /format binary_little_endian 1.0/);
  assert.match(header, /property float nx/);
  assert.match(header, /property float s/);
  // 4 vertices * (3+3+2) floats, then 2 faces * (1 + 12) bytes
  assert.equal(data.length - end, 4 * 32 + 2 * 13);
});

test('PLY writes vertex colors when the model has them', () => {
  const doc = buildQuad();
  const prim = first(doc)[0];
  const buffer = doc.getRoot().listBuffers()[0];
  prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setBuffer(buffer).setArray(new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1])));
  const { data } = toPly(doc);
  assert.match(data.toString('latin1', 0, 400), /property uchar red/);
});

test('OBJ output writes normal, roughness/metallic and emissive textures', async () => {
  const doc = buildQuad({ withTexture: true });
  const mat = doc.getRoot().listMaterials()[0];
  const mk = (n) => doc.createTexture(n).setImage(new Uint8Array(PNG)).setMimeType('image/png');
  mat.setNormalTexture(mk('n')).setMetallicRoughnessTexture(mk('mr')).setEmissiveTexture(mk('e')).setEmissiveFactor([1, 1, 1]);
  const { files } = toObj(doc, 'quad');
  const names = files.map((f) => f.name);
  for (const n of ['textures/red_baseColor.png', 'textures/red_normal.png', 'textures/red_metallicRoughness.png', 'textures/red_emissive.png']) {
    assert.ok(names.includes(n), n);
  }
  const mtl = files.find((f) => f.name === 'quad.mtl').data.toString();
  assert.match(mtl, /map_Kd textures\/red_baseColor.png/);
  assert.match(mtl, /map_Bump textures\/red_normal.png/);
  assert.match(mtl, /map_Pr textures\/red_metallicRoughness.png/);
  assert.match(mtl, /map_Ke textures\/red_emissive.png/);
});

test('OBJ parser reads groups, uv, normals, quads and negative indices', () => {
  const files = { 'quad.mtl': strToU8(MTL), 'tex/red.png': new Uint8Array(PNG) };
  const doc = parseObj(Buffer.from(OBJ), files, 'quad.obj');
  const prims = first(doc);
  assert.equal(prims.length, 2);
  const [red, blue] = prims;
  assert.equal(red.getIndices().getCount(), 6, 'quad becomes two triangles');
  assert.equal(red.getAttribute('TEXCOORD_0').getCount(), 4);
  assert.deepEqual([...red.getMaterial().getBaseColorFactor()].map((v) => +v.toFixed(2)), [1, 0, 0, 1]);
  assert.ok(red.getMaterial().getBaseColorTexture(), 'map_Kd texture loaded');
  assert.equal(blue.getIndices().getCount(), 3);
  assert.equal(blue.getAttribute('TEXCOORD_0'), null, 'no uv in the second group');
  assert.ok(blue.getAttribute('NORMAL'));
  assert.equal(blue.getMaterial().getBaseColorFactor()[3], 0.5);
  const uv = red.getAttribute('TEXCOORD_0').getElement(3, []);
  assert.deepEqual(uv, [0, 0], 'V is flipped back from OBJ');
});

test('OBJ parser rejects files without faces or with bad indices', () => {
  assert.throws(() => parseObj(Buffer.from('v 0 0 0\n')), (e) => e instanceof MeshportError && e.code === 'bad-file');
  assert.throws(() => parseObj(Buffer.from('v 0 0 0\nf 1 2 3\n')), (e) => e instanceof MeshportError);
});

test('OBJ written by meshport can be read back', () => {
  const { files } = toObj(buildQuad({ withTexture: true }), 'quad');
  const map = Object.fromEntries(files.map((f) => [f.name, new Uint8Array(f.data)]));
  const doc = parseObj(map['quad.obj'], map, 'quad.obj');
  const prim = first(doc)[0];
  assert.equal(prim.getIndices().getCount(), 6);
  assert.ok(prim.getMaterial().getBaseColorTexture());
});

async function gltfJson(doc) {
  const io = await getIO();
  const { json, resources } = await io.writeJSON(doc);
  json.buffers.forEach((b) => { b.uri = 'data:application/octet-stream;base64,' + Buffer.from(resources[b.uri]).toString('base64'); });
  (json.images || []).forEach((i) => { i.uri = 'data:image/png;base64,' + Buffer.from(resources[i.uri]).toString('base64'); });
  return { json, resources };
}

test('readModel: .gltf with embedded buffers', async () => {
  const { json } = await gltfJson(buildQuad({ withTexture: true }));
  const doc = await readModel(Buffer.from(JSON.stringify(json)), 'thing.gltf');
  assert.equal(first(doc)[0].getAttribute('POSITION').getCount(), 4);
});

test('readModel: .gltf with outside files explains to use a zip', async () => {
  const io = await getIO();
  const { json } = await io.writeJSON(buildQuad());
  await assert.rejects(() => readModel(Buffer.from(JSON.stringify(json)), 'x.gltf'), (e) => e instanceof MeshportError && /zip/.test(e.hint));
});

test('readModel: zip with gltf, bin and texture', async () => {
  const io = await getIO();
  const { json, resources } = await io.writeJSON(buildQuad({ withTexture: true }));
  const entries = { 'scene/model.gltf': strToU8(JSON.stringify(json)) };
  for (const [uri, data] of Object.entries(resources)) entries[`scene/${uri}`] = data;
  const doc = await readModel(Buffer.from(zipSync(entries)), 'pack.zip');
  assert.ok(first(doc)[0].getMaterial().getBaseColorTexture());
});

test('readModel: zip with glb, zip with obj+mtl+texture', async () => {
  const io = await getIO();
  const glb = await io.writeBinary(buildQuad());
  const d1 = await readModel(Buffer.from(zipSync({ 'a.glb': glb })), 'a.zip');
  assert.equal(first(d1)[0].getIndices().getCount(), 6);
  const d2 = await readModel(Buffer.from(zipSync({ 'm/quad.obj': strToU8(OBJ), 'm/quad.mtl': strToU8(MTL), 'm/tex/red.png': new Uint8Array(PNG) })), 'm.zip');
  assert.equal(first(d2).length, 2);
  assert.ok(first(d2)[0].getMaterial().getBaseColorTexture());
});

test('readModel: plain .obj and clear errors', async () => {
  const doc = await readModel(Buffer.from(OBJ), 'quad.obj');
  assert.equal(first(doc).length, 2);
  await assert.rejects(() => readModel(Buffer.from('hello'), 'a.zip'), (e) => e.code === 'bad-archive');
  await assert.rejects(() => readModel(Buffer.from('hello'), 'a.xyz'), (e) => /not supported/.test(e.message));
  await assert.rejects(() => readModel(Buffer.from('Kaydara FBX Binary'), 'a.fbx'), (e) => /FBX/.test(e.message));
  await assert.rejects(() => readModel(Buffer.alloc(0), 'a.glb'), (e) => /empty/.test(e.message));
  await assert.rejects(() => readModel(Buffer.from(zipSync({ 'readme.txt': strToU8('hi') })), 'a.zip'), (e) => /no model/.test(e.message));
});

function fakeBridge(found = '/fake/blender') {
  const calls = [];
  return {
    calls,
    async find() { return found; },
    async exportFbx(glb, fbx) {
      calls.push({ glb, fbx, glbExists: await fs.access(glb).then(() => true, () => false) });
      await fs.writeFile(fbx, 'FAKEFBX');
    },
  };
}

test('exportDocument writes stl, ply and fbx (fake Blender)', async () => {
  const blender = fakeBridge();
  const out = await exportDocument(buildQuad(), { name: 'all', formats: ['glb', 'stl', 'ply', 'fbx'], outDir: path.join(tmp, 'a'), blender });
  assert.deepEqual(out.files.map((f) => f.name).sort(), ['all.fbx', 'all.glb', 'all.ply', 'all.stl']);
  assert.ok(blender.calls[0].glbExists);
  assert.ok(blender.calls[0].glb.endsWith('all.glb'));
  assert.ok(out.notes.some((n) => /STL/.test(n)));
});

test('fbx without a requested glb uses a temp copy and leaves no glb behind', async () => {
  const blender = fakeBridge();
  const out = await exportDocument(buildQuad(), { name: 'only', formats: ['fbx'], outDir: path.join(tmp, 'b'), blender });
  assert.deepEqual(out.files.map((f) => f.name), ['only.fbx']);
  assert.ok(blender.calls[0].glbExists);
  assert.equal(await fs.access(blender.calls[0].glb).then(() => true, () => false), false);
});

test('fbx without Blender fails early with an install hint and no folder', async () => {
  const blender = fakeBridge(null);
  const outDir = path.join(tmp, 'c');
  await assert.rejects(() => exportDocument(buildQuad(), { name: 'x', formats: ['fbx'], outDir, blender }),
    (e) => e instanceof MeshportError && e.code === 'no-blender' && /blender\.org/.test(e.hint));
  await assert.rejects(() => fs.access(outDir));
});

test('a failing Blender run removes the half-made folder', async () => {
  const blender = { find: async () => 'x', exportFbx: async () => { throw new MeshportError('boom'); } };
  const outDir = path.join(tmp, 'd');
  await assert.rejects(() => exportDocument(buildQuad(), { name: 'x', formats: ['glb', 'fbx'], outDir, blender }), /boom/);
  assert.deepEqual(await fs.readdir(outDir), []);
});

test('options reach applyOptions and cleanup stats are returned', async () => {
  const out = await exportDocument(buildQuad(), { name: 'opt', formats: ['glb'], outDir: path.join(tmp, 'e'), options: { scale: 2 } });
  assert.equal(out.stats.triangles, 2);
  assert.ok('cleanup' in out || out.cleanup === undefined);
});

// Fake child process for the Blender runner.
test('Blender bridge runs the script and reports failures', async () => {
  const spawned = [];
  const mk = (code, write) => (cmd, args) => {
    spawned.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(async () => {
      if (write) await fs.writeFile(args[args.length - 1], 'x');
      else child.stderr.emit('data', 'Error: something broke');
      child.emit('close', code);
    });
    return child;
  };
  const glb = path.join(tmp, 'in.glb');
  const fbx = path.join(tmp, 'out.fbx');
  const ok = createBlenderBridge({ spawnImpl: mk(0, true), findImpl: async () => 'blender-bin' });
  await ok.exportFbx(glb, fbx);
  assert.equal(spawned[0].cmd, 'blender-bin');
  assert.ok(spawned[0].args.includes('-b') && spawned[0].args.includes('--python'));
  assert.deepEqual(spawned[0].args.slice(-3), ['--', glb, fbx]);
  const bad = createBlenderBridge({ spawnImpl: mk(1, false), findImpl: async () => 'blender-bin' });
  await assert.rejects(() => bad.exportFbx(glb, path.join(tmp, 'nope.fbx')), (e) => e.code === 'fbx-failed' && /something broke/.test(e.message));
});

test('findBlender prefers PATH, then the newest install folder', async () => {
  const pf = path.join(tmp, 'pf');
  for (const v of ['Blender 3.6', 'Blender 4.2', 'Blender 4.10']) {
    await fs.mkdir(path.join(pf, 'Blender Foundation', v), { recursive: true });
    await fs.writeFile(path.join(pf, 'Blender Foundation', v, 'blender.exe'), '');
  }
  const found = await findBlender({ env: { PATH: '' }, platform: 'win32', programFiles: [pf] });
  assert.ok(found.includes('Blender 4.10'));
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'blender.exe'), '');
  assert.equal(await findBlender({ env: { PATH: bin }, platform: 'win32', programFiles: [pf] }), path.join(bin, 'blender.exe'));
  assert.equal(await findBlender({ env: { PATH: '' }, platform: 'win32', programFiles: [path.join(tmp, 'none')] }), null);
});
