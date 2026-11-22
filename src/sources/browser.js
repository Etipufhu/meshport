import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

/**
 * Dynamically resolves browser executable paths across Windows, macOS, and Linux
 * without hardcoding any user-specific directory paths.
 */
export function findBrowserExecutable() {
  // 1. Explicit user override via environment variables
  if (process.env.MESHPORT_BROWSER_PATH && fs.existsSync(process.env.MESHPORT_BROWSER_PATH)) {
    return process.env.MESHPORT_BROWSER_PATH;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';

  const candidates = [];

  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    candidates.push(
      // Opera GX (Default installation path in user AppData)
      path.join(localAppData, 'Programs', 'Opera GX', 'opera.exe'),
      // Standard Opera
      path.join(localAppData, 'Programs', 'Opera', 'opera.exe'),
      // Google Chrome (64-bit, 32-bit, and user-level)
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Microsoft Edge
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      // Brave Browser
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      // Vivaldi
      path.join(localAppData, 'Vivaldi', 'Application', 'vivaldi.exe')
    );
  } else if (isMac) {
    candidates.push(
      '/Applications/Opera GX.app/Contents/MacOS/Opera',
      '/Applications/Opera.app/Contents/MacOS/Opera',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else if (isLinux) {
    candidates.push(
      '/usr/bin/opera',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/brave-browser'
    );
  }

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return undefined;
}

/**
 * Launches Puppeteer browser configured for 3D model ripping:
 * - Uses stealth plugin to bypass anti-bot detections.
 * - Disables web security to permit cross-origin WebGL texture & canvas extraction.
 * - Hardware acceleration / WebGL flags enabled.
 */
export async function launchRipperBrowser({ headless = false, userDataDir } = {}) {
  const executablePath = findBrowserExecutable();
  
  // Ripping requires WebGL canvas extraction and cross-origin resource capture:
  // - '--disable-web-security' is essential to allow reading canvas buffers and textures from CDNs without CORS taint.
  // - '--no-sandbox' is required in Linux / container environments; optional on Windows.
  const args = [
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--window-size=1280,900',
    '--window-position=50,50',
    '--disable-blink-features=AutomationControlled',
  ];

  // Enable no-sandbox when on Linux or if not explicitly disabled
  if (process.platform === 'linux' || process.env.MESHPORT_NO_SANDBOX !== 'false') {
    args.unshift('--no-sandbox', '--disable-setuid-sandbox');
  }

  const options = {
    headless,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args,
  };

  if (executablePath) {
    options.executablePath = executablePath;
  }
  if (userDataDir) {
    options.userDataDir = userDataDir;
  }

  const browser = await puppeteer.launch(options);
  return browser;
}
