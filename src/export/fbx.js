import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MeshportError } from '../errors.js';

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

// Looks for blender.exe: first on PATH, then in the usual Windows install folders
// (newest version first), then the usual spots on macOS and Linux.
export async function findBlender({ env = process.env, platform = process.platform, programFiles } = {}) {
  const exe = platform === 'win32' ? 'blender.exe' : 'blender';
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir.replace(/^"|"$/g, ''), exe);
    if (await exists(full)) return full;
  }
  if (platform === 'win32') {
    const roots = programFiles || [env.ProgramFiles || 'C:\Program Files', env['ProgramFiles(x86)']].filter(Boolean);
    for (const root of roots) {
      const base = path.join(root, 'Blender Foundation');
      let dirs = [];
      try { dirs = await fs.readdir(base); } catch { continue; }
      dirs = dirs.filter((d) => /^Blender/i.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const d of dirs) {
        const full = path.join(base, d, exe);
        if (await exists(full)) return full;
      }
    }
  } else {
    const spots = platform === 'darwin' ? ['/Applications/Blender.app/Contents/MacOS/Blender'] : ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender'];
    for (const s of spots) if (await exists(s)) return s;
  }
  return null;
}

const SCRIPT = `import bpy, sys
args = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=args[0])
bpy.ops.export_scene.fbx(filepath=args[1], path_mode='COPY', embed_textures=True)
`;

// Runs Blender in the background to turn a GLB into an FBX.
function runBlender(spawnImpl, blenderPath, glbPath, fbxPath) {
  return new Promise((resolve, reject) => {
    (async () => {
      const script = path.join(os.tmpdir(), `meshport-fbx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
      await fs.writeFile(script, SCRIPT);
      const done = (err) => { fs.rm(script, { force: true }).catch(() => {}); err ? reject(err) : resolve(); };
      let log = '';
      const child = spawnImpl(blenderPath, ['-b', '--factory-startup', '--python', script, '--', glbPath, fbxPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { child.kill(); done(new MeshportError('Blender took too long to write the FBX.', 'Try a smaller model.', 'fbx-failed')); }, 10 * 60 * 1000);
      const take = (d) => { log = (log + d).slice(-2000); };
      child.stdout && child.stdout.on('data', take);
      child.stderr && child.stderr.on('data', take);
      child.on('error', (e) => { clearTimeout(timer); done(new MeshportError('Could not start Blender: ' + e.message, 'Check that Blender is installed and can be opened.', 'fbx-failed')); });
      child.on('close', async (code) => {
        clearTimeout(timer);
        if (code === 0 && await exists(fbxPath)) return done();
        const tail = log.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        done(new MeshportError(`Blender could not write the FBX (exit code ${code}).${tail ? ' ' + tail : ''}`, 'Try the GLB or OBJ output instead.', 'fbx-failed'));
      });
    })().catch(reject);
  });
}

// Blender access in one place, so tests can swap in a fake.
// A bridge has find() -> path or null, and exportFbx(glbPath, fbxPath).
export function createBlenderBridge({ spawnImpl = spawn, findImpl = findBlender } = {}) {
  let cached;
  return {
    async find() {
      if (cached === undefined || cached === null) cached = await findImpl();
      return cached;
    },
    async exportFbx(glbPath, fbxPath) {
      const blender = await this.find();
      if (!blender) throw noBlender();
      await runBlender(spawnImpl, blender, glbPath, fbxPath);
    },
  };
}

export function noBlender() {
  return new MeshportError('FBX export needs Blender, and it was not found on this computer.',
    'Install Blender from blender.org (it is free), then try again. GLB, OBJ, STL and PLY work without it.', 'no-blender');
}

export async function fbxAvailability(bridge) {
  const found = await bridge.find();
  return found
    ? { available: true, reason: `Using Blender at ${found}` }
    : { available: false, reason: 'Blender was not found. Install it from blender.org to export FBX.' };
}
