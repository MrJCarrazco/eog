#!/usr/bin/env node
// Small source-level fault injection: no browser, network, clone or existing scratch touched.
// Run: node --test _verify_hud_lifecycle.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(HERE, 'check_responsive_hud.mjs'), 'utf8');
// Exercise the actual production launch function without starting main or exporting test APIs.
const launchSource = source.slice(source.indexOf('async function launch(chrome) {'), source.indexOf('/* ---------- in-page measurement'));
assert.match(launchSource, /^async function launch\(chrome\)/);
let base = process.env.HUD_SCRATCH_DIR || (process.env.HERMES_HOME && path.join(process.env.HERMES_HOME, 'cache', 'scratch')) || process.env.TMPDIR || os.tmpdir();
if (process.platform === 'win32') base = base.replace(/^\/([a-z])\//i, (_, d) => d.toUpperCase() + ':/');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(fs.existsSync(base) ? base : os.tmpdir(), 'eog-lifecycle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sandbox = {
    fs: Object.assign({}, fs, overrides.fs), path,
    scratchRoot: () => root,
    process: { platform: process.platform, env: {} },
    spawn: () => { throw new Error('injected spawn resource exhaustion'); },
    execFileSync: () => { throw new Error('unexpected process termination'); },
    sleep: async () => {},
    until: async (fn, _ms, what) => {
      await Promise.resolve();
      const value = await fn();
      if (!value) throw new Error('injected timeout waiting for ' + what);
      return value;
    },
    Incomplete: class Incomplete extends Error {},
    emergencyCleanup: async () => {},
    ...overrides,
  };
  // fs overrides wrap the real fs, retaining actual owned-directory allocation/removal.
  sandbox.fs = Object.assign({}, fs, overrides.fs);
  vm.runInNewContext(launchSource, sandbox);
  return { root, sandbox };
}

test('synchronous spawn failure releases its newly allocated profile', async (t) => {
  const { root, sandbox } = fixture(t);
  await assert.rejects(sandbox.launch('fake-browser'), /injected spawn resource exhaustion/);
  assert.deepEqual(fs.readdirSync(root), [], 'spawn failure leaked an owned browser profile');
});

test('asynchronous launch error releases its profile', async (t) => {
  const { root, sandbox } = fixture(t, {
    spawn: () => ({ exitCode: null, pid: undefined, on(event, fn) {
      if (event === 'error') queueMicrotask(() => fn(new Error('injected async launch failure')));
    } }),
  });
  await assert.rejects(sandbox.launch('fake-browser'), /browser exited at launch \(injected async launch failure\)/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('DevTools startup timeout releases its profile', async (t) => {
  const { root, sandbox } = fixture(t, {
    spawn: () => ({ exitCode: 1, on() {} }),
  });
  await assert.rejects(sandbox.launch('fake-browser'), /injected timeout waiting for DevToolsActivePort/);
  assert.deepEqual(fs.readdirSync(root), []);
});

function readySpawn(_chrome, args) {
  const profile = args.find((a) => a.startsWith('--user-data-dir=')).split('=').slice(1).join('=');
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/test\n');
  return { exitCode: 0, on() {} }; // fake already-reaped child; never terminate a real process
}

test('CDP connection failure releases the partially launched profile', async (t) => {
  const { root, sandbox } = fixture(t, {
    spawn: readySpawn,
    CDP: { open: async () => { throw new Error('injected CDP connection failure'); } },
  });
  await assert.rejects(sandbox.launch('fake-browser'), /injected CDP connection failure/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('normal and emergency cleanup share one release and preserve report evidence', async (t) => {
  const events = [];
  let removes = 0;
  const { root, sandbox } = fixture(t, {
    spawn: readySpawn,
    CDP: { open: async () => ({
      send: async (method) => events.push(method),
      close: () => events.push('cdp.close'),
    }) },
    fs: { rmSync: (...args) => { removes++; return fs.rmSync(...args); } },
    emergencyCleanup: async () => events.push('server.close'),
  });
  const evidence = path.join(root, 'report.json');
  fs.writeFileSync(evidence, '{"retained":true}\n');
  const browser = await sandbox.launch('fake-browser');
  assert.equal(fs.readdirSync(root).filter((n) => n.startsWith('eog-hud-profile-')).length, 1);
  await browser.cleanup();
  await sandbox.emergencyCleanup();
  await browser.cleanup();
  assert.deepEqual(events, ['Browser.close', 'cdp.close', 'server.close']);
  assert.equal(removes, 1);
  assert.deepEqual(fs.readdirSync(root), ['report.json']);
  assert.equal(fs.readFileSync(evidence, 'utf8'), '{"retained":true}\n');
});

test('transient Windows profile lock is retried without touching sibling reports', async (t) => {
  let attempts = 0;
  const { root, sandbox } = fixture(t, {
    fs: { rmSync: (...args) => {
      if (++attempts <= 2) throw Object.assign(new Error('injected profile lock'), { code: 'EBUSY' });
      return fs.rmSync(...args);
    } },
  });
  await assert.rejects(sandbox.launch('fake-browser'), /injected spawn resource exhaustion/);
  assert.equal(attempts, 3);
  assert.deepEqual(fs.readdirSync(root), []);
});
