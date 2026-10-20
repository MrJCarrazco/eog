#!/usr/bin/env node
// Gate: every HUD control, stat and gameplay surface of the demo stays on-screen and
// usable across the pinned viewports, measured in a REAL headless Chrome (not grep).
//
//   node check_responsive_hud.mjs [--site DIR] [--out DIR] [--shots] [--quiet]
//
// --site DIR  serve DIR instead of this script's own directory (sandbox mutants)
// --out DIR   write report.json (+ PNGs with --shots) there; default: a fresh os.tmpdir() dir
// Browser: $CHROME_PATH if set (must exist - no silent fallback), else standard installs.
//
// Exit 0 = GATE OPEN, 1 = GATE CLOSED (each failure named), 2 = INCOMPLETE (no browser,
// boot/font timeout, CDP error). Never 0 unless every check ran and passed.
//
// Network posture: a loopback-only static server; Chrome runs with a fresh profile, a
// private CDP port and a host-resolver rule that maps every non-loopback host to
// NOTFOUND. Any non-loopback request the page still attempts is failed and FAILS the
// gate. Paid-exit clicks are real Input.dispatchMouseEvent clicks; a capture-phase
// listener records the anchor hit and cancels the navigation before any request.
// Dependency-free: Node >= 22 (global WebSocket + fetch).
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratchRoot = () => {
  let p = process.env.HUD_SCRATCH_DIR || (process.env.HERMES_HOME && path.join(process.env.HERMES_HOME, 'cache', 'scratch')) || process.env.TMPDIR || os.tmpdir();
  if (process.platform === 'win32') p = p.replace(/^\/([a-z])\//i, (_, d) => d.toUpperCase() + ':/');
  return path.resolve(p);
};
// Resolve existing ancestors too, so a junction cannot put a report into the serving tree.
function realCandidate(p) {
  const tail = [];
  p = path.resolve(p);
  while (!fs.existsSync(p)) { tail.unshift(path.basename(p)); const up = path.dirname(p); if (up === p) break; p = up; }
  return path.resolve(fs.realpathSync(p), ...tail);
}
let emergencyCleanup = async () => {};
const VIEWPORTS = [
  [320, 568], [375, 667], [390, 844], [640, 800], [641, 800], [768, 1024], [900, 700],
  [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [568, 320], [740, 360], [844, 390],
];
const CONTROLS = ['demo-badge', 'btn-share', 'link-itch', 'link-buy-hud', 'btn-full'];
// Keyboard crew comms (R-EOG35): in the feed, NOT the HUD - same visible/hit/font/target limits,
// excluded from the HUD overlap and HUD-height checks.
const COMMS = ['crew-select', 'btn-talk'];
const MIN_TALK_W = 48;
const MAX_TABS = 30;      // real Tab presses allowed to reach the roster from wherever focus is
const ROSTER_VP = '1920x1080'; // every one of the 13 gods is opened by keyboard here
// Exact paid exits (raw attribute values). A drift here is a gate failure, not a test update.
const PAID_HUD = 'https://mrjcarrazco.gumroad.com/l/rqaxx?utm_source=eog_demo&utm_medium=hud';
const PAID_UPSELL = 'https://mrjcarrazco.gumroad.com/l/rqaxx?utm_source=eog_demo&utm_medium=upsell';
const TOL = 1;            // px tolerance for "inside the viewport"
const MIN_TARGET = 32;    // CSS px, both axes
const MIN_FONT = 14;      // CSS px
const MAX_HUD_FRAC = 0.45;
const MIN_GODS_CLEAR = 7; // of 13 god centres must be hit-testable on the bare canvas
const WATCHDOG_MS = 480000; // worst case waits out a missed event for the next one (45-90 s)

class Incomplete extends Error {}

function parseArgs(argv) {
  const a = { site: HERE, out: null, shots: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--site') a.site = path.resolve(argv[++i] || '');
    else if (k === '--out') a.out = path.resolve(argv[++i] || '');
    else if (k === '--shots') a.shots = true;
    else if (k === '--quiet') a.quiet = true;
    else throw new Incomplete('unknown argument ' + k);
  }
  return a;
}

/* ---------- browser discovery (no user names; env first, then standard installs) ---------- */
function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env) {
    if (fs.existsSync(env)) return env;
    throw new Incomplete('CHROME_PATH is set but does not exist: ' + env);
  }
  const c = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      c.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      c.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
      c.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    c.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const dir of (process.env.PATH || '').split(':').concat(['/usr/bin', '/usr/local/bin', '/snap/bin'])) {
      for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) c.push(path.join(dir, n));
    }
    c.push('/opt/google/chrome/chrome');
  }
  const hit = c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!hit) throw new Incomplete('no Chrome/Chromium/Edge found (set CHROME_PATH)');
  return hit;
}

/* ---------- loopback static server rooted at the site dir ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'application/xml' };
function serve(root) {
  const srv = createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((ok, bad) => { srv.once('error', bad); srv.listen(0, '127.0.0.1', () => ok(srv)); });
}

/* ---------- minimal flat-session CDP client ---------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.wait = new Map(); this.handlers = []; ws.onmessage = (m) => this.onMsg(m); }
  static open(url) {
    return new Promise((ok, bad) => {
      const ws = new WebSocket(url);
      ws.onopen = () => ok(new CDP(ws));
      ws.onerror = () => bad(new Incomplete('CDP websocket failed'));
    });
  }
  onMsg(m) {
    const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
    if (msg.id && this.wait.has(msg.id)) {
      const { ok, bad, method } = this.wait.get(msg.id); this.wait.delete(msg.id);
      if (msg.error) bad(new Incomplete(method + ': ' + msg.error.message)); else ok(msg.result);
    } else if (msg.method) for (const h of this.handlers) h(msg);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((ok, bad) => this.wait.set(id, { ok, bad, method }));
  }
  on(h) { this.handlers.push(h); }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Incomplete('timeout waiting for ' + what);
    await sleep(100);
  }
}

async function launch(chrome) {
  const profile = fs.mkdtempSync(path.join(scratchRoot(), 'eog-hud-profile-'));
  const args = ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--metrics-recording-only', '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'];
  if (process.platform === 'linux') args.unshift('--no-sandbox'); // CI runners restrict userns sandboxing
  let proc = null, died = null;
  let cdp = null, cleaning = null;
  const cleanup = () => cleaning ||= (async () => {
    if (cdp) {
      try { await Promise.race([cdp.send('Browser.close'), sleep(1500)]); } catch {}
      cdp.close();
    }
    if (proc && proc.exitCode === null && proc.pid) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', timeout: 5000 });
        else proc.kill('SIGKILL');
      } catch {}
    }
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
  })();
  const previousCleanup = emergencyCleanup;
  emergencyCleanup = async () => { await cleanup(); await previousCleanup(); };
  try {
  // Register cleanup before spawn: resource exhaustion can throw synchronously.
  proc = spawn(chrome, args, { stdio: 'ignore', env: { ...process.env, TEMP: scratchRoot(), TMP: scratchRoot(), TMPDIR: scratchRoot() } });
  proc.on('exit', (c) => { died = c; });
  proc.on('error', (e) => { died = e.message; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const lines = await until(() => {
    if (died !== null) throw new Incomplete('browser exited at launch (' + died + ')');
    try { const t = fs.readFileSync(portFile, 'utf8').split('\n'); return t.length >= 2 && t[1] ? t : null; } catch { return null; }
  }, 20000, 'DevToolsActivePort');
  cdp = await CDP.open('ws://127.0.0.1:' + lines[0].trim() + lines[1].trim());
  return { cdp, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

/* ---------- in-page measurement (serialised into the page) ---------- */
function pageMeasure(ids) {
  const vw = innerWidth, vh = innerHeight;
  const R = (r) => ({ x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
  function vis(el) {
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return { shown: false, why: 'display:none on ' + (n.id || n.className || n.tagName) };
      op *= parseFloat(cs.opacity);
      if (n.hidden) return { shown: false, why: 'hidden attribute' };
    }
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible') return { shown: false, why: 'visibility:' + cs.visibility };
    if (op < 0.1) return { shown: false, why: 'opacity ' + op.toFixed(2) };
    return { shown: true };
  }
  function probe(el) {
    const r = el.getBoundingClientRect();
    const v = vis(el);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return { rect: R(r), shown: v.shown, why: v.why || null,
      inside: r.left >= -TOL && r.top >= -TOL && r.right <= vw + TOL && r.bottom <= vh + TOL,
      hitOk: !!hit && (hit === el || el.contains(hit)), hitWhat: hit ? (hit.id || hit.className || hit.tagName) : null,
      font: parseFloat(getComputedStyle(el).fontSize),
      clipX: el.scrollWidth - el.clientWidth, clipY: el.scrollHeight - el.clientHeight };
  }
  const TOL = 1;
  const out = { vw, vh, controls: {}, stats: [], gods: [] };
  for (const id of ids) {
    const el = document.getElementById(id);
    out.controls[id] = el ? probe(el) : null;
  }
  document.querySelectorAll('#stats .stat, #clock').forEach((el) => {
    const p = probe(el); p.k = el.dataset.k || el.id;
    const val = el.querySelector('.val') || el;
    p.font = parseFloat(getComputedStyle(val).fontSize);
    out.stats.push(p);
  });
  const hud = document.querySelector('.hud');
  out.hudBottom = hud ? Math.round(hud.getBoundingClientRect().bottom * 10) / 10 : null;
  const canvas = document.getElementById('stage');
  out.canvas = canvas ? R(canvas.getBoundingClientRect()) : null;
  const api = window.__eogdemo;
  const godIds = ((window.EOG_BANTER && EOG_BANTER.cast) || []).map((c) => c.id);
  for (const id of godIds) {
    const s = api && api.bodyScreen(id);
    if (!s) { out.gods.push({ id, missing: true }); continue; }
    const hit = document.elementFromPoint(s.x, s.y);
    out.gods.push({ id, x: Math.round(s.x), y: Math.round(s.y), loaded: s.loaded,
      inside: s.x >= 0 && s.y >= 0 && s.x <= vw && s.y <= vh, belowHud: s.y > out.hudBottom,
      clear: !!hit && hit === canvas });
  }
  return out;
}

async function pagePanel(sel, parts) {
  const el = document.querySelector(sel);
  if (!el || el.hidden) return null;
  await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => null))); // measure the settled card, not its slide-in
  if (el.hidden) return null;
  const vw = innerWidth, vh = innerHeight, TOL = 1;
  const r = el.getBoundingClientRect();
  const res = { rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    inside: r.left >= -TOL && r.top >= -TOL && r.right <= vw + TOL && r.bottom <= vh + TOL,
    hudBottom: document.querySelector('.hud').getBoundingClientRect().bottom, parts: {} };
  for (const p of parts) {
    const t = el.querySelector(p);
    if (!t) { res.parts[p] = null; continue; }
    const tr = t.getBoundingClientRect();
    const hit = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
    res.parts[p] = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2, w: Math.round(tr.width), h: Math.round(tr.height),
      inside: tr.left >= -TOL && tr.top >= -TOL && tr.right <= vw + TOL && tr.bottom <= vh + TOL,
      hitOk: !!hit && (hit === t || t.contains(hit)), hitWhat: hit ? (hit.id || hit.className || hit.tagName) : null };
  }
  return res;
}

function pageInstallClickTrap() {
  window.__hudTrap = [];
  addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    window.__hudTrap.push({ trusted: e.isTrusted, target: e.target && (e.target.id || e.target.className || e.target.tagName),
      anchor: a ? a.id : null, href: a ? a.getAttribute('href') : null });
    if (a && !/^https?:\/\/127\.0\.0\.1[:/]/.test(a.href)) e.preventDefault(); // cancel BEFORE any request
  }, true);
  return true;
}

/* ---------- main ---------- */
async function run(opts) {
  const failures = [];
  const report = { site: path.basename(opts.site), viewports: [], failures };
  const fail = (vp, msg) => failures.push((vp ? vp + ' ' : '') + msg);
  const say = (s) => { if (!opts.quiet) console.log(s); };

  if (!fs.existsSync(path.join(opts.site, 'index.html'))) throw new Incomplete('no index.html in --site dir');
  const chrome = findChrome();
  const srv = await serve(opts.site);
  emergencyCleanup = async () => { srv.close(); };
  const origin = 'http://127.0.0.1:' + srv.address().port;
  const { cdp, cleanup } = await launch(chrome).catch((e) => { srv.close(); throw e; });
  const outbound = [], strayTargets = [];
  let sid = null, pageTarget = null;
  const known = new Set(); // tabs that existed before we attached (Chrome's own startup tab)
  const S = (m, p) => cdp.send(m, p, sid);
  const ev = async (fn, ...args) => {
    const r = await S('Runtime.evaluate', { expression: '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')', returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Incomplete('page eval threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const setVp = async (w, h) => {
    await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))));
  };
  const click = async (x, y) => {
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
  };
  const shot = async (name) => {
    if (!opts.shots) return;
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(opts.out, name + '.png'), Buffer.from(data, 'base64'));
  };
  const trap = () => ev(() => window.__hudTrap.splice(0));
  // Real key presses (Input.dispatchKeyEvent): never .click()/.focus() for the keyboard proofs.
  const KEYS = { Tab: [9, 'Tab'], Enter: [13, 'Enter', '\r'], ' ': [32, 'Space', ' '], ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], Escape: [27, 'Escape'] };
  const key = async (k, shift) => {
    const [vk, code, text] = KEYS[k];
    const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
    await S('Input.dispatchKeyEvent', Object.assign({ type: text ? 'keyDown' : 'rawKeyDown' }, base, text ? { text, unmodifiedText: text } : {}));
    await S('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    await sleep(40);
  };
  const focusInfo = () => ev(() => {
    const a = document.activeElement, sel = document.getElementById('crew-select');
    const dc = [...document.querySelectorAll('#dlg-choices .choice')], ec = [...document.querySelectorAll('#ev-choices .choice')];
    return { id: (a && a.id) || (a && a.tagName) || null, dlgChoice: dc.indexOf(a), dlgN: dc.length, evChoice: ec.indexOf(a),
      sel: sel ? sel.value : null, selIdx: sel ? sel.selectedIndex : -1 };
  });
  const tabTo = async (id) => {
    for (let n = 1; n <= MAX_TABS; n++) { await key('Tab'); if ((await focusInfo()).id === id) return n; }
    return 0;
  };
  const dlgOpen = () => ev(() => !document.getElementById('dialog').hidden);
  const rows = new Map(VIEWPORTS.map(([w, h]) => [w + 'x' + h, { vp: w + 'x' + h }]));
  report.viewports = [...rows.values()];
  try {
    cdp.on((m) => {
      if (m.method === 'Target.targetCreated' && !sid) known.add(m.params.targetInfo.targetId);
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    pageTarget = targetId;
    cdp.on((m) => {
      const ti = m.method === 'Target.targetCreated' && m.params.targetInfo;
      if (ti && sid && ti.type === 'page' && ti.targetId !== pageTarget && !known.has(ti.targetId)) {
        strayTargets.push(ti.url || '(blank)');
        cdp.send('Target.closeTarget', { targetId: ti.targetId }).catch(() => {});
      }
      if (m.method === 'Fetch.requestPaused' && m.sessionId === sid) {
        const u = m.params.request.url;
        if (u.startsWith(origin + '/')) cdp.send('Fetch.continueRequest', { requestId: m.params.requestId }, sid).catch(() => {});
        else { outbound.push(u); cdp.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {}); }
      }
    });
    ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));

    await S('Page.enable');
    await S('Runtime.enable');
    await S('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    const [w0, h0] = VIEWPORTS[0];
    await S('Emulation.setDeviceMetricsOverride', { width: w0, height: h0, deviceScaleFactor: 1, mobile: false });
    await S('Page.navigate', { url: origin + '/index.html?seed=42' });

    // Boot: real readiness, not readyState - fonts settled, VT323 in use, demo booted, splash gone.
    await until(() => ev(() => !!(window.__eogdemo && __eogdemo.stats().booted)), 30000, '__eogdemo boot');
    await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' }); // any key dismisses the splash
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft' });
    await until(() => ev(() => {
      const sp = document.getElementById('splash');
      return __eogdemo.stats().splashGone && (!sp || getComputedStyle(sp).display === 'none');
    }), 10000, 'splash gone');
    await until(() => ev(() => document.fonts.ready.then(() => document.fonts.check('20px VT323') &&
      [...document.fonts].some((f) => f.family.replace(/['"]/g, '') === 'VT323' && f.status === 'loaded'))), 15000, 'VT323 font loaded');
    await until(() => ev(() => __eogdemo.stats().bodiesLoaded >= 13), 30000, 'all 13 god atlases');
    await ev(pageInstallClickTrap);

    /* pass 1: a REAL station event (game timing untouched: first fires ~20 s after boot) on every
       viewport, then resolved by a real click on its choice so the HUD pass runs uncovered. */
    await until(() => ev(() => !!__eogdemo.stats().eventActive), 40000, 'first station event');
    // Keyboard TALK while that event is live: refused with a visible status, no dialogue, no stat
    // increment, focus handed to the event's first choice (restore is checked after it resolves).
    const refusal = await keyboardRefusal();
    // A loaded machine can outlast the game's 30 s event timeout: then wait for the NEXT real event.
    for (const [w, h] of VIEWPORTS) {
      const vp = w + 'x' + h;
      for (let tries = 0; ; tries++) {
        await until(() => ev(() => !!__eogdemo.stats().eventActive), 100000, 'a station event');
        await setVp(w, h);
        const e = await ev(pagePanel, '#event', ['.choice']);
        if (!e && tries < 2) continue; // auto-resolved mid-measure
        if (!e) { fail(vp, 'event card vanished mid-measure (3 tries)'); break; }
        rows.get(vp).event = e;
        if (e.rect.y < e.hudBottom - TOL) fail(vp, `event card top ${e.rect.y} is under the HUD (bottom ${Math.round(e.hudBottom)})`);
        if (!e.inside) fail(vp, `event card clipped by viewport rect=${JSON.stringify(e.rect)}`);
        const c = e.parts['.choice'];
        if (!c || !c.inside || !c.hitOk) fail(vp, `event choice not reachable (${c ? c.hitWhat : 'missing'})`);
        await shot('event-' + vp);
        break;
      }
    }
    // Resolve it with a real click on its choice (re-measured now) so the HUD pass runs uncovered.
    const live = await ev(pagePanel, '#event', ['.choice']);
    const lc = live && live.parts['.choice'];
    if (lc && lc.hitOk) {
      const before = await ev(() => __eogdemo.stats().eventsResolved);
      await click(lc.x, lc.y);
      const ok = await until(() => ev((n) => __eogdemo.stats().eventsResolved > n, before), 3000, 'event resolve').catch(() => false);
      if (!ok) fail(VIEWPORTS[VIEWPORTS.length - 1].join('x'), 'real click on the event choice did not resolve the event');
    }
    if (refusal) {
      const s = await ev(() => __eogdemo.stats());
      // only provable when the event that took focus is the one just resolved (not a later one)
      if (!s.eventActive && s.eventsFired === refusal.eventsFired) {
        const f = await focusInfo();
        report.refusalRestore = f.id;
        if (f.id !== 'btn-talk') fail('', `keyboard: focus did not return to #btn-talk after the event that took it resolved (on ${f.id})`);
      } else report.refusalRestore = 'not observable (event replaced or unresolved)';
    }
    say(`event card checked on ${VIEWPORTS.length} viewports`);

    /* pass 2: HUD, gameplay, dialog, paid clicks, upsell - per viewport. The next event is >= 45 s
       away, but a slow runner can outlast that: an event that fires mid-viewport is resolved with a
       real click and that viewport is measured again (once), so a covered card never flakes the gate. */
    const settleEvent = async () => {
      if (!(await ev(() => !!__eogdemo.stats().eventActive))) return;
      const e = await ev(pagePanel, '#event', ['.choice']);
      const c = e && e.parts['.choice'];
      if (!c || !c.hitOk) throw new Incomplete('a station event fired mid-pass and its choice is not clickable');
      await click(c.x, c.y);
      await until(() => ev(() => !__eogdemo.stats().eventActive), 3000, 'mid-pass event resolve');
    };
    for (const [w, h] of VIEWPORTS) {
      for (let attempt = 0; ; attempt++) {
        await settleEvent();
        const mark = failures.length, fired = await ev(() => __eogdemo.stats().eventsFired);
        const r = await checkViewport(w, h);
        if (attempt === 1 || (await ev(() => __eogdemo.stats().eventsFired)) === fired) {
          if (r) say(r);
          break;
        }
        failures.length = mark;
      }
    }
    await settleEvent();
    await keyboardEventOverDialogue();
  } finally {
    report.outbound = outbound; report.strayTargets = strayTargets;
    await cleanup();
    srv.close();
  }
  if (outbound.length) fail('', `page attempted ${outbound.length} non-loopback request(s): ${outbound.slice(0, 3).join(' ')}`);
  if (strayTargets.length) fail('', `a click opened ${strayTargets.length} new tab(s): ${strayTargets.join(' ')}`);
  return report;

  async function checkViewport(w, h) {
      const vp = w + 'x' + h;
      await setVp(w, h);
      const m = await ev(pageMeasure, CONTROLS);
      const row = Object.assign(rows.get(vp), { hudBottom: m.hudBottom, controls: m.controls, stats: m.stats, gods: m.gods });
      if (m.vw !== w || m.vh !== h) { fail(vp, `viewport emulation mismatch (${m.vw}x${m.vh})`); return null; }

      const boxes = [];
      for (const id of CONTROLS) {
        const c = m.controls[id];
        if (!c) { fail(vp, `#${id} MISSING from the DOM`); continue; }
        if (!c.shown) { fail(vp, `#${id} not visible (${c.why})`); continue; }
        if (!c.inside) fail(vp, `#${id} OFFSCREEN/clipped rect=${JSON.stringify(c.rect)}`);
        if (c.rect.w < MIN_TARGET || c.rect.h < MIN_TARGET) fail(vp, `#${id} target ${c.rect.w}x${c.rect.h} < ${MIN_TARGET}x${MIN_TARGET}`);
        if (!c.hitOk) fail(vp, `#${id} centre is covered by "${c.hitWhat}" (elementFromPoint)`);
        if (c.font < MIN_FONT) fail(vp, `#${id} font ${c.font}px < ${MIN_FONT}px`);
        if (c.clipX > 1 || c.clipY > 1) fail(vp, `#${id} text clipped inside its box (${c.clipX}/${c.clipY}px)`);
        boxes.push(['#' + id, c.rect]);
      }
      if (m.stats.length !== 4) fail(vp, `expected 3 stats + clock, found ${m.stats.length}`);
      for (const s of m.stats) {
        if (!s.shown) { fail(vp, `stat ${s.k} not visible (${s.why})`); continue; }
        if (!s.inside) fail(vp, `stat ${s.k} OFFSCREEN rect=${JSON.stringify(s.rect)}`);
        if (!s.hitOk) fail(vp, `stat ${s.k} covered by "${s.hitWhat}"`);
        if (s.font < MIN_FONT) fail(vp, `stat ${s.k} font ${s.font}px < ${MIN_FONT}px`);
        boxes.push(['stat ' + s.k, s.rect]);
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const [na, a] = boxes[i], [nb, b] = boxes[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 1 && oy > 1) fail(vp, `HUD overlap ${na} x ${nb} (${ox.toFixed(1)}x${oy.toFixed(1)}px)`);
      }
      if (m.hudBottom > h * MAX_HUD_FRAC) fail(vp, `HUD consumes ${m.hudBottom}px = ${Math.round(100 * m.hudBottom / h)}% of height (> ${MAX_HUD_FRAC * 100}%)`);
      if (!m.canvas || m.canvas.w < w - 1 || m.canvas.h < h - 1) fail(vp, 'stage canvas does not cover the viewport');
      if (m.gods.length !== 13) fail(vp, `expected 13 gods, found ${m.gods.length}`);
      const off = m.gods.filter((g) => g.missing || !g.inside || !g.belowHud);
      if (off.length) fail(vp, `god(s) offscreen or under the HUD: ${off.map((g) => g.id + '@' + g.x + ',' + g.y).join(' ')}`);
      const clear = m.gods.filter((g) => g.clear);
      row.godsClear = clear.length;
      if (clear.length < MIN_GODS_CLEAR) fail(vp, `only ${clear.length}/13 gods are clickable on the bare canvas (< ${MIN_GODS_CLEAR})`);
      await shot('hud-' + vp);

      // Paid HUD exit: real click at the centre; the trap records the anchor and cancels the navigation.
      const buy = m.controls['link-buy-hud'];
      if (buy && buy.shown) {
        await trap();
        await click(buy.rect.x + buy.rect.w / 2, buy.rect.y + buy.rect.h / 2);
        const got = await trap();
        const hit = got.find((g) => g.anchor === 'link-buy-hud' && g.trusted);
        if (!hit) fail(vp, `real click on #link-buy-hud centre did not reach it (got ${JSON.stringify(got)})`);
        else if (hit.href !== PAID_HUD) fail(vp, `#link-buy-hud href drifted: ${hit.href}`);
        row.paidHudClick = hit ? hit.href : null;
      }

      // Dialog: click a loaded, uncovered god for real (re-measured just before the click: gods walk);
      // card must open below the HUD with close + choice reachable.
      let god = null, open = false;
      for (let attempt = 0; attempt < 3 && !open; attempt++) {
        const now = (await ev(pageMeasure, [])).gods.filter((g) => g.clear && g.loaded);
        god = now[attempt % Math.max(1, now.length)];
        if (!god) break;
        await click(god.x, god.y);
        open = await until(() => ev(() => !document.getElementById('dialog').hidden), 1500, 'dialog open').catch(() => false);
      }
      if (!god) fail(vp, 'no loaded uncovered god to open a dialog on');
      else {
        if (!open) fail(vp, `clicking god ${god.id} at ${god.x},${god.y} did not open the dialog (3 attempts)`);
        else {
          await until(() => ev(() => document.querySelectorAll('#dlg-choices .choice').length > 0), 3000, 'dialog choices');
          if (await ev(() => document.getElementById('dialog').contains(document.activeElement))) fail(vp, 'pointer-opened dialog pulled focus into the card (pointer path must stay unchanged)');
          const d = await ev(pagePanel, '#dialog', ['.dialog-x', '.choice']);
          row.dialog = d;
          if (d.rect.y < d.hudBottom - TOL) fail(vp, `dialog top ${d.rect.y} is under the HUD (bottom ${Math.round(d.hudBottom)})`);
          if (!d.inside) fail(vp, `dialog clipped by viewport rect=${JSON.stringify(d.rect)}`);
          for (const [p, v] of Object.entries(d.parts)) if (!v || !v.inside || !v.hitOk) fail(vp, `dialog ${p} not reachable (${v ? v.hitWhat : 'missing'})`);
          await shot('dialog-' + vp);
          const x = d.parts['.dialog-x'];
          if (x && x.hitOk) await click(x.x, x.y);
          const closed = await until(() => ev(() => document.getElementById('dialog').hidden), 3000, 'dialog close').catch(() => false);
          if (!closed) fail(vp, 'dialog close button did not close it');
        }
      }

      // Upsell: open via the real GET THE FULL GAME click; close + paid CTA must be reachable (internal scroll allowed).
      const full = m.controls['btn-full'];
      if (full && full.shown && full.hitOk) {
        await click(full.rect.x + full.rect.w / 2, full.rect.y + full.rect.h / 2);
        const up = await ev(pagePanel, '#upsell', ['.upsell-x', '#link-buy']);
        if (!up) fail(vp, 'GET THE FULL GAME click did not open #upsell');
        else {
          row.upsell = up;
          if (!up.inside) fail(vp, `upsell clipped by viewport rect=${JSON.stringify(up.rect)}`);
          if (up.rect.y < up.hudBottom - TOL) fail(vp, `upsell top ${up.rect.y} is under the HUD (bottom ${Math.round(up.hudBottom)})`);
          let cta = up.parts['#link-buy'];
          if (cta && !cta.hitOk) { // user can scroll the card: emulate that, then re-measure
            await ev(() => document.getElementById('link-buy').scrollIntoView({ block: 'nearest' }));
            cta = (await ev(pagePanel, '#upsell', ['#link-buy'])).parts['#link-buy'];
          }
          if (!cta || !cta.inside || !cta.hitOk) fail(vp, `upsell paid CTA not reachable (${cta ? cta.hitWhat : 'missing'})`);
          else {
            await trap();
            await click(cta.x, cta.y);
            const got = await trap();
            const hit = got.find((g) => g.anchor === 'link-buy' && g.trusted);
            if (!hit) fail(vp, `real click on upsell #link-buy did not reach it (got ${JSON.stringify(got)})`);
            else if (hit.href !== PAID_UPSELL) fail(vp, `upsell #link-buy href drifted: ${hit.href}`);
          }
          await shot('upsell-' + vp);
          const x = (await ev(pagePanel, '#upsell', ['.upsell-x'])).parts['.upsell-x'];
          if (!x || !x.inside || !x.hitOk) fail(vp, `upsell close not reachable (${x ? x.hitWhat : 'missing'})`);
          else await click(x.x, x.y);
          if (!(await ev(() => document.getElementById('upsell').hidden))) {
            fail(vp, 'upsell did not close');
            await ev(() => { document.getElementById('upsell').hidden = true; });
          }
        }
      }
      // Keyboard crew comms: geometry (feed, not HUD), exact roster, then a real Tab/Arrow/Enter|Space walk.
      const k = await ev(pageMeasure, COMMS);
      row.comms = k.controls;
      for (const id of COMMS) {
        const c = k.controls[id];
        if (!c) { fail(vp, `#${id} MISSING from the DOM`); continue; }
        if (!c.shown) { fail(vp, `#${id} not visible (${c.why})`); continue; }
        if (!c.inside) fail(vp, `#${id} OFFSCREEN/clipped rect=${JSON.stringify(c.rect)}`);
        if (c.rect.w < MIN_TARGET || c.rect.h < MIN_TARGET) fail(vp, `#${id} target ${c.rect.w}x${c.rect.h} < ${MIN_TARGET}x${MIN_TARGET}`);
        if (!c.hitOk) fail(vp, `#${id} centre is covered by "${c.hitWhat}" (elementFromPoint)`);
        if (c.font < MIN_FONT) fail(vp, `#${id} font ${c.font}px < ${MIN_FONT}px`);
      }
      if (k.controls['btn-talk'] && k.controls['btn-talk'].rect.w < MIN_TALK_W) fail(vp, `#btn-talk width ${k.controls['btn-talk'].rect.w} < ${MIN_TALK_W}`);
      const roster = await ev(() => {
        const sel = document.getElementById('crew-select');
        const cast = ((window.EOG_BANTER && EOG_BANTER.cast) || []).map((c) => [c.id, c.name.toUpperCase()]);
        const opts = sel ? [...sel.options].map((o) => [o.value, o.textContent]) : [];
        return { cast, opts };
      });
      if (roster.opts.length !== 13 || JSON.stringify(roster.opts) !== JSON.stringify(roster.cast)) fail(vp, `#crew-select roster != the 13-god cast (${JSON.stringify(roster.opts.map((o) => o[0]))})`);
      if (k.controls['crew-select'] && k.controls['btn-talk']) {
        row.keyboard = await keyboardTalk(vp, VIEWPORTS.findIndex(([a, b]) => a === w && b === h) % 2 === 1);
        if (vp === ROSTER_VP) row.roster = await keyboardRoster(vp, roster.cast.map((c) => c[0]));
      }
      const n = failures.filter((f) => f.startsWith(vp + ' ')).length;
      return `${n ? 'FAIL' : 'ok  '} ${vp.padEnd(9)} hud=${Math.round(m.hudBottom)}px gods clear ${clear.length}/13${n ? '  (' + n + ' issue' + (n > 1 ? 's' : '') + ')' : ''}`;
  }

  // Tab to the roster, Arrow changes the selection (and opens nothing), Tab to TALK, Enter/Space opens
  // THAT god's existing dialogue with focus on its first choice; Tab + Enter advances to the next node
  // with focus on its first choice; Escape closes and returns focus to TALK.
  async function keyboardTalk(vp, useSpace) {
    const r = { key: useSpace ? 'Space' : 'Enter' };
    try {
      r.tabs = await tabTo('crew-select');
      if (!r.tabs) { fail(vp, `keyboard: ${MAX_TABS} real Tab presses never reached #crew-select`); return r; }
      const f0 = await focusInfo(), s0 = await ev(() => __eogdemo.stats());
      const dir = f0.selIdx < 12 ? 'ArrowDown' : 'ArrowUp';
      await key(dir);
      const f1 = await focusInfo(), s1 = await ev(() => __eogdemo.stats());
      if (f1.id !== 'crew-select' || f1.selIdx !== f0.selIdx + (dir === 'ArrowDown' ? 1 : -1)) fail(vp, `keyboard: ${dir} on #crew-select did not move the selection (${f0.selIdx} -> ${f1.selIdx}, focus ${f1.id})`);
      if (s1.dialogOpen || s1.dialogsOpened !== s0.dialogsOpened) fail(vp, 'keyboard: changing #crew-select opened a dialogue (select must only select)');
      r.god = f1.sel;
      await key('Tab');
      if ((await focusInfo()).id !== 'btn-talk') { fail(vp, 'keyboard: Tab from #crew-select did not reach #btn-talk'); return r; }
      await key(useSpace ? ' ' : 'Enter');
      const opened = await until(() => ev((g) => __eogdemo.stats().dialogGod === g, f1.sel), 2000, 'keyboard dialogue').catch(() => false);
      if (!opened) { fail(vp, `keyboard: ${r.key} on #btn-talk did not open ${f1.sel}'s dialogue`); return r; }
      if ((await ev(() => __eogdemo.stats().dialogsOpened)) !== s0.dialogsOpened + 1) fail(vp, 'keyboard: TALK did not count exactly one dialogue');
      let f = await focusInfo();
      if (f.dlgChoice !== 0) { fail(vp, `keyboard: first dialogue choice not focused after TALK (focus ${f.id})`); return r; }
      if (f.dlgN < 2) { fail(vp, `keyboard: ${f1.sel} start node has ${f.dlgN} choice(s), need 2 to prove Tab`); return r; }
      await key('Tab');
      if ((await focusInfo()).dlgChoice !== 1) { fail(vp, 'keyboard: native Tab did not move from choice 1 to choice 2'); return r; }
      const c0 = await ev(() => __eogdemo.stats().choicesMade);
      await key('Enter');
      const advanced = await until(() => ev((n) => __eogdemo.stats().choicesMade > n, c0), 1500, 'keyboard choice').catch(() => false);
      if (!advanced) { fail(vp, 'keyboard: Enter on a dialogue choice did not advance the dialogue'); return r; }
      f = await focusInfo();
      if (!(await dlgOpen()) || f.dlgChoice !== 0) fail(vp, `keyboard: focus not on the next node's first choice (focus ${f.id})`);
      await key('Escape');
      const closed = await until(() => ev(() => document.getElementById('dialog').hidden), 1500, 'keyboard close').catch(() => false);
      if (!closed) fail(vp, 'keyboard: Escape did not close the dialogue');
      else if ((f = await focusInfo()).id !== 'btn-talk') fail(vp, `keyboard: focus not restored to #btn-talk after Escape (on ${f.id})`);
      r.ok = true;
      return r;
    } finally {
      if (await dlgOpen()) await key('Escape'); // never leave a card over the next viewport's measure
    }
  }

  // All 13 roster identities by keyboard (from #btn-talk): Shift+Tab, Arrow, Tab, Enter, Escape.
  // God 1 also proves: Escape on the select leaves the open dialogue alone, and TALK over an open
  // dialogue switches cleanly (focus lands once on the new first choice).
  async function keyboardRoster(vp, ids) {
    const seen = [];
    try {
      await key('Tab', true);
      let f = await focusInfo();
      if (f.id !== 'crew-select') { fail(vp, `roster: Shift+Tab from #btn-talk did not reach #crew-select (${f.id})`); return seen; }
      for (let n = 0; n < 13 && f.selIdx > 0; n++) { await key('ArrowUp'); f = await focusInfo(); }
      for (let i = 0; i < ids.length; i++) {
        if (i) { await key('ArrowDown'); f = await focusInfo(); }
        if (f.selIdx !== i || f.sel !== ids[i]) { fail(vp, `roster: selection ${f.selIdx}/${f.sel}, wanted ${i}/${ids[i]}`); return seen; }
        await key('Tab');
        if ((await focusInfo()).id !== 'btn-talk') { fail(vp, 'roster: Tab did not reach #btn-talk'); return seen; }
        await key('Enter');
        if (!(await until(() => ev((g) => __eogdemo.stats().dialogGod === g, ids[i]), 2000, 'roster dialogue').catch(() => false))) { fail(vp, `roster: ${ids[i]} did not open by keyboard`); return seen; }
        if ((await focusInfo()).dlgChoice !== 0) fail(vp, `roster: ${ids[i]} first choice not focused`);
        if (i === 0) {
          for (let n = 0; n < 4 && (await focusInfo()).id !== 'crew-select'; n++) await key('Tab', true);
          if ((await focusInfo()).id !== 'crew-select') fail(vp, 'roster: Shift+Tab from the dialogue never reached #crew-select');
          else {
            await key('Escape');
            if (!(await dlgOpen())) fail(vp, 'roster: Escape on #crew-select closed the unrelated dialogue');
            await key('Tab');
            const before = await ev(() => __eogdemo.stats().dialogsOpened);
            await key('Enter'); // TALK over the open card: switch, no double restore
            await sleep(60);
            const s = await ev(() => __eogdemo.stats());
            if (!s.dialogOpen || s.dialogGod !== ids[0] || s.dialogsOpened !== before + 1 || (await focusInfo()).dlgChoice !== 0) fail(vp, 'roster: TALK over an open dialogue did not switch with focus on the new first choice');
          }
        }
        seen.push((await ev(() => __eogdemo.stats())).dialogGod);
        await key('Escape');
        if ((await focusInfo()).id !== 'btn-talk') fail(vp, `roster: focus not back on #btn-talk after closing ${ids[i]}`);
        await key('Tab', true);
        f = await focusInfo();
      }
      if (JSON.stringify(seen) !== JSON.stringify(ids)) fail(vp, `roster: keyboard opened ${JSON.stringify(seen)} != cast ${JSON.stringify(ids)}`);
      return seen;
    } finally {
      if (await dlgOpen()) await key('Escape');
    }
  }

  // During the first live event: Tab to TALK, Enter -> refusal status, no dialogue/stat, focus on event choice 1.
  async function keyboardRefusal() {
    const s0 = await ev(() => __eogdemo.stats());
    const tabs = await tabTo('btn-talk');
    if (!tabs) { fail('', `keyboard: ${MAX_TABS} real Tab presses never reached #btn-talk`); return null; }
    await key('Enter');
    await sleep(80);
    const s1 = await ev(() => __eogdemo.stats()), f = await focusInfo();
    const status = await ev(() => { const t = document.getElementById('toast'); return t && !t.hidden && t.getAttribute('role') === 'status' ? t.textContent : null; });
    if (!s1.eventActive || s1.eventsFired !== s0.eventsFired) {
      if (s1.dialogOpen) await key('Escape');
      throw new Incomplete('the first station event ended before the keyboard TALK refusal could be checked');
    }
    report.refusal = { tabs, status, focus: f.id, evChoice: f.evChoice };
    if (s1.dialogOpen || s1.dialogsOpened !== s0.dialogsOpened) fail('', 'keyboard: TALK during a station event opened/counted a dialogue');
    if (!status) fail('', 'keyboard: TALK during a station event gave no visible role=status refusal');
    if (f.evChoice !== 0) fail('', `keyboard: TALK during a station event did not hand focus to the first event choice (on ${f.id})`);
    // the status must not sit over the event card the viewport pass measures next
    await until(() => ev(() => document.getElementById('toast').hidden), 6000, 'refusal status to clear');
    return { eventsFired: s1.eventsFired };
  }

  // A REAL event firing over a keyboard-focused dialogue takes focus to its first choice; resolving it
  // by keyboard returns focus to the still-open dialogue. Waits for the next real event (timing untouched).
  async function keyboardEventOverDialogue() {
    const vp = 'event-over-dialogue';
    try {
      if (!(await tabTo('btn-talk'))) { fail(vp, `${MAX_TABS} real Tab presses never reached #btn-talk`); return; }
      await key('Enter');
      if (!(await until(dlgOpen, 2000, 'keyboard dialogue').catch(() => false)) || (await focusInfo()).dlgChoice !== 0) { fail(vp, 'keyboard dialogue did not open with focus on choice 1'); return; }
      const r0 = await ev(() => __eogdemo.stats().eventsResolved);
      await until(() => ev(() => !!__eogdemo.stats().eventActive), 100000, 'a station event over the dialogue');
      await sleep(80);
      let f = await focusInfo();
      if (f.evChoice !== 0) { fail(vp, `event did not take focus from the keyboard dialogue (on ${f.id})`); return; }
      await key('Enter');
      if (!(await until(() => ev((n) => __eogdemo.stats().eventsResolved > n, r0), 2000, 'keyboard event resolve').catch(() => false))) { fail(vp, 'Enter on the event choice did not resolve it'); return; }
      f = await focusInfo();
      if (!(await dlgOpen()) || f.dlgChoice !== 0) fail(vp, `focus not restored to the open dialogue after the event (on ${f.id})`);
      report.eventOverDialogue = f.id || f.dlgChoice;
    } finally {
      if (await dlgOpen()) await key('Escape');
    }
  }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.log('INCOMPLETE: ' + e.message); return 2; }
  opts.out = opts.out || path.join(scratchRoot(), 'eog-hud-' + process.pid + '-' + Date.now());
  try {
    const site = realCandidate(opts.site), out = realCandidate(opts.out);
    const rel = path.relative(site, out);
    if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw new Incomplete('--out must be outside the serving tree');
    fs.mkdirSync(opts.out, { recursive: true });
  } catch (e) { console.log('INCOMPLETE: ' + e.message); return 2; }
  const timer = setTimeout(async () => {
    console.log('INCOMPLETE: watchdog ' + WATCHDOG_MS + 'ms');
    const hard = setTimeout(() => process.exit(2), 10000);
    await emergencyCleanup(); clearTimeout(hard); process.exit(2);
  }, WATCHDOG_MS);
  let report, code;
  try {
    report = await run(opts);
    code = report.failures.length ? 1 : 0;
  } catch (e) {
    report = { incomplete: e.message };
    console.log('INCOMPLETE: ' + (e instanceof Incomplete ? e.message : (e && e.stack) || e));
    code = 2;
  }
  clearTimeout(timer);
  fs.writeFileSync(path.join(opts.out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
  if (code === 1) for (const f of report.failures) console.log('FAIL: ' + f);
  if (code !== 2) console.log(`${code ? 'GATE CLOSED' : 'GATE OPEN'} (${VIEWPORTS.length} viewports, ${report.failures.length} failure(s)); report: ${path.join(opts.out, 'report.json')}`);
  return code;
}

process.exit(await main());
