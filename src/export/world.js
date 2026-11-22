// Shared helpers for writers that need triangles in world space (STL, PLY).

// Mesh nodes in scene order.
export function listMeshNodes(doc) {
  const nodes = [];
  const walk = (node) => { nodes.push(node); node.listChildren().forEach(walk); };
  doc.getRoot().listScenes().forEach((s) => s.listChildren().forEach(walk));
  return nodes.filter((n) => n.getMesh());
}

function determinant(m) {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
}

export function transformPoint(m, p, out) {
  out[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  out[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  out[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  return out;
}

export function transformDirection(m, p, out) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2];
  const len = Math.hypot(x, y, z) || 1;
  out[0] = x / len; out[1] = y / len; out[2] = z / len;
  return out;
}

// Every triangle primitive with its world matrix. `flip` is true for mirrored nodes,
// where the winding has to be reversed to keep faces pointing outwards.
export function listTrianglePrimitives(doc) {
  const out = [];
  let skipped = false;
  for (const node of listMeshNodes(doc)) {
    const m = node.getWorldMatrix();
    const flip = determinant(m) < 0;
    for (const prim of node.getMesh().listPrimitives()) {
      if (prim.getMode() !== 4) { skipped = true; continue; }
      if (!prim.getAttribute('POSITION')) continue;
      out.push({ prim, m, flip });
    }
  }
  return { prims: out, skipped };
}

// Triangle corner indices of a primitive, as a flat array.
export function triangleIndices(prim, flip) {
  const idx = prim.getIndices();
  const count = idx ? idx.getCount() : prim.getAttribute('POSITION').getCount();
  const tris = Math.floor(count / 3);
  const out = new Uint32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const a = idx ? idx.getScalar(t * 3) : t * 3;
    const b = idx ? idx.getScalar(t * 3 + 1) : t * 3 + 1;
    const c = idx ? idx.getScalar(t * 3 + 2) : t * 3 + 2;
    out[t * 3] = a;
    out[t * 3 + 1] = flip ? c : b;
    out[t * 3 + 2] = flip ? b : c;
  }
  return out;
}
