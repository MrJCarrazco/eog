#!/usr/bin/env node
// Mutation proof for check_responsive_hud.mjs: the gate must PASS the current tree and
// FAIL (naming the cause) on known-bad trees. Every mutant is a scratch COPY under
// os.tmpdir(); production files are hashed before and after and must be byte-identical.
//
//   node _verify_responsive_hud.mjs [--keep]
//
// Cases: clean copy -> 0; pre-fix CSS (fc56d4c) -> 1 naming an offscreen control;
// paid HUD control deleted / display:none / opacity:0 / zero-size / href drifted -> 1;
// CHROME_PATH pointing at nothing -> 2 (never a pass).
// Exit 0 = every expectation met, 1 = an expectation failed, 2 = incomplete.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let SCRATCH = process.env.HUD_SCRATCH_DIR || (process.env.HERMES_HOME && path.join(process.env.HERMES_HOME, 'cache', 'scratch')) || process.env.TMPDIR || os.tmpdir();
if (process.platform === 'win32') SCRATCH = SCRATCH.replace(/^\/([a-z])\//i, (_, d) => d.toUpperCase() + ':/');
const GATE = 'check_responsive_hud.mjs';
const PREFIX_COMMIT = 'fc56d4c'; // last commit with the pre-fix single-row HUD CSS
const SITE = ['index.html', 'css', 'js', 'data', 'assets', GATE];
const PAID = 'https://mrjcarrazco.gumroad.com/l/rqaxx?utm_source=eog_demo&amp;utm_medium=hud';

function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n), out);
  else out.push(p);
  return out;
}
function digest() {
  const h = crypto.createHash('sha256');
  for (const top of SITE) for (const f of walk(path.join(HERE, top))) {
    h.update(path.relative(HERE, f).replace(/\\/g, '/') + '\0');
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex');
}
function copySite(dst) {
  for (const top of SITE) fs.cpSync(path.join(HERE, top), path.join(dst, top), { recursive: true });
}
function edit(dir, rel, fn) {
  const p = path.join(dir, rel);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error('mutation did not apply to ' + rel);
  fs.writeFileSync(p, after);
}
const appendCss = (css) => (dir) => edit(dir, 'css/demo.css', (s) => s + '\n' + css + '\n');

function runGate(dir, env, args = []) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [path.join(dir, GATE), '--site', dir, '--out', path.join(dir + '-report'), '--quiet', ...args.map((a) => a === '{site}' ? dir : a)],
      { env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => ok({ code, out }));
  });
}

const CASES = [
  { name: 'clean copy of the current tree', expect: 0 },
  { name: 'pre-fix CSS (' + PREFIX_COMMIT + ')', expect: 1, must: /FAIL: \S+ #(link-itch|link-buy-hud|btn-full) OFFSCREEN/,
    mutate: (d) => fs.writeFileSync(path.join(d, 'css/demo.css'),
      execFileSync('git', ['-C', HERE, 'show', PREFIX_COMMIT + ':css/demo.css'])) },
  { name: 'paid HUD anchor deleted', expect: 1, must: /#link-buy-hud MISSING/,
    mutate: (d) => edit(d, 'index.html', (s) => s.replace(/\s*<a id="link-buy-hud"[^\n]*<\/a>/, '')) },
  { name: 'paid HUD anchor display:none', expect: 1, must: /#link-buy-hud not visible \(display:none/,
    mutate: appendCss('#link-buy-hud { display: none !important; }') },
  { name: 'paid HUD anchor opacity:0', expect: 1, must: /#link-buy-hud not visible \(opacity/,
    mutate: appendCss('#link-buy-hud { opacity: 0 !important; }') },
  { name: 'paid HUD anchor zero-size', expect: 1, must: /#link-buy-hud target \d+(\.\d+)?x\d+(\.\d+)? < 32x32/,
    mutate: appendCss('.hud #link-buy-hud { width: 0 !important; height: 0 !important; min-height: 0 !important; padding: 0 !important; border: 0 !important; overflow: hidden !important; font-size: 0 !important; flex: none !important; }') },
  { name: 'paid HUD href drifted', expect: 1, must: /#link-buy-hud href drifted/,
    mutate: (d) => edit(d, 'index.html', (s) => s.replace(PAID, PAID.replace('utm_medium=hud', 'utm_medium=hux'))) },
  { name: 'browser missing (CHROME_PATH -> nothing)', expect: 2, must: /INCOMPLETE: CHROME_PATH is set but does not exist/,
    env: { CHROME_PATH: path.join(SCRATCH, 'no-such-browser-' + process.pid) } },
  { name: 'report inside serving tree refused before write', expect: 2, must: /--out must be outside the serving tree/,
    args: ['--out', '{site}'] },
  { name: 'existing executable is not a browser; partial launch cleaned', expect: 2, must: /browser exited at launch/,
    env: { CHROME_PATH: process.execPath } },
];

async function main() {
  const keep = process.argv.includes('--keep');
  const base = fs.mkdtempSync(path.join(SCRATCH, 'eog-hud-verify-'));
  const h0 = digest();
  let bad = 0, incomplete = 0;
  try {
    for (const [i, c] of CASES.entries()) {
      c.dir = path.join(base, 'm' + String(i).padStart(2, '0'));
      copySite(c.dir);
      try { if (c.mutate) c.mutate(c.dir); } catch (e) { c.setupError = e.message; }
    }
    // ONE browser at a time: constrained laptops can exhaust Windows process resources.
    for (const c of CASES.filter((c) => !c.setupError)) {
      console.log('running: ' + c.name);
      c.res = await runGate(c.dir, c.env, c.args);
    }
    for (const c of CASES) {
      if (c.setupError) { incomplete++; console.log(`INCOMPLETE  ${c.name}: setup failed (${c.setupError})`); continue; }
      const { code, out } = c.res;
      const named = !c.must || c.must.test(out);
      const ok = code === c.expect && named;
      if (!ok) { bad++; if (c.expect === 0 && code === 2) incomplete++; }
      const first = (out.split('\n').find((l) => (c.must ? c.must.test(l) : /GATE (OPEN|CLOSED)/.test(l))) || out.trim().split('\n').pop() || '').trim();
      console.log(`${ok ? 'ok  ' : 'BAD '} ${c.name}: exit ${code} (want ${c.expect})${named ? '' : ' - expected cause NOT named'} | ${first.slice(0, 150)}`);
      if (!ok) console.log(out.split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
    }
  } finally {
    if (!keep) fs.rmSync(base, { recursive: true, force: true });
  }
  const h1 = digest();
  console.log(`production site bytes ${h0 === h1 ? 'unchanged' : 'CHANGED'} (sha256 ${h1.slice(0, 16)})`);
  if (h0 !== h1) bad++;
  console.log(bad ? `VERIFY FAILED (${bad} case(s))` : `VERIFY OK (${CASES.length} cases)`);
  return bad ? (incomplete && bad === incomplete ? 2 : 1) : 0;
}

process.exit(await main());
