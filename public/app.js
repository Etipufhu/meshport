const $ = (id) => document.getElementById(id);
const state = { tab: 'sketchfab', busy: false };

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) node.append(k);
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.hint = data.hint || '';
    throw err;
  }
  return data;
}

const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const num = (n) => Number(n).toLocaleString();
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fileUrl = (folder, name) => `/files/${encodeURIComponent(folder)}/${name.split('/').map(encodeURIComponent).join('/')}`;

// ----- tabs -----
function setTab(name) {
  state.tab = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ----- file queue (My file tab) -----
const ACCEPT = /\.(glb|gltf|zip|obj)$/i;
const queue = [];
let qid = 0;
const drop = $('drop');

function addFiles(list) {
  const skipped = [];
  for (const f of list) {
    if (ACCEPT.test(f.name)) queue.push({ id: ++qid, file: f, status: 'waiting', pct: 0, step: '', error: null, hint: '', result: null });
    else skipped.push(f.name);
  }
  if (skipped.length) showJob('', '', 0, { text: `Skipped ${skipped.join(', ')}: only .glb, .gltf, .zip and .obj files work here.` }, 'bad');
  paintQueue();
}
drop.addEventListener('click', () => $('fileInput').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
$('fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
$('fileInput').addEventListener('click', (e) => e.stopPropagation());
$('qclear').addEventListener('click', () => {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].status === 'done' || queue[i].status === 'failed') queue.splice(i, 1);
  paintQueue();
});

const STATUS_TEXT = { waiting: 'Waiting', running: 'Working', done: 'Done', failed: 'Failed' };
function paintQueue() {
  $('qtools').hidden = queue.length === 0;
  const waiting = queue.filter((q) => q.status === 'waiting').length;
  $('qcount').textContent = `${queue.length} file${queue.length === 1 ? '' : 's'}, ${waiting} waiting`;
  $('queue').replaceChildren(...queue.map((q) => {
    const stat = el('span', { className: 'qstat', textContent: q.status === 'running' && q.step ? q.step : STATUS_TEXT[q.status] });
    const li = el('li', { className: 'qitem ' + (q.status === 'done' ? 'ok' : q.status === 'failed' ? 'bad' : '') },
      el('div', { className: 'qtop' }, el('span', { className: 'name', textContent: `${q.file.name} (${size(q.file.size)})` }), stat));
    if (q.status === 'running' || q.status === 'done') {
      const fill = el('div', {});
      fill.style.width = (q.status === 'done' ? 100 : q.pct) + '%';
      li.append(el('div', { className: 'bar' }, fill));
    }
    if (q.status === 'failed') {
      li.append(el('div', { className: 'qmsg bad', textContent: q.error }));
      if (q.hint) li.append(el('div', { className: 'hint', textContent: q.hint }));
    }
    if (q.status === 'done' && q.result) li.append(renderSummary(q.result));
    if (q.status === 'waiting') {
      const rm = el('button', { className: 'ghost small', type: 'button', textContent: 'Remove' });
      rm.setAttribute('aria-label', 'Remove ' + q.file.name);
      rm.addEventListener('click', () => { queue.splice(queue.indexOf(q), 1); paintQueue(); });
      li.append(rm);
    }
    return li;
  }));
}

async function runQueue(fmts) {
  for (;;) {
    const q = queue.find((x) => x.status === 'waiting');
    if (!q) break;
    q.status = 'running'; q.pct = 2; q.step = 'Starting';
    paintQueue();
    try {
      const opts = currentOptions();
      const qs = `name=${encodeURIComponent(q.file.name)}&formats=${fmts.join(',')}` + (Object.keys(opts).length ? `&options=${encodeURIComponent(JSON.stringify(opts))}` : '');
      const { id } = await api('/api/convert?' + qs, { method: 'POST', body: q.file });
      const job = await track(id, (j) => { q.pct = jobPercent(j); q.step = j.step || ''; paintQueue(); });
      if (job.status === 'done') {
        q.status = 'done'; q.result = job.result || {};
      } else {
        q.status = 'failed'; q.error = job.error?.message || 'Something went wrong.'; q.hint = job.error?.hint || job.hint || '';
      }
    } catch (err) {
      q.status = 'failed'; q.error = err.message; q.hint = err.hint || '';
    }
    paintQueue();
    loadModels().catch(() => {});
  }
}

// ----- URL paste auto-detection across tabs -----
const onUrlInput = (e) => {
  const v = (e.target.value || '').trim();
  if (v.includes('sketchfab.com') && state.tab !== 'sketchfab') {
    setTab('sketchfab');
    $('sfInput').value = v;
  } else if (v.includes('meshy.ai') && state.tab !== 'meshy') {
    setTab('meshy');
    if ($('meshyInput')) $('meshyInput').value = v;
  } else if (v.includes('tripo3d.ai') && state.tab !== 'tripo') {
    setTab('tripo');
    $('tripoInput').value = v;
  }
};
$('sfInput').addEventListener('input', onUrlInput);
if ($('meshyInput')) $('meshyInput').addEventListener('input', onUrlInput);
if ($('tripoInput')) $('tripoInput').addEventListener('input', onUrlInput);

// ----- formats -----
const FORMAT_LABELS = { glb: 'GLB', obj: 'OBJ', stl: 'STL', ply: 'PLY', fbx: 'FBX', gltf: 'glTF' };
function renderFormats(list, optional = {}) {
  const make = (f, disabled, reason) => {
    const input = el('input', { type: 'checkbox', id: 'fmt_' + f, value: f, checked: f === 'glb' && !disabled, disabled });
    const lab = el('label', { className: 'check' + (disabled ? ' off' : '') }, input, ' ' + (FORMAT_LABELS[f] || f.toUpperCase()));
    if (reason) lab.title = reason;
    return lab;
  };
  const nodes = list.filter((f) => f !== 'fbx').map((f) => make(f, false));
  if (optional && optional.fbx) nodes.push(make('fbx', !optional.fbx.available, optional.fbx.available ? '' : optional.fbx.reason || 'Not available on this computer.'));
  else if (list.includes('fbx')) nodes.push(make('fbx', false));
  $('fmtList').replaceChildren(...nodes);
}
const formats = () => [...$('fmtList').querySelectorAll('input:checked:not(:disabled)')].map((i) => i.value);

// ----- options -----
const OPT_KEY = 'meshport.options';
const OPT_DEFAULTS = { cleanup: true, up: '', unit: '', scale: '1', dec: '100', tex: '0', center: false, ground: false };
const OPT_FIELDS = { cleanup: 'optCleanup', up: 'optUp', unit: 'optUnit', scale: 'optScale', dec: 'optDec', tex: 'optTex', center: 'optCenter', ground: 'optGround' };
function readOpts() {
  const o = {};
  for (const [k, id] of Object.entries(OPT_FIELDS)) o[k] = typeof OPT_DEFAULTS[k] === 'boolean' ? $(id).checked : $(id).value;
  return o;
}
function writeOpts(o) {
  for (const [k, id] of Object.entries(OPT_FIELDS)) {
    if (typeof OPT_DEFAULTS[k] === 'boolean') $(id).checked = Boolean(o[k]); else $(id).value = String(o[k]);
  }
  paintDec();
}
function paintDec() {
  const v = Number($('optDec').value);
  $('optDecVal').textContent = v >= 100 ? '100% kept (off)' : v + '% of triangles kept';
}
function saveOpts() {
  try { localStorage.setItem(OPT_KEY, JSON.stringify({ ...readOpts(), open: $('opts').open })); } catch { /* storage may be blocked */ }
}
// Only values that differ from the defaults are sent.
function currentOptions() {
  const o = readOpts();
  const out = {};
  if (!o.cleanup) out.cleanup = false;
  if (o.up) out.upAxis = o.up;
  if (o.center) out.center = true;
  if (o.ground) out.ground = true;
  if (o.unit) out.unit = o.unit;
  const sc = Number(o.scale);
  if (Number.isFinite(sc) && sc > 0 && sc !== 1) out.scale = sc;
  const dec = Number(o.dec);
  if (dec < 100) out.decimate = dec / 100;
  if (Number(o.tex) > 0) out.maxTexture = Number(o.tex);
  return out;
}
try {
  const saved = JSON.parse(localStorage.getItem(OPT_KEY) || 'null');
  if (saved && typeof saved === 'object') { writeOpts({ ...OPT_DEFAULTS, ...saved }); $('opts').open = Boolean(saved.open); }
} catch { /* ignore */ }
paintDec();
for (const id of Object.values(OPT_FIELDS)) $(id).addEventListener('input', () => { paintDec(); saveOpts(); });
$('opts').addEventListener('toggle', saveOpts);
$('optReset').addEventListener('click', () => { writeOpts(OPT_DEFAULTS); saveOpts(); });

// ----- result summary -----
function cleanupLine(c) {
  const parts = [];
  if (c.merged) parts.push(`merged ${num(c.merged)} vertices`);
  const removed = [];
  if (c.triangles) removed.push(`${num(c.triangles)} stray triangle${c.triangles === 1 ? '' : 's'}`);
  if (c.lines) removed.push(`${num(c.lines)} line${c.lines === 1 ? '' : 's'}`);
  if (c.vertices) removed.push(`${num(c.vertices)} unused vertices`);
  if (removed.length) parts.push('removed ' + removed.join(removed.length > 2 ? ', ' : ' and '));
  if (!parts.length) return 'Cleanup found nothing to fix.';
  const t = parts.join(', ');
  return t[0].toUpperCase() + t.slice(1) + '.';
}
function glbName(files) {
  const f = (files || []).find((x) => /^[^/]+\.glb$/i.test(x.name));
  return f ? f.name : null;
}
function renderSummary(r) {
  const box = el('div', { className: 'summary' });
  const st = r.stats;
  if (st) {
    const dl = el('dl');
    for (const [k, label] of [['vertices', 'Vertices'], ['triangles', 'Triangles'], ['materials', 'Materials'], ['textures', 'Textures']]) {
      if (st[k] != null) dl.append(el('div', {}, el('dt', { textContent: label }), el('dd', { textContent: num(st[k]) })));
    }
    box.append(dl);
  }
  if (r.folder) box.append(el('div', { textContent: `Saved in "${r.folder}".` }));
  if (r.cleanup) box.append(el('div', { textContent: cleanupLine(r.cleanup) }));
  if (r.notes && r.notes.length) box.append(el('ul', {}, ...r.notes.map((n) => el('li', { textContent: n }))));
  const acts = el('div', { className: 'acts' });
  const glb = glbName(r.files);
  if (glb && r.folder) {
    const pv = el('button', { className: 'ghost small', type: 'button', textContent: 'Preview' });
    pv.addEventListener('click', () => showPreview(r.folder, glb));
    acts.append(pv);
  }
  for (const f of (r.files || []).filter((x) => /\.(glb|obj|stl|ply|fbx)$/i.test(x.name))) {
    acts.append(el('a', { href: fileUrl(r.folder, f.name), download: '', textContent: f.name.split('.').pop().toUpperCase() + ' ' + size(f.size) }));
  }
  if (acts.children.length) box.append(acts);
  return box;
}

// ----- run a job -----
function showJob(label, step, percent, msg, cls = '') {
  $('jobBox').hidden = false;
  $('jobLabel').textContent = label;
  $('jobStep').textContent = step;
  $('jobBar').style.width = percent + '%';
  const m = $('jobMsg');
  m.className = cls;
  m.replaceChildren();
  $('jobResult').replaceChildren();
  if (msg) {
    m.append(msg.text);
    if (msg.hint) m.append(el('span', { className: 'why', textContent: msg.hint }));
  }
}

function jobPercent(j) {
  const p = j.percent ?? (j.progress != null ? (j.progress <= 1 ? j.progress * 100 : j.progress) : 0);
  return Math.max(0, Math.min(100, p));
}

// Polls a job until it is finished; calls onUpdate while it runs.
async function track(id, onUpdate) {
  for (;;) {
    const job = await api(`/api/jobs/${id}`);
    if (job.status !== 'running' && job.status !== 'queued') return job;
    onUpdate(job);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function follow(id, label) {
  const job = await track(id, (j) => showJob(label, j.step, jobPercent(j)));
  if (job.status === 'done') {
    showJob(label, 'Done', 100, { text: 'Finished.' }, 'ok');
    $('jobResult').replaceChildren(renderSummary(job.result || {}));
  } else {
    const e = job.error || {};
    showJob(label, 'Stopped', 0, { text: e.message || 'Something went wrong.', hint: e.hint || job.hint }, 'bad');
  }
}

async function go() {
  if (state.busy) return;
  const fmts = formats();
  if (!fmts.length) return showJob('', '', 0, { text: 'Pick at least one format.' }, 'bad');
  const options = currentOptions();
  const extra = Object.keys(options).length ? { options } : {};
  let start;
  let label;
  if (state.tab === 'sketchfab') {
    const val = $('sfInput')?.value?.trim();
    if (!val) return showJob('', '', 0, { text: 'Paste a Sketchfab link first.' }, 'bad');
    label = 'Sketchfab';
    start = () => api('/api/jobs', json({ source: 'sketchfab', input: val, formats: fmts, ...extra }));
  } else if (state.tab === 'meshy') {
    const meshyVal = $('meshyInput')?.value?.trim();
    if (!meshyVal) return showJob('', '', 0, { text: 'Paste a Meshy link first.' }, 'bad');
    label = 'Meshy';
    start = () => api('/api/jobs', json({ source: 'meshy', input: meshyVal, formats: fmts, ...extra }));
  } else if (state.tab === 'tripo') {
    const tripoVal = $('tripoInput')?.value?.trim();
    if (!tripoVal) return showJob('', '', 0, { text: 'Paste a Tripo link first.' }, 'bad');
    label = 'Tripo';
    start = () => api('/api/jobs', json({ source: 'tripo', input: tripoVal, formats: fmts, ...extra }));
  } else {
    if (!queue.some((q) => q.status === 'waiting')) return showJob('', '', 0, { text: 'Add at least one .glb, .gltf, .zip or .obj file first.' }, 'bad');
    $('jobBox').hidden = true;
    state.busy = true;
    $('goBtn').disabled = true;
    try { await runQueue(fmts); } finally { state.busy = false; $('goBtn').disabled = false; }
    return;
  }
  state.busy = true;
  $('goBtn').disabled = true;
  showJob(label, 'Starting', 2);
  try {
    const { id } = await start();
    await follow(id, label);
  } catch (err) {
    showJob(label, 'Stopped', 0, { text: err.message, hint: err.hint }, 'bad');
  } finally {
    state.busy = false;
    $('goBtn').disabled = false;
    loadModels().catch(() => {});
  }
}
$('goBtn').addEventListener('click', go);

// ----- 3D preview -----
const pvDlg = $('preview');
let pvApi = null;
async function showPreview(folder, name) {
  $('pvTitle').textContent = `${folder} / ${name}`;
  $('pvMsg').textContent = 'Loading...';
  $('pvWire').checked = false;
  $('pvStage').replaceChildren();
  pvApi = null;
  if (!pvDlg.open) pvDlg.showModal();
  try {
    const mod = await import('/preview.js');
    if (!pvDlg.open) return;
    pvApi = await mod.openPreview($('pvStage'), fileUrl(folder, name), (t) => { $('pvMsg').textContent = t; });
  } catch (err) {
    $('pvMsg').textContent = 'Could not show this model: ' + (err.message || err);
  }
}
$('pvWire').addEventListener('change', (e) => pvApi?.setWireframe(e.target.checked));
$('pvClose').addEventListener('click', () => pvDlg.close());
pvDlg.addEventListener('close', async () => {
  pvApi = null;
  try { (await import('/preview.js')).closePreview(); } catch { /* never opened */ }
  $('pvStage').replaceChildren();
});

// ----- library -----
let allModels = [];
const totalSize = (m) => m.files.reduce((n, f) => n + f.size, 0);
async function loadModels() {
  allModels = await api('/api/models');
  paintModels();
}
function paintModels() {
  const q = $('search').value.trim().toLowerCase();
  const sort = $('sort').value;
  const models = allModels.filter((m) => !q || m.id.toLowerCase().includes(q));
  models.sort((a, b) => (sort === 'old' ? a.modified - b.modified : sort === 'name' ? a.id.localeCompare(b.id) : sort === 'size' ? totalSize(b) - totalSize(a) : b.modified - a.modified));
  const none = allModels.length === 0;
  $('empty').hidden = !(none || !models.length);
  $('empty').textContent = none ? 'Nothing here yet. Models you get will show up in this list.' : 'No models match your search.';
  $('models').replaceChildren(...models.map((m) => {
    const links = m.files
      .filter((f) => /\.(glb|obj|stl|ply|fbx)$/i.test(f.name))
      .map((f) => el('a', { href: fileUrl(m.id, f.name), textContent: f.name.split('.').pop().toUpperCase() + ' ' + size(f.size), download: '' }));
    const acts = [];
    const glb = glbName(m.files);
    if (glb) {
      const pv = el('button', { className: 'ghost small', type: 'button', textContent: 'Preview' });
      pv.addEventListener('click', () => showPreview(m.id, glb));
      acts.push(pv);
    }
    const open = el('button', { className: 'ghost small', type: 'button', textContent: 'Folder' });
    open.addEventListener('click', () => api('/api/open-folder', json({ model: m.id })));
    const del = el('button', { className: 'ghost small', type: 'button', textContent: 'Delete' });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${m.id}" and its files? This cannot be undone.`)) return;
      try { await api(`/api/models/${encodeURIComponent(m.id)}`, { method: 'DELETE' }); } catch (err) { alert(err.message); }
      loadModels().catch(() => {});
    });
    return el('div', { className: 'item' }, el('div', {}, el('div', { className: 'name', textContent: m.id }), el('div', { className: 'meta', textContent: `${new Date(m.modified).toLocaleString()} - ${size(totalSize(m))} total` })), el('div', { className: 'acts' }, ...links, ...acts, open, del));
  }));
}
$('search').addEventListener('input', paintModels);
$('sort').addEventListener('change', paintModels);
$('openAll').addEventListener('click', () => api('/api/open-folder', json({})));

// ----- theme -----
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : mq.matches);
function paintTheme() { $('themeBtn').textContent = isDark() ? 'Light theme' : 'Dark theme'; }
$('themeBtn').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('meshport.theme', next); } catch { /* ignore */ }
  paintTheme();
});
if (mq.addEventListener) mq.addEventListener('change', paintTheme);
paintTheme();

// ----- start -----
let first = { formats: ['glb', 'obj'] };
try { first = { ...first, ...(await api('/api/state')) }; } catch { /* keep defaults */ }
renderFormats(Array.isArray(first.formats) && first.formats.length ? first.formats : ['glb', 'obj'], first.optionalFormats);
try { await loadModels(); } catch { /* list stays empty */ }
