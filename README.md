# meshport

A small local app for getting 3D models into Blender. Paste a link or drop a file, press one button, and you get a clean GLB (and OBJ if you want it).

It runs on your own computer. Nothing is uploaded anywhere.

## Use it in 30 seconds

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. Double-click `start.bat` (Windows), or run `npm install` and then `npm start`.
3. Your browser opens. Pick a tab, press **Get model**.

Models are saved in the `output` folder, one folder per model. The **Folder** button next to each model opens it.

**To try it without any account:** open the **My file** tab and drop `examples/compressed-quad.glb` onto it.

## What each tab does

| Tab | What you need | What happens |
|---|---|---|
| **Sketchfab** | A model link | Opens a browser window and captures the model from Sketchfab's 3D viewer. A `CREDITS.txt` with author and license is saved next to the model. |
| **Meshy** | A model link | Same idea for Meshy. |
| **Tripo** | A model link | Same idea for Tripo Studio. |
| **My file** | Nothing | Drop one or many files: `.glb`, `.gltf` (embedded buffers), `.obj`, or a `.zip` that holds any of those with their textures. Fixes files that Blender cannot open because they are compressed (meshopt, Draco) or quantized. |

### The viewer capture mode

The three link tabs work by opening a real browser window and capturing the geometry and textures from the site's own 3D viewer. It needs no account or key. It does not check whether the author allowed downloads, and it hides that the browser is automated, so a site may change or block it at any time. Use it only on models you own or have permission to copy, and keep the license and credit that belong to the model.

It needs Chrome, Edge, Brave, Vivaldi or Opera installed. If none is found, set the `MESHPORT_BROWSER_PATH` environment variable to the browser's `.exe`.

### API keys

The page has no field for API keys. The code for the official Sketchfab, Meshy and Tripo APIs is still there and runs when a key is saved in `data/config.json` (plain text, on your computer only). With a Sketchfab token, a pasted link goes through the official API, which refuses models that are not downloadable.

## Output

- **GLB**: plain float geometry, opens in Blender, Unity, Godot and web viewers.
- **OBJ**: geometry, UVs, normals, a `.mtl` file and the base color, normal, metallic-roughness and emissive textures.
- **STL**: binary STL, shape only.
- **PLY**: binary PLY with normals, UVs and vertex colors when the model has them.
- **FBX**: needs Blender installed. meshport finds it by itself and uses it in the background to write the file. If Blender is not found, the FBX box is greyed out.

## Cleanup and options

Every model goes through a cleanup before it is saved: lines and zero-area or paper-thin triangles are removed, unused vertices are dropped, and vertices that sit on top of each other are merged. Merging stays inside one connected part, so separate parts are never glued together, and UV seams and hard edges are kept. You can turn the cleanup off.

Under **Options** you can also set the up axis, unit and scale, center the model, put it on the ground, reduce the triangle count, and shrink large textures. The result panel shows what the cleanup changed, and **Preview** shows the GLB in a 3D view.

## Tests

```bash
npm test
```

The tests cover file name safety, the cleanup and merging, every input and output format (Blender is faked), the processing options, each official API source (with fake servers, no network), the local server, and path traversal checks. Live calls to Sketchfab, Meshy and Tripo are not part of the tests, and the viewer capture mode has no tests, so the first real download is the real check.

## How it is built

```
src/
  server.js        local web server, only reachable from this computer
  jobs.js          progress and error tracking for each download
  safe.js          file name and path checks
  sources/         sketchfab.js, meshy.js, tripo.js
  export/          shared cleanup (clean.js), GLB/OBJ writers, zip reader
public/            the single page you see
test/              node:test files
```

All three sources hand a model to the same export step, so a fix there helps everything.

## Notes

- Only download models you have the right to use, and keep the license and credit information that comes with them.
- Requires Node.js 18.17 or newer.

## License

MIT
