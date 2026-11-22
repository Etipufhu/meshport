import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { Document } from '@gltf-transform/core';
import { parseSketchfabInput, fetchSketchfab } from '../src/sources/sketchfab.js';
import { fetchMeshy, listMeshyTasks } from '../src/sources/meshy.js';
import { fetchTripo, parseTripoInput } from '../src/sources/tripo.js';
import { MeshportError } from '../src/errors.js';
import { getIO } from '../src/export/io.js';
import { buildQuad } from './helpers.js';

const UID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bytes = (buf, status = 200) => new Response(buf, { status });

async function glbBytes() {
  const io = await getIO();
  return Buffer.from(await io.writeBinary(buildQuad()));
}

async function gltfZip() {
  const io = await getIO();
  const { json: gltf, resources } = await io.writeJSON(buildQuad({ withTexture: true }));
  const files = { 'scene.gltf': strToU8(JSON.stringify(gltf)) };
  for (const [uri, data] of Object.entries(resources)) files[uri.includes('.') && /png|jpe?g/.test(uri) ? `textures/${uri}` : uri] = data;
  // point image URIs at the textures/ folder like Sketchfab archives do
  gltf.images?.forEach((i) => { if (i.uri && !i.uri.startsWith('textures/')) i.uri = `textures/${i.uri}`; });
  files['scene.gltf'] = strToU8(JSON.stringify(gltf));
  return Buffer.from(zipSync(files));
}

// ---------- Sketchfab ----------
test('Sketchfab: understands links and bare ids', () => {
  assert.equal(parseSketchfabInput(`https://sketchfab.com/3d-models/old-car-${UID}`), UID);
  assert.equal(parseSketchfabInput(UID.toUpperCase()), UID);
  assert.throws(() => parseSketchfabInput('https://example.com/' + UID), MeshportError);
  assert.throws(() => parseSketchfabInput('https://sketchfab.com/'), MeshportError);
  assert.throws(() => parseSketchfabInput(''), MeshportError);
});

test('Sketchfab: needs a token', async () => {
  await assert.rejects(() => fetchSketchfab({ input: UID, token: '' }), (e) => e.code === 'no-key');
});

test('Sketchfab: stops with a clear message when the author did not allow downloads', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return json({ name: 'Locked', isDownloadable: false });
  };
  await assert.rejects(() => fetchSketchfab({ input: UID, token: 't', fetchImpl }), (e) => e.code === 'not-downloadable' && /not available for download/.test(e.message));
  assert.equal(calls.length, 1, 'does not even ask for a download link');
});

test('Sketchfab: downloads, unpacks the zip and keeps the credit', async () => {
  const zip = await gltfZip();
  const headers = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.headers?.Authorization) headers.push(opts.headers.Authorization);
    if (url.endsWith(`/models/${UID}`)) return json({ name: 'Old Car', isDownloadable: true, user: { displayName: 'Ann' }, license: { label: 'CC Attribution', url: 'https://creativecommons.org/licenses/by/4.0/' } });
    if (url.endsWith('/download')) return json({ gltf: { url: 'https://cdn.example/archive.zip' } });
    if (url === 'https://cdn.example/archive.zip') return bytes(zip);
    throw new Error('unexpected ' + url);
  };
  const steps = [];
  const out = await fetchSketchfab({ input: UID, token: 'tok', fetchImpl, onStep: (s) => steps.push(s) });
  assert.equal(out.name, 'Old Car');
  assert.match(out.credit, /by Ann/);
  assert.match(out.credit, /CC Attribution/);
  assert.equal(out.doc.getRoot().listMeshes().length, 1);
  assert.equal(out.doc.getRoot().listTextures().length, 1);
  assert.deepEqual(headers, ['Token tok']);
  assert.ok(steps.includes('Downloading'));
});

test('Sketchfab: retries with Bearer when Token is rejected', async () => {
  const zip = await gltfZip();
  const headers = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith(`/models/${UID}`)) return json({ name: 'X', isDownloadable: true });
    if (url.endsWith('/download')) {
      headers.push(opts.headers.Authorization);
      return opts.headers.Authorization.startsWith('Bearer') ? json({ gltf: { url: 'https://cdn.example/a.zip' } }) : json({}, 401);
    }
    return bytes(zip);
  };
  await fetchSketchfab({ input: UID, token: 'oauth', fetchImpl });
  assert.deepEqual(headers, ['Token oauth', 'Bearer oauth']);
});

test('Sketchfab: bad token and refused download give different advice', async () => {
  const base = (status) => async (url) => (url.endsWith(`/models/${UID}`) ? json({ name: 'X', isDownloadable: true }) : json({}, status));
  await assert.rejects(() => fetchSketchfab({ input: UID, token: 't', fetchImpl: base(401) }), (e) => e.code === 'bad-key');
  await assert.rejects(() => fetchSketchfab({ input: UID, token: 't', fetchImpl: base(403) }), (e) => e.code === 'forbidden');
  await assert.rejects(() => fetchSketchfab({ input: UID, token: 't', fetchImpl: async () => json({}, 404) }), (e) => e.code === 'not-found');
});

// ---------- Meshy ----------
test('Meshy: lists only finished tasks, newest first', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/v2/text-to-3d')) return json([
      { id: 'a', status: 'SUCCEEDED', prompt: 'old', model_urls: { glb: 'u' }, created_at: 1 },
      { id: 'b', status: 'IN_PROGRESS', prompt: 'busy', model_urls: {}, created_at: 5 },
    ]);
    return json([{ id: 'c', status: 'SUCCEEDED', model_urls: { glb: 'u' }, created_at: 9 }]);
  };
  const tasks = await listMeshyTasks({ key: 'k', fetchImpl });
  assert.deepEqual(tasks.map((t) => t.id), ['c', 'a']);
  assert.equal(tasks[0].kind, 'image');
});

test('Meshy: downloads a finished task and refuses unfinished or keyless calls', async () => {
  const glb = await glbBytes();
  const fetchImpl = async (url, opts = {}) => {
    if (url.startsWith('https://cdn.example')) {
      assert.equal(opts.headers, undefined, 'the API key is not sent to the file host');
      return bytes(glb);
    }
    assert.equal(opts.headers.Authorization, 'Bearer k');
    if (url.endsWith('/v2/text-to-3d/ok')) return json({ id: 'ok', status: 'SUCCEEDED', prompt: 'a monster mask', model_urls: { glb: 'https://cdn.example/m.glb' } });
    if (url.endsWith('/v2/text-to-3d/busy')) return json({ id: 'busy', status: 'IN_PROGRESS' });
    return bytes(glb);
  };
  const out = await fetchMeshy({ id: 'ok', kind: 'text', key: 'k', fetchImpl });
  assert.equal(out.name, 'a monster mask');
  assert.equal(out.doc.getRoot().listMeshes().length, 1);
  await assert.rejects(() => fetchMeshy({ id: 'busy', key: 'k', fetchImpl }), (e) => e.code === 'not-ready');
  await assert.rejects(() => fetchMeshy({ id: 'ok', key: '', fetchImpl }), (e) => e.code === 'no-key');
});

// ---------- Tripo ----------
test('Tripo: finds the task id inside pasted text', () => {
  assert.equal(parseTripoInput('task 07764597-9C93-4eb9-92b6-4ea96a8c7d1a done'), '07764597-9c93-4eb9-92b6-4ea96a8c7d1a');
  assert.throws(() => parseTripoInput('nope'), (e) => e.code === 'bad-input');
});

test('Tripo: prefers the PBR model and reports unfinished tasks', async () => {
  const glb = await glbBytes();
  const id = '07764597-9c93-4eb9-92b6-4ea96a8c7d1a';
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith(`/task/${id}`)) return json({ code: 0, data: { status: 'success', output: { model: 'https://cdn.example/plain.glb', pbr_model: 'https://cdn.example/pbr.glb' } } });
    return bytes(glb);
  };
  const out = await fetchTripo({ input: id, key: 'k', fetchImpl });
  assert.equal(out.name, 'tripo-07764597');
  assert.ok(requested.includes('https://cdn.example/pbr.glb'));

  const running = async () => json({ code: 0, data: { status: 'running' } });
  await assert.rejects(() => fetchTripo({ input: id, key: 'k', fetchImpl: running }), (e) => e.code === 'not-ready');
  await assert.rejects(() => fetchTripo({ input: id, key: '', fetchImpl }), (e) => e.code === 'no-key');
});

test('downloads that are not a GLB are rejected with a readable error', async () => {
  const id = '07764597-9c93-4eb9-92b6-4ea96a8c7d1a';
  const fetchImpl = async (url) => (url.endsWith(`/task/${id}`)
    ? json({ code: 0, data: { status: 'success', output: { model: 'https://cdn.example/x.glb' } } })
    : bytes(Buffer.from('<html>expired</html>')));
  await assert.rejects(() => fetchTripo({ input: id, key: 'k', fetchImpl }), (e) => e.code === 'bad-file');
  assert.ok(new Document());
});
