#!/usr/bin/env node
// Mutation proof for the keyboard crew comms (R-EOG35).
//
//   node _verify_keyboard_dialogue.mjs            static: source invariants PASS clean, FAIL each mutant
//   node _verify_keyboard_dialogue.mjs --browser  also runs check_responsive_hud.mjs on scratch COPIES
//                                                 (clean -> 0, each mutant -> 1 naming the cause), ONE
//                                                 browser at a time; production bytes hashed before/after.
// Exit 0 = every expectation met, 1 = an expectation failed, 2 = incomplete.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let SCRATCH = process.env.HUD_SCRATCH_DIR || (process.env.HERMES_HOME && path.join(process.env.HERMES_HOME, 'cache', 'scratch')) || process.env.TMPDIR || os.tmpdir();
if (process.platform === 'win32') SCRATCH = SCRATCH.replace(/^\/([a-z])\//i, (_, d) => d.toUpperCase() + ':/');
const GATE = 'check_responsive_hud.mjs';
const SITE = ['index.html', 'css', 'js', 'data', 'assets', GATE];
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

/* ---------- static invariants (no browser) ---------- */
function staticCheck(html, js) {
  const bad = [];
  const feed = (html.match(/<aside id="feed"[\s\S]*?<\/aside>/) || [''])[0];
  if (!/<select id="crew-select"/.test(feed)) bad.push('select#crew-select not in the feed');
  if (!/<button id="btn-talk"[^>]*type="button"/.test(feed)) bad.push('button#btn-talk (type=button) not in the feed');
  if (!/<label[^>]*for="crew-select"[^>]*>Choose a god to talk to<\/label>/.test(feed)) bad.push('select label missing');
  if (feed.indexOf('id="crew-select"') > feed.indexOf('id="feed-list"') || feed.indexOf('id="btn-talk"') > feed.indexOf('id="feed-list"')) bad.push('controls not before #feed-list');
  if (/<aside[^>]*aria-live/.test(feed) || !/<ol id="feed-list" aria-live="polite">/.test(feed)) bad.push('aria-live not moved from the aside to #feed-list');
  if (/crew-select|btn-talk/.test((html.match(/<header class="hud">[\s\S]*?<\/header>/) || [''])[0])) bad.push('roster controls leaked into the HUD');
  if (!/BANTER\.cast\.forEach\(function \(c\) \{\s*if \(!byId\[c\.id\]\) return;[\s\S]{0,200}crewSel\.appendChild\(o\)/.test(js)) bad.push('roster not populated once from BANTER.cast/byId');
  if (!/btnTalk\.addEventListener\('click',[\s\S]{0,400}openDialog\(b, clock\.now, btnTalk\)/.test(js)) bad.push('TALK listener does not call openDialog(selected, clock.now, btnTalk)');
  if (!/if \(activeEvent\) \{ toast\([\s\S]{0,120}handEventFocus\(btnTalk\); return; \}/.test(js)) bad.push('TALK during an event is not refused/handed off');
  if (/crewSel\.addEventListener\('(change|input)'/.test(js)) bad.push('select change auto-opens');
  if (!/if \(focusFirst && dlgChoices\.firstChild\) dlgChoices\.firstChild\.focus\(\);/.test(js)) bad.push('first new choice is not focused in showNode');
  if (!/if \(opener && owned && !keepFocus\)/.test(js)) bad.push('closeDialog does not restore focus to the opener');
  if (!/if \(dlg\) closeDialog\(now, true\);/.test(js)) bad.push('switching gods would double-restore focus');
  if (!/e\.key === 'Escape' && e\.target !== crewSel/.test(js)) bad.push('Escape on the select closes the dialogue');
  if (!/if \(back && owned\)/.test(js) || !/if \(dlg && dlgEl\.contains\(document\.activeElement\)\) handEventFocus/.test(js)) bad.push('event focus handoff/restore missing');
  if (!/setTimeout\(function \(\) \{ if \(!upsellShown && !dlg\) openUpsell\(\); \}, 75000\);/.test(js)) bad.push('75 s upsell guard changed');
  if (/aria-modal/.test(html)) bad.push('aria-modal introduced');
  if (/fetch\(|localStorage|sessionStorage|XMLHttpRequest/.test(js)) bad.push('network/storage call introduced');
  return bad;
}

const MUTANTS = [
  { name: 'select removed', file: 'index.html', from: /<select id="crew-select"[^>]*><\/select>/, expect: 2, gate: /INCOMPLETE/ }, // boot breaks: never a pass
  { name: 'TALK listener lost', file: 'js/demo.js', from: "btnTalk.addEventListener('click', function () {", to: "btnTalk.addEventListener('x-none', function () {", gate: /did not open .*dialogue/ },
  { name: 'first-choice focus lost', file: 'js/demo.js', from: 'if (focusFirst && dlgChoices.firstChild) dlgChoices.firstChild.focus();', to: '', gate: /first (dialogue )?choice not focused/ },
  { name: 'close focus restore lost', file: 'js/demo.js', from: 'if (opener && owned && !keepFocus)', to: 'if (false)', gate: /focus not (restored to|back on) #btn-talk/ },
  { name: 'select change auto-opens', file: 'js/demo.js', from: "  // choosing only selects;", to: "  crewSel.addEventListener('change', function () { btnTalk.click(); });\n  // choosing only selects;", gate: /changing #crew-select opened a dialogue/ },
];
function applyMut(src, m) {
  const out = src.replace(m.from, m.to === undefined ? '' : m.to);
  if (out === src) throw new Error('mutation did not apply: ' + m.name);
  return out;
}

function digest() {
  const h = crypto.createHash('sha256');
  const walk = (p) => { const st = fs.statSync(p); if (st.isDirectory()) fs.readdirSync(p).sort().forEach((n) => walk(path.join(p, n))); else { h.update(path.relative(HERE, p).replace(/\\/g, '/') + '\0'); h.update(fs.readFileSync(p)); } };
  for (const top of SITE) walk(path.join(HERE, top));
  return h.digest('hex');
}
function runGate(dir) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [path.join(dir, GATE), '--site', dir, '--out', dir + '-report', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => ok({ code, out }));
  });
}

async function main() {
  let bad = 0, incomplete = 0;
  const html = read('index.html'), js = read('js/demo.js');
  const clean = staticCheck(html, js);
  console.log(`${clean.length ? 'BAD ' : 'ok  '} static clean tree${clean.length ? ': ' + clean.join('; ') : ''}`);
  if (clean.length) bad++;
  for (const m of MUTANTS) {
    let got;
    try { got = staticCheck(m.file === 'index.html' ? applyMut(html, m) : html, m.file === 'js/demo.js' ? applyMut(js, m) : js); }
    catch (e) { incomplete++; bad++; console.log('INCOMPLETE ' + e.message); continue; }
    console.log(`${got.length ? 'ok  ' : 'BAD '} static mutant "${m.name}" ${got.length ? 'fails: ' + got[0] : 'PASSED (should fail)'}`);
    if (!got.length) bad++;
  }
  if (process.argv.includes('--browser')) {
    const h0 = digest();
    const base = fs.mkdtempSync(path.join(SCRATCH, 'eog-kbd-verify-'));
    try {
      const cases = [{ name: 'clean copy', expect: 0 }, ...MUTANTS.map((m) => ({ expect: 1, ...m }))];
      for (const [i, c] of cases.entries()) {
        const dir = path.join(base, 'k' + i);
        for (const top of SITE) fs.cpSync(path.join(HERE, top), path.join(dir, top), { recursive: true });
        if (c.file) fs.writeFileSync(path.join(dir, c.file), applyMut(fs.readFileSync(path.join(dir, c.file), 'utf8'), c));
        console.log('running: ' + c.name);
        const { code, out } = await runGate(dir); // ONE browser at a time
        const named = !c.gate || c.gate.test(out);
        const ok = code === c.expect && named;
        if (!ok) { bad++; if (code === 2) incomplete++; }
        console.log(`${ok ? 'ok  ' : 'BAD '} gate ${c.name}: exit ${code} (want ${c.expect})${named ? '' : ' - cause NOT named'}`);
        if (!ok) console.log(out.split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
      }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
    const h1 = digest();
    console.log(`production site bytes ${h0 === h1 ? 'unchanged' : 'CHANGED'}`);
    if (h0 !== h1) bad++;
  }
  console.log(bad ? `VERIFY FAILED (${bad})` : 'VERIFY OK');
  return bad ? (incomplete && bad === incomplete ? 2 : 1) : 0;
}

process.exit(await main());
