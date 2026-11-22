import { dequantize, prune } from '@gltf-transform/functions';
import { weldNearVertices } from './weld.js';

const COMPRESSION_EXTENSIONS = [
  'EXT_meshopt_compression',
  'KHR_mesh_quantization',
  'KHR_draco_mesh_compression',
];

const MODE_TRIANGLES = 4;
const LINE_MODES = new Set([1, 2, 3]);
// A triangle whose height is less than this fraction of its longest edge is drawn as a line.
const SLIVER_RATIO = 1e-4;

// True when the triangle has no area worth keeping: repeated corners, NaN values,
// zero area, or so thin that it only shows up as a stray edge.
function isJunkTriangle(pos, a, b, c) {
  if (a === b || b === c || a === c) return true;
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
  const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const e3x = cx - bx, e3y = cy - by, e3z = cz - bz;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const twiceArea = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!Number.isFinite(twiceArea) || twiceArea === 0) return true;
  const longest = Math.sqrt(Math.max(
    e1x * e1x + e1y * e1y + e1z * e1z,
    e2x * e2x + e2y * e2y + e2z * e2z,
    e3x * e3x + e3y * e3y + e3z * e3z,
  ));
  return twiceArea / longest / longest < SLIVER_RATIO;
}

// Removes what shows up as loose edges and stray lines in Blender: lines, degenerate
// or paper-thin triangles, and vertices no triangle uses any more. Works on any model.
export function removeJunkGeometry(doc) {
  const removed = { lines: 0, triangles: 0, vertices: 0 };

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode();
      if (LINE_MODES.has(mode)) {
        prim.dispose();
        removed.lines++;
        continue;
      }
      if (mode !== MODE_TRIANGLES) continue;

      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) continue;
      const pos = posAcc.getArray();
      const vertexCount = posAcc.getCount();
      const idxAcc = prim.getIndices();
      const src = idxAcc ? idxAcc.getArray() : null;
      const total = src ? src.length : vertexCount;

      const kept = [];
      for (let i = 0; i + 2 < total; i += 3) {
        const a = src ? src[i] : i;
        const b = src ? src[i + 1] : i + 1;
        const c = src ? src[i + 2] : i + 2;
        if (isJunkTriangle(pos, a, b, c)) removed.triangles++;
        else kept.push(a, b, c);
      }

      // Keep only vertices that a triangle still uses, and renumber the triangles.
      const remap = new Int32Array(vertexCount).fill(-1);
      let used = 0;
      for (const v of kept) if (remap[v] === -1) remap[v] = used++;
      const unusedHere = vertexCount - used;
      if (!unusedHere && kept.length === total) continue;
      removed.vertices += unusedHere;

      if (!kept.length) {
        prim.dispose();
        continue;
      }

      const buffer = posAcc.getBuffer();
      const compact = (acc) => {
        const size = acc.getElementSize();
        const old = acc.getArray();
        const out = new old.constructor(used * size);
        for (let v = 0; v < vertexCount; v++) {
          const to = remap[v];
          if (to === -1) continue;
          for (let k = 0; k < size; k++) out[to * size + k] = old[v * size + k];
        }
        return doc.createAccessor().setType(acc.getType()).setBuffer(buffer)
          .setNormalized(acc.getNormalized()).setArray(out);
      };

      for (const semantic of prim.listSemantics()) {
        const acc = prim.getAttribute(semantic);
        if (acc && acc.getCount() === vertexCount) prim.setAttribute(semantic, compact(acc));
      }
      for (const target of prim.listTargets()) {
        for (const semantic of target.listSemantics()) {
          const acc = target.getAttribute(semantic);
          if (acc && acc.getCount() === vertexCount) target.setAttribute(semantic, compact(acc));
        }
      }
      const IndexArray = used > 65535 ? Uint32Array : Uint16Array;
      const newIdx = new IndexArray(kept.length);
      for (let i = 0; i < kept.length; i++) newIdx[i] = remap[kept[i]];
      prim.setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(newIdx));
    }
    if (!mesh.listPrimitives().length) mesh.dispose();
  }

  return removed;
}

const cleanStats = new WeakMap();

// Numbers from the last cleanup of `doc`: lines/triangles/vertices removed and vertices
// merged. Undefined when cleanup did not run on this document.
export function getCleanStats(doc) {
  return cleanStats.get(doc);
}

// Turns a compressed or quantized model into plain float glTF so that Blender
// and other tools open it without extra plugins, and drops loose edges and
// degenerate triangles. Mutates and returns `doc`. Pass {cleanup: false} to only
// dequantize and drop the compression extensions.
export async function cleanForBlender(doc, { cleanup = true } = {}) {
  cleanStats.delete(doc);
  await doc.transform(dequantize());
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (COMPRESSION_EXTENSIONS.includes(ext.extensionName)) ext.dispose();
  }
  if (!cleanup) return doc;
  const merged = weldNearVertices(doc);
  const removed = removeJunkGeometry(doc);
  cleanStats.set(doc, { ...removed, merged });
  // Only sweeps up the accessors left behind above; attributes, nodes and extras stay.
  await doc.transform(prune({ keepAttributes: true, keepLeaves: true, keepExtras: true }));
  return doc;
}

// Short summary used in the UI after a job finishes.
export function describeDocument(doc) {
  let vertices = 0;
  let triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (pos) vertices += pos.getCount();
      const idx = prim.getIndices();
      triangles += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
    }
  }
  return {
    meshes: doc.getRoot().listMeshes().length,
    materials: doc.getRoot().listMaterials().length,
    textures: doc.getRoot().listTextures().length,
    vertices,
    triangles,
  };
}
