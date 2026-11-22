import { listTrianglePrimitives, triangleIndices, transformPoint } from './world.js';

// Binary STL: 80 byte header, triangle count, then 50 bytes per triangle.
// Triangles are written in world space, so node transforms are baked in.
export function toStl(doc, name = 'meshport') {
  const { prims, skipped } = listTrianglePrimitives(doc);
  const parts = prims.map(({ prim, m, flip }) => {
    const pos = prim.getAttribute('POSITION');
    const world = new Float32Array(pos.getCount() * 3);
    const p = [0, 0, 0];
    const o = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, p);
      transformPoint(m, p, o);
      world.set(o, i * 3);
    }
    return { world, tris: triangleIndices(prim, flip) };
  });
  const total = parts.reduce((s, x) => s + x.tris.length / 3, 0);
  const buf = Buffer.alloc(84 + total * 50);
  buf.write(`meshport ${name}`.slice(0, 79), 0, 'latin1');
  buf.writeUInt32LE(total, 80);
  let off = 84;
  for (const { world, tris } of parts) {
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const e1 = [world[b] - world[a], world[b + 1] - world[a + 1], world[b + 2] - world[a + 2]];
      const e2 = [world[c] - world[a], world[c + 1] - world[a + 1], world[c + 2] - world[a + 2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1];
      let ny = e1[2] * e2[0] - e1[0] * e2[2];
      let nz = e1[0] * e2[1] - e1[1] * e2[0];
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (const v of [nx, ny, nz]) { buf.writeFloatLE(v, off); off += 4; }
      for (const base of [a, b, c]) {
        for (let k = 0; k < 3; k++) { buf.writeFloatLE(world[base + k], off); off += 4; }
      }
      off += 2; // attribute byte count, unused
    }
  }
  return { data: buf, triangles: total, skippedModes: skipped };
}
