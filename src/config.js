import fs from 'node:fs/promises';
import path from 'node:path';

export const KEY_NAMES = ['sketchfab', 'meshy', 'tripo'];

// API keys live in one JSON file on this computer and are only ever sent to the service they belong to.
export class Config {
  constructor(file) {
    this.file = file;
    this.data = {};
  }

  async load() {
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    return this;
  }

  get(name) {
    return this.data[name] || '';
  }

  // Which keys are saved, without revealing them.
  status() {
    return Object.fromEntries(KEY_NAMES.map((n) => [n, Boolean(this.data[n])]));
  }

  async set(name, value) {
    if (!KEY_NAMES.includes(name)) throw new Error('Unknown key name');
    const v = String(value || '').trim();
    if (v) this.data[name] = v;
    else delete this.data[name];
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
