import { NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { MeshportError } from '../errors.js';

let ioPromise;

// One shared reader/writer that understands compressed glTF files.
export function getIO() {
  if (!ioPromise) {
    ioPromise = (async () => {
      await MeshoptDecoder.ready;
      return new NodeIO()
        .setLogger(new Logger(Logger.Verbosity.WARN))
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
          'meshopt.decoder': MeshoptDecoder,
          'draco3d.decoder': await draco3d.createDecoderModule(),
        });
    })();
  }
  return ioPromise;
}

const GLB_MAGIC = 0x46546c67; // "glTF"

export function isGlb(buf) {
  return buf && buf.byteLength >= 12 && Buffer.from(buf.buffer, buf.byteOffset, 4).readUInt32LE(0) === GLB_MAGIC;
}

export async function readGlb(buf) {
  if (!isGlb(buf)) {
    throw new MeshportError(
      'This is not a GLB file.',
      'Pick a .glb file. If you have .gltf, .fbx or .obj, convert it to GLB in Blender first.',
      'bad-file'
    );
  }
  const io = await getIO();
  try {
    return await io.readBinary(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch (err) {
    throw new MeshportError(
      'The GLB file could not be read: ' + err.message,
      'The file may be damaged or use an extension that is not supported.',
      'bad-file'
    );
  }
}
