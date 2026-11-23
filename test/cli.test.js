import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDistance, formatResult, main, parseCli, UsageError } from '../src/cli.js';
import { displayPath, historyPath } from '../src/history.js';

const testTempDirs = [];
function tempHistoryFile() {
  const dir = mkdtempSync(join(tmpdir(), 'chattymaps-middle-history-'));
  testTempDirs.push(dir);
  return join(dir, 'polls.jsonl');
}
after(() => {
  for (const dir of testTempDirs) rmSync(dir, { recursive: true, force: true });
});

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
  assert.throws(() => parseCli(['A', 'B', '--source=chattymaps'], env));
});

test('distances', () => {
  assert.equal(formatDistance(575), '580 m');
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(15_200), '15 km');
  assert.equal(formatDistance(1000), '1 km');
});

const response = {
  id: 'abc', url: 'https://chattymaps.test/poll/abc', preview: false, source: 'apple',
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

function io(fetchImpl, apple = noApple, extra = {}) {
  const out = []; const err = [];
  const historyFile = extra.historyFile ?? tempHistoryFile();
  const mergedEnv = { CHATTYMAPS_MIDDLE_HISTORY: historyFile, ...(extra.env ?? {}) };
  return {
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    env: mergedEnv,
    fetch: fetchImpl,
    apple,
    openUrl: extra.openUrl,
    historyFile,
    output: out,
    errors: err,
  };
}

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

test('--preview finds everything locally with Apple Maps and never contacts ChattyMaps', async () => {
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

test('creating a poll sends only the midpoint, area and places, never the starting places', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  let seen;
  const streams = io(async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return Response.json({ id: 'p1', url: 'https://chattymaps.test/poll/p1' }, { status: 201 }); }, apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--count=2', '--name=Sam', '--url=http://localhost:4480'], streams), 0);
  assert.equal(seen.url, 'http://localhost:4480/api/middle');
  assert.deepEqual(Object.keys(seen.body).sort(), ['area', 'midpoint', 'nickname', 'places', 'radiusM', 'source', 'what']);
  assert.deepEqual(seen.body.area, { label: 'Hoxton', regionLabel: 'London', countryCode: 'gb' });
  assert.equal(seen.body.source, 'apple_maps');
  assert.deepEqual(seen.body.places.map((p) => p.name), ['The Eagle', 'The Wenlock']);
  assert.doesNotMatch(JSON.stringify(seen.body), /Clapham|Walthamstow|51\.4618/);
  assert.match(streams.output.join(''), /Vote here: https:\/\/chattymaps\.test\/poll\/p1/);
});

test('main reports a server without the endpoint', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  const streams = io(async () => new Response('Not found', { status: 404 }), apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs'], streams), 1);
  assert.match(streams.errors.join(''), /doesn't have \/api\/middle/);
});

test('widens the search when too few places are close, and refuses a one-place poll', async () => {
  const { calls, apple } = fakeApple([nearMiddle('Only one', 0.001)]);
  const streams = io(async () => { throw new Error('should not post'); }, apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs'], streams), 1);
  assert.deepEqual(calls.filter(([c]) => c === 'search').map(([, , r]) => r), [1000, 2000, 4000]);
  assert.match(streams.errors.join(''), /Apple Maps found only one within 4 km/);
});

test('an unknown starting place is named', async () => {
  const { apple } = fakeApple([]);
  const streams = io(async () => { throw new Error('should not post'); }, apple);
  assert.equal(await main(['Clapham', 'Atlantis', 'pubs'], streams), 1);
  assert.match(streams.errors.join(''), /starting place 2, "Atlantis"/);
});

test('refuses to run without macOS / Apple Maps and never contacts ChattyMaps', async () => {
  const streams = io(async () => { throw new Error('ChattyMaps must not be contacted'); }, noApple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs'], streams), 1);
  assert.match(streams.errors.join(''), /macOS.*Apple Maps/);
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

test('middle-with-me explains when Apple Maps / CoreLocation is unavailable', async () => {
  const streams = io(async () => { throw new Error('should not post'); }, noApple);
  assert.equal(await main(['Camden', 'pubs'], streams, { withMe: true }), 1);
  assert.match(streams.errors.join(''), /middle-with-me.*macOS.*Apple Maps/);
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

test('subsequent geocodes pass country and the prior starts midpoint as a region hint', async () => {
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
  assert.match(text, /Saved to: .*\(private, owner-only\)/);
  assert.match(text, /Pass --no-save to skip saving/);
});

test('saves created poll to private 0600 history without starting places, and reports it clearly', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  const manageUrl = 'https://chattymaps.test/poll/p9#manage=secret123';
  const streams = io(async () => Response.json({ id: 'p9', url: 'https://chattymaps.test/poll/p9', manageUrl, manageExpiresAt: '2026-12-23T00:00:00Z' }, { status: 201 }), apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--title=Friday pints', '--count=2'], streams), 0);

  assert.equal(existsSync(streams.historyFile), true);
  assert.equal(statSync(streams.historyFile).mode & 0o777, 0o600);
  const raw = readFileSync(streams.historyFile, 'utf8');
  assert.doesNotMatch(raw, /Clapham|Walthamstow|51\.4618|51\.5839/);
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.id, 'p9');
  assert.equal(entry.title, 'Friday pints');
  assert.equal(entry.what, 'pubs');
  assert.equal(entry.area, 'Hoxton, London');
  assert.equal(entry.url, 'https://chattymaps.test/poll/p9');
  assert.equal(entry.manageUrl, manageUrl);
  assert.equal(entry.manageExpiresAt, '2026-12-23T00:00:00Z');
  assert.deepEqual(entry.places, ['The Eagle', 'The Wenlock']);
  assert.match(streams.output.join(''), new RegExp(`Saved to: .*polls\\.jsonl \\(private, owner-only\\)`));
});

test('--no-save skips writing to disk and tells the user clearly', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  const streams = io(async () => Response.json({ id: 'p10', url: 'https://chattymaps.test/poll/p10' }, { status: 201 }), apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--count=2', '--no-save'], streams), 0);
  assert.equal(existsSync(streams.historyFile), false);
  const text = streams.output.join('');
  assert.match(text, /Not saved \(--no-save\)/);
  assert.doesNotMatch(text, /Saved to:/);
});

test('--no-save with --json sets savedTo to null and writes nothing', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  const streams = io(async () => Response.json({ id: 'p11', url: 'https://chattymaps.test/poll/p11' }, { status: 201 }), apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--count=2', '--no-save', '--json'], streams), 0);
  assert.equal(existsSync(streams.historyFile), false);
  const parsed = JSON.parse(streams.output.join(''));
  assert.equal(parsed.savedTo, null);
});

test('--preview never writes to history', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  const streams = io(async () => { throw new Error('unused'); }, apple);
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--preview'], streams), 0);
  assert.equal(existsSync(streams.historyFile), false);
  assert.match(streams.output.join(''), /nothing was saved/);
});

test('middle-with-me saves poll without current coordinates or starting places, and respects --no-save', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  const savedStreams = io(async () => Response.json({ id: 'm1', url: 'https://chattymaps.test/poll/m1' }, { status: 201 }), apple);
  assert.equal(await main(['Walthamstow', 'pubs', '--count=2'], savedStreams, { withMe: true }), 0);
  const raw = readFileSync(savedStreams.historyFile, 'utf8');
  assert.doesNotMatch(raw, /Walthamstow|51\.4618|you/);

  const skippedStreams = io(async () => Response.json({ id: 'm2', url: 'https://chattymaps.test/poll/m2' }, { status: 201 }), apple);
  assert.equal(await main(['Walthamstow', 'pubs', '--count=2', '--no-save'], skippedStreams, { withMe: true }), 0);
  assert.equal(existsSync(skippedStreams.historyFile), false);
});

test('middle history and middle last read, open, show path, and clear saved polls', async () => {
  const historyFile = tempHistoryFile();
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);

  // Empty state
  const emptyHist = io(async () => { throw new Error('unused'); }, noApple, { historyFile });
  assert.equal(await main(['history'], emptyHist), 0);
  assert.match(emptyHist.output.join(''), /No saved polls/);

  const emptyLast = io(async () => { throw new Error('unused'); }, noApple, { historyFile });
  assert.equal(await main(['last'], emptyLast), 1);
  assert.match(emptyLast.errors.join(''), /No saved polls/);

  // Create two polls
  const s1 = io(async () => Response.json({ id: 'p1', url: 'https://chattymaps.test/poll/p1' }, { status: 201 }), apple, { historyFile });
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--title=First poll', '--count=2'], s1), 0);

  const manageUrl = 'https://chattymaps.test/poll/p2#manage=tok2';
  const s2 = io(async () => Response.json({ id: 'p2', url: 'https://chattymaps.test/poll/p2', manageUrl, manageExpiresAt: '2026-12-23T00:00:00Z' }, { status: 201 }), apple, { historyFile });
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--title=Second poll', '--count=2'], s2), 0);

  // middle history
  const list = io(async () => { throw new Error('unused'); }, noApple, { historyFile });
  assert.equal(await main(['history'], list), 0);
  assert.match(list.output.join(''), /1\. First poll/);
  assert.match(list.output.join(''), /2\. Second poll/);
  assert.match(list.output.join(''), /middle history --clear/);

  // middle history --json
  const listJson = io(async () => { throw new Error('unused'); }, noApple, { historyFile });
  assert.equal(await main(['history', '--json'], listJson), 0);
  assert.deepEqual(JSON.parse(listJson.output.join('')).map((e) => e.id), ['p1', 'p2']);

  // middle history --path
  const pathOut = io(async () => { throw new Error('unused'); }, noApple, { historyFile });
  assert.equal(await main(['history', '--path'], pathOut), 0);
  assert.equal(pathOut.output.join('').trim(), historyFile);

  // middle last --open
  const opened = [];
  const lastOpen = io(async () => { throw new Error('unused'); }, noApple, { historyFile, openUrl: (u) => opened.push(u) });
  assert.equal(await main(['last', '--open'], lastOpen), 0);
  assert.match(lastOpen.output.join(''), /Second poll/);
  assert.deepEqual(opened, [manageUrl]);

  // middle last --json
  const lastJson = io(async () => { throw new Error('unused'); }, noApple, { historyFile });
  assert.equal(await main(['last', '--json'], lastJson), 0);
  assert.equal(JSON.parse(lastJson.output.join('')).id, 'p2');

  // middle history --clear
  const cleared = io(async () => { throw new Error('unused'); }, noApple, { historyFile });
  assert.equal(await main(['history', '--clear'], cleared), 0);
  assert.match(cleared.output.join(''), /Deleted saved poll history/);
  assert.equal(existsSync(historyFile), false);
});

test('history subcommand flag validation and default path helper', () => {
  assert.throws(() => parseCli(['A', 'B', '--clear'], env), UsageError);
  assert.throws(() => parseCli(['A', 'B', '--path'], env), UsageError);
  assert.throws(() => parseCli(['history', '--open'], env), UsageError);
  assert.throws(() => parseCli(['history', '--clear', '--path'], env), UsageError);
  assert.throws(() => parseCli(['last', '--clear'], env), UsageError);
  assert.throws(() => parseCli(['history', '--no-save'], env), UsageError);
  // Two words starting with "history" are treated as normal starting places, not a subcommand.
  assert.deepEqual(parseCli(['history', 'Camden'], env).body, { from: ['history', 'Camden'] });

  assert.match(historyPath({}), /Library\/Application Support\/chattymaps-middle\/polls\.jsonl$/);
  assert.equal(displayPath('/Users/alice/Library/Application Support/chattymaps-middle/polls.jsonl', '/Users/alice'), '~/Library/Application Support/chattymaps-middle/polls.jsonl');
});

test('a failure writing history warns on stderr without losing the created poll output', async () => {
  const { apple } = fakeApple([nearMiddle('The Wenlock', 0.002), nearMiddle('The Eagle', 0.001)]);
  // Point CHATTYMAPS_MIDDLE_HISTORY at an existing directory so appendFileSync fails with EISDIR.
  const dir = mkdtempSync(join(tmpdir(), 'chattymaps-middle-eisdir-'));
  testTempDirs.push(dir);
  const streams = io(async () => Response.json({ id: 'p12', url: 'https://chattymaps.test/poll/p12' }, { status: 201 }), apple, { historyFile: dir });
  assert.equal(await main(['Clapham', 'Walthamstow', 'pubs', '--count=2'], streams), 0);
  assert.match(streams.output.join(''), /Vote here: https:\/\/chattymaps\.test\/poll\/p12/);
  assert.match(streams.errors.join(''), /Warning: couldn't save poll/);
});
