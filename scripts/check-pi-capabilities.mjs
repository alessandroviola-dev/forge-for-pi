import assert from 'node:assert/strict';
import { realpath, readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// No session, credentials, prompts, production lifecycle dispatch or model calls.
export async function checkCapabilities(sdk, root, entry) {
  for (const name of ['discoverAndLoadExtensions', 'ExtensionRunner'])
    assert.equal(typeof sdk[name], 'function', `Missing Pi API: ${name}`);
  const probe = join(root, 'probe.mjs');
  await writeFile(probe, `export default function(pi) {
    for (const name of ['on','registerTool','setActiveTools'])
      if (typeof pi[name] !== 'function') throw new Error('Missing extension API: ' + name);
    pi.on('session_start', (_, ctx) => {
      if (typeof ctx.ui.setWidget !== 'function' || typeof ctx.sessionManager.getSessionId !== 'function')
        throw new Error('Missing Forge context API');
      pi.setActiveTools(['read','bash','edit','write']);
    });
  }`);
  const loaded = await sdk.discoverAndLoadExtensions([probe], root, join(root, 'agent'));
  assert.deepEqual(loaded.errors, [], 'Probe registration failed');
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, root, { getSessionId: () => 'offline' }, {});
  let active;
  runner.bindCore({ setActiveTools: names => { active = names; } }, {
    getModel: () => undefined, getThinkingLevel: () => 'off', isIdle: () => true,
    isProjectTrusted: () => true, getSignal: () => undefined, abort() {}, hasPendingMessages: () => false,
    shutdown() {}, getContextUsage() {}, compact() {}, getSystemPrompt: () => ''
  });
  await runner.emit({ type: 'session_start' });
  assert.deepEqual(active, ['read','bash','edit','write'], 'Tool activation dispatch failed');
  const actual = await sdk.discoverAndLoadExtensions([entry], root, join(root, 'agent'));
  assert.deepEqual(actual.errors, [], 'Forge factory registration failed');
  assert.equal(actual.extensions.length, 1, 'Expected exactly one Forge extension');
  assert.deepEqual([...actual.extensions[0].tools.keys()].sort(), ['edit','read']);
  assert.equal(actual.extensions[0].commands.size, 0);
  assert.equal(actual.extensions[0].flags.size, 0);
}

async function main() {
  let dir = dirname(await realpath(process.argv[2]));
  let entry;
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') {
        entry = join(dir, typeof pkg.main === 'string' ? pkg.main : 'dist/index.js'); break;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot locate Pi SDK (not a version restriction)');
    dir = parent;
  }
  const root = await mkdtemp(join(tmpdir(), 'forge-pi-capabilities-'));
  for (const key of Object.keys(process.env)) if (key.startsWith('FORGE')) delete process.env[key];
  process.env.FORGE_FOR_PI = '1';
  // Retain scratch evidence; do not dispatch Forge handlers.
  await checkCapabilities(await import(pathToFileURL(entry)), root, process.argv[3]);
  console.log('PASS: offline Forge extension capabilities');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('FAIL: Pi extension capabilities incompatible'); process.exitCode = 1; });
