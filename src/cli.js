import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { appleMaps, appleMapsAvailable, AppleMapsError } from './apple.js';
import {
  appendHistory,
  buildHistoryEntry,
  clearHistory,
  displayPath,
  formatHistoryEntry,
  formatHistoryList,
  historyPath,
  readHistory,
} from './history.js';
import { findMiddleLocally, LocalSearchError, placesRequest } from './local.js';

export const VERSION = '0.2.0';
export const DEFAULT_BASE_URL = 'https://chattymaps.com';
const TIMEOUT_MS = 90_000;

export const USAGE = `middle — find places to meet in the middle on macOS, then let the group vote on ChattyMaps

Usage:
  middle <place> <place> [more places…] [what] [options]
  middle history [--path | --clear | --json]
  middle last [--open | --json]

  With three or more words, the last one is what to look for:
    middle "Clapham" "Walthamstow" pubs
    middle "Clapham" "Walthamstow" "pubs with a garden" --count=6
  With two, both are starting places and it looks for cafés:
    middle "Brixton" "Camden"
  Use --what when every word is a starting place:
    middle Clapham Walthamstow Brixton --what=bars
  Starting places can be towns, stations, postcodes or "lat,lng".

All lookups run locally on your Mac through Apple Maps (no keys, no accounts).
Your starting places never leave your machine — only the midpoint, area and
chosen places are sent to ChattyMaps to create the poll.

Saved poll history:
  By default, creating a poll saves its title, area, place names, vote link and
  one-time manage link (never your starting places) to an owner-only (0600) file:
    ~/Library/Application Support/chattymaps-middle/polls.jsonl
  Override the path with CHATTYMAPS_MIDDLE_HISTORY. Pass --no-save to write
  nothing to disk. --preview never saves anything. Run 'middle history --clear'
  to delete the file.

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
                     ChattyMaps or save anything locally)
  --no-save          Do not save the created poll to local history
  --open             Open the poll as its organiser in your browser
  --json             Print the raw JSON response
  --url=URL          ChattyMaps server (default: $CHATTYMAPS_URL or
                     ${DEFAULT_BASE_URL})
  -h, --help         Show help
  -v, --version      Show version

History commands:
  middle history          List saved polls and show the file location
  middle history --path   Print the exact path to the saved history file
  middle history --clear  Delete the saved history file
  middle last             Show the most recently saved poll (--open to open it)

The middle is a straight-line average, not travel time. That's why the
group gets a vote.`;

export const USAGE_WITH_ME = `middle-with-me — find places to meet halfway from where you are on macOS, then vote on ChattyMaps

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

All lookups run locally on your Mac through Apple Maps and CoreLocation. Your
current location and starting places never leave your machine — only the
midpoint, area and chosen places go to ChattyMaps. On first run, macOS will ask
to allow Location Services for your terminal.

Saved poll history:
  By default, creating a poll saves its title, area, place names, vote link and
  one-time manage link (never your current location or starting places) to an
  owner-only (0600) file:
    ~/Library/Application Support/chattymaps-middle/polls.jsonl
  Pass --no-save to write nothing to disk. View or clear saved polls with
  'middle history' and 'middle last'.

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
                     ChattyMaps or save anything locally)
  --no-save          Do not save the created poll to local history
  --open             Open the poll as its organiser in your browser
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

/** Turns argv into local search options plus CLI-only settings. */
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
      'no-save': { type: 'boolean', default: false },
      clear: { type: 'boolean', default: false },
      path: { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      url: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help || values.version) return { help: values.help, version: values.version, withMe };

  const words = positionals.map((word) => word.trim()).filter(Boolean);
  if (!withMe && words.length === 1 && (words[0] === 'history' || words[0] === 'last')) {
    const command = words[0];
    const disallowed = ['what', 'count', 'radius', 'country', 'title', 'name', 'days', 'preview', 'url', 'no-save'];
    if (command === 'history') disallowed.push('open');
    if (command === 'last') disallowed.push('clear', 'path');
    const bad = disallowed.find((key) => values[key] !== undefined && values[key] !== false);
    if (bad) throw new UsageError(`--${bad} can't be used with 'middle ${command}'.`);
    if (values.clear && values.path) throw new UsageError("Use either --clear or --path with 'middle history', not both.");
    return { command, clear: values.clear, path: values.path, open: values.open, json: values.json, withMe };
  }
  if (values.clear) throw new UsageError("--clear can only be used with 'middle history'.");
  if (values.path) throw new UsageError("--path can only be used with 'middle history'.");

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
  const baseUrl = (values.url ?? env.CHATTYMAPS_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  try { new URL(baseUrl); } catch { throw new UsageError(`--url is not a valid URL: ${baseUrl}`); }
  return { body, baseUrl, json: values.json, open: values.open, noSave: values['no-save'], whatFromPosition, withMe };
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

export function formatResult(data, { savedTo = null, noSave = false } = {}) {
  const lines = [];
  const middle = data.midpoint;
  const where = [middle.label, middle.regionLabel].filter(Boolean).join(', ');
  lines.push(`Middle: ${where} (${middle.lat.toFixed(4)}, ${middle.lng.toFixed(4)})`);
  const starts = data.startingPoints ?? [];
  lines.push(`${starts.length} starting places, up to ${formatDistance(data.spreadM)} apart · searched within ${formatDistance(data.radiusM)}`);
  lines.push(`${data.note ?? 'Straight-line middle, not travel time.'}${data.source === 'apple' ? ' Places from Apple Maps.' : ''}`);
  lines.push('');

  if (!data.candidates?.length) lines.push(`No ${String(data.what?.label ?? 'places').toLowerCase()} found near the middle.`, '');
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
  if (data.manageUrl) {
    lines.push('', `Manage it: ${data.manageUrl}`);
    lines.push('  Keep this link to yourself. The first browser to open it becomes the organiser');
    lines.push('  (edit, close, decide), and then the link stops working. Unused, it expires in 30 days.');
  } else if (data.preview) {
    lines.push('Preview only: no poll was created and nothing was saved. Run again without --preview to create one.');
  }

  if (!data.preview && data.url) {
    if (savedTo) {
      lines.push('', `Saved to: ${displayPath(savedTo)} (private, owner-only)`);
      lines.push('  Stores the poll title, area, place names, vote link and manage link — never your starting places.');
      lines.push('  View later with `middle history` or `middle last`. Pass --no-save to skip saving.');
    } else if (noSave) {
      lines.push('', 'Not saved (--no-save). Copy these links now — nothing was written to disk.');
    }
  }
  return lines.join('\n');
}

function openInBrowser(url) {
  spawn('open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function runHistoryCommand(options, streams) {
  const filePath = historyPath(streams.env);
  if (options.command === 'history') {
    if (options.path) {
      streams.out.write(`${filePath}\n`);
      return 0;
    }
    if (options.clear) {
      const { cleared } = clearHistory(streams.env);
      const shown = displayPath(filePath);
      streams.out.write(cleared ? `Deleted saved poll history: ${shown}\n` : `No saved poll history found at ${shown}.\n`);
      return 0;
    }
    const entries = readHistory(streams.env);
    streams.out.write(options.json ? `${JSON.stringify(entries, null, 2)}\n` : `${formatHistoryList(entries, filePath)}\n`);
    return 0;
  }

  // options.command === 'last'
  const entries = readHistory(streams.env);
  if (!entries.length) {
    streams.err.write(`No saved polls in ${displayPath(filePath)}.\n`);
    return 1;
  }
  const latest = entries[entries.length - 1];
  if (options.json) {
    streams.out.write(`${JSON.stringify(latest, null, 2)}\n`);
  } else {
    streams.out.write(`${formatHistoryEntry(latest)}\n\nSaved in: ${displayPath(filePath)} (private, owner-only)\n`);
  }
  if (options.open && (latest.manageUrl || latest.url)) {
    (streams.openUrl ?? openInBrowser)(latest.manageUrl ?? latest.url);
  }
  return 0;
}

const DEFAULT_APPLE = { available: () => appleMapsAvailable(), open: (options) => appleMaps(options) };

/** Apple Maps client for this run; always local on macOS, never falls back to ChattyMaps. */
async function openAppleMaps(io, { withMe = false } = {}) {
  const apple = io.apple ?? DEFAULT_APPLE;
  if (!(await apple.available())) {
    const command = withMe ? 'middle-with-me' : 'middle';
    throw new AppleMapsError(
      `${command} runs locally on macOS using Apple Maps and needs the Command Line Tools (xcode-select --install).`,
    );
  }
  return apple.open({ env: io.env, log: (line) => io.err.write(`${line}\n`) });
}

async function findWithApple(options, maps, io, me = null) {
  const local = await findMiddleLocally(options.body, maps, { me });
  if (options.body.preview) return { preview: true, ...local };
  if (local.candidates.length < 2)
    throw new LocalSearchError(
      `A poll needs at least two places, and Apple Maps found ${local.candidates.length === 0 ? 'none' : 'only one'} within ${formatDistance(local.radiusM)} of the middle. Try something else with --what, or a bigger --radius.`,
      local,
    );
  if (!local.area)
    throw new LocalSearchError(
      "Couldn't tell which country the middle is in, so the poll can't be set up.",
      local,
    );
  const created = await requestMiddle(options.baseUrl, placesRequest(local, options.body), io.fetch);
  return { ...local, id: created.id, url: created.url, manageUrl: created.manageUrl, manageExpiresAt: created.manageExpiresAt, preview: false };
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
  if (options.command) return runHistoryCommand(options, streams);

  try {
    const maps = await openAppleMaps(streams, { withMe });
    let me = null;
    if (withMe) {
      const located = await maps.locate();
      me = { name: 'you', lat: located.lat, lng: located.lng };
    }
    const data = await findWithApple(options, maps, streams, me);
    let savedTo = null;
    if (!data.preview && data.url && !options.noSave) {
      try {
        savedTo = appendHistory(buildHistoryEntry(data, options.body.title), streams.env);
      } catch (saveError) {
        const target = displayPath(historyPath(streams.env));
        streams.err.write(`Warning: couldn't save poll to ${target}: ${saveError.message}. Copy the links above now.\n`);
      }
    }
    if (options.json) {
      const payload = data.preview ? data : { ...data, savedTo };
      streams.out.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      streams.out.write(`${formatResult(data, { savedTo, noSave: options.noSave })}\n`);
    }
    // Whoever runs the CLI is usually the organiser, so open the manage link.
    if (options.open && (data.manageUrl || data.url)) (streams.openUrl ?? openInBrowser)(data.manageUrl ?? data.url);
    return 0;
  } catch (error) {
    if (error instanceof AppleMapsError || error instanceof LocalSearchError || error instanceof ApiError) {
      if (options.json && error.data) streams.out.write(`${JSON.stringify(error.data, null, 2)}\n`);
      let message = `Error: ${error.message}`;
      if (!options.json && error.data?.midpoint) message += `\n\n${formatResult(error.data)}`;
      streams.err.write(`${message}\n`);
      return 1;
    }
    throw error;
  }
}
