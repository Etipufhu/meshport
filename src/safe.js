import path from 'node:path';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Makes a string usable as a file or folder name on Windows, macOS and Linux.
export function safeName(input, fallback = 'model') {
  let s = String(input ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).trim();
  if (!s || RESERVED.test(s)) return fallback;
  return s;
}

// Joins path parts under `root` and refuses anything that would leave it.
// Returns the full path, or null when the parts are not safe.
export function safeJoin(root, ...parts) {
  for (const p of parts) {
    if (typeof p !== 'string' || p === '' || p === '.' || p === '..') return null;
    if (p.includes('/') || p.includes('\\') || p.includes('\0')) return null;
  }
  const full = path.resolve(root, ...parts);
  const rel = path.relative(path.resolve(root), full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}
