// Apple Maps lookups through src/mapkit-helper.swift (MapKit + CoreLocation):
// the same keyless, account-free approach as George Mandis's `nearme` and
// `whereami`. macOS only. The helper is compiled on first use with the
// Swift compiler from Apple's Command Line Tools and cached by content hash.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'mapkit-helper.swift');

export class AppleMapsError extends Error {}

function cacheDir(env) {
  if (env.CHATTYMAPS_MIDDLE_CACHE) return env.CHATTYMAPS_MIDDLE_CACHE;
  return join(homedir(), 'Library', 'Caches', 'chattymaps-middle');
}

export async function appleMapsAvailable(platform = process.platform) {
  if (platform !== 'darwin') return false;
  try {
    await run('xcrun', ['--find', 'swiftc']);
    return true;
  } catch {
    return false;
  }
}

/** Path to the compiled helper, building it if this version isn't cached yet. */
export async function helperPath({ env = process.env, log = () => {} } = {}) {
  const source = readFileSync(SOURCE);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const dir = cacheDir(env);
  const binary = join(dir, `mapkit-helper-${hash}`);
  if (existsSync(binary)) return binary;
  mkdirSync(dir, { recursive: true });
  log('Building the Apple Maps helper (first run only, about 15 seconds)…');
  const temporary = `${binary}.${process.pid}.tmp`;
  try {
    await run('xcrun', ['swiftc', '-O', SOURCE, '-o', temporary], { timeout: 180_000 });
  } catch (error) {
    throw new AppleMapsError(`Couldn't build the Apple Maps helper: ${String(error.stderr || error.message).split('\n')[0]}`);
  }
  renameSync(temporary, binary);
  return binary;
}

async function call(binary, args, timeout = 30_000) {
  try {
    const { stdout } = await run(binary, args, { timeout });
    return JSON.parse(stdout);
  } catch (error) {
    let message = error.message;
    try { message = JSON.parse(error.stdout).error ?? message; } catch { /* not JSON */ }
    throw new AppleMapsError(message);
  }
}

/** { geocode, search, reverse, locate } backed by Apple Maps & CoreLocation. */
export async function appleMaps(options = {}) {
  const binary = options.binary ?? await helperPath(options);
  return {
    /** → { name, lat, lng, countryCode } or null */
    geocode: (text, countryCode, near) => call(binary, [
      'geocode',
      text,
      ...(countryCode || near ? [countryCode ?? ''] : []),
      ...(near ? [String(near.lat), String(near.lng)] : []),
    ]),
    /** → [{ name, lat, lng, address, kind, phone, url }] */
    search: (query, center, radiusM) => call(binary, ['search', query, String(center.lat), String(center.lng), String(radiusM)]),
    /** → { label, regionLabel, countryCode } or null */
    reverse: (point) => call(binary, ['reverse', String(point.lat), String(point.lng)]),
    /** → { lat, lng, accuracyM } */
    locate: () => call(binary, ['locate'], 40_000),
  };
}
