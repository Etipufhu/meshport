import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as cleanMod from './clean.js';
import { toObj } from './obj.js';
import { toStl } from './stl.js';
import { toPly } from './ply.js';
import { createBlenderBridge, noBlender } from './fbx.js';
import { parseObj } from './obj-import.js';
import { unzipFiles, gltfFilesToDoc } from './gltfzip.js';
import { getIO, readGlb, isGlb } from './io.js';
import { safeName } from '../safe.js';
import { MeshportError } from '../errors.js';

const { cleanForBlender, describeDocument } = cleanMod;

// glb, obj, stl and ply are always available; fbx needs Blender on the computer.
export const FORMATS = ['glb', 'obj', 'stl', 'ply', 'fbx'];
export const ALWAYS_FORMATS = ['glb', 'obj', 'stl', 'ply'];

let defaultBridge;
const getDefaultBridge = () => (defaultBridge ||= createBlenderBridge());

// Picks a folder name inside `outDir` that does not exist yet.
async function freshFolder(outDir, name) {
  await fs.mkdir(outDir, { recursive: true });
  for (let i = 1; i < 1000; i++) {
    const dir = path.join(outDir, i === 1 ? name : `${name}-${i}`);
    try {
      await fs.mkdir(dir);
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new MeshportError('Could not create an output folder.', 'Clean up the output folder and try again.');
}

// The processing step lives in its own file; use it only when it is there.
async function loadProcessing() {
  try {
    return await import('./process.js');
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes('process.js')) return null;
    throw err;
  }
}

// Cleans `doc` and writes it in each requested format under outDir/<name>/.
// `credit` is optional text saved next to the model (license and author).
// `options` goes to applyOptions in process.js. `blender` can be swapped in tests.
export async function exportDocument(doc, { name, formats = ['glb'], outDir, credit, options = {}, blender } = {}) {
  const wanted = [...new Set(formats)].filter((f) => FORMATS.includes(f));
  if (!wanted.length) throw new MeshportError('No export format selected.', 'Choose at least one output format.', 'bad-input');

  const bridge = blender || getDefaultBridge();
  if (wanted.includes('fbx') && !(await bridge.find())) throw noBlender();

  const base = safeName(name);
  const dir = await freshFolder(outDir, base);
  try {
    return await writeAll(doc, { base, dir, wanted, credit, options, bridge });
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function writeAll(doc, { base, dir, wanted, credit, options, bridge }) {
  await cleanForBlender(doc);
  const processing = await loadProcessing();
  if (processing && processing.applyOptions) await processing.applyOptions(doc, options || {});
  const stats = describeDocument(doc);
  if (!stats.vertices) {
    throw new MeshportError('The model has no geometry.', 'The file is empty or only contains animations.', 'empty-model');
  }
  const cleanup = cleanMod.getCleanStats ? cleanMod.getCleanStats(doc) : undefined;

  const written = [];
  const put = async (rel, data) => {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    written.push({ name: rel.replace(/\\/g, '/'), size: data.byteLength });
  };

  const notes = [];
  let glbData;
  if (wanted.includes('glb') || wanted.includes('fbx')) glbData = Buffer.from(await (await getIO()).writeBinary(doc));
  if (wanted.includes('glb')) await put(`${base}.glb`, glbData);
  if (wanted.includes('obj')) {
    const obj = toObj(doc, base);
    for (const f of obj.files) await put(f.name, f.data);
    if (obj.skippedModes.length) notes.push('Some points/lines were left out of the OBJ file (only triangles are exported).');
  }
  if (wanted.includes('stl')) {
    await put(`${base}.stl`, toStl(doc, base).data);
    notes.push('STL has no colors or textures, only the shape.');
  }
  if (wanted.includes('ply')) await put(`${base}.ply`, toPly(doc).data);
  if (wanted.includes('fbx')) {
    // Blender reads the GLB next to the model; if none was asked for, use a throwaway copy.
    const tmp = wanted.includes('glb') ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'meshport-fbx-'));
    const glbPath = tmp ? path.join(tmp, `${base}.glb`) : path.join(dir, `${base}.glb`);
    if (tmp) await fs.writeFile(glbPath, glbData);
    const fbxPath = path.join(dir, `${base}.fbx`);
    try {
      await bridge.exportFbx(glbPath, fbxPath);
    } finally {
      if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    }
    written.push({ name: `${base}.fbx`, size: (await fs.stat(fbxPath)).size });
  }
  if (credit) await put('CREDITS.txt', Buffer.from(credit + '\n'));

  const result = { folder: path.basename(dir), files: written, stats, notes };
  if (cleanup) result.cleanup = cleanup;
  return result;
}

const SUPPORTED = 'Supported files: .glb, .gltf, .obj, or a .zip containing one of them (with its textures).';

// Reads an uploaded model of any supported kind. Looks at the content first and the
// file name second, because browsers and users get extensions wrong.
export async function readModel(buf, filename = '') {
  const ext = path.extname(filename).toLowerCase();
  if (!buf || !buf.byteLength) throw new MeshportError('The file is empty.', SUPPORTED, 'bad-file');

  if (isGlb(buf)) return readGlb(buf);
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5)) return readZipModel(buf);

  const head = buf.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('{')) return gltfFilesToDoc({ 'model.gltf': buf }, 'model.gltf');

  if (ext === '.fbx' || head.startsWith('Kaydara FBX')) {
    throw new MeshportError('FBX files cannot be read.', 'Open it in Blender and export it as GLB first. ' + SUPPORTED, 'bad-file');
  }
  const looksObj = /^(v|vt|vn|f|o|g|mtllib|usemtl)\s/m.test(head);
  if (ext === '.obj' || (looksObj && !ext)) return parseObj(buf);
  if (ext === '.glb') throw new MeshportError('This is not a GLB file.', SUPPORTED, 'bad-file');
  if (ext === '.gltf') throw new MeshportError('The .gltf file is not valid JSON.', SUPPORTED, 'bad-file');
  if (ext === '.zip') throw new MeshportError('This is not a valid zip file.', SUPPORTED, 'bad-archive');
  throw new MeshportError(`This file type is not supported${ext ? ` (${ext})` : ''}.`, SUPPORTED, 'bad-file');
}

async function readZipModel(buf) {
  const files = unzipFiles(buf);
  const names = Object.keys(files);
  const find = (e) => names.find((n) => n.toLowerCase().endsWith(e));
  const gltf = find('.gltf');
  if (gltf) return gltfFilesToDoc(files, gltf);
  const glb = find('.glb');
  if (glb) return readGlb(Buffer.from(files[glb]));
  const obj = find('.obj');
  if (obj) return parseObj(files[obj], files, obj);
  throw new MeshportError('The zip has no model inside.', 'It should contain a .gltf, .glb or .obj file. ' + SUPPORTED, 'bad-archive');
}
