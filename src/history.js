// Private local history of polls created by the CLI.
// Stored outside the current working directory (in macOS Application Support,
// owner-only 0600) so private poll URLs and one-time manage links are never
// accidentally committed to a git repo. Starting places and current locations
// are never written to disk.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function historyPath(env = process.env) {
  if (env?.CHATTYMAPS_MIDDLE_HISTORY) return env.CHATTYMAPS_MIDDLE_HISTORY;
  return join(homedir(), 'Library', 'Application Support', 'chattymaps-middle', 'polls.jsonl');
}

export function displayPath(filePath, home = homedir()) {
  if (home && (filePath === home || filePath.startsWith(`${home}/`))) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

/** Builds a history record from a created poll — omits starting places & coordinates. */
export function buildHistoryEntry(data, title, now = new Date()) {
  const area = [data.midpoint?.label, data.midpoint?.regionLabel].filter(Boolean).join(', ');
  return {
    savedAt: now.toISOString(),
    ...(data.id ? { id: data.id } : {}),
    ...(title ? { title } : {}),
    ...(data.what?.label ? { what: data.what.label } : {}),
    ...(area ? { area } : {}),
    url: data.url,
    ...(data.manageUrl ? { manageUrl: data.manageUrl } : {}),
    ...(data.manageExpiresAt ? { manageExpiresAt: data.manageExpiresAt } : {}),
    places: (data.candidates ?? []).map((place) => place.name),
  };
}

export function appendHistory(entry, env = process.env) {
  const filePath = historyPath(env);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(filePath, 0o600);
  return filePath;
}

export function readHistory(env = process.env) {
  const filePath = historyPath(env);
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.url === 'string') entries.push(parsed);
    } catch {
      // Skip corrupted lines rather than breaking history lookup.
    }
  }
  return entries;
}

export function clearHistory(env = process.env) {
  const filePath = historyPath(env);
  if (!existsSync(filePath)) return { filePath, cleared: false };
  unlinkSync(filePath);
  return { filePath, cleared: true };
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

export function formatHistoryEntry(entry, index = null) {
  const lines = [];
  const headingParts = [];
  if (entry.title) headingParts.push(entry.title);
  const subtitle = [entry.what, entry.area ? `near ${entry.area}` : ''].filter(Boolean).join(' ');
  if (subtitle) headingParts.push(subtitle);
  const heading = headingParts.join(' — ') || entry.id || 'Poll';
  const when = formatTimestamp(entry.savedAt);
  const prefix = index === null ? '' : `${index}. `;
  lines.push(`${prefix}${heading}${when ? ` (${when})` : ''}`);
  const indent = index === null ? '  ' : '   ';
  if (entry.places?.length) lines.push(`${indent}Places: ${entry.places.join(', ')}`);
  lines.push(`${indent}Vote here: ${entry.url}`);
  if (entry.manageUrl) {
    lines.push(`${indent}Manage it: ${entry.manageUrl}`);
    if (entry.manageExpiresAt) {
      lines.push(`${indent}(one-time organiser link; expires ${entry.manageExpiresAt.slice(0, 10)} if unused)`);
    }
  }
  return lines.join('\n');
}

export function formatHistoryList(entries, filePath) {
  const shown = displayPath(filePath);
  if (!entries.length) {
    return [
      `No saved polls in ${shown}.`,
      'Polls created without --no-save (and without --preview) are saved there automatically.',
    ].join('\n');
  }
  const blocks = entries.map((entry, idx) => formatHistoryEntry(entry, idx + 1));
  blocks.push([
    `Saved in: ${shown} (private, owner-only)`,
    'Run `middle last --open` to open the latest poll, or `middle history --clear` to delete this file.',
  ].join('\n'));
  return blocks.join('\n\n');
}
