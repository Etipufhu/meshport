# 📦 meshport

> **All-in-one local 3D model ripper & Blender optimizer** for **Sketchfab**, **Meshy**, and **Tripo3D**.  
> ⚡ **No API keys or accounts required.** Paste a link, press one button, and get clean, uncompressed **GLB**, **OBJ**, **STL**, **PLY**, or **FBX** ready for Blender, Unity, and Unreal Engine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js: >=18.17](https://img.shields.io/badge/Node.js-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)]()
[![Tests](https://img.shields.io/badge/Tests-70%2F70%20Passing-success.svg)]()

---

## 🌟 Key Features

- 🎨 **Sketchfab Ripper (PolySnatch Engine):** Hooks directly into Sketchfab's WebGL draw calls (`drawGeometry`, `drawArrays`). Automatically rotates the camera 360° to harvest all sub-meshes, materials, and high-res PBR textures (BaseColor, Normal, Roughness, Metallic).
- 🤖 **MeshyRipper Engine:** Intercepts Web Workers, Blobs, and network streams to extract models directly from any Meshy model or workspace link.
- ⚡ **TripoRipper Engine:** Dual-mode extraction (direct CDN stream capture + Vue/Three.js RAM traversal). **Automatically fixes the dreaded Blender `EXT_meshopt_compression` error!**
- 🛠️ **Blender Fixer & Converter ("My file" Tab):** Drag & drop any `.glb`, `.gltf`, `.zip`, or `.obj` to decompress, dequantize, merge duplicate vertices, remove degenerate faces, and make it 100% Blender-compatible.
- 🌐 **Automatic Browser Detection:** Intelligently detects and runs through your existing **Opera GX**, **Google Chrome**, **Microsoft Edge**, **Brave**, or **Vivaldi** installation without configuration.
- 🔒 **100% Local & Private:** Runs entirely on `http://localhost:3100`. No third-party servers, no logins, no personal data uploaded anywhere.

---

## 🚀 Quick Start (Hızlı Başlangıç)

### 🪟 Windows (1-Click Run)
1. Install [Node.js (LTS version)](https://nodejs.org/) if you don't already have it.
2. Download or clone this repository:
   ```bash
   git clone https://github.com/Etipufhu/meshport.git
   cd meshport
   ```
3. Double-click **`start.bat`**.  
   *(It installs dependencies automatically on first run and opens your browser at `http://localhost:3100`)*.

---

### 🍎 macOS / 🐧 Linux
```bash
git clone https://github.com/Etipufhu/meshport.git
cd meshport
chmod +x start.sh
./start.sh
```
*(Or simply run `npm install` followed by `npm start`)*.

---

## 📖 Usage Guide (Kullanım Rehberi)

```
                          ┌────────────────────────┐
                          │   meshport (Web UI)    │
                          │ http://localhost:3100  │
                          └───────────┬────────────┘
                                      │
     ┌────────────────────────────────┼────────────────────────────────┐
     ▼                                ▼                                ▼
[Sketchfab Link]                [Meshy Link]                   [Tripo Link]
PolySnatch Engine              MeshyRipper Engine              TripoRipper Engine
(WebGL Draw Hook &             (Web Worker & Blob/Fetch        (CDN Stream Sniffer +
360° Camera Spin)              Decryption)                     Vue Three.js RAM Extraction)
     │                                │                                │
     └────────────────────────────────┼────────────────────────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │ @gltf-transform Pipeline  │
                        │ - Decompresses meshopt    │
                        │ - Welds duplicate vertices│
                        │ - Normalizes textures/UVs │
                        └─────────────┬─────────────┘
                                      │
           ┌──────────────┬───────────┴───┬──────────────┬──────────────┐
           ▼              ▼               ▼              ▼              ▼
         [GLB]          [OBJ]           [STL]          [PLY]          [FBX]
     (Blender/Web)  (3D Software)   (3D Printing)    (Points/Scan)  (Games/Rig)
```

### 1. Sketchfab Models
1. Copy any Sketchfab model link (e.g. `https://sketchfab.com/3d-models/model-name-123456...`).
2. Paste it into the **Sketchfab** tab (or just paste it anywhere on the page, meshport auto-detects the tab!).
3. Choose your desired output formats (**GLB**, **OBJ**, etc.) and click **Get model**.
4. The engine opens a background viewer, orbits the model to buffer geometry, gathers textures, and saves the cleaned model into the `output/` folder. A `CREDITS.txt` file is generated automatically.

### 2. Meshy Models
1. Copy any Meshy link (e.g. `https://www.meshy.ai/workspace/...` or model page).
2. Paste it into the **Meshy** tab.
3. Click **Get model**. The model is captured and saved with full textures.

### 3. Tripo3D Models
1. Copy any Tripo Studio link (e.g. `https://studio.tripo3d.ai/3d-model/52d63b42-...`).
2. Paste it into the **Tripo** tab and click **Get model**.
3. **meshport** downloads the original high-res PBR model and automatically strips the vendor `EXT_meshopt_compression` tag, making it immediately editable in Blender!

### 4. Fixing Broken / Compressed GLBs ("My file" Tab)
- Got a `.glb` or `.gltf` file that throws errors in Blender?
- Switch to the **My file** tab and drop your file(s) into the dropzone (supports multiple files at once).
- It unpacks, dequantizes, decodes meshopt/Draco, and exports clean, standard files.

---

## 📤 Supported Output Formats

| Format | Features | Best For |
|---|---|---|
| **GLB** | Full PBR textures, uncompressed float geometry | Blender, Godot, Unity, Three.js, Web |
| **OBJ + MTL** | Diffuse, Normal, Roughness, Metallic, Emissive textures | Maya, 3ds Max, ZBrush, Cinema 4D |
| **STL** | Watertight binary triangles, world-space coordinates | 3D Printing / Slicers (Cura, PrusaSlicer) |
| **PLY** | Little-endian binary with UVs and vertex colors | Point cloud tools, MeshLab, Photogrammetry |
| **FBX** | Standard Autodesk binary format (requires Blender installed) | Game engines, Unreal Engine, Rigging |

---

## 🎛️ Optimization & Cleanup Options

Click on the **Options** accordion on the page to customize processing:
- **Clean up the model:** Merges duplicate points, removes zero-area / paper-thin faces and loose vertices.
- **Reduce triangles (Decimation):** Reduce polygon count down to 5% - 100% while preserving UV seams, normals, and materials.
- **Max texture size:** Downscale 4K textures to 2048, 1024, or 512 px to save memory.
- **Up axis:** Switch coordinate systems between Y-up and Z-up.
- **Center & Ground:** Automatically centers the model at origin `(0, 0)` and rests its base on ground level `y = 0`.
- **Unit & Scale:** Scale geometries to Meters, Centimeters, or Millimeters.

---

## ❓ Troubleshooting & FAQ (Sıkça Sorulan Sorular)

<details>
<summary><strong>Q: Blender says: "Extension EXT_meshopt_compression is not available on this addon version"?</strong></summary>

> **Answer:**  
> Tripo3D and other modern web viewers use `EXT_meshopt_compression` to minimize download size. Blender's built-in glTF importer does not support this extension out of the box.  
> **Solution:** Simply drop the file into meshport's **"My file"** tab (or rip it through meshport directly). meshport uses `@gltf-transform` and the official `meshoptimizer` WebAssembly decoder to decompress it into standard, uncompressed glTF/GLB that Blender opens instantly.
</details>

<details>
<summary><strong>Q: Browser not found / Which browsers are supported?</strong></summary>

> **Answer:**  
> meshport automatically scans for:
> - **Opera GX** (`%LOCALAPPDATA%\Programs\Opera GX\opera.exe`)
> - **Google Chrome**
> - **Microsoft Edge**
> - **Brave Browser**
> - **Vivaldi**
> 
> If your browser is installed in a non-standard location, you can set the environment variable:
> ```bash
> set MESHPORT_BROWSER_PATH=C:\Path\To\your-browser.exe
> ```
</details>

<details>
<summary><strong>Q: How does FBX export work?</strong></summary>

> **Answer:**  
> If you have **Blender** installed on your system (either in `Program Files` or in your `PATH`), meshport automatically detects it and enables the **FBX** checkbox. It runs Blender in headless mode in the background to produce standard Autodesk FBX files. If Blender is not found, the FBX option will be greyed out.
</details>

<details>
<summary><strong>Q: Are API keys needed?</strong></summary>

> **Answer:**  
> **No!** All three link tabs (Sketchfab, Meshy, Tripo) use direct viewer capture and network sniffer engines. You do not need API tokens, paid plans, or developer accounts.
</details>

---

## 🧪 Tests

meshport comes with a 100% offline, comprehensive test suite:
```bash
npm test
```
```text
✔ 70 tests passing (0 failed, ~800ms)
```
Tests cover geometry cleanup, mesh welding, texture downsizing, format conversion (GLB, OBJ, STL, PLY, FBX), safe path traversal, and security sandboxing.

---

## ⚖️ License & Credits

- Licensed under the **[MIT License](LICENSE)**.
- Only rip and download models that you have permission to use or own. Always respect creator rights and retain the `CREDITS.txt` license information.
