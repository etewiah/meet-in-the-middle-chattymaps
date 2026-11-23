import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDistance, formatResult, main, parseCli, UsageError } from '../src/cli.js';

const env = {};

test('two words are both starting places', () => {
  const { body } = parseCli(['Brixton', 'Camden'], env);
  assert.deepEqual(body, { from: ['Brixton', 'Camden'] });
});

test('with three or more words, the last is what to look for', () => {
  const { body, whatFromPosition } = parseCli(['Clapham', 'Walthamstow', 'pubs with a garden', '--count=3'], env);
  assert.deepEqual(body, { from: ['Clapham', 'Walthamstow'], what: 'pubs with a garden', count: 3 });
  assert.equal(whatFromPosition, true);
});

test('--what keeps every word as a starting place', () => {
  const { body } = parseCli(['A', 'B', 'C', '--what=bars', '--days=7', '--preview', '--name=Sam'], env);
  assert.deepEqual(body, { from: ['A', 'B', 'C'], what: 'bars', expiresIn: 604800, preview: true, nickname: 'Sam' });
});

test('base URL comes from --url, then CHATTYMAPS_URL, then the default', () => {
  assert.equal(parseCli(['A', 'B', '--url=http://localhost:4480/'], env).baseUrl, 'http://localhost:4480');
  assert.equal(parseCli(['A', 'B'], { CHATTYMAPS_URL: 'http://x.test' }).baseUrl, 'http://x.test');
  assert.match(parseCli(['A', 'B'], env).baseUrl, /^https:\/\//);
});

test('usage errors', () => {
  assert.throws(() => parseCli(['Only one'], env), UsageError);
  assert.throws(() => parseCli(['A', 'B', '--count=lots'], env), UsageError);
  assert.throws(() => parseCli(['A', 'B', '--days=200'], env), UsageError);
});

test('distances', () => {
  assert.equal(formatDistance(575), '580 m');
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(15_200), '15 km');
  assert.equal(formatDistance(1000), '1 km');
});

const response = {
  id: 'abc', url: 'https://chattymaps.test/poll/abc', preview: false,
  what: { query: 'pubs', label: 'Pubs', unchecked: [] },
  midpoint: { lat: 51.52286, lng: -0.0792, label: 'Hoxton', regionLabel: 'London' },
  radiusM: 1000, spreadM: 15_300, note: 'Straight-line middle, not travel time.',
  startingPoints: [{ name: 'Clapham, Lambeth', lat: 51.46, lng: -0.14 }, { name: 'Walthamstow, Waltham Forest', lat: 51.58, lng: -0.02 }],
  candidates: [{ name: 'The Wenlock', address: '26 Wharf Rd', kind: 'pub', lat: 51.53, lng: -0.09, distanceM: 575, fromStartsM: [7900, 7600] }],
};

test('human output lists places with journeys and ends with the vote link', () => {
  const text = formatResult(response);
  assert.match(text, /^Middle: Hoxton, London \(51\.5229, -0\.0792\)/);
  assert.match(text, /1\. The Wenlock \(pub\)\n {3}26 Wharf Rd\n {3}580 m from the middle · 7\.9 km from Clapham · 7\.6 km from Walthamstow/);
  assert.match(text, /Vote here: https:\/\/chattymaps\.test\/poll\/abc$/);
});

function io(fetchImpl) {
  const out = []; const err = [];
  return { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, env, fetch: fetchImpl, output: out, errors: err };
}

test('main posts to /api/middle and prints the result', async () => {
  let seen;
  const streams = io(async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return Response.json(response, { status: 201 }); });
  const code = await main(['Clapham', 'Walthamstow', 'pubs', '--url=http://localhost:4480'], streams);
  assert.equal(code, 0);
  assert.equal(seen.url, 'http://localhost:4480/api/middle');
  assert.deepEqual(seen.body, { from: ['Clapham', 'Walthamstow'], what: 'pubs' });
  assert.match(streams.output.join(''), /Vote here/);
});

test('main explains API errors and hints when the last word was probably a place', async () => {
  const streams = io(async () => Response.json({ error: 'ChattyMaps doesn\'t know "Brixton" as a kind of place yet.', code: 'UNKNOWN_PLACE_KIND' }, { status: 422 }));
  const code = await main(['Clapham', 'Walthamstow', 'Brixton'], streams);
  assert.equal(code, 1);
  assert.match(streams.errors.join(''), /If "Brixton" is a starting place, add --what=/);
});

test('main reports a server without the endpoint', async () => {
  const streams = io(async () => new Response('Not found', { status: 404 }));
  assert.equal(await main(['A', 'B'], streams), 1);
  assert.match(streams.errors.join(''), /doesn't have \/api\/middle/);
});
