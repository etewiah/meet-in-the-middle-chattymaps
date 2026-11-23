// Offline tests for src/mapkit-helper.swift: verifies it compiles cleanly on
// macOS and handles invalid arguments with structured JSON errors (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appleMapsAvailable, helperPath } from '../src/apple.js';

const run = promisify(execFile);
const hasSwift = await appleMapsAvailable();

async function runHelperExpectError(binary, args) {
  try {
    await run(binary, args, { timeout: 10_000 });
    assert.fail(`Expected helper to exit non-zero for args: ${JSON.stringify(args)}`);
  } catch (error) {
    assert.equal(error.code, 1);
    const parsed = JSON.parse(error.stdout);
    assert.equal(typeof parsed.error, 'string');
    assert.ok(parsed.error.length > 0);
    return parsed.error;
  }
}

test('mapkit-helper.swift compiles cleanly and reports structured JSON usage errors', { skip: !hasSwift }, async () => {
  const binary = await helperPath();
  assert.match(await runHelperExpectError(binary, []), /usage:/i);
  assert.match(await runHelperExpectError(binary, ['bogus']), /unknown command/i);
  assert.match(await runHelperExpectError(binary, ['geocode']), /usage:/i);
  assert.match(await runHelperExpectError(binary, ['geocode', 'London', 'gb', 'not-a-lat', '0']), /must be a number/i);
  assert.match(await runHelperExpectError(binary, ['search', 'pubs', 'bad', '0', '1000']), /must be a number/i);
  assert.match(await runHelperExpectError(binary, ['reverse', '51.5']), /usage:/i);
});
