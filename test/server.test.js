import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp, listen } from '../src/server.js';
import { compressedGlb } from './helpers.js';

let app, base, port, tmp, opened;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'meshport-srv-'));
  opened = [];
  app = await createApp({ outDir: path.join(tmp, 'out'), configFile: path.join(tmp, 'config.json'), opener: (d) => opened.push(d) });
  port = await listen(app.server, 3400);
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  app.server.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function waitJob(id) {
  for (let i = 0; i < 100; i++) {
    const job = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}

// Raw request so the Host header can be set to anything.
function raw(pathname, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the page', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /meshport/);
});

test('refuses unknown host names (DNS rebinding) and cross-site posts', async () => {
  assert.equal(await raw('/api/state', 'evil.example'), 403);
  assert.equal(await raw('/api/state', `localhost:${port}`), 200);
  const res = await post('/api/settings', { meshy: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  const none = await post('/api/settings', { meshy: 'x' }, { Origin: 'null' });
  assert.equal(none.status, 403);
});

test('saving keys never echoes them back', async () => {
  const res = await post('/api/settings', { sketchfab: 'secret-token-123' });
  const body = await res.text();
  assert.ok(!body.includes('secret-token-123'));
  assert.deepEqual(JSON.parse(body).keys, { sketchfab: true, meshy: false, tripo: false });
  const state = await (await fetch(base + '/api/state')).text();
  assert.ok(!state.includes('secret-token-123'));
});

test('missing key gives an actionable error on the job', async () => {
  const res = await post('/api/jobs', { source: 'meshy', id: 'x', formats: ['glb'] });
  assert.equal(res.status, 202);
  const job = await waitJob((await res.json()).id);
  assert.equal(job.status, 'error');
  assert.match(job.error.message, /Meshy API key/);
  assert.match(job.error.hint, /Settings/);
});

test('converting a compressed GLB works end to end and the file can be downloaded', async () => {
  const glb = await compressedGlb();
  const res = await fetch(`${base}/api/convert?name=${encodeURIComponent('../../My Dragon.glb')}&formats=glb,obj`, { method: 'POST', body: glb });
  assert.equal(res.status, 202);
  const job = await waitJob((await res.json()).id);
  assert.equal(job.status, 'done', JSON.stringify(job.error));
  assert.equal(job.result.folder, 'My Dragon');
  assert.equal(job.result.stats.triangles, 2);

  const models = await (await fetch(base + '/api/models')).json();
  assert.equal(models[0].id, 'My Dragon');
  const file = await fetch(`${base}/files/My%20Dragon/My%20Dragon.glb`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.equal((await file.arrayBuffer()).byteLength > 100, true);
});

test('a file that is not a GLB reports a clear error', async () => {
  const res = await fetch(`${base}/api/convert?name=bad.glb`, { method: 'POST', body: Buffer.from('not a model') });
  const job = await waitJob((await res.json()).id);
  assert.equal(job.status, 'error');
  assert.match(job.error.message, /not a GLB/);
});

test('path traversal is blocked for download and delete', async () => {
  await fs.writeFile(path.join(tmp, 'secret.txt'), 'top secret');
  for (const p of ['/files/..%2f/secret.txt', '/files/%2e%2e/%2e%2e/secret.txt', '/files/My%20Dragon/..%2f..%2fsecret.txt', '/..%2f..%2fpackage.json', '/%2e%2e/package.json']) {
    const res = await fetch(base + p);
    assert.ok([400, 404].includes(res.status), `${p} -> ${res.status}`);
    assert.ok(!(await res.text()).includes('top secret'));
  }
  const del = await fetch(base + '/api/models/..%2f', { method: 'DELETE' });
  assert.equal(del.status, 400);
  assert.equal(await fs.readFile(path.join(tmp, 'secret.txt'), 'utf8'), 'top secret');
});

test('open-folder only opens folders inside the output directory', async () => {
  const bad = await post('/api/open-folder', { model: '..' });
  assert.equal(bad.status, 400);
  const ok = await post('/api/open-folder', { model: 'My Dragon' });
  assert.equal(ok.status, 200);
  assert.equal(opened.at(-1), path.join(app.outDir, 'My Dragon'));
});

test('deleting a model removes its folder', async () => {
  const del = await fetch(base + '/api/models/My%20Dragon', { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await (await fetch(base + '/api/models')).json(), []);
});

test('invalid requests fail with a clear message', async () => {
  assert.equal((await post('/api/jobs', { source: 'nope', formats: ['glb'] })).status, 400);
  assert.equal((await post('/api/jobs', { source: 'tripo', input: 'x', formats: [] })).status, 400);
});

test('state lists always-on formats and optional FBX', async () => {
  const state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state.formats, ['glb', 'obj', 'stl', 'ply']);
  assert.equal(typeof state.optionalFormats.fbx.available, 'boolean');
  assert.equal(typeof state.optionalFormats.fbx.reason, 'string');
});

const OBJ_TEXT = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

test('convert accepts .obj, writes stl/ply and passes options; many calls in a row work', async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${base}/api/convert?name=tri${i}.obj&formats=glb,stl,ply&options=${encodeURIComponent('{"x":1}')}`, { method: 'POST', body: Buffer.from(OBJ_TEXT) });
    assert.equal(res.status, 202);
    ids.push((await res.json()).id);
  }
  for (const id of ids) {
    const job = await waitJob(id);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.stats.triangles, 1);
    assert.ok(Array.isArray(job.result.notes));
    assert.deepEqual(job.result.files.map((f) => f.name.split('.').pop()).sort(), ['glb', 'ply', 'stl']);
  }
});

test('bad options JSON is rejected, unsupported files report a clear error', async () => {
  const bad = await fetch(`${base}/api/convert?name=a.obj&options=%7Bnope`, { method: 'POST', body: Buffer.from(OBJ_TEXT) });
  assert.equal(bad.status, 400);
  const res = await fetch(`${base}/api/convert?name=a.xyz`, { method: 'POST', body: Buffer.from('whatever') });
  const job = await waitJob((await res.json()).id);
  assert.equal(job.status, 'error');
  assert.match(job.error.message, /not supported/);
});

test('requesting fbx without Blender gives an install hint', async () => {
  const dir = await fs.mkdtemp(path.join(tmp, 'nb-'));
  const noBlender = await createApp({ outDir: dir, configFile: path.join(dir, 'c.json'), blender: { find: async () => null, exportFbx: async () => {} } });
  const p = await listen(noBlender.server, 3500);
  try {
    const state = await (await fetch(`http://127.0.0.1:${p}/api/state`)).json();
    assert.equal(state.optionalFormats.fbx.available, false);
    assert.match(state.optionalFormats.fbx.reason, /Blender/);
    const res = await fetch(`http://127.0.0.1:${p}/api/convert?name=a.obj&formats=fbx`, { method: 'POST', body: Buffer.from(OBJ_TEXT) });
    const id = (await res.json()).id;
    let job;
    for (let i = 0; i < 100; i++) {
      job = await (await fetch(`http://127.0.0.1:${p}/api/jobs/${id}`)).json();
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.status, 'error');
    assert.match(job.error.hint, /blender\.org/);
  } finally {
    noBlender.server.close();
  }
});

test('fbx works through the server with an injected Blender', async () => {
  const dir = await fs.mkdtemp(path.join(tmp, 'fb-'));
  const fake = { find: async () => 'fake', exportFbx: async (g, f) => fs.writeFile(f, 'FBX') };
  const a = await createApp({ outDir: dir, configFile: path.join(dir, 'c.json'), blender: fake });
  const p = await listen(a.server, 3550);
  try {
    const st = await (await fetch(`http://127.0.0.1:${p}/api/state`)).json();
    assert.equal(st.optionalFormats.fbx.available, true);
    const res = await post2(p, '/api/jobs', { source: 'nope' });
    assert.equal(res.status, 400);
    const r = await fetch(`http://127.0.0.1:${p}/api/convert?name=a.obj&formats=fbx`, { method: 'POST', body: Buffer.from(OBJ_TEXT) });
    const id = (await r.json()).id;
    let job;
    for (let i = 0; i < 100; i++) {
      job = await (await fetch(`http://127.0.0.1:${p}/api/jobs/${id}`)).json();
      if (job.status !== 'running') break;
      await new Promise((x) => setTimeout(x, 50));
    }
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.deepEqual(job.result.files.map((f) => f.name), ['a.fbx']);
  } finally {
    a.server.close();
  }
});

const post2 = (p, route, body) => fetch(`http://127.0.0.1:${p}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
