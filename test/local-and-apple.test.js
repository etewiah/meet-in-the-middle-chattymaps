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

test('parseCli validates --url, --days, --radius and --country and rejects removed --source', () => {
  const parsed = parseCli(['Richmond', 'Kingston', 'cafés', '--country=gb', '--radius=2000', '--title=Coffee', '--json', '--open'], {});
  assert.deepEqual(parsed.body, { from: ['Richmond', 'Kingston'], what: 'cafés', country: 'gb', radiusM: 2000, title: 'Coffee' });
  assert.equal(parsed.json, true);
  assert.equal(parsed.open, true);

  assert.throws(() => parseCli(['A', 'B', '--source=chattymaps'], {}));
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

test('local.js falls back to starting point countryCode when reverse geocode returns null', async () => {
  const maps = {
    geocode: async (text) => ({ A: { name: 'A', lat: 51.4, lng: -0.2, countryCode: 'gb' }, B: { name: 'B', lat: 51.6, lng: 0.0, countryCode: 'gb' } }[text]),
    reverse: async () => null,
    search: async () => [{ name: 'One', lat: 51.5, lng: -0.1 }, { name: 'Two', lat: 51.501, lng: -0.1 }],
  };
  const result = await findMiddleLocally({ from: ['A', 'B'], what: 'pubs' }, maps);
  assert.deepEqual(result.area, { label: 'the middle', countryCode: 'gb' });
});

test('main fails cleanly when Apple helper fails or country cannot be determined, never calling ChattyMaps', async () => {
  const brokenApple = {
    available: async () => true,
    open: async () => { throw new AppleMapsError('compiler missing'); },
  };
  const err = [];
  const streams = {
    out: { write: () => {} },
    err: { write: (s) => err.push(s) },
    env: {},
    apple: brokenApple,
    fetch: async () => { throw new Error('ChattyMaps must not be contacted'); },
  };
  assert.equal(await main(['A', 'B', 'pubs'], streams), 1);
  assert.match(err.join(''), /compiler missing/);

  const oceanMaps = {
    geocode: async () => { throw new Error('unused'); },
    reverse: async () => null,
    search: async () => [{ name: 'Buoy 1', lat: 0, lng: 0 }, { name: 'Buoy 2', lat: 0.001, lng: 0 }],
  };
  const errOcean = [];
  assert.equal(await main(['0,0', '0.01,0.01', 'pubs'], {
    out: { write: () => {} },
    err: { write: (s) => errOcean.push(s) },
    env: {},
    apple: { available: async () => true, open: async () => oceanMaps },
    fetch: async () => { throw new Error('ChattyMaps must not be contacted without country'); },
  }), 1);
  assert.match(errOcean.join(''), /which country the middle is in/);
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
