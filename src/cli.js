import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { appleMaps, appleMapsAvailable, AppleMapsError } from './apple.js';
import { findMiddleLocally, LocalSearchError, placesRequest } from './local.js';

export const VERSION = '0.2.0';
export const DEFAULT_BASE_URL = 'https://chattymaps.etewiah.workers.dev';
const TIMEOUT_MS = 90_000;

export const USAGE = `middle — find places to meet in the middle, then let the group vote on ChattyMaps

Usage:
  middle <place> <place> [more places…] [what] [options]

  With three or more words, the last one is what to look for:
    middle "Clapham" "Walthamstow" pubs
    middle "Clapham" "Walthamstow" "pubs with a garden" --count=6
  With two, both are starting places and it looks for cafés:
    middle "Brixton" "Camden"
  Use --what when every word is a starting place:
    middle Clapham Walthamstow Brixton --what=bars
  Starting places can be towns, stations, postcodes or "lat,lng".

On a Mac, the lookups run through Apple Maps on your machine (no keys,
no accounts), and only the midpoint and the chosen places go to ChattyMaps.
Elsewhere, ChattyMaps does the lookups with OpenStreetMap.

Options:
  --what=TEXT        What to look for (default: cafés), e.g. pubs, tapas,
                     "pubs with a garden".
  --count=N          Places to suggest, 2–10 (default: 5)
  --radius=M         Search circle in metres, 100–5000 (default: 1000).
                     Widens automatically if too few places are found.
  --country=CC       Look up starting places in one country (e.g. gb)
  --title=TEXT       Poll title (default: "Where should we meet? …")
  --name=TEXT        Your name on the poll (default: Organiser)
  --days=N           Close voting after N days
  --preview          Show the places without creating a poll (on a Mac,
                     this doesn't contact ChattyMaps at all)
  --source=WHERE     Who finds the places: apple, chattymaps, or auto
                     (default: apple on a Mac, otherwise chattymaps)
  --open             Open the poll in your browser
  --json             Print the raw JSON response
  --url=URL          ChattyMaps server (default: $CHATTYMAPS_URL or
                     ${DEFAULT_BASE_URL})
  -h, --help         Show help
  -v, --version      Show version

The middle is a straight-line average, not travel time. That's why the
group gets a vote.`;

export const USAGE_WITH_ME = `middle-with-me — find places to meet halfway from where you are, then vote on ChattyMaps

Usage:
  middle-with-me <place> [more places…] [what] [options]

  Uses your Mac's current location (via CoreLocation) as the first starting
  place, so you only pass the other starting places:
    middle-with-me "Walthamstow" pubs
    middle-with-me "Camden"
    middle-with-me Clapham Walthamstow --what=bars

  With two or more words, the last one is what to look for.
  With one, it's the other starting place and it looks for cafés.
  Use --what when every word is a starting place.

Your current location stays on your Mac (with Apple Maps); only the midpoint
and the chosen places go to ChattyMaps. On first run, macOS will ask to allow
Location Services for your terminal.

Options:
  --what=TEXT        What to look for (default: cafés), e.g. pubs, tapas,
                     "pubs with a garden".
  --count=N          Places to suggest, 2–10 (default: 5)
  --radius=M         Search circle in metres, 100–5000 (default: 1000).
                     Widens automatically if too few places are found.
  --country=CC       Look up starting places in one country (e.g. gb)
  --title=TEXT       Poll title (default: "Where should we meet? …")
  --name=TEXT        Your name on the poll (default: Organiser)
  --days=N           Close voting after N days
  --preview          Show the places without creating a poll (doesn't contact
                     ChattyMaps at all)
  --source=WHERE     Who finds the places: apple, chattymaps, or auto
                     (default: apple on a Mac)
  --open             Open the poll in your browser
  --json             Print the raw JSON response
  --url=URL          ChattyMaps server (default: $CHATTYMAPS_URL or
                     ${DEFAULT_BASE_URL})
  -h, --help         Show help
  -v, --version      Show version

The middle is a straight-line average, not travel time. That's why the
group gets a vote.`;

export class UsageError extends Error {}

function integer(value, name) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number`);
  return Number(value);
}

/** Turns argv into the /api/middle request body, plus CLI-only settings. */
export function parseCli(argv, env = process.env, { withMe = false } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      what: { type: 'string' },
      count: { type: 'string' },
      radius: { type: 'string' },
      country: { type: 'string' },
      title: { type: 'string' },
      name: { type: 'string' },
      days: { type: 'string' },
      preview: { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      url: { type: 'string' },
      source: { type: 'string', default: 'auto' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help || values.version) return { help: values.help, version: values.version, withMe };

  const words = positionals.map((word) => word.trim()).filter(Boolean);
  let what = values.what;
  let whatFromPosition = false;
  const minWords = withMe ? 1 : 2;
  if (what === undefined && words.length >= minWords + 1) {
    what = words.pop();
    whatFromPosition = true;
  }
  if (words.length < minWords) {
    throw new UsageError(withMe ? 'Give at least one other starting place.' : 'Give at least two starting places.');
  }

  const days = integer(values.days, '--days');
  if (days !== undefined && (days < 1 || days > 90)) throw new UsageError('--days must be from 1 to 90');

  const body = {
    from: words,
    ...(what ? { what } : {}),
    ...(values.count ? { count: integer(values.count, '--count') } : {}),
    ...(values.radius ? { radiusM: integer(values.radius, '--radius') } : {}),
    ...(values.country ? { country: values.country } : {}),
    ...(values.title ? { title: values.title } : {}),
    ...(values.name ? { nickname: values.name } : {}),
    ...(days ? { expiresIn: days * 86_400 } : {}),
    ...(values.preview ? { preview: true } : {}),
  };
  if (!['auto', 'apple', 'chattymaps'].includes(values.source)) throw new UsageError('--source must be apple, chattymaps or auto');
  const baseUrl = (values.url ?? env.CHATTYMAPS_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  try { new URL(baseUrl); } catch { throw new UsageError(`--url is not a valid URL: ${baseUrl}`); }
  return { body, baseUrl, json: values.json, open: values.open, whatFromPosition, source: values.source, withMe };
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function requestMiddle(baseUrl, body, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/middle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `chattymaps-middle/${VERSION}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
    throw new ApiError(`ChattyMaps at ${baseUrl} ${reason}.`, 0, null);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (response.status === 404 && !data?.error)
    throw new ApiError(`${baseUrl} doesn't have /api/middle. It may be running an older ChattyMaps; try --url.`, 404, data);
  if (!response.ok) throw new ApiError(data?.error ?? `ChattyMaps returned HTTP ${response.status}.`, response.status, data);
  if (!data) throw new ApiError('ChattyMaps returned an empty response.', response.status, null);
  return data;
}

export function formatDistance(metres) {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0).replace(/\.0$/, '')} km`;
}

/** Short name for a starting place: "Clapham, London Borough of Lambeth" → "Clapham". */
function shortName(name) {
  return name.split(',')[0].trim();
}

export function formatResult(data) {
  const lines = [];
  const middle = data.midpoint;
  const where = [middle.label, middle.regionLabel].filter(Boolean).join(', ');
  lines.push(`Middle: ${where} (${middle.lat.toFixed(4)}, ${middle.lng.toFixed(4)})`);
  const starts = data.startingPoints ?? [];
  const searched = data.code === 'PLACES_UNAVAILABLE' ? '' : ` · searched within ${formatDistance(data.radiusM)}`;
  lines.push(`${starts.length} starting places, up to ${formatDistance(data.spreadM)} apart${searched}`);
  lines.push(`${data.note ?? 'Straight-line middle, not travel time.'}${data.source === 'apple' ? ' Places from Apple Maps.' : ''}`);
  if (data.what?.unchecked?.length) lines.push(`Not checked: ${data.what.unchecked.join(', ')}`);
  lines.push('');

  if (!data.candidates?.length && data.code !== 'PLACES_UNAVAILABLE') lines.push(`No ${String(data.what?.label ?? 'places').toLowerCase()} found near the middle.`, '');
  data.candidates?.forEach((place, index) => {
    lines.push(`${index + 1}. ${place.name}${place.kind ? ` (${place.kind})` : ''}`);
    if (place.address) lines.push(`   ${place.address}`);
    const journeys = (place.fromStartsM ?? []).map((m, i) => `${formatDistance(m)} from ${shortName(starts[i]?.name ?? `start ${i + 1}`)}`);
    const contact = [place.phone, place.url].filter(Boolean).join(' · ');
    if (contact) lines.push(`   ${contact}`);
    lines.push(`   ${[`${formatDistance(place.distanceM)} from the middle`, ...journeys].join(' · ')}`);
    lines.push('');
  });

  if (data.url) lines.push(`Vote here: ${data.url}`);
  else if (data.preview) lines.push('Preview only: no poll was created. Run again without --preview to create one.');
  return lines.join('\n');
}

function openInBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const DEFAULT_APPLE = { available: () => appleMapsAvailable(), open: (options) => appleMaps(options) };

/** Apple Maps client for this run, or null to let ChattyMaps do the lookups. */
async function chooseAppleMaps(options, io, { required = false } = {}) {
  if (!required && options.source === 'chattymaps') return null;
  const apple = io.apple ?? DEFAULT_APPLE;
  if (!(await apple.available())) {
    if (required) {
      throw new AppleMapsError(
        'middle-with-me needs macOS with the Command Line Tools (xcode-select --install) to read your current location. Elsewhere, use \'middle\' with your coordinates as "lat,lng".',
      );
    }
    if (options.source === 'apple') throw new AppleMapsError('Apple Maps needs macOS with the Command Line Tools (xcode-select --install).');
    return null;
  }
  try {
    return await apple.open({ env: io.env, log: (line) => io.err.write(`${line}\n`) });
  } catch (error) {
    if (required || options.source === 'apple' || !(error instanceof AppleMapsError)) throw error;
    io.err.write(`${error.message}\nUsing ChattyMaps to find places instead.\n`);
    return null;
  }
}

async function findWithApple(options, maps, io, me = null) {
  const local = await findMiddleLocally(options.body, maps, { me });
  if (options.body.preview) return { preview: true, ...local };
  if (local.candidates.length < 2)
    throw new LocalSearchError(
      `A poll needs at least two places, and Apple Maps found ${local.candidates.length === 0 ? 'none' : 'only one'} within ${formatDistance(local.radiusM)} of the middle. Try something else with --what, or a bigger --radius.`,
      local,
    );
  const created = await requestMiddle(options.baseUrl, placesRequest(local, options.body), io.fetch);
  return { ...local, id: created.id, url: created.url, preview: false };
}

export async function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr, env: process.env, fetch }, { withMe = false } = {}) {
  const streams = io ?? { out: process.stdout, err: process.stderr, env: process.env, fetch };
  const command = withMe ? 'middle-with-me' : 'middle';
  let options;
  try {
    options = parseCli(argv, streams.env, { withMe });
  } catch (error) {
    streams.err.write(`Error: ${error.message}\n\nRun '${command} --help' for usage.\n`);
    return 2;
  }
  if (options.help) { streams.out.write(`${withMe ? USAGE_WITH_ME : USAGE}\n`); return 0; }
  if (options.version) { streams.out.write(`${VERSION}\n`); return 0; }

  try {
    const maps = await chooseAppleMaps(options, streams, { required: withMe });
    let data;
    if (withMe) {
      const located = await maps.locate();
      const me = { name: 'you', lat: located.lat, lng: located.lng };
      if (options.source === 'chattymaps') {
        const body = { ...options.body, from: [`${me.lat.toFixed(6)},${me.lng.toFixed(6)}`, ...options.body.from] };
        data = await requestMiddle(options.baseUrl, body, streams.fetch);
      } else {
        data = await findWithApple(options, maps, streams, me);
      }
    } else {
      data = maps ? await findWithApple(options, maps, streams) : await requestMiddle(options.baseUrl, options.body, streams.fetch);
    }
    streams.out.write(options.json ? `${JSON.stringify(data, null, 2)}\n` : `${formatResult(data)}\n`);
    if (options.open && data.url) openInBrowser(data.url);
    return 0;
  } catch (error) {
    if (error instanceof AppleMapsError || error instanceof LocalSearchError) {
      if (options.json && error.data) streams.out.write(`${JSON.stringify(error.data, null, 2)}\n`);
      let message = `Error: ${error.message}`;
      if (!options.json && error.data?.midpoint) message += `\n\n${formatResult(error.data)}`;
      streams.err.write(`${message}\n`);
      return 1;
    }
    if (!(error instanceof ApiError)) throw error;
    if (options.json && error.data) streams.out.write(`${JSON.stringify(error.data, null, 2)}\n`);
    let message = `Error: ${error.message}`;
    if (error.data?.code === 'UNKNOWN_PLACE_KIND' && options.whatFromPosition)
      message += `\nIf "${options.body.what}" is a starting place, add --what=cafés (or whatever you're looking for).`;
    // Show what was found, so a "not enough places" answer is still useful.
    if (!options.json && error.data?.midpoint) message += `\n\n${formatResult(error.data)}`;
    streams.err.write(`${message}\n`);
    return 1;
  }
}
