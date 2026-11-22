const MODE_TRIANGLES = 4;
// Vertices closer than this fraction of the model size count as "on top of each other".
const MERGE_RATIO = 1e-5;
// Vertices closer than this (float noise) prove two triangles belong to the same part.
const JOIN_RATIO = 1e-7;
const NORMAL_DOT = 0.99;

function find(uf, x) {
  while (uf[x] !== x) {
    uf[x] = uf[uf[x]];
    x = uf[x];
  }
  return x;
}

function cellKey(ix, iy, iz) {
  return Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791);
}

// Per-attribute rule for "these two vertices are the same vertex": positions alone are
// not enough, otherwise UV seams and hard edges would be glued shut.
function attributeCheckers(prim) {
  const checks = [];
  for (const semantic of prim.listSemantics()) {
    if (semantic === 'POSITION') continue;
    const acc = prim.getAttribute(semantic);
    if (!acc) continue;
    const size = acc.getElementSize();
    const a = new Array(size).fill(0);
    const b = new Array(size).fill(0);
    const tol = semantic.startsWith('COLOR_') ? 0.01 : 1e-4;
    checks.push((i, j) => {
      acc.getElement(i, a);
      acc.getElement(j, b);
      if (semantic === 'NORMAL') {
        const la = Math.hypot(a[0], a[1], a[2]) || 1;
        const lb = Math.hypot(b[0], b[1], b[2]) || 1;
        return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb) >= NORMAL_DOT;
      }
      for (let k = 0; k < size; k++) if (Math.abs(a[k] - b[k]) > tol) return false;
      return true;
    });
  }
  return checks;
}

// Merges vertices that sit (almost) on top of each other, like Blender's "Merge by Distance",
// but only inside one part. A part is one mesh primitive, and within it every group of
// triangles that is connected. Two separate parts are never joined, even when they touch.
// Returns how many vertices were merged. Unused vertices are removed later by removeJunkGeometry.
export function weldNearVertices(doc, { ratio = MERGE_RATIO } = {}) {
  let merged = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== MODE_TRIANGLES || prim.listTargets().length) continue;
      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc || posAcc.getElementSize() !== 3) continue;
      const n = posAcc.getCount();
      if (n < 3) continue;
      const pos = posAcc.getArray();

      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          const v = pos[i * 3 + k];
          if (v < lo[k]) lo[k] = v;
          if (v > hi[k]) hi[k] = v;
        }
      }
      const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      const eps = diag * ratio;
      if (!(eps > 0) || !Number.isFinite(eps)) continue;
      const join = diag * JOIN_RATIO;

      const idxAcc = prim.getIndices();
      const src = idxAcc ? idxAcc.getArray() : null;
      const total = src ? src.length : n;

      // Parts: vertices of one triangle belong together, and so do vertices that are the
      // same point up to float noise (unwelded models repeat every corner).
      const uf = new Int32Array(n);
      for (let i = 0; i < n; i++) uf[i] = i;
      const union = (x, y) => {
        const rx = find(uf, x);
        const ry = find(uf, y);
        if (rx !== ry) uf[ry] = rx;
      };
      for (let i = 0; i + 2 < total; i += 3) {
        const a = src ? src[i] : i;
        const b = src ? src[i + 1] : i + 1;
        const c = src ? src[i + 2] : i + 2;
        union(a, b);
        union(b, c);
      }

      const grid = new Map();
      const near = (i, visit) => {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const cx = Math.floor(x / eps), cy = Math.floor(y / eps), cz = Math.floor(z / eps);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              const list = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
              if (!list) continue;
              for (const j of list) {
                if (j >= i) break;
                const ddx = pos[j * 3] - x, ddy = pos[j * 3 + 1] - y, ddz = pos[j * 3 + 2] - z;
                if (visit(j, Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)) === true) return;
              }
            }
          }
        }
      };

      for (let i = 0; i < n; i++) {
        near(i, (j, d) => { if (d <= join) union(i, j); });
        const key = cellKey(Math.floor(pos[i * 3] / eps), Math.floor(pos[i * 3 + 1] / eps), Math.floor(pos[i * 3 + 2] / eps));
        const list = grid.get(key);
        if (list) list.push(i); else grid.set(key, [i]);
      }

      const checks = attributeCheckers(prim);
      const remap = new Int32Array(n);
      let count = 0;
      for (let i = 0; i < n; i++) {
        remap[i] = i;
        const part = find(uf, i);
        near(i, (j, d) => {
          if (remap[j] !== j || d > eps || find(uf, j) !== part) return false;
          for (const ok of checks) if (!ok(i, j)) return false;
          remap[i] = j;
          count++;
          return true;
        });
      }
      if (!count) continue;

      const out = [];
      for (let i = 0; i + 2 < total; i += 3) {
        const a = remap[src ? src[i] : i];
        const b = remap[src ? src[i + 1] : i + 1];
        const c = remap[src ? src[i + 2] : i + 2];
        if (a !== b && b !== c && a !== c) out.push(a, b, c);
      }
      const IndexArray = n > 65535 ? Uint32Array : Uint16Array;
      prim.setIndices(doc.createAccessor().setType('SCALAR').setBuffer(posAcc.getBuffer()).setArray(new IndexArray(out)));
      merged += count;
    }
  }
  return merged;
}
