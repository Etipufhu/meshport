import { Document } from '@gltf-transform/core';
import { MeshportError } from '../errors.js';

// Small Wavefront OBJ + MTL reader that builds a glTF document.
// `files` is an optional { path: Uint8Array } map (from a zip) used to find the
// .mtl file and the textures next to the OBJ.

const clean = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

// Looks a referenced file up in the zip: relative to the OBJ first, then by name only.
function makeFinder(files, baseDir) {
  const index = new Map();
  const byName = new Map();
  for (const key of Object.keys(files || {})) {
    index.set(clean(key), key);
    const short = clean(key).split('/').pop();
    if (!byName.has(short)) byName.set(short, key);
  }
  return (ref) => {
    if (!ref) return null;
    let r = clean(ref);
    try { r = clean(decodeURIComponent(ref)); } catch { /* keep as is */ }
    const hit = index.get(clean(baseDir) + r) || index.get(r) || byName.get(r.split('/').pop());
    return hit ? files[hit] : null;
  };
}

function imageType(data) {
  if (data.length > 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  return null;
}

// Texture lines can carry options ("-bm 1 file.png"); the file name is what is left after them.
function textureRef(rest) {
  const tokens = rest.trim().split(/\s+/);
  const optionArgs = { '-bm': 1, '-s': 3, '-o': 3, '-t': 3, '-mm': 2, '-texres': 1, '-boost': 1, '-clamp': 1, '-blendu': 1, '-blendv': 1, '-imfchan': 1, '-type': 1 };
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith('-')) i += 1 + (optionArgs[tokens[i].toLowerCase()] ?? 0);
  return tokens.slice(i).join(' ');
}

export function parseMtl(text) {
  const mats = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.search(/\s/);
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (key === 'newmtl') { cur = { name: rest, kd: [0.8, 0.8, 0.8], alpha: 1 }; mats.set(rest, cur); continue; }
    if (!cur) continue;
    const nums = () => rest.split(/\s+/).map(Number);
    if (key === 'kd') { const n = nums(); if (n.length >= 3 && n.every(Number.isFinite)) cur.kd = n.slice(0, 3); }
    else if (key === 'ke') { const n = nums(); if (n.length >= 3 && n.every(Number.isFinite)) cur.ke = n.slice(0, 3); }
    else if (key === 'd') { const d = Number(rest); if (Number.isFinite(d)) cur.alpha = d; }
    else if (key === 'tr') { const d = Number(rest); if (Number.isFinite(d)) cur.alpha = 1 - d; }
    else if (key === 'map_kd') cur.mapKd = textureRef(rest);
    else if (key === 'map_bump' || key === 'bump' || key === 'norm') cur.mapBump = textureRef(rest);
    else if (key === 'map_ke') cur.mapKe = textureRef(rest);
  }
  return mats;
}

// OBJ indices are 1-based, and negative ones count back from the end.
function resolveIndex(s, count) {
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n === 0) return -1;
  return n > 0 ? n - 1 : count + n;
}

export function parseObj(buf, files = {}, objPath = '') {
  const text = Buffer.from(buf).toString('utf8');
  const finder = makeFinder(files, dirOf(objPath));

  const V = [], VT = [], VN = [];
  const mtlNames = [];
  // One group per material; vertices are shared by (position, uv, normal) triples.
  const groups = new Map();
  let current = 'default';
  const group = (name) => {
    if (!groups.has(name)) groups.set(name, { pos: [], uv: [], nor: [], idx: [], seen: new Map(), allUv: true, allNor: true });
    return groups.get(name);
  };

  const lines = text.split(/\r?\n/);
  let faceCount = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line || line[0] === '#') continue;
    if (line.startsWith('v ')) {
      const t = line.trim().split(/\s+/);
      V.push(+t[1], +t[2], +t[3]);
    } else if (line.startsWith('vt ')) {
      const t = line.trim().split(/\s+/);
      VT.push(+t[1], +t[2] || 0);
    } else if (line.startsWith('vn ')) {
      const t = line.trim().split(/\s+/);
      VN.push(+t[1], +t[2], +t[3]);
    } else if (line.startsWith('f ')) {
      const t = line.trim().split(/\s+/).slice(1);
      if (t.length < 3) continue;
      const g = group(current);
      const ids = t.map((tok) => {
        const hit = g.seen.get(tok);
        if (hit !== undefined) return hit;
        const [a, b, n] = tok.split('/');
        const vi = resolveIndex(a, V.length / 3);
        if (vi < 0 || vi * 3 + 2 >= V.length) {
          throw new MeshportError(`The OBJ file has a face that points to a missing vertex (line ${li + 1}).`, 'The file may be damaged.', 'bad-file');
        }
        const ti = b ? resolveIndex(b, VT.length / 2) : -1;
        const ni = n ? resolveIndex(n, VN.length / 3) : -1;
        g.pos.push(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]);
        if (ti >= 0 && ti * 2 + 1 < VT.length) g.uv.push(VT[ti * 2], 1 - VT[ti * 2 + 1]);
        else { g.uv.push(0, 0); g.allUv = false; }
        if (ni >= 0 && ni * 3 + 2 < VN.length) g.nor.push(VN[ni * 3], VN[ni * 3 + 1], VN[ni * 3 + 2]);
        else { g.nor.push(0, 0, 1); g.allNor = false; }
        const id = g.pos.length / 3 - 1;
        g.seen.set(tok, id);
        return id;
      });
      for (let i = 1; i + 1 < ids.length; i++) g.idx.push(ids[0], ids[i], ids[i + 1]);
      faceCount++;
    } else if (line.startsWith('usemtl')) {
      current = line.slice(6).trim() || 'default';
    } else if (line.startsWith('mtllib')) {
      mtlNames.push(line.slice(6).trim());
    }
  }
  if (!faceCount) throw new MeshportError('The OBJ file has no faces.', 'It may be empty, or it only contains points or lines.', 'bad-file');

  const mats = new Map();
  for (const n of mtlNames) {
    const data = finder(n);
    if (data) for (const [k, v] of parseMtl(Buffer.from(data).toString('utf8'))) mats.set(k, v);
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh('mesh');
  const textures = new Map();
  const texture = (ref) => {
    const data = finder(ref);
    if (!data) return null;
    const mime = imageType(data);
    if (!mime) return null;
    if (!textures.has(ref)) textures.set(ref, doc.createTexture(ref).setImage(new Uint8Array(data)).setMimeType(mime));
    return textures.get(ref);
  };
  const materials = new Map();
  const material = (name) => {
    if (materials.has(name)) return materials.get(name);
    const def = mats.get(name);
    const m = doc.createMaterial(name)
      .setBaseColorFactor(def ? [...def.kd, Math.max(0, Math.min(1, def.alpha))] : [0.8, 0.8, 0.8, 1])
      .setMetallicFactor(0).setRoughnessFactor(1);
    if (def) {
      if (def.alpha < 1) m.setAlphaMode('BLEND');
      const kd = def.mapKd && texture(def.mapKd);
      if (kd) m.setBaseColorTexture(kd);
      const bump = def.mapBump && texture(def.mapBump);
      if (bump) m.setNormalTexture(bump);
      const ke = def.mapKe && texture(def.mapKe);
      if (def.ke) m.setEmissiveFactor(def.ke.map((x) => Math.max(0, Math.min(1, x))));
      if (ke) { m.setEmissiveTexture(ke); if (!def.ke) m.setEmissiveFactor([1, 1, 1]); }
    }
    materials.set(name, m);
    return m;
  };

  for (const [name, g] of groups) {
    if (!g.idx.length) continue;
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(g.pos)))
      .setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint32Array(g.idx)))
      .setMaterial(material(name));
    if (g.allNor) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(g.nor)));
    if (g.allUv) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setBuffer(buffer).setArray(new Float32Array(g.uv)));
    mesh.addPrimitive(prim);
  }
  doc.createScene('scene').addChild(doc.createNode('model').setMesh(mesh));
  return doc;
}
