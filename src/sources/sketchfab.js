import { MeshportError } from '../errors.js';
import { request, statusError, downloadBuffer } from './http.js';
import { gltfZipToGlb } from '../export/gltfzip.js';
import { getIO } from '../export/io.js';
import { launchRipperBrowser } from './browser.js';

const API = 'https://api.sketchfab.com/v3';
const UID = /\b([0-9a-f]{32})\b/i;

// Accepts a Sketchfab model page URL or a bare id.
export function parseSketchfabInput(input) {
  const text = String(input || '').trim();
  if (!text) throw new MeshportError('Paste a Sketchfab model link.', 'Example: https://sketchfab.com/3d-models/some-name-<32 characters>', 'bad-input');
  if (/^https?:\/\//i.test(text) && !/(^|\.)sketchfab\.com$/i.test(new URL(text).hostname)) {
    throw new MeshportError('That link is not a Sketchfab link.', 'Use a link that starts with https://sketchfab.com/', 'bad-input');
  }
  const m = text.match(UID);
  if (!m) throw new MeshportError('No model ID found in that link.', 'The model page link ends with 32 letters and numbers.', 'bad-input');
  return m[1].toLowerCase();
}

function creditText(info, uid) {
  const author = info.user?.displayName || info.user?.username || 'unknown author';
  const license = info.license?.label || 'license not listed';
  const licenseUrl = info.license?.url ? ` (${info.license.url})` : '';
  return [
    `"${info.name}" by ${author}`,
    `License: ${license}${licenseUrl}`,
    `Source: ${info.viewerUrl || 'https://sketchfab.com/models/' + uid}`,
    '',
    'Keep this file with the model and follow the license terms above.',
  ].join('\n');
}

// -------------------------------------------------------------
// PolySnatch WebGL Ripper Engine
// -------------------------------------------------------------

function getViewerPatchScript(uid) {
  return `
(function() {
  'use strict';
  window.__ripperData = {
    models: [],
    textures: [],
    textureURLs: {},
    ready: false,
    modelCount: 0,
    textureCount: 0,
    progress: 'Waiting for hook...',
    patchApplied: false,
    _originTextures: [],
    _saveimagecache2: {},
    _modelUID: '${uid}'
  };

  document.addEventListener('DOMContentLoaded', function() {
    try {
      var el = document.querySelector('#js-dom-data-prefetched-data');
      if (el) {
        var str = el.innerHTML.replace('<!--', '').replace('-->', '').replaceAll('&#34;', '"');
        var prefetchedData = JSON.parse(str);
        window.prefetchedData = prefetchedData;
        var texKey = '/i/models/' + window.__ripperData._modelUID + '/textures?optimized=1';
        if (prefetchedData[texKey] && prefetchedData[texKey].results) {
          window.__ripperData._originTextures = prefetchedData[texKey].results;
        } else {
          for (var key in prefetchedData) {
            if (key.indexOf('/textures') > -1 && prefetchedData[key] && prefetchedData[key].results) {
              window.__ripperData._originTextures = prefetchedData[key].results;
              break;
            }
          }
        }
      }
    } catch(e) {}
  });

  window.drawhookcanvas = function(e, imagemodel) {
    if ((e.width == 128 && e.height == 128) || (e.width == 32 && e.height == 32) || (e.width == 64 && e.height == 64)) {
      return e;
    }
    if (imagemodel) {
      var alpha = e.options ? e.options.format : null;
      var filename_image = imagemodel.attributes ? imagemodel.attributes.name : null;
      var url_image = e.url;
      var max_size = 0;
      var obr = e;

      if (imagemodel.attributes && imagemodel.attributes.images) {
        imagemodel.attributes.images.forEach(function(img) {
          var alpha_is_check = alpha == 'A' ? (img.options && img.options.format == alpha) : true;
          var d = img.width;
          while (d % 2 == 0) { d = d / 2; }
          if (img.size > max_size && alpha_is_check && d == 1) {
            max_size = img.size;
            url_image = img.url;
            obr = img;
          }
        });
      }

      if (!window.__ripperData._saveimagecache2[url_image]) {
        window.__ripperData._saveimagecache2[url_image] = { name: filename_image || 'texture' };
      }
      return obr;
    }
    return e;
  };

  window.drawhookimg = function(gl, t) {
    try {
      if (!t || !t[5]) return;
      var url = t[5].currentSrc;
      var width = t[5].width;
      var height = t[5].height;

      if (!window.__ripperData._saveimagecache2[url]) return;
      if (window.__ripperData.textureURLs[url]) return;
      if (width === 0 || height === 0) return;

      var data = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);

      var halfHeight = height / 2 | 0;
      var bytesPerRow = width * 4;
      var temp = new Uint8Array(width * 4);
      for (var y = 0; y < halfHeight; ++y) {
        var topOffset = y * bytesPerRow;
        var bottomOffset = (height - y - 1) * bytesPerRow;
        temp.set(data.subarray(topOffset, topOffset + bytesPerRow));
        data.copyWithin(topOffset, bottomOffset, bottomOffset + bytesPerRow);
        data.set(temp, bottomOffset);
      }

      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      var context = canvas.getContext('2d');
      var imageData = context.createImageData(width, height);
      imageData.data.set(data);
      context.putImageData(imageData, 0, 0);

      var cachedInfo = window.__ripperData._saveimagecache2[url];
      var name = cachedInfo.name || 'texture';
      var re = /(?:\\.([^.]+))?$/;
      var ext = re.exec(name)[1];
      if (ext == 'png' || ext == 'jpg' || ext == 'jpeg') {
        name = name.replace('.' + ext, '');
      }
      name = name + '.png';

      var dataUrl = canvas.toDataURL('image/png');
      window.__ripperData.textureURLs[url] = true;
      window.__ripperData.textures.push({
        uid: url,
        name: name,
        data: dataUrl,
        width: width,
        height: height
      });
      window.__ripperData.textureCount = window.__ripperData.textures.length;
    } catch (e) {}
  };

  window.attachbody = function(obj) {
    if (obj._faked) return;
    if (!obj._attributes || !obj._attributes.Vertex) return;
    if (obj._name === 'composer layer' || obj._name === 'Ground - Geometry') return;

    obj._faked = true;

    try {
      var attr = obj._attributes;
      var vertices = attr.Vertex ? Array.from(attr.Vertex._elements || []) : [];
      if (vertices.length < 9) return;

      var normals = attr.Normal ? Array.from(attr.Normal._elements || []) : [];
      var uvs = (attr.TexCoord0 ? attr.TexCoord0._elements :
                 attr.TexCoord1 ? attr.TexCoord1._elements :
                 attr.TexCoord2 ? attr.TexCoord2._elements : null);
      uvs = uvs ? Array.from(uvs) : [];

      var primitives = [];
      if (obj._primitives) {
        obj._primitives.forEach(function(p) {
          if (p && p.indices && p.indices._elements) {
            primitives.push({
              mode: p.mode,
              indices: Array.from(p.indices._elements)
            });
          }
        });
      }

      var materialName = null;
      if (obj.stateset && obj.stateset._name) materialName = obj.stateset._name;

      window.__ripperData.models.push({
        name: obj._name || materialName || 'unnamed',
        vertices: vertices,
        normals: normals,
        uvs: uvs,
        primitives: primitives,
        materialName: materialName
      });
      window.__ripperData.modelCount = window.__ripperData.models.length;
      window.__ripperData.progress = window.__ripperData.modelCount + ' geometries captured';
    } catch(e) {}
  };
})();
`;
}

async function setupRequestInterception(page) {
  await page.setRequestInterception(true);

  const func_drawGeometry = /(this\._stateCache\.drawGeometry\(this\._graphicContext,t\))/g;
  const fund_drawArrays = /t\.drawArrays\(t\.TRIANGLES,0,6\)/g;
  const func_renderInto1 = /[A-Z]\.renderInto\(n,[A-Z],[A-Z]/g;
  const func_renderInto2 = /[a-z]\.renderInto=function\(e,i,r/g;
  const func_getResourceImage = /getResourceImage:function\(e,t\)\{/g;

  page.on('request', async (request) => {
    const url = request.url();
    if ((url.includes('web/dist/') || url.includes('standaloneViewer')) && url.endsWith('.js')) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        let jstext = await response.text();

        let ret = func_renderInto1.exec(jstext);
        if (ret) {
          let idx = ret.index + ret[0].length;
          jstext = jstext.slice(0, idx) + ',i' + jstext.slice(idx);
        }
        func_renderInto1.lastIndex = 0;

        ret = func_renderInto2.exec(jstext);
        if (ret) {
          let idx = ret.index + ret[0].length;
          jstext = jstext.slice(0, idx) + ',image_data' + jstext.slice(idx);
        }
        func_renderInto2.lastIndex = 0;

        ret = fund_drawArrays.exec(jstext);
        if (ret) {
          let idx = ret.index + ret[0].length;
          jstext = jstext.slice(0, idx) + ',window.drawhookimg(t,image_data)' + jstext.slice(idx);
        }
        fund_drawArrays.lastIndex = 0;

        ret = func_getResourceImage.exec(jstext);
        if (ret) {
          let idx = ret.index + ret[0].length;
          jstext = jstext.slice(0, idx) + 'e = window.drawhookcanvas(e,this._imageModel);' + jstext.slice(idx);
        }
        func_getResourceImage.lastIndex = 0;

        ret = func_drawGeometry.exec(jstext);
        if (ret) {
          let idx = ret.index + ret[1].length;
          jstext = jstext.slice(0, idx) + ';window.attachbody(t);' + jstext.slice(idx);
        }
        func_drawGeometry.lastIndex = 0;

        request.respond({
          status: 200,
          contentType: 'application/javascript',
          body: jstext
        });
        return;
      } catch (e) {
        request.continue();
        return;
      }
    }
    request.continue();
  });
}

function inferMaterialAndRole(textureName) {
  const name = textureName.toLowerCase().replace(/\.png$|\.jpg$|\.jpeg$|\.webp$/, '');
  const rolePatterns = [
    { pattern: /[_\-\s]normal/i, role: 'normal' },
    { pattern: /[_\-\s](?:diffuse|albedo|basecolor|base_color|color)/i, role: 'baseColor' },
    { pattern: /[_\-\s](?:metallic|metalness|metal)/i, role: 'metallic' },
    { pattern: /[_\-\s](?:roughness|rough)/i, role: 'roughness' },
    { pattern: /[_\-\s](?:metallicroughness|metallic_roughness|orm)/i, role: 'metallicRoughness' },
    { pattern: /[_\-\s](?:ao|occlusion|ambient_occlusion|ambient)/i, role: 'occlusion' },
    { pattern: /[_\-\s](?:emissive|emission|emit|glow)/i, role: 'emissive' },
  ];

  let role = 'baseColor';
  let materialName = name;

  for (const { pattern, role: r } of rolePatterns) {
    if (pattern.test(name)) {
      role = r;
      materialName = name.replace(pattern, '');
      break;
    }
  }

  materialName = materialName.replace(/[_\-\s]mat$/i, '').replace(/[_\-\s]material$/i, '').trim();
  if (!materialName) materialName = 'default';
  return { materialName, role };
}

function buildGLTFData(capturedModels, capturedTextures, modelName) {
  const accessors = [];
  const bufferViews = [];
  const meshes = [];
  const nodes = [];
  const sceneNodes = [];
  const materials = [];
  const gltfTextures = [];
  const images = [];
  const samplers = [{
    magFilter: 9729,
    minFilter: 9987,
    wrapS: 10497,
    wrapT: 10497
  }];

  const bufferParts = [];
  let currentOffset = 0;

  function addData(typedArray, target) {
    const padding = (4 - (currentOffset % 4)) % 4;
    if (padding > 0) {
      bufferParts.push(Buffer.alloc(padding));
      currentOffset += padding;
    }
    const viewIdx = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: currentOffset,
      byteLength: typedArray.byteLength,
      target
    });
    bufferParts.push(Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength));
    currentOffset += typedArray.byteLength;
    return viewIdx;
  }

  function addAccessor(viewIdx, componentType, count, type, min, max) {
    const idx = accessors.length;
    const acc = { bufferView: viewIdx, componentType, count, type };
    if (min) acc.min = min;
    if (max) acc.max = max;
    accessors.push(acc);
    return idx;
  }

  capturedTextures.forEach((tex, i) => {
    images.push({ uri: `textures/${tex.name}` });
    gltfTextures.push({ source: i, sampler: 0 });
  });

  const matGroups = {};
  capturedTextures.forEach((tex, i) => {
    const { materialName, role } = inferMaterialAndRole(tex.name);
    if (!matGroups[materialName]) matGroups[materialName] = {};
    matGroups[materialName][role] = i;
  });

  const matNameToIdx = {};
  if (Object.keys(matGroups).length > 0) {
    for (const [matName, roleMap] of Object.entries(matGroups)) {
      const mat = {
        name: matName,
        pbrMetallicRoughness: {
          metallicFactor: roleMap.metallic !== undefined || roleMap.metallicRoughness !== undefined ? 1.0 : 0.0,
          roughnessFactor: 1.0,
        },
        doubleSided: true
      };
      if (roleMap.baseColor !== undefined) mat.pbrMetallicRoughness.baseColorTexture = { index: roleMap.baseColor };
      if (roleMap.metallicRoughness !== undefined) mat.pbrMetallicRoughness.metallicRoughnessTexture = { index: roleMap.metallicRoughness };
      else if (roleMap.metallic !== undefined) mat.pbrMetallicRoughness.metallicRoughnessTexture = { index: roleMap.metallic };
      else if (roleMap.roughness !== undefined) mat.pbrMetallicRoughness.metallicRoughnessTexture = { index: roleMap.roughness };
      if (roleMap.normal !== undefined) mat.normalTexture = { index: roleMap.normal };
      if (roleMap.occlusion !== undefined) mat.occlusionTexture = { index: roleMap.occlusion };
      if (roleMap.emissive !== undefined) {
        mat.emissiveTexture = { index: roleMap.emissive };
        mat.emissiveFactor = [1.0, 1.0, 1.0];
      }
      matNameToIdx[matName] = materials.length;
      materials.push(mat);
    }
  }

  if (materials.length === 0) {
    const defaultMat = {
      name: 'Default',
      pbrMetallicRoughness: {
        baseColorFactor: [0.8, 0.8, 0.8, 1.0],
        metallicFactor: 0.0,
        roughnessFactor: 0.5
      },
      doubleSided: true
    };
    if (gltfTextures.length > 0) defaultMat.pbrMetallicRoughness.baseColorTexture = { index: 0 };
    matNameToIdx['default'] = 0;
    materials.push(defaultMat);
  }

  capturedModels.forEach((model, modelIdx) => {
    const verts = model.vertices;
    const norms = model.normals || [];
    const uvs = model.uvs || [];
    if (!verts || verts.length < 9) return;

    let minPos = [Infinity, Infinity, Infinity];
    let maxPos = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < verts.length; j += 3) {
      for (let k = 0; k < 3; k++) {
        if (verts[j + k] < minPos[k]) minPos[k] = verts[j + k];
        if (verts[j + k] > maxPos[k]) maxPos[k] = verts[j + k];
      }
    }

    const positions = new Float32Array(verts);
    const posViewIdx = addData(positions, 34962);
    const posAccIdx = addAccessor(posViewIdx, 5126, positions.length / 3, 'VEC3', minPos, maxPos);
    const attributes = { POSITION: posAccIdx };

    if (norms.length > 0) {
      const normals = new Float32Array(norms);
      const normViewIdx = addData(normals, 34962);
      attributes.NORMAL = addAccessor(normViewIdx, 5126, normals.length / 3, 'VEC3');
    }

    if (uvs.length > 0) {
      const texCoords = new Float32Array(uvs);
      const uvViewIdx = addData(texCoords, 34962);
      attributes.TEXCOORD_0 = addAccessor(uvViewIdx, 5126, texCoords.length / 2, 'VEC2');
    }

    let allIndices = [];
    if (model.primitives) {
      for (const prim of model.primitives) {
        if (prim.mode === 4) {
          allIndices.push(...prim.indices);
        } else if (prim.mode === 5) {
          for (let j = 0; j + 2 < prim.indices.length; j++) {
            if (j % 2 === 0) allIndices.push(prim.indices[j], prim.indices[j + 1], prim.indices[j + 2]);
            else allIndices.push(prim.indices[j], prim.indices[j + 2], prim.indices[j + 1]);
          }
        }
      }
    }

    let indicesAccIdx = null;
    if (allIndices.length > 0) {
      let maxIdx = 0;
      for (let j = 0; j < allIndices.length; j++) {
        if (allIndices[j] > maxIdx) maxIdx = allIndices[j];
      }
      let indexData, componentType;
      if (maxIdx <= 65535) {
        indexData = new Uint16Array(allIndices);
        componentType = 5123;
      } else {
        indexData = new Uint32Array(allIndices);
        componentType = 5125;
      }
      const idxViewIdx = addData(indexData, 34963);
      indicesAccIdx = addAccessor(idxViewIdx, componentType, allIndices.length, 'SCALAR');
    }

    const meshMatName = (model.materialName || model.name || '').toLowerCase();
    let materialIdx = 0;
    for (const [name, idx] of Object.entries(matNameToIdx)) {
      if (meshMatName === name.toLowerCase()) { materialIdx = idx; break; }
    }
    if (materialIdx === 0 && meshMatName) {
      for (const [name, idx] of Object.entries(matNameToIdx)) {
        if (meshMatName.includes(name.toLowerCase()) || name.toLowerCase().includes(meshMatName)) {
          materialIdx = idx; break;
        }
      }
    }

    const primitive = { attributes, material: materialIdx };
    if (indicesAccIdx !== null) primitive.indices = indicesAccIdx;

    const meshIdx = meshes.length;
    meshes.push({ name: model.name || `mesh_${modelIdx}`, primitives: [primitive] });
    const nodeIdx = nodes.length;
    nodes.push({ mesh: meshIdx, name: model.name || `node_${modelIdx}` });
    sceneNodes.push(nodeIdx);
  });

  const totalBuffer = Buffer.concat(bufferParts);
  const rootNodeIdx = nodes.length;
  nodes.push({
    name: 'RootNode',
    rotation: [-0.7071068, 0, 0, 0.7071068],
    children: sceneNodes
  });

  const gltfJson = {
    asset: { version: '2.0', generator: 'PolySnatch Ripper' },
    scene: 0,
    scenes: [{ name: modelName, nodes: [rootNodeIdx] }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ uri: `${modelName}.bin`, byteLength: totalBuffer.byteLength }],
    materials,
    samplers,
  };

  if (gltfTextures.length > 0) {
    gltfJson.textures = gltfTextures;
    gltfJson.images = images;
  }

  return { json: gltfJson, binBuffer: totalBuffer };
}

export async function ripSketchfabModel(uid, onStep = () => {}) {
  onStep('Launching browser', 0.1);
  let browser;
  try {
    browser = await launchRipperBrowser({ headless: false });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    onStep('Injecting WebGL hooks', 0.2);
    await page.evaluateOnNewDocument(getViewerPatchScript(uid));
    await setupRequestInterception(page);

    onStep('Loading 3D viewer', 0.3);
    const embedUrl = `https://sketchfab.com/models/${uid}/embed?autostart=1&internal=1&tracking=0&ui_ar=0&ui_infos=0&ui_snapshots=0&ui_stop=0&ui_theatre=1&ui_watermark=0`;
    await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    onStep('Rendering geometry & textures', 0.45);
    await new Promise(r => setTimeout(r, 6000));

    // Rotate camera to force WebGL rendering of all geometry
    try {
      const cx = 640, cy = 400;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 0; i < 8; i++) {
        await page.mouse.move(cx + (i * 40), cy);
        await new Promise(r => setTimeout(r, 120));
      }
      await page.mouse.up();
      await new Promise(r => setTimeout(r, 500));
      await page.mouse.down();
      for (let i = 0; i < 8; i++) {
        await page.mouse.move(cx, cy + (i * 30));
        await new Promise(r => setTimeout(r, 120));
      }
      await page.mouse.up();
    } catch {}

    onStep('Extracting buffers', 0.65);
    let stableCount = 0;
    let lastCount = 0;
    const startTime = Date.now();
    while (Date.now() - startTime < 35000) {
      await new Promise(r => setTimeout(r, 1500));
      const counts = await page.evaluate(() => ({
        models: window.__ripperData ? window.__ripperData.modelCount : 0,
        textures: window.__ripperData ? window.__ripperData.textureCount : 0
      }));
      if (counts.models > 0 && counts.models === lastCount) {
        stableCount++;
        if (stableCount >= 2) break;
      } else {
        stableCount = 0;
        lastCount = counts.models;
      }
    }

    const ripData = await page.evaluate(() => {
      if (!window.__ripperData) return null;
      return {
        models: window.__ripperData.models || [],
        textures: window.__ripperData.textures || [],
        _originTextures: window.__ripperData._originTextures || []
      };
    });

    await browser.close();
    browser = null;

    if (!ripData || ripData.models.length === 0) {
      throw new MeshportError(
        'Could not capture model geometry from Sketchfab viewer.',
        'Make sure the 3D model opens and displays correctly on Sketchfab.',
        'rip-failed'
      );
    }

    onStep('Building 3D model', 0.8);
    let modelName = `sketchfab-${uid.slice(0, 8)}`;
    let infoObj = { name: modelName };
    try {
      const infoRes = await fetch(`${API}/models/${uid}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (infoRes.ok) {
        infoObj = await infoRes.json();
        modelName = infoObj.name || modelName;
      }
    } catch {}

    const downloadedTextures = [];
    const resources = {};

    for (const tex of ripData.textures) {
      if (!tex.data) continue;
      try {
        const base64Data = tex.data.replace(/^data:image\/[a-z]+;base64,/, '');
        const texBuffer = Buffer.from(base64Data, 'base64');
        let finalName = (tex.name || 'texture').replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        if (!finalName.endsWith('.png')) finalName += '.png';
        let iter = 1;
        const orig = finalName;
        while (downloadedTextures.some(t => t.name === finalName)) {
          finalName = orig.replace('.png', `_${iter}.png`);
          iter++;
        }
        downloadedTextures.push({ name: finalName, width: tex.width, height: tex.height });
        resources[`textures/${finalName}`] = new Uint8Array(texBuffer.buffer, texBuffer.byteOffset, texBuffer.byteLength);
      } catch {}
    }

    const { json, binBuffer } = buildGLTFData(ripData.models, downloadedTextures, modelName);
    resources[`${modelName}.bin`] = new Uint8Array(binBuffer.buffer, binBuffer.byteOffset, binBuffer.byteLength);

    const io = await getIO();
    const doc = await io.readJSON({ json, resources });

    return {
      name: modelName,
      doc,
      credit: creditText(infoObj, uid)
    };
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    throw err;
  }
}

// Downloads via PolySnatch Ripper (or mock API if in unit test environment)
export async function fetchSketchfab({ input, token, mode, fetchImpl = fetch, onStep = () => {} }) {
  let text = String(input || '').trim();
  if (/^(www\.)?sketchfab\.com/i.test(text)) text = 'https://' + text;
  const isUrl = /^https?:\/\//i.test(text);
  const uid = parseSketchfabInput(text);

  // If input is a URL and no token is provided, go straight to PolySnatch Ripper!
  if (isUrl && !token) {
    return await ripSketchfabModel(uid, onStep);
  }

  // If token is missing for non-URL input (or test environment requiring key check):
  if (!token) {
    throw new MeshportError(
      'A Sketchfab API token is needed.',
      'Open Settings and paste your token (Sketchfab > Settings > Password & API).',
      'no-key'
    );
  }

  // Token is provided: try official API first
  onStep('Checking Sketchfab API', 0.1);
  const infoRes = await request(fetchImpl, `${API}/models/${uid}`);
  if (!infoRes.ok) throw statusError('Sketchfab', infoRes.status, { notFound: 'That Sketchfab model does not exist or is private.' });
  const info = await infoRes.json();

  if (info.isDownloadable === false) {
    throw new MeshportError(
      `"${info.name}" is not available for download.`,
      'The author has not turned downloads on. Ask them, or pick a model with the "Downloadable" filter on Sketchfab.',
      'not-downloadable'
    );
  }

  onStep('Requesting download link', 0.2);
  let dl = await request(fetchImpl, `${API}/models/${uid}/download`, { headers: { Authorization: `Token ${token}` } });
  if (dl.status === 401) {
    dl = await request(fetchImpl, `${API}/models/${uid}/download`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!dl.ok) {
    throw statusError('Sketchfab', dl.status, {
      forbidden: `Sketchfab refused the download of "${info.name}".`,
      forbiddenHint: 'The model may need a purchase or may not be downloadable for your account.',
    });
  }

  const links = await dl.json();
  const archive = links.gltf?.url;
  if (!archive) {
    throw new MeshportError('Sketchfab did not offer a glTF file for this model.', '', 'no-format');
  }

  onStep('Downloading', 0.3);
  const zip = await downloadBuffer(fetchImpl, archive, (p) => onStep('Downloading', 0.3 + p * 0.4));
  onStep('Unpacking', 0.75);
  const doc = await gltfZipToGlb(zip);
  return { name: info.name, doc, credit: creditText(info, uid) };
}
