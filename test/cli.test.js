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

const noApple = { available: async () => false, open: async () => { throw new Error('unused'); } };

function io(fetchImpl, apple = noApple) {
  const out = []; const err = [];
  return { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, env, fetch: fetchImpl, apple, output: out, errors: err };
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

test('when the places service is down, it still shows the middle without claiming nothing was found', async () => {
  const streams = io(async () => Response.json({
    error: "The places service didn't answer, so no venues could be suggested.", code: 'PLACES_UNAVAILABLE',
    midpoint: response.midpoint, spreadM: 15_300, startingPoints: response.startingPoints, radiusM: 1000, candidates: [],
  }, { status: 502 }));
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs'], streams), 1);
  const text = streams.errors.join('');
  assert.match(text, /places service didn't answer/);
  assert.match(text, /Middle: Hoxton, London/);
  assert.doesNotMatch(text, /No pubs found|searched within/);
});

// A fake Apple Maps: Clapham and Walthamstow, a midpoint in Hoxton, three pubs.
function fakeApple(places) {
  const calls = [];
  const maps = {
    geocode: async (text) => { calls.push(['geocode', text]); return { Clapham: { name: 'Clapham, London', lat: 51.4618, lng: -0.1384, countryCode: 'gb' }, Walthamstow: { name: 'Walthamstow, London', lat: 51.5839, lng: -0.02, countryCode: 'gb' } }[text] ?? null; },
    reverse: async () => { calls.push(['reverse']); return { label: 'Hoxton', regionLabel: 'London', countryCode: 'gb' }; },
    search: async (query, center, radius) => { calls.push(['search', query, radius]); return places; },
    locate: async () => { calls.push(['locate']); return { lat: 51.4618, lng: -0.1384, accuracyM: 35 }; },
  };
  return { calls, apple: { available: async () => true, open: async () => maps } };
}
const nearMiddle = (name, dLat, extra = {}) => ({ name, lat: 51.52285 + dLat, lng: -0.0792, ...extra });

test('on a Mac, --preview finds everything with Apple Maps and never contacts ChattyMaps', async () => {
  const { calls, apple } = fakeApple([nearMiddle('Far', 0.05), nearMiddle('The Wenlock', 0.002, { phone: '+44 20', url: 'https://wenlock.test' }), nearMiddle('The Eagle', 0.001)]);
  const streams = io(async () => { throw new Error('ChattyMaps should not be called'); }, apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--preview', '--count=2'], streams), 0);
  const text = streams.output.join('');
  assert.match(text, /Places from Apple Maps/);
  assert.match(text, /1\. The Eagle\n {3}110 m from the middle/);
  assert.match(text, /2\. The Wenlock\n {3}\+44 20 · https:\/\/wenlock\.test/);
  assert.doesNotMatch(text, /Far/);
  assert.deepEqual(calls.filter(([c]) => c === 'search'), [['search', 'pubs', 1000]]);
});

test('on a Mac, creating a poll sends only the midpoint and places, never the starting places', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  let sent;
  const streams = io(async (url, init) => { sent = JSON.parse(init.body); return Response.json({ id: 'p1', url: 'https://chattymaps.test/poll/p1' }, { status: 201 }); }, apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--count=2', '--name=Sam'], streams), 0);
  assert.deepEqual(Object.keys(sent).sort(), ['area', 'midpoint', 'nickname', 'places', 'radiusM', 'source', 'what']);
  assert.deepEqual(sent.area, { label: 'Hoxton', regionLabel: 'London', countryCode: 'gb' });
  assert.equal(sent.source, 'apple_maps');
  assert.deepEqual(sent.places.map((p) => p.name), ['The Eagle', 'The Wenlock']);
  assert.doesNotMatch(JSON.stringify(sent), /Clapham|Walthamstow|51\.4618/);
  assert.match(streams.output.join(''), /Vote here: https:\/\/chattymaps\.test\/poll\/p1/);
});

test('on a Mac, it widens the search when too few places are close, and refuses a one-place poll', async () => {
  const { calls, apple } = fakeApple([nearMiddle('Only one', 0.001)]);
  const streams = io(async () => { throw new Error('should not post'); }, apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs'], streams), 1);
  assert.deepEqual(calls.filter(([c]) => c === 'search').map(([, , r]) => r), [1000, 2000, 4000]);
  assert.match(streams.errors.join(''), /Apple Maps found only one within 4 km/);
});

test('on a Mac, an unknown starting place is named', async () => {
  const { apple } = fakeApple([]);
  const streams = io(async () => { throw new Error('should not post'); }, apple);
  assert.equal(await main(['Clapham', 'Atlantis', 'pubs'], streams), 1);
  assert.match(streams.errors.join(''), /starting place 2, "Atlantis"/);
});

test('--source=chattymaps skips Apple Maps', async () => {
  const { apple } = fakeApple([]);
  let posted;
  const streams = io(async (url, init) => { posted = JSON.parse(init.body); return Response.json(response, { status: 201 }); }, apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--source=chattymaps'], streams), 0);
  assert.deepEqual(posted.from, ['Clapham', 'Walthamstow']);
});

test('middle-with-me positional parsing', () => {
  assert.deepEqual(parseCli(['Camden'], env, { withMe: true }).body, { from: ['Camden'] });
  const two = parseCli(['Camden', 'pubs'], env, { withMe: true });
  assert.deepEqual(two.body, { from: ['Camden'], what: 'pubs' });
  assert.equal(two.whatFromPosition, true);
  assert.deepEqual(parseCli(['Camden', 'Brixton', '--what=bars'], env, { withMe: true }).body, { from: ['Camden', 'Brixton'], what: 'bars' });
  assert.throws(() => parseCli([], env, { withMe: true }), UsageError);
});

test('middle-with-me uses current location locally and never sends it to ChattyMaps', async () => {
  const { calls, apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  let sent;
  const streams = io(async (url, init) => { sent = JSON.parse(init.body); return Response.json({ id: 'p2', url: 'https://chattymaps.test/poll/p2' }, { status: 201 }); }, apple);
  assert.equal(await main(['Walthamstow', 'pubs', '--count=2'], streams, { withMe: true }), 0);
  assert.deepEqual(calls.filter(([c]) => c === 'locate' || c === 'geocode'), [['locate'], ['geocode', 'Walthamstow']]);
  assert.match(streams.output.join(''), /from you · .* from Walthamstow/);
  assert.doesNotMatch(JSON.stringify(sent), /51\.4618|Walthamstow|you/);
});

test('middle-with-me with --source=chattymaps locates on Mac and sends coordinates', async () => {
  const { calls, apple } = fakeApple([]);
  let posted;
  const streams = io(async (url, init) => { posted = JSON.parse(init.body); return Response.json(response, { status: 201 }); }, apple);
  assert.equal(await main(['Walthamstow', 'pubs', '--source=chattymaps'], streams, { withMe: true }), 0);
  assert.deepEqual(calls, [['locate']]);
  assert.deepEqual(posted.from, ['51.461800,-0.138400', 'Walthamstow']);
});

test('middle-with-me explains when Apple Maps / CoreLocation is unavailable', async () => {
  const streams = io(async () => { throw new Error('should not post'); }, noApple);
  assert.equal(await main(['Camden', 'pubs'], streams, { withMe: true }), 1);
  assert.match(streams.errors.join(''), /needs macOS.*lat,lng/);
});

test('middle-with-me caps total starting places at 8 including you', async () => {
  const { apple } = fakeApple([]);
  const streams = io(async () => { throw new Error('should not post'); }, apple);
  assert.equal(await main(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', '--what=pubs'], streams, { withMe: true }), 1);
  assert.match(streams.errors.join(''), /at most 8 starting places/);
});

test('middle-with-me --help prints middle-with-me usage', async () => {
  const streams = io(async () => { throw new Error('unused'); });
  assert.equal(await main(['--help'], streams, { withMe: true }), 0);
  assert.match(streams.output.join(''), /^middle-with-me —/);
});

test('on a Mac, subsequent geocodes pass country and the prior starts midpoint as a region hint', async () => {
  const geocodeCalls = [];
  const maps = {
    geocode: async (text, country, near) => {
      geocodeCalls.push({ text, country, near });
      return {
        Richmond: { name: 'Richmond', lat: 51.4612, lng: -0.303, countryCode: 'gb' },
        Kingston: { name: 'Kingston upon Thames', lat: 51.4087, lng: -0.3066, countryCode: 'gb' },
      }[text] ?? null;
    },
    reverse: async () => ({ label: 'Ham', regionLabel: 'Richmond', countryCode: 'gb' }),
    search: async () => [
      { name: 'Café A', lat: 51.435, lng: -0.305 },
      { name: 'Café B', lat: 51.436, lng: -0.304 },
    ],
  };
  const streams = io(async () => { throw new Error('unused'); }, { available: async () => true, open: async () => maps });
  assert.equal(await main(['Richmond', 'Kingston', 'cafés', '--country=gb', '--preview'], streams), 0);
  assert.deepEqual(geocodeCalls, [
    { text: 'Richmond', country: 'gb', near: null },
    { text: 'Kingston', country: 'gb', near: { lat: 51.4612, lng: -0.303 } },
  ]);
});

test('prints the one-time manage link after the vote link, with a warning to keep it private', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  const manageUrl = 'https://chattymaps.test/poll/p1#manage=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
  const streams = io(async () => Response.json({ id: 'p1', url: 'https://chattymaps.test/poll/p1', manageUrl, manageExpiresAt: '2026-12-23T00:00:00Z' }, { status: 201 }), apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--count=2'], streams), 0);
  const text = streams.output.join('');
  assert.match(text, /Vote here: https:\/\/chattymaps\.test\/poll\/p1\n\nManage it: https:\/\/chattymaps\.test\/poll\/p1#manage=/);
  assert.match(text, /Keep this link to yourself/);
});
