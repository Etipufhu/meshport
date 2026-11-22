import { listTrianglePrimitives, triangleIndices, transformPoint, transformDirection } from './world.js';

// Binary little endian PLY with positions in world space. Normals, UVs and vertex
// colors are written when every primitive has them.
export function toPly(doc) {
  const { prims, skipped } = listTrianglePrimitives(doc);
  const hasNormals = prims.length > 0 && prims.every(({ prim }) => prim.getAttribute('NORMAL'));
  const hasUv = prims.length > 0 && prims.every(({ prim }) => prim.getAttribute('TEXCOORD_0'));
  const hasColor = prims.length > 0 && prims.every(({ prim }) => prim.getAttribute('COLOR_0'));

  const verts = prims.reduce((s, x) => s + x.prim.getAttribute('POSITION').getCount(), 0);
  const faces = prims.reduce((s, x) => s + triangleIndices(x.prim, false).length / 3, 0);

  const header = ['ply', 'format binary_little_endian 1.0', 'comment exported by meshport', `element vertex ${verts}`,
    'property float x', 'property float y', 'property float z'];
  if (hasNormals) header.push('property float nx', 'property float ny', 'property float nz');
  if (hasUv) header.push('property float s', 'property float t');
  if (hasColor) header.push('property uchar red', 'property uchar green', 'property uchar blue', 'property uchar alpha');
  header.push(`element face ${faces}`, 'property list uchar int vertex_indices', 'end_header');
  const head = Buffer.from(header.join('\n') + '\n', 'latin1');

  const stride = 12 + (hasNormals ? 12 : 0) + (hasUv ? 8 : 0) + (hasColor ? 4 : 0);
  const body = Buffer.alloc(verts * stride + faces * 13);
  let off = 0;
  const p = [0, 0, 0], o = [0, 0, 0], t = [0, 0], c = [0, 0, 0, 1];
  const byte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (const { prim, m } of prims) {
    const pos = prim.getAttribute('POSITION');
    const nor = hasNormals && prim.getAttribute('NORMAL');
    const uv = hasUv && prim.getAttribute('TEXCOORD_0');
    const col = hasColor && prim.getAttribute('COLOR_0');
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, p);
      transformPoint(m, p, o);
      for (const v of o) { body.writeFloatLE(v, off); off += 4; }
      if (nor) {
        nor.getElement(i, p);
        transformDirection(m, p, o);
        for (const v of o) { body.writeFloatLE(v, off); off += 4; }
      }
      if (uv) {
        uv.getElement(i, t);
        body.writeFloatLE(t[0], off); off += 4;
        body.writeFloatLE(1 - t[1], off); off += 4;
      }
      if (col) {
        c[3] = 1;
        col.getElement(i, c);
        for (let k = 0; k < 4; k++) body[off++] = byte(c[k]);
      }
    }
  }
  let base = 0;
  for (const { prim, flip } of prims) {
    const tris = triangleIndices(prim, flip);
    for (let i = 0; i < tris.length; i += 3) {
      body[off++] = 3;
      for (let k = 0; k < 3; k++) { body.writeInt32LE(tris[i + k] + base, off); off += 4; }
    }
    base += prim.getAttribute('POSITION').getCount();
  }
  return { data: Buffer.concat([head, body]), vertices: verts, faces, skippedModes: skipped };
}
