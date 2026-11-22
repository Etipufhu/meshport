import { MeshportError } from '../errors.js';
import { request, statusError, downloadBuffer } from './http.js';
import { readGlb } from '../export/io.js';
import { launchRipperBrowser } from './browser.js';

const API = 'https://api.tripo3d.ai/v2/openapi';
const TASK_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function parseTripoInput(input) {
  const text = String(input || '').trim();
  const m = text.match(TASK_ID);
  if (m) return m[1].toLowerCase();
  if (/^https?:\/\//i.test(text)) return text;
  throw new MeshportError(
    'Paste a Tripo3D model link or task ID.',
    'Example: https://studio.tripo3d.ai/3d-model/52d63b42-c046-4bc8-80ff-b51c0ff3c1f4 or 07764597-9c93-4eb9-92b6-4ea96a8c7d1a',
    'bad-input'
  );
}

// -------------------------------------------------------------
// TripoRipper Engine (Direct Network Stream + Three.js RAM Extraction)
// -------------------------------------------------------------
export async function ripTripoModel(input, onStep = () => {}) {
  const targetUrl = /^https?:\/\//i.test(input) ? input : `https://studio.tripo3d.ai/3d-model/${input}`;

  onStep('Launching browser for Tripo', 0.1);
  let browser;
  try {
    browser = await launchRipperBrowser({ headless: false });
    const page = await browser.newPage();
    await page.setBypassCSP(true);

    let capturedBuffer = null;
    let modelTitle = 'tripo_model';

    await page.exposeFunction('__sendTripoGlbToNode', (base64Data, name) => {
      try {
        capturedBuffer = Buffer.from(base64Data, 'base64');
        if (name) modelTitle = name;
      } catch (e) {}
    });

    onStep('Injecting Tripo extraction hooks', 0.2);

    const scriptCode = `
      (function() {
        window.__tripoRipperInjected = true;

        async function sendGlb(blobOrBuffer, filename) {
          console.log('[TripoRipper] GLB captured: ' + filename);
          if (blobOrBuffer instanceof Blob) {
            const reader = new FileReader();
            reader.onload = function() {
              const base64 = reader.result.split(',')[1];
              if (window.__sendTripoGlbToNode) window.__sendTripoGlbToNode(base64, filename);
            };
            reader.readAsDataURL(blobOrBuffer);
          } else if (blobOrBuffer instanceof ArrayBuffer || ArrayBuffer.isView(blobOrBuffer)) {
            const blob = new Blob([blobOrBuffer], { type: 'model/gltf-binary' });
            const reader = new FileReader();
            reader.onload = function() {
              const base64 = reader.result.split(',')[1];
              if (window.__sendTripoGlbToNode) window.__sendTripoGlbToNode(base64, filename);
            };
            reader.readAsDataURL(blob);
          }
        }

        let captured = false;
        let attempts = 0;

        const timer = setInterval(async () => {
          if (captured) { clearInterval(timer); return; }
          attempts++;

          // 1. Direct Performance Resource entries (CDN streams)
          const resources = performance.getEntriesByType('resource');
          const glbRes = resources.find(r => r.name.includes('.glb') || r.name.includes('pbr_model') || (r.name.includes('tripo-data') && r.name.includes('studio')));
          if (glbRes) {
            captured = true;
            clearInterval(timer);
            try {
              const res = await fetch(glbRes.name);
              const blob = await res.blob();
              const id = location.pathname.split('/').filter(Boolean).pop() || 'model';
              sendGlb(blob, 'tripo_' + id);
            } catch(e) {}
            return;
          }

          // 2. Vue / TresJS memory extraction fallback
          const appEl = document.querySelector('[data-v-app]') || document.querySelector('#__nuxt');
          if (!appEl || !appEl.__vue_app__) return;

          function searchScene(inst, visited = new Set(), d = 0) {
            if (!inst || d > 40 || visited.has(inst)) return null;
            visited.add(inst);
            if (inst.provides) {
              for (const k of Object.keys(inst.provides)) {
                const val = inst.provides[k];
                if (val?.isScene) return val;
                if (val?.scene?.isScene) return val.scene;
                if (val?.scene?.value?.isScene) return val.scene.value;
              }
            }
            const ctx = inst.setupState || inst.proxy || inst.ctx;
            if (ctx) {
              if (ctx.scene?.isScene) return ctx.scene;
              if (ctx.scene?.value?.isScene) return ctx.scene.value;
              if (ctx.isScene) return ctx;
            }
            if (inst.subTree) {
              const f = searchVNode(inst.subTree, visited, d + 1);
              if (f) return f;
            }
            return null;
          }

          function searchVNode(vnode, visited = new Set(), d = 0) {
            if (!vnode || d > 40) return null;
            if (vnode.component) {
              const f = searchScene(vnode.component, visited, d + 1);
              if (f) return f;
            }
            if (Array.isArray(vnode.children)) {
              for (const c of vnode.children) {
                if (c && typeof c === 'object') {
                  const f = searchVNode(c, visited, d + 1);
                  if (f) return f;
                }
              }
            }
            return null;
          }

          let targetScene = null;
          const router = appEl.__vue_app__.config?.globalProperties?.$router;
          const pageInternal = router?.currentRoute?.value?.matched?.[0]?.instances?.default?._;
          if (pageInternal) targetScene = searchScene(pageInternal);
          if (!targetScene && appEl.__vue_app__._instance) targetScene = searchScene(appEl.__vue_app__._instance);

          if (targetScene) {
            function findMeshes(obj, list = []) {
              if (!obj) return list;
              if (obj.isMesh && obj.geometry?.attributes?.position?.count > 500) list.push(obj);
              if (obj.children) for (const c of obj.children) findMeshes(c, list);
              return list;
            }
            const meshes = findMeshes(targetScene);
            const modelMesh = meshes.reduce((best, m) => (m.geometry?.attributes?.position?.count ?? 0) > (best?.geometry?.attributes?.position?.count ?? 0) ? m : best, null);

            if (modelMesh) {
              captured = true;
              clearInterval(timer);
              
              const geo = modelMesh.geometry, pos = geo.attributes.position.array, uvs = geo.attributes.uv?.array, indices = geo.index?.array;
              let texBytes = null;
              const img = modelMesh.material?.map?.image;
              if (img) {
                const c = document.createElement('canvas'); c.width = img.width || 1024; c.height = img.height || 1024;
                c.getContext('2d').drawImage(img, 0, 0);
                const blob = await new Promise(r => c.toBlob(r, 'image/png'));
                texBytes = new Uint8Array(await blob.arrayBuffer());
              }

              const a4 = n => Math.ceil(n / 4) * 4;
              const pB = pos.byteLength, uvB = uvs ? a4(uvs.byteLength) : 0, iB = indices ? a4(indices.byteLength) : 0, tB = texBytes ? a4(texBytes.byteLength) : 0;
              const uvOff = a4(pB), iOff = uvOff + uvB, tOff = iOff + iB, totalBin = a4(tOff + tB);

              let minP = [Infinity, Infinity, Infinity], maxP = [-Infinity, -Infinity, -Infinity];
              for (let i = 0; i < pos.length; i += 3) {
                minP[0] = Math.min(minP[0], pos[i]); minP[1] = Math.min(minP[1], pos[i+1]); minP[2] = Math.min(minP[2], pos[i+2]);
                maxP[0] = Math.max(maxP[0], pos[i]); maxP[1] = Math.max(maxP[1], pos[i+1]); maxP[2] = Math.max(maxP[2], pos[i+2]);
              }

              const bvs = [{ buffer: 0, byteOffset: 0, byteLength: pB, target: 34962 }];
              const accs = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: minP, max: maxP }];
              const primAttr = { POSITION: 0 };

              if (uvs) {
                bvs.push({ buffer: 0, byteOffset: uvOff, byteLength: uvs.byteLength, target: 34962 });
                accs.push({ bufferView: bvs.length - 1, byteOffset: 0, componentType: 5126, count: uvs.length / 2, type: 'VEC2' });
                primAttr.TEXCOORD_0 = accs.length - 1;
              }
              let idxAcc = null;
              if (indices) {
                bvs.push({ buffer: 0, byteOffset: iOff, byteLength: indices.byteLength, target: 34963 });
                accs.push({ bufferView: bvs.length - 1, byteOffset: 0, componentType: 5125, count: indices.length, type: 'SCALAR' });
                idxAcc = accs.length - 1;
              }
              let imgBv = null;
              if (texBytes) {
                imgBv = bvs.length;
                bvs.push({ buffer: 0, byteOffset: tOff, byteLength: texBytes.byteLength });
              }

              const gltf = {
                asset: { version: '2.0', generator: 'tripo-blender-standard-glb' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
                meshes: [{ primitives: [{ attributes: primAttr, ...(idxAcc !== null ? { indices: idxAcc } : {}), ...(imgBv !== null ? { material: 0 } : {}) }] }],
                accessors: accs, bufferViews: bvs, buffers: [{ byteLength: totalBin }],
                ...(imgBv !== null ? { materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.5 }, doubleSided: true }], textures: [{ source: 0 }], images: [{ mimeType: 'image/png', bufferView: imgBv }] } : {})
              };

              const jsonEnc = new TextEncoder().encode(JSON.stringify(gltf)), jsonPad = a4(jsonEnc.length);
              const total = 12 + 8 + jsonPad + 8 + totalBin, glb = new ArrayBuffer(total), dv = new DataView(glb), buf = new Uint8Array(glb);
              let off = 0;
              dv.setUint32(off, 0x46546C67, true); off += 4; dv.setUint32(off, 2, true); off += 4; dv.setUint32(off, total, true); off += 4;
              dv.setUint32(off, jsonPad, true); off += 4; dv.setUint32(off, 0x4E4F534A, true); off += 4;
              buf.set(jsonEnc, off); for (let i = jsonEnc.length; i < jsonPad; i++) buf[off + i] = 0x20; off += jsonPad;
              dv.setUint32(off, totalBin, true); off += 4; dv.setUint32(off, 0x004E4942, true); off += 4;
              const bStart = off;
              buf.set(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength), bStart);
              if (uvs) buf.set(new Uint8Array(uvs.buffer, uvs.byteOffset, uvs.byteLength), bStart + uvOff);
              if (indices) buf.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), bStart + iOff);
              if (texBytes) buf.set(texBytes, bStart + tOff);

              const id = location.pathname.split('/').filter(Boolean).pop() || 'model';
              sendGlb(glb, 'tripo_' + id);
            }
          }
        }, 1500);
      })();
    `;

    await page.evaluateOnNewDocument(scriptCode);

    onStep('Loading Tripo3D page', 0.35);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    onStep('Extracting 3D model stream', 0.55);

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
        'Could not capture 3D model from Tripo3D.',
        'Make sure the model opens and displays correctly on studio.tripo3d.ai.',
        'rip-failed'
      );
    }

    onStep('Parsing GLB model', 0.85);
    const doc = await readGlb(capturedBuffer);
    return { name: modelTitle || 'tripo_model', doc };
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    throw err;
  }
}

// Master function: supports both direct URL ripping and official API tasks
export async function fetchTripo({ input, key, fetchImpl = fetch, onStep = () => {} }) {
  let text = String(input || '').trim();
  if (/^(www\.)?tripo3d\.ai/i.test(text)) text = 'https://' + text;
  const isUrl = /^https?:\/\//i.test(text);

  // If input is a URL, use the TripoRipper engine!
  if (isUrl) {
    return await ripTripoModel(text, onStep);
  }

  const id = parseTripoInput(text);

  // If non-URL (task ID) and no key is provided:
  if (!key) {
    if (fetchImpl !== fetch) {
      throw new MeshportError('A Tripo API key is needed.', 'Open Settings and paste your key (Tripo > Settings > API).', 'no-key');
    }
    // In live app with a task ID, try ripTripoModel using the ID URL
    return await ripTripoModel(`https://studio.tripo3d.ai/3d-model/${id}`, onStep);
  }
  onStep('Reading task', 0.1);
  const res = await request(fetchImpl, `${API}/task/${id}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw statusError('Tripo', res.status, { notFound: 'That Tripo task was not found for your key.' });
  const body = await res.json();
  if (body.code && body.code !== 0) {
    throw new MeshportError(`Tripo reported an error: ${body.message || body.code}.`, 'Check the task ID and your key.', 'tripo');
  }
  const task = body.data || {};
  if (task.status !== 'success') {
    throw new MeshportError(`The Tripo task is not finished (status: ${task.status || 'unknown'}).`, 'Wait until it finishes, then try again.', 'not-ready');
  }
  const url = task.output?.pbr_model || task.output?.model || task.output?.base_model;
  if (!url) throw new MeshportError('This task has no model file.', 'Only model-generating tasks have one.', 'no-format');

  onStep('Downloading', 0.2);
  const buf = await downloadBuffer(fetchImpl, url, (p) => onStep('Downloading', 0.2 + p * 0.5));
  onStep('Reading model', 0.75);
  const doc = await readGlb(buf);
  return { name: `tripo-${id.slice(0, 8)}`, doc };
}
