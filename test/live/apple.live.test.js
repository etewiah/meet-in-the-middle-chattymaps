// Live Apple Maps integration tests + README example verification.
// Run explicitly with `npm run test:live` (macOS + network required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appleMaps, appleMapsAvailable } from '../../src/apple.js';
import { main } from '../../src/cli.js';
import { distanceMeters } from '../../src/local.js';

const hasSwift = await appleMapsAvailable();
const skip = !hasSwift ? 'macOS Command Line Tools (swiftc) required' : false;

function captureIo() {
  const out = [];
  const err = [];
  return {
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    env: process.env,
    fetch: async () => { throw new Error('preview test must not contact ChattyMaps'); },
    output: () => out.join(''),
    errors: () => err.join(''),
  };
}

test('geocode disambiguates Kingston with --country=gb (with and without near hint)', { skip }, async () => {
  const maps = await appleMaps();
  const richmond = await maps.geocode('Richmond', 'gb');
  assert.ok(richmond, 'Richmond in GB should resolve');
  assert.equal(richmond.countryCode, 'gb');
  assert.ok(distanceMeters(richmond, { lat: 51.4612, lng: -0.303 }) < 5000, `Unexpected Richmond coords: ${JSON.stringify(richmond)}`);

  const kingstonNear = await maps.geocode('Kingston', 'gb', richmond);
  assert.ok(kingstonNear, 'Kingston in GB near Richmond should resolve');
  assert.equal(kingstonNear.countryCode, 'gb');
  assert.ok(distanceMeters(kingstonNear, { lat: 51.4087, lng: -0.3066 }) < 5000, `Expected Kingston upon Thames, got: ${JSON.stringify(kingstonNear)}`);
  assert.doesNotMatch(kingstonNear.name, /Kingston upon Thames, Kingston Upon Thames/i);

  const kingstonAlone = await maps.geocode('Kingston', 'gb');
  assert.ok(kingstonAlone, 'Kingston in GB without near hint should resolve');
  assert.equal(kingstonAlone.countryCode, 'gb');
  assert.ok(distanceMeters(kingstonAlone, { lat: 51.4087, lng: -0.3066 }) < 5000, `Expected Kingston upon Thames, got: ${JSON.stringify(kingstonAlone)}`);
});

test('geocode respects other country codes (CA, US) and returns null for nonsense/invalid country', { skip }, async () => {
  const maps = await appleMaps();

  const kingstonCA = await maps.geocode('Kingston', 'ca');
  assert.ok(kingstonCA);
  assert.equal(kingstonCA.countryCode, 'ca');
  assert.ok(distanceMeters(kingstonCA, { lat: 44.2312, lng: -76.486 }) < 10_000, `Expected Kingston ON, got: ${JSON.stringify(kingstonCA)}`);

  const parisUS = await maps.geocode('Paris', 'us');
  assert.ok(parisUS);
  assert.equal(parisUS.countryCode, 'us');

  assert.equal(await maps.geocode('xyzzyplughnotaplace12345', 'gb'), null);
  assert.equal(await maps.geocode('Kingston', 'zz'), null);
});

test('reverse and search return valid results around Hoxton', { skip }, async () => {
  const maps = await appleMaps();
  const area = await maps.reverse({ lat: 51.5229, lng: -0.0792 });
  assert.ok(area?.label);
  assert.equal(area.countryCode, 'gb');

  const pubs = await maps.search('pubs', { lat: 51.5229, lng: -0.0792 }, 1000);
  assert.ok(Array.isArray(pubs) && pubs.length >= 2, `Expected >= 2 pubs near Hoxton, got ${pubs.length}`);
  assert.ok(pubs[0].name && Number.isFinite(pubs[0].lat) && Number.isFinite(pubs[0].lng));
});

const readmePreviewExamples = [
  {
    name: 'Clapham + Walthamstow pubs',
    args: ['Clapham', 'Walthamstow', 'pubs', '--preview', '--json'],
    check: (data) => {
      assert.ok(data.spreadM > 10_000 && data.spreadM < 25_000, `unexpected spreadM=${data.spreadM}`);
      assert.ok(data.candidates.length >= 2);
    },
  },
  {
    name: 'Three London areas with --what="pubs with a garden"',
    args: ['Brixton', 'Camden', 'Hackney', '--what=pubs with a garden', '--preview', '--json'],
    check: (data) => {
      assert.equal(data.startingPoints.length, 3);
      assert.ok(data.spreadM < 25_000, `unexpected spreadM=${data.spreadM}`);
      assert.ok(data.candidates.length >= 2);
    },
  },
  {
    name: 'Postcodes + station (E1 6AN, SW4 7AA, King\'s Cross)',
    args: ['E1 6AN', 'SW4 7AA', "King's Cross", '--what=coffee', '--preview', '--json'],
    check: (data) => {
      assert.equal(data.startingPoints.length, 3);
      assert.ok(data.spreadM < 20_000, `unexpected spreadM=${data.spreadM}`);
      assert.ok(data.candidates.length >= 2);
    },
  },
  {
    name: 'Disambiguate Richmond + Kingston with --country=gb',
    args: ['Richmond', 'Kingston', 'cafés', '--country=gb', '--preview', '--json'],
    check: (data) => {
      assert.ok(data.spreadM < 15_000, `Expected Richmond & Kingston upon Thames (~6 km), got spreadM=${data.spreadM}`);
      assert.equal(data.area?.countryCode, 'gb');
      assert.ok(data.candidates.length >= 2);
    },
  },
  {
    name: 'US cities (Brooklyn, Queens, Hoboken) ramen',
    args: ['Brooklyn', 'Queens', 'Hoboken', '--what=ramen', '--preview', '--json'],
    check: (data) => {
      assert.equal(data.startingPoints.length, 3);
      assert.ok(data.spreadM < 30_000, `unexpected spreadM=${data.spreadM}`);
      assert.equal(data.area?.countryCode, 'us');
      assert.ok(data.candidates.length >= 2);
    },
  },
  {
    name: 'Coordinates + Greenwich parks with --radius=2000 --count=8',
    args: ['51.5074,-0.1278', 'Greenwich', 'parks', '--radius=2000', '--count=8', '--preview', '--json'],
    check: (data) => {
      assert.ok(data.spreadM < 20_000, `unexpected spreadM=${data.spreadM}`);
      assert.ok(data.candidates.length >= 2);
    },
  },
];

for (const example of readmePreviewExamples) {
  test(`README example: ${example.name}`, { skip }, async () => {
    const streams = captureIo();
    const code = await main(example.args, streams);
    assert.equal(code, 0, `stderr: ${streams.errors()}`);
    const data = JSON.parse(streams.output());
    assert.equal(data.preview, true);
    assert.equal(data.source, 'apple');
    example.check(data);
  });
}
