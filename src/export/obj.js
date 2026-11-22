import { safeName } from '../safe.js';

// Writes the model as Wavefront OBJ + MTL, with base color textures next to it.
// Returns [{ name, data }] where `name` is relative to the model folder.
export function toObj(doc, baseName) {
  const out = [];
  const lines = [`# exported by meshport`, `mtllib ${baseName}.mtl`];
  const mtl = [];
  const materialNames = new Map();
  const textureFiles = new Map();
  let vOffset = 1;
  let vtOffset = 1;
  let vnOffset = 1;
  const skipped = new Set();

  const matName = (material) => {
    if (!material) return 'default';
    if (materialNames.has(material)) return materialNames.get(material);
    let name = safeName(material.getName(), 'material').replace(/\s+/g, '_');
    const used = new Set(materialNames.values());
    for (let i = 2; used.has(name); i++) name = `${name}_${i}`;
    materialNames.set(material, name);

    const f = material.getBaseColorFactor();
    mtl.push(`newmtl ${name}`, `Kd ${f[0].toFixed(4)} ${f[1].toFixed(4)} ${f[2].toFixed(4)}`, `d ${f[3].toFixed(4)}`);
    // Writes a texture next to the model once, and returns its path (or null).
    const saveTex = (tex, suffix) => {
      if (!tex || !tex.getImage()) return null;
      if (!textureFiles.has(tex)) {
        const ext = tex.getMimeType() === 'image/jpeg' ? 'jpg' : 'png';
        const file = `textures/${name}_${suffix}.${ext}`;
        textureFiles.set(tex, file);
        out.push({ name: file, data: Buffer.from(tex.getImage()) });
      }
      return textureFiles.get(tex);
    };
    const base = saveTex(material.getBaseColorTexture(), 'baseColor');
    if (base) mtl.push(`map_Kd ${base}`);
    const em = material.getEmissiveFactor();
    if (em.some((v) => v > 0)) mtl.push(`Ke ${em.map((v) => v.toFixed(4)).join(' ')}`);
    const emTex = saveTex(material.getEmissiveTexture(), 'emissive');
    if (emTex) mtl.push(`map_Ke ${emTex}`);
    const normal = saveTex(material.getNormalTexture(), 'normal');
    if (normal) mtl.push(`map_Bump ${normal}`, `norm ${normal}`);
    // glTF packs roughness (green) and metalness (blue) in one image; Blender reads both from it.
    mtl.push(`Pr ${material.getRoughnessFactor().toFixed(4)}`, `Pm ${material.getMetallicFactor().toFixed(4)}`);
    const mr = saveTex(material.getMetallicRoughnessTexture(), 'metallicRoughness');
    if (mr) mtl.push(`map_Pr ${mr}`, `map_Pm ${mr}`);
    mtl.push('');
    return name;
  };

  const scenes = doc.getRoot().listScenes();
  const nodes = [];
  const walk = (node) => { nodes.push(node); node.listChildren().forEach(walk); };
  (scenes.length ? scenes : []).forEach((s) => s.listChildren().forEach(walk));

  let meshIndex = 0;
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    const nm = normalMatrix(m);
    meshIndex++;
    mesh.listPrimitives().forEach((prim, pi) => {
      const mode = prim.getMode();
      if (mode !== 4) { skipped.add(mode); return; }
      const pos = prim.getAttribute('POSITION');
      if (!pos) return;
      const nor = prim.getAttribute('NORMAL');
      const uv = prim.getAttribute('TEXCOORD_0');
      const idx = prim.getIndices();

      lines.push(`o ${safeName(node.getName() || mesh.getName(), 'mesh').replace(/\s+/g, '_')}_${meshIndex}_${pi}`);
      const p = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, p);
        lines.push(`v ${fmt(m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12])} ${fmt(m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13])} ${fmt(m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14])}`);
      }
      if (uv) {
        const t = [0, 0];
        for (let i = 0; i < uv.getCount(); i++) { uv.getElement(i, t); lines.push(`vt ${fmt(t[0])} ${fmt(1 - t[1])}`); }
      }
      if (nor) {
        const n = [0, 0, 0];
        for (let i = 0; i < nor.getCount(); i++) {
          nor.getElement(i, n);
          const x = nm[0] * n[0] + nm[3] * n[1] + nm[6] * n[2];
          const y = nm[1] * n[0] + nm[4] * n[1] + nm[7] * n[2];
          const z = nm[2] * n[0] + nm[5] * n[1] + nm[8] * n[2];
          const len = Math.hypot(x, y, z) || 1;
          lines.push(`vn ${fmt(x / len)} ${fmt(y / len)} ${fmt(z / len)}`);
        }
      }
      lines.push(`usemtl ${matName(prim.getMaterial())}`);
      const count = idx ? idx.getCount() : pos.getCount();
      const ref = (i) => {
        const v = (idx ? idx.getScalar(i) : i);
        const a = v + vOffset;
        if (uv && nor) return `${a}/${v + vtOffset}/${v + vnOffset}`;
        if (uv) return `${a}/${v + vtOffset}`;
        if (nor) return `${a}//${v + vnOffset}`;
        return `${a}`;
      };
      for (let i = 0; i + 2 < count; i += 3) lines.push(`f ${ref(i)} ${ref(i + 1)} ${ref(i + 2)}`);
      vOffset += pos.getCount();
      if (uv) vtOffset += uv.getCount();
      if (nor) vnOffset += nor.getCount();
    });
  }

  if (!materialNames.size) mtl.push('newmtl default', 'Kd 0.8 0.8 0.8', '');
  out.unshift(
    { name: `${baseName}.obj`, data: Buffer.from(lines.join('\n') + '\n') },
    { name: `${baseName}.mtl`, data: Buffer.from(mtl.join('\n') + '\n') }
  );
  return { files: out, skippedModes: [...skipped] };
}

const fmt = (n) => (Math.abs(n) < 1e-12 ? '0' : String(+n.toFixed(6)));

// Inverse transpose of the upper 3x3 of a column-major 4x4 matrix.
function normalMatrix(m) {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  const r = 1 / det;
  // cofactor matrix / det = inverse transpose (column-major result)
  return [
    A * r, B * r, C * r,
    (-(b * i - c * h)) * r, (a * i - c * g) * r, (-(a * h - b * g)) * r,
    (b * f - c * e) * r, (-(a * f - c * d)) * r, (a * e - b * d) * r,
  ];
}
