#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Jobs } from './jobs.js';
import { Config, KEY_NAMES } from './config.js';
import { exportDocument, readModel, FORMATS, ALWAYS_FORMATS } from './export/index.js';
import { createBlenderBridge, fbxAvailability } from './export/fbx.js';
import { safeJoin, safeName } from './safe.js';
import { MeshportError, describeError } from './errors.js';
import { fetchSketchfab } from './sources/sketchfab.js';
import { fetchMeshy, listMeshyTasks } from './sources/meshy.js';
import { fetchTripo } from './sources/tripo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const MAX_UPLOAD = 500 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.stl': 'model/stl', '.ply': 'application/octet-stream', '.fbx': 'application/octet-stream', '.obj': 'text/plain; charset=utf-8', '.mtl': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request is too large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req, 1024 * 1024);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Body is not valid JSON.'); }
}

// Options arrive as JSON from the page; anything that is not a plain object is ignored.
function pickOptions(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new HttpError(400, 'Options are not valid JSON.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Options must be an object.');
  return value;
}

function pickFormats(value) {
  const list = Array.isArray(value) ? value : ['glb'];
  const formats = list.filter((f) => FORMATS.includes(f));
  if (!formats.length) throw new HttpError(400, `Choose at least one format (${FORMATS.join(', ')}).`);
  return formats;
}

// The page and the API only answer to the browser on this computer: a web page on another
// site cannot call them, even though it can reach localhost.
function checkOrigin(req) {
  const host = String(req.headers.host || '');
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!LOCAL_HOSTS.has(hostname.toLowerCase())) throw new HttpError(403, 'Unexpected host name.');
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && new URL(origin).host !== host) throw new HttpError(403, 'Cross-site request blocked.');
  if (origin === 'null') throw new HttpError(403, 'Cross-site request blocked.');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Cross-site request blocked.');
  }
}

async function listModels(outDir) {
  let entries = [];
  try { entries = await fs.readdir(outDir, { withFileTypes: true }); } catch { return []; }
  const models = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(outDir, e.name);
    const files = [];
    const walk = async (d, prefix) => {
      for (const f of await fs.readdir(d, { withFileTypes: true })) {
        if (f.isDirectory()) await walk(path.join(d, f.name), `${prefix}${f.name}/`);
        else files.push({ name: `${prefix}${f.name}`, size: (await fs.stat(path.join(d, f.name))).size });
      }
    };
    await walk(dir, '');
    const stat = await fs.stat(dir);
    models.push({ id: e.name, files, modified: stat.mtimeMs });
  }
  return models.sort((a, b) => b.modified - a.modified);
}

function openFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export async function createApp({ outDir, configFile, fetchImpl = fetch, opener = openFolder, blender = createBlenderBridge() } = {}) {
  outDir = path.resolve(outDir || path.join(here, '..', 'output'));
  const config = await new Config(configFile || path.join(here, '..', 'data', 'config.json')).load();
  const jobs = new Jobs();

  const finish = async (source, formats, update, options = {}) => {
    update('Cleaning the model', 0.8);
    const out = await exportDocument(source.doc, { name: source.name, formats, outDir, credit: source.credit, options, blender });
    update('Saving files', 0.95);
    return out;
  };

  async function handle(req, res) {
    checkOrigin(req);
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const seg = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));

    if (route === 'GET /api/state') {
      return send(res, 200, { keys: config.status(), formats: ALWAYS_FORMATS, optionalFormats: { fbx: await fbxAvailability(blender) }, outDir });
    }

    if (route === 'POST /api/settings') {
      const body = await readJson(req);
      for (const name of KEY_NAMES) if (name in body) await config.set(name, body[name]);
      return send(res, 200, { keys: config.status() });
    }

    if (route === 'POST /api/jobs') {
      const body = await readJson(req);
      const formats = pickFormats(body.formats);
      const options = pickOptions(body.options);
      const { source, input } = body;
      let job;
      if (source === 'sketchfab') {
        job = jobs.start('Sketchfab model', async (u) => finish(await fetchSketchfab({ input, token: config.get('sketchfab'), fetchImpl, onStep: u }), formats, u, options));
      } else if (source === 'meshy') {
        job = jobs.start('Meshy model', async (u) => finish(await fetchMeshy({ input: input || body.id, id: body.id, kind: body.kind, key: config.get('meshy'), fetchImpl, onStep: u }), formats, u, options));
      } else if (source === 'tripo') {
        job = jobs.start('Tripo model', async (u) => finish(await fetchTripo({ input, key: config.get('tripo'), fetchImpl, onStep: u }), formats, u, options));
      } else {
        throw new HttpError(400, 'Unknown source.');
      }
      return send(res, 202, { id: job.id });
    }

    if (route === 'POST /api/convert') {
      const fileName = url.searchParams.get('name') || 'model.glb';
      const name = safeName(path.parse(fileName).name);
      const formats = pickFormats((url.searchParams.get('formats') || 'glb').split(','));
      const options = pickOptions(url.searchParams.get('options'));
      const data = await readBody(req, MAX_UPLOAD);
      const job = jobs.start(`File: ${name}`, async (u) => {
        u('Reading file', 0.2);
        const doc = await readModel(data, path.basename(fileName));
        return finish({ name, doc }, formats, u, options);
      });
      return send(res, 202, { id: job.id });
    }

    if (route === 'GET /api/jobs') return send(res, 200, jobs.list());
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg.length === 3 && req.method === 'GET') {
      const job = jobs.get(seg[2]);
      return job ? send(res, 200, job) : send(res, 404, { error: 'Unknown job.' });
    }

    if (route === 'GET /api/meshy/tasks') {
      return send(res, 200, await listMeshyTasks({ key: config.get('meshy'), fetchImpl }));
    }

    if (route === 'GET /api/models') return send(res, 200, await listModels(outDir));

    if (seg[0] === 'api' && seg[1] === 'models' && seg.length === 3 && req.method === 'DELETE') {
      const dir = safeJoin(outDir, seg[2]);
      if (!dir) throw new HttpError(400, 'Invalid model name.');
      try { await fs.access(dir); } catch { throw new HttpError(404, 'Model not found.'); }
      await fs.rm(dir, { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }

    if (route === 'POST /api/open-folder') {
      const body = await readJson(req);
      const dir = body.model ? safeJoin(outDir, String(body.model)) : outDir;
      if (!dir) throw new HttpError(400, 'Invalid model name.');
      await fs.mkdir(dir, { recursive: true });
      opener(dir);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && seg[0] === 'files' && seg.length >= 3) {
      const full = safeJoin(path.join(outDir, seg[1]), ...seg.slice(2).map((s) => s));
      const modelDir = safeJoin(outDir, seg[1]);
      if (!full || !modelDir || !path.resolve(full).startsWith(modelDir + path.sep)) throw new HttpError(400, 'Invalid path.');
      return serveFile(res, full, true);
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : seg.join('/');
      const full = safeJoin(PUBLIC_DIR, ...rel.split('/'));
      if (!full) throw new HttpError(404, 'Not found.');
      return serveFile(res, full, false);
    }

    throw new HttpError(404, 'Not found.');
  }

  async function serveFile(res, full, download) {
    let stat;
    try { stat = await fs.stat(full); } catch { throw new HttpError(404, 'Not found.'); }
    if (!stat.isFile()) throw new HttpError(404, 'Not found.');
    const headers = {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
    };
    if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`;
    res.writeHead(200, headers);
    createReadStream(full).pipe(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      const d = describeError(err);
      if (err instanceof MeshportError) return send(res, 400, { error: d.message, hint: d.hint });
      console.error(err);
      send(res, 500, { error: d.message, hint: d.hint });
    });
  });
  return { server, jobs, config, outDir };
}

// Starts listening on the first free port from `start`, on this computer only.
export function listen(server, start = 3100) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryNext = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < start + 20) { port++; tryNext(); } else reject(err);
      });
      server.listen(port, '127.0.0.1', () => { server.removeAllListeners('error'); resolve(port); });
    };
    tryNext();
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await createApp({ outDir: process.env.MESHPORT_OUT, configFile: process.env.MESHPORT_CONFIG });
  const port = await listen(app.server, Number(process.env.PORT) || 3100);
  const url = `http://localhost:${port}`;
  console.log(`\n  meshport is running: ${url}`);
  console.log(`  Models are saved in: ${app.outDir}`);
  console.log('  Close this window to stop.\n');
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    const c = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
  }
}
