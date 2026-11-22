import { Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';
import { meshopt, quantize } from '@gltf-transform/functions';
import { getIO } from '../src/export/io.js';

// A small textured quad, optionally compressed the way AI-generated models usually are.
export function buildQuad({ withTexture = false } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]));
  const normal = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
  const uv = doc.createAccessor().setType('VEC2').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
  const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]));
  const material = doc.createMaterial('red').setBaseColorFactor([1, 0, 0, 1]);
  if (withTexture) {
    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    material.setBaseColorTexture(doc.createTexture('tex').setImage(new Uint8Array(png)).setMimeType('image/png'));
  }
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal)
    .setAttribute('TEXCOORD_0', uv).setIndices(indices).setMaterial(material);
  const mesh = doc.createMesh('quad').addPrimitive(prim);
  const node = doc.createNode('quad').setMesh(mesh);
  doc.createScene().addChild(node);
  return doc;
}

export async function compressedGlb() {
  await MeshoptEncoder.ready;
  const io = await getIO();
  io.registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = buildQuad();
  await doc.transform(quantize(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  return Buffer.from(await io.writeBinary(doc));
}
