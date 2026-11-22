import { unzipSync } from 'fflate';
import { getIO } from './io.js';
import { MeshportError } from '../errors.js';

// Unzips a buffer into { path: Uint8Array }, skipping folders and macOS junk.
export function unzipFiles(zipBuffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength));
  } catch {
    throw new MeshportError('This is not a valid zip file.', 'Try again. If it keeps failing, the file may be damaged or the download link may have expired.', 'bad-archive');
  }
  const out = {};
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) continue;
    out[name] = data;
  }
  return out;
}

// Builds a document from an already-unzipped glTF (scene.gltf + scene.bin + textures/).
export async function gltfFilesToDoc(files, gltfName) {
  let json;
  try {
    json = JSON.parse(Buffer.from(files[gltfName]).toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new MeshportError('The .gltf file is not valid JSON.', 'The file may be damaged.', 'bad-file');
  }
  const baseDir = gltfName.includes('/') ? gltfName.slice(0, gltfName.lastIndexOf('/') + 1) : '';

  // glTF refers to files by relative URI; zip entries use plain paths.
  const resources = {};
  const addUri = (uri) => {
    if (!uri || uri.startsWith('data:')) return;
    let decoded = uri;
    try { decoded = decodeURIComponent(uri); } catch { /* use as is */ }
    const data = files[baseDir + decoded] || files[baseDir + uri];
    if (data) resources[uri] = data;
  };
  (json.buffers || []).forEach((b) => addUri(b.uri));
  (json.images || []).forEach((i) => addUri(i.uri));

  const refs = [...(json.buffers || []), ...(json.images || [])].map((r) => r.uri);
  const missing = refs.filter((u) => u && !u.startsWith('data:') && !resources[u]);
  if (missing.length) {
    throw new MeshportError(
      `The glTF refers to files that are missing: ${missing.slice(0, 3).join(', ')}.`,
      'Put the .gltf, its .bin and the textures in one zip file and drop that instead.',
      'bad-file'
    );
  }

  const io = await getIO();
  try {
    return await io.readJSON({ json, resources });
  } catch (err) {
    throw new MeshportError('The glTF file could not be read: ' + err.message, 'The file may be damaged or use an extension that is not supported.', 'bad-file');
  }
}

// Reads a zipped glTF and returns the document.
export async function gltfZipToGlb(zipBuffer) {
  const files = unzipFiles(zipBuffer);
  const gltfName = Object.keys(files).find((n) => n.toLowerCase().endsWith('.gltf'));
  if (!gltfName) throw new MeshportError('The archive has no .gltf file inside.', '', 'bad-archive');
  return gltfFilesToDoc(files, gltfName);
}
