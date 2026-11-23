// Unit tests for local.js, apple.js wrapper, CLI option edge cases, and bin/ entrypoints (offline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appleMaps, AppleMapsError } from '../src/apple.js';
import { main, parseCli, UsageError, VERSION } from '../src/cli.js';
import { distanceMeters, findMiddleLocally, LocalSearchError, midpointOf, placesRequest, radiusSteps, rank } from '../src/local.js';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json version matches CLI VERSION', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('parseCli validates --source, --url, --days, --radius and --country', () => {
  const parsed = parseCli(['Richmond', 'Kingston', 'cafés', '--country=gb', '--radius=2000', '--title=Coffee', '--json', '--open'], {});
  assert.deepEqual(parsed.body, { from: ['Richmond', 'Kingston'], what: 'cafés', country: 'gb', radiusM: 2000, title: 'Coffee' });
  assert.equal(parsed.json, true);
  assert.equal(parsed.open, true);

  assert.throws(() => parseCli(['A', 'B', '--source=google'], {}), UsageError);
  assert.throws(() => parseCli(['A', 'B', '--url=not-a-url'], {}), UsageError);
  assert.throws(() => parseCli(['A', 'B', '--days=0'], {}), UsageError);
  assert.throws(() => parseCli(['A', 'B', '--days=91'], {}), UsageError);
  assert.throws(() => parseCli(['A', 'B', '--radius=1.5'], {}), UsageError);
});

test('local.js geometry, radiusSteps, deduplication and validation', async () => {
  assert.equal(Math.round(distanceMeters({ lat: 51.5, lng: -0.1 }, { lat: 51.5, lng: -0.1 })), 0);
  assert.deepEqual(midpointOf([{ lat: 51.4, lng: -0.2 }, { lat: 51.6, lng: 0.0 }]), { lat: 51.5, lng: -0.1 });
  assert.deepEqual(radiusSteps(1000), [1000, 2000, 4000]);
  assert.deepEqual(radiusSteps(2000), [2000, 4000, 5000]);
  assert.deepEqual(radiusSteps(5000), [5000]);

  const middle = { lat: 51.5, lng: -0.1 };
  const ranked = rank([
    { name: 'Far', lat: 51.6, lng: -0.1 },
    { name: 'Spot', lat: 51.5005, lng: -0.1, address: '1 High St' },
    { name: 'spot', lat: 51.5006, lng: -0.1 },
    { name: 'Second', lat: 51.502, lng: -0.1 },
  ], middle, [{ lat: 51.45, lng: -0.15 }], 1000, 5);
  assert.deepEqual(ranked.map((p) => p.name), ['Spot', 'Second']);
  assert.equal(ranked[0].address, '1 High St');

  const unusedMaps = {
    geocode: async () => { throw new Error('should not geocode coordinates'); },
    reverse: async () => null,
    search: async () => [{ name: 'A', lat: 51.5, lng: -0.1 }, { name: 'B', lat: 51.501, lng: -0.1 }],
  };
  await assert.rejects(() => findMiddleLocally({ from: ['A', 'B'], count: 1 }, unusedMaps), LocalSearchError);
  await assert.rejects(() => findMiddleLocally({ from: ['A', 'B'], count: 11 }, unusedMaps), LocalSearchError);
  await assert.rejects(() => findMiddleLocally({ from: ['A', 'B'], radiusM: 50 }, unusedMaps), LocalSearchError);
  await assert.rejects(() => findMiddleLocally({ from: ['A', 'B'], radiusM: 6000 }, unusedMaps), LocalSearchError);

  const coordResult = await findMiddleLocally({ from: ['51.4,-0.2', '51.6,0.0'], what: 'parks' }, unusedMaps);
  assert.equal(coordResult.midpoint.label, 'the middle');
  assert.equal(coordResult.area, null);
  const req = placesRequest(coordResult, { title: 'Meet', nickname: 'Sam', expiresIn: 86_400 });
  assert.equal('area' in req, false);
  assert.equal(req.source, 'apple_maps');
  assert.equal(req.title, 'Meet');
});

test('main falls back to ChattyMaps when Apple helper fails under --source=auto, but fails under --source=apple', async () => {
  const brokenApple = {
    available: async () => true,
    open: async () => { throw new AppleMapsError('compiler missing'); },
  };
  const err = [];
  const out = [];
  let calledFetch = false;
  const streams = {
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    env: {},
    apple: brokenApple,
    fetch: async () => {
      calledFetch = true;
      return Response.json({
        preview: true,
        what: { query: 'pubs', label: 'Pubs', unchecked: [] },
        midpoint: { lat: 51.52, lng: -0.08, label: 'Hoxton' },
        radiusM: 1000,
        spreadM: 15_000,
        startingPoints: [{ name: 'A', lat: 51.46, lng: -0.14 }, { name: 'B', lat: 51.58, lng: -0.02 }],
        candidates: [],
      });
    },
  };

  assert.equal(await main(['A', 'B', 'pubs', '--preview'], streams), 0);
  assert.equal(calledFetch, true);
  assert.match(err.join(''), /Using ChattyMaps to find places instead/);

  const errStrict = [];
  assert.equal(await main(['A', 'B', 'pubs', '--source=apple', '--preview'], { ...streams, err: { write: (s) => errStrict.push(s) } }), 1);
  assert.match(errStrict.join(''), /compiler missing/);
});

test('appleMaps wrapper serializes arguments and parses JSON responses and errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chattymaps-middle-test-'));
  const fakeBin = join(dir, 'fake-helper');
  writeFileSync(fakeBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[1] === 'FAIL') {
  process.stdout.write(JSON.stringify({ error: 'boom from helper' }) + '\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ args }) + '\\n');
`);
  chmodSync(fakeBin, 0o755);

  try {
    const maps = await appleMaps({ binary: fakeBin });
    assert.deepEqual((await maps.geocode('Clapham')).args, ['geocode', 'Clapham']);
    assert.deepEqual((await maps.geocode('Richmond', 'gb')).args, ['geocode', 'Richmond', 'gb']);
    assert.deepEqual((await maps.geocode('Kingston', 'gb', { lat: 51.46, lng: -0.3 })).args, ['geocode', 'Kingston', 'gb', '51.46', '-0.3']);
    assert.deepEqual((await maps.geocode('Kingston', undefined, { lat: 51.46, lng: -0.3 })).args, ['geocode', 'Kingston', '', '51.46', '-0.3']);
    assert.deepEqual((await maps.search('pubs', { lat: 51.5, lng: -0.1 }, 1000)).args, ['search', 'pubs', '51.5', '-0.1', '1000']);
    assert.deepEqual((await maps.reverse({ lat: 51.5, lng: -0.1 })).args, ['reverse', '51.5', '-0.1']);
    assert.deepEqual((await maps.locate()).args, ['locate']);
    await assert.rejects(() => maps.geocode('FAIL'), (err) => err instanceof AppleMapsError && err.message === 'boom from helper');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bin/middle.js and bin/middle-with-me.js exit cleanly for --help, --version and bad usage', async () => {
  const help = await run(process.execPath, [join(ROOT, 'bin/middle.js'), '--help']);
  assert.match(help.stdout, /^middle —/);

  const ver = await run(process.execPath, [join(ROOT, 'bin/middle.js'), '--version']);
  assert.equal(ver.stdout.trim(), VERSION);

  const helpMe = await run(process.execPath, [join(ROOT, 'bin/middle-with-me.js'), '--help']);
  assert.match(helpMe.stdout, /^middle-with-me —/);

  await assert.rejects(
    () => run(process.execPath, [join(ROOT, 'bin/middle.js'), 'OnlyOne']),
    (err) => err.code === 2 && /at least two starting places/i.test(err.stderr),
  );
});
