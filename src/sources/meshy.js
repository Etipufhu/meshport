import { MeshportError } from '../errors.js';
import { request, statusError, downloadBuffer } from './http.js';
import { readGlb } from '../export/io.js';
import { launchRipperBrowser } from './browser.js';

const API = 'https://api.meshy.ai/openapi';
const KINDS = {
  text: '/v2/text-to-3d',
  image: '/v1/image-to-3d',
};

function auth(key) {
  if (!key) {
    throw new MeshportError('A Meshy API key is needed.', 'Open Settings and paste your key (Meshy > Settings > API).', 'no-key');
  }
  return { Authorization: `Bearer ${key}` };
}

export function parseMeshyInput(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  // If it's a URL
  if (/^https?:\/\//i.test(text)) {
    if (!/meshy\.ai/i.test(text)) {
      throw new MeshportError('That link is not a Meshy link.', 'Use a link that starts with https://www.meshy.ai/', 'bad-input');
    }
    return text;
  }
  return text;
}

// Lists your latest finished Meshy tasks via official API
export async function listMeshyTasks({ key, fetchImpl = fetch }) {
  const headers = auth(key);
  const all = [];
  for (const [kind, p] of Object.entries(KINDS)) {
    const res = await request(fetchImpl, `${API}${p}?page_size=20`, { headers });
    if (!res.ok) throw statusError('Meshy', res.status);
    const items = await res.json();
    for (const t of Array.isArray(items) ? items : items.result || []) {
      if (t.status !== 'SUCCEEDED' || !t.model_urls?.glb) continue;
      all.push({
        id: t.id,
        kind,
        title: t.prompt || t.name || t.id.slice(0, 8),
        thumbnail: t.thumbnail_url || '',
        createdAt: t.created_at || 0,
      });
    }
  }
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

// -------------------------------------------------------------
// MeshyRipper Engine (Direct WebGL / Worker Interception)
// -------------------------------------------------------------
export async function ripMeshyModel(targetUrl, onStep = () => {}) {
  onStep('Launching browser for Meshy', 0.1);
  let browser;
  try {
    browser = await launchRipperBrowser({ headless: false });
    const page = await browser.newPage();
    await page.setBypassCSP(true);

    let capturedBuffer = null;
    let capturedTitle = 'meshy_model';

    // Expose Node function to receive the captured GLB buffer
    await page.exposeFunction('__sendGlbToNode', (base64Data, title) => {
      try {
        capturedBuffer = Buffer.from(base64Data, 'base64');
        if (title) capturedTitle = title;
      } catch (e) {}
    });

    onStep('Injecting decryption hooks', 0.2);

    const scriptCode = `
      (function() {
        window.__meshyDecryptorInjected = true;

        function getModelFilename() {
          const title = document.querySelector('h1')?.textContent || '';
          const safeTitle = title.replace(/[<>:"/\\\\|?*\\x00-\\x1F-]+/g, '-').replace(/\\s+/g, ' ').trim();
          return safeTitle || 'meshy_' + Date.now();
        }

        async function notifyCapture(blob, src) {
          console.log('[MeshyRipper] GLB captured from ' + src + ' (size: ' + blob.size + ')');
          const reader = new FileReader();
          reader.onload = function() {
            const base64 = reader.result.split(',')[1];
            if (window.__sendGlbToNode) {
              window.__sendGlbToNode(base64, getModelFilename());
            }
          };
          reader.readAsDataURL(blob);
        }

        // 1. Worker Hook
        const _OrigWorker = window.Worker;
        window.Worker = function(scriptURL, options) {
          const w = new _OrigWorker(scriptURL, options);
          const proto = Object.getPrototypeOf(w);
          const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
          if (desc && desc.set) {
            Object.defineProperty(w, 'onmessage', {
              configurable: true,
              get() { return desc.get ? desc.get.call(w) : undefined; },
              set(fn) {
                desc.set.call(w, function(e) {
                  spyWorkerMsg(e);
                  return fn.call(this, e);
                });
              }
            });
          }
          const _origAEL = w.addEventListener.bind(w);
          w.addEventListener = function(type, listener, opts) {
            if (type === 'message') {
              return _origAEL(type, function(e) {
                spyWorkerMsg(e);
                return listener.call(this, e);
              }, opts);
            }
            return _origAEL(type, listener, opts);
          };
          return w;
        };
        window.Worker.prototype = _OrigWorker.prototype;

        function spyWorkerMsg(e) {
          const d = e.data;
          if (!d || !d.type) return;
          if (d.type === 'process' && d.success && d.data) {
            try {
              const copy = d.data.slice(0);
              notifyCapture(new Blob([copy], { type: 'model/gltf-binary' }), 'worker');
            } catch(ex) {}
          }
        }

        // 2. URL.createObjectURL Hook
        const _origCreateObjectURL = URL.createObjectURL.bind(URL);
        URL.createObjectURL = function(blob) {
          const url = _origCreateObjectURL(blob);
          if (blob instanceof Blob || blob instanceof File) {
            if (blob.type === 'model/gltf-binary') {
              notifyCapture(blob, 'createObjectURL');
            } else if (blob.size > 50000) {
              blob.arrayBuffer().then(buf => {
                if (buf && buf.byteLength >= 4 && new Uint32Array(buf.slice(0, 4))[0] === 0x46546C67) {
                  notifyCapture(new Blob([buf], { type: 'model/gltf-binary' }), 'createObjectURL-magic');
                }
              }).catch(() => {});
            }
          }
          return url;
        };

        // 3. fetch Hook
        const _origFetch = window.fetch;
        window.fetch = async function(input, ...rest) {
          const url = typeof input === 'string' ? input : (input && input.url) || String(input);
          const p = _origFetch.apply(this, [input, ...rest]);
          if (!url.includes('.glb') && !url.includes('misc/cdn-models') && !url.includes('meshy')) return p;
          
          return p.then(async resp => {
            try {
              const buf = await resp.clone().arrayBuffer();
              if (buf && buf.byteLength >= 4 && new Uint32Array(buf.slice(0, 4))[0] === 0x46546C67) {
                notifyCapture(new Blob([buf], { type: 'model/gltf-binary' }), 'fetch');
              }
            } catch(ex) {}
            return resp;
          });
        };
      })();
    `;

    await page.evaluateOnNewDocument(scriptCode);

    onStep('Loading Meshy page', 0.35);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    onStep('Waiting for decrypted 3D model', 0.55);

    const startTime = Date.now();
    const maxWait = 45000;
    while (Date.now() - startTime < maxWait) {
      if (capturedBuffer) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    await browser.close();
    browser = null;

    if (!capturedBuffer) {
      throw new MeshportError(
        'Could not capture 3D model from Meshy.',
        'Make sure the model loads in the browser and you are signed in if it is private.',
        'rip-failed'
      );
    }

    onStep('Parsing GLB model', 0.85);
    const doc = await readGlb(capturedBuffer);
    return { name: capturedTitle || 'meshy_model', doc };
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    throw err;
  }
}

// Master function: supports both direct URL ripping and official API tasks
export async function fetchMeshy({ input, id, kind = 'text', key, fetchImpl = fetch, onStep = () => {} }) {
  let raw = String(input || id || '').trim();
  if (/^(www\.)?meshy\.ai/i.test(raw)) raw = 'https://' + raw;
  const isUrl = /^https?:\/\//i.test(raw);

  // If a full web URL is provided, run MeshyRipper!
  if (isUrl) {
    const parsedUrl = parseMeshyInput(raw);
    return await ripMeshyModel(parsedUrl, onStep);
  }

  // Non-URL input (API task ID) requires an API key
  if (!key) {
    throw new MeshportError(
      'A Meshy API key is needed.',
      'Open Settings and paste your key (Meshy > Settings > API).',
      'no-key'
    );
  }

  const taskId = raw;
  if (!taskId) throw new MeshportError('Pick a Meshy task or paste a model link first.', '', 'bad-input');

  const headers = auth(key);
  if (!KINDS[kind]) kind = 'text';

  onStep('Reading task', 0.1);
  const res = await request(fetchImpl, `${API}${KINDS[kind]}/${encodeURIComponent(taskId)}`, { headers });
  if (!res.ok) throw statusError('Meshy', res.status, { notFound: 'That Meshy task was not found in your account.' });
  const task = await res.json();
  if (task.status !== 'SUCCEEDED') {
    throw new MeshportError(`The Meshy task is not finished (status: ${task.status}).`, 'Wait until it shows as finished on Meshy.', 'not-ready');
  }
  const url = task.model_urls?.glb;
  if (!url) throw new MeshportError('This task has no GLB file.', '', 'no-format');

  onStep('Downloading', 0.2);
  const buf = await downloadBuffer(fetchImpl, url, (p) => onStep('Downloading', 0.2 + p * 0.5));
  onStep('Reading model', 0.75);
  const doc = await readGlb(buf);
  return { name: task.prompt || task.name || `meshy-${taskId.slice(0, 8)}`, doc };
}
