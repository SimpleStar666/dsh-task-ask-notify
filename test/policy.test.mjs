/**
 * Audio policy: directory convention, uniform random choice, WAV duration, and
 * the mtime-keyed cache that makes "drop in a new file" work without a restart.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import {
  WavDirectoryCache,
  chooseAudio,
  listWavFiles,
  parseWavDurationMs,
  pickUniform,
  readWavDurationMs,
  resolveAudioPath,
  resolvePath,
} from '../lib/policy.js';
import { cleanupTempDirs, makeTempDir, wavHeader, writeWav } from './helpers.mjs';

after(cleanupTempDirs);

test('listWavFiles returns only .wav files, sorted, and tolerates a missing directory', () => {
  const dir = makeTempDir();
  writeWav(dir, 'b.wav');
  writeWav(dir, 'a.wav');
  writeFileSync(join(dir, 'notes.txt'), 'not audio');
  mkdirSync(join(dir, 'nested'));
  writeWav(join(dir, 'nested'), 'deep.wav');

  const files = listWavFiles(dir);
  assert.deepEqual(
    files.map((file) => file.slice(dir.length + 1)),
    ['a.wav', 'b.wav'],
  );
  assert.deepEqual(listWavFiles(join(dir, 'does-not-exist')), []);
  assert.deepEqual(listWavFiles(''), []);
});

test('pickUniform covers every entry with the expected frequency', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const draws = 3000;
  const counts = new Map(items.map((item) => [item, 0]));
  let seed = 123456789;
  const random = () => {
    // Deterministic xorshift so the assertion cannot flake.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };

  for (let index = 0; index < draws; index += 1) {
    const chosen = pickUniform(items, random);
    counts.set(chosen, counts.get(chosen) + 1);
  }

  const expected = draws / items.length;
  const sigma = Math.sqrt(draws * (1 / items.length) * (1 - 1 / items.length));
  for (const item of items) {
    const observed = counts.get(item);
    assert.ok(observed > 0, `${item} was never chosen`);
    assert.ok(
      Math.abs(observed - expected) <= 3 * sigma,
      `${item} chose ${observed}, expected about ${expected} (3 sigma = ${Math.round(3 * sigma)})`,
    );
  }
});

test('pickUniform clamps a broken random source instead of returning undefined', () => {
  assert.equal(pickUniform(['only'], () => 1), 'only');
  assert.equal(pickUniform(['only'], () => -1), 'only');
  assert.equal(pickUniform(['only'], () => Number.NaN), 'only');
  assert.equal(pickUniform([], () => 0.5), null);
  assert.equal(pickUniform(null, () => 0.5), null);
});

test('WAV duration is derived from the data chunk and byte rate', () => {
  // 22050 Hz mono 16-bit => 44100 bytes per second; 22050 bytes => 500 ms.
  assert.equal(parseWavDurationMs(wavHeader({ dataBytes: 22050 })), 500);
  // Stereo doubles the byte rate for the same sample count.
  assert.equal(parseWavDurationMs(wavHeader({ dataBytes: 44100, channels: 2 })), 500);
  // 48000 Hz 16-bit mono.
  assert.equal(parseWavDurationMs(wavHeader({ sampleRate: 48000, dataBytes: 48000 })), 500);
});

test('a chunk with an odd size is skipped word-aligned', () => {
  const header = wavHeader({ dataBytes: 100 });
  // Insert an odd-sized JUNK chunk between fmt and data.
  const junk = Buffer.alloc(8 + 3 + 1);
  junk.write('JUNK', 0, 'ascii');
  junk.writeUInt32LE(3, 4);
  const rebuilt = Buffer.concat([header.subarray(0, 36), junk, header.subarray(36)]);
  rebuilt.writeUInt32LE(36 + 100 + junk.length, 4);
  assert.equal(parseWavDurationMs(rebuilt), Math.round((100 / 44100) * 1000));
});

test('unrecognised or truncated headers report "unknown" instead of throwing', () => {
  assert.equal(parseWavDurationMs(wavHeader({ id: 'RIFX' })), null);
  assert.equal(parseWavDurationMs(Buffer.alloc(4)), null);
  assert.equal(parseWavDurationMs(Buffer.from('not a wav file at all')), null);
  assert.equal(parseWavDurationMs(null), null);
  // A fmt chunk that promises more bytes than are present.
  assert.equal(parseWavDurationMs(wavHeader({ fmtSize: 200 }).subarray(0, 30)), null);
  // A data size that can only mean "streaming".
  assert.equal(parseWavDurationMs(wavHeader({ dataBytes: 0 })), null);
});

test('readWavDurationMs reads a real file and reports null for a missing one', () => {
  const dir = makeTempDir();
  const file = writeWav(dir, 'half.wav', 0.5);
  const duration = readWavDurationMs(file);
  assert.ok(Math.abs(duration - 500) <= 1, `expected about 500 ms, got ${duration}`);
  assert.equal(readWavDurationMs(join(dir, 'missing.wav')), null);
});

test('chooseAudio prefers the scenario directory and falls back only when it is unusable', () => {
  const root = makeTempDir();
  const complete = join(root, 'complete');
  const fallbackDir = join(root, 'fallback');
  mkdirSync(complete);
  mkdirSync(fallbackDir);
  const wanted = writeWav(complete, 'chosen.wav', 0.4);
  writeWav(fallbackDir, 'default.wav', 0.6);

  const cache = new WavDirectoryCache();
  const hit = chooseAudio({ dir: complete, fallback: join(fallbackDir, 'default.wav'), cache, random: () => 0 });
  assert.equal(hit.path, wanted);
  assert.equal(hit.fallback, false);
  assert.equal(hit.durationMs, 400);

  const emptyDir = join(root, 'empty');
  mkdirSync(emptyDir);
  const miss = chooseAudio({ dir: emptyDir, fallback: join(fallbackDir, 'default.wav'), cache, random: () => 0 });
  assert.equal(miss.path, join(fallbackDir, 'default.wav'));
  assert.equal(miss.fallback, true);
  assert.equal(miss.durationMs, 600);

  // A fallback that is a directory also works.
  const dirFallback = chooseAudio({ dir: emptyDir, fallback: fallbackDir, cache, random: () => 0 });
  assert.equal(dirFallback.path, join(fallbackDir, 'default.wav'));

  // Nothing playable at all is not an error.
  assert.equal(chooseAudio({ dir: emptyDir, fallback: join(root, 'nope.wav'), cache }), null);
  assert.equal(chooseAudio({ dir: join(root, 'nope'), fallback: '', cache }), null);
});

test('the directory cache notices files added and removed while running', () => {
  const dir = makeTempDir();
  writeWav(dir, 'first.wav');

  // A zero lifetime forces a fresh listing on every lookup, which is what the
  // cache does once its lifetime has passed.
  let clock = 1000;
  const cache = new WavDirectoryCache({ ttlMs: 0, now: () => clock });
  assert.equal(cache.get(dir).length, 1);

  writeWav(dir, 'second.wav');
  clock += 10;
  assert.equal(cache.get(dir).length, 2, 'a new file must be picked up without a restart');

  rmSync(join(dir, 'first.wav'));
  clock += 10;
  assert.equal(cache.get(dir).length, 1, 'a removed file must stop being offered');
});

test('the directory cache reuses a listing only within its lifetime', () => {
  let calls = 0;
  let clock = 1000;
  const cache = new WavDirectoryCache({
    listImpl: () => {
      calls += 1;
      return ['a.wav'];
    },
    ttlMs: 500,
    now: () => clock,
  });
  const dir = makeTempDir();

  cache.get(dir);
  cache.get(dir);
  assert.equal(calls, 1, 'lookups inside one alert must not re-list');

  clock += 600;
  cache.get(dir);
  assert.equal(calls, 2, 'after the lifetime the directory is read again, so lazy NTFS timestamps cannot hide a new file');

  cache.clear();
  cache.get(dir);
  assert.equal(calls, 3);
});

test('an empty listing is never cached, so a first dropped-in file is seen at once', () => {
  let files = [];
  const cache = new WavDirectoryCache({ listImpl: () => files, ttlMs: 1_000_000 });
  const dir = makeTempDir();

  assert.deepEqual(cache.get(dir), []);
  // The lifetime is deliberately huge here: emptiness alone must defeat the cache.
  files = ['first.wav'];
  assert.deepEqual(cache.get(dir), ['first.wav']);
});

test('a listing failure degrades to an empty list', () => {
  const cache = new WavDirectoryCache({
    listImpl: () => {
      throw new Error('permission denied');
    },
  });
  assert.deepEqual(cache.get(makeTempDir()), []);
});

test('relative sound directories resolve against the plugin root, absolute ones do not', () => {
  assert.equal(resolvePath('audio/complete', 'C:/plugin'), join('C:/plugin', 'audio/complete'));
  assert.equal(resolvePath('C:/elsewhere/sounds', 'C:/plugin'), 'C:/elsewhere/sounds');
  assert.equal(resolvePath('', 'C:/plugin'), '');
});

test('a relative sound path prefers the user audio root, but only when it holds something', () => {
  const root = makeTempDir();
  const userRoot = makeTempDir();
  const cache = new WavDirectoryCache();

  const bundled = join(root, 'audio', 'complete');
  mkdirSync(bundled, { recursive: true });
  const bundledFile = writeWav(bundled, 'bundled.wav');

  // Nothing in the user root yet: the bundled directory wins.
  assert.equal(resolveAudioPath('audio/complete', { root, userRoot, cache }), bundled);

  // An empty user directory must not shadow the bundled one.
  mkdirSync(join(userRoot, 'audio', 'complete'), { recursive: true });
  assert.equal(resolveAudioPath('audio/complete', { root, userRoot, cache }), bundled);

  // Once it holds a sound, the user's directory wins.
  const userFile = writeWav(join(userRoot, 'audio', 'complete'), 'mine.wav');
  assert.equal(resolveAudioPath('audio/complete', { root, userRoot, cache }), join(userRoot, 'audio', 'complete'));

  // A single file is used whenever it exists.
  assert.equal(resolveAudioPath('audio/_default/chime.wav', { root, userRoot, cache }), join(root, 'audio', '_default', 'chime.wav'));
  writeWav(join(userRoot, 'audio', '_default'), 'chime.wav');
  assert.equal(
    resolveAudioPath('audio/_default/chime.wav', { root, userRoot, cache }),
    join(userRoot, 'audio', '_default', 'chime.wav'),
  );

  // Absolute paths bypass the whole preference order.
  assert.equal(resolveAudioPath(userFile, { root, userRoot, cache }), userFile);
  assert.equal(resolveAudioPath('', { root, userRoot, cache }), '');
  // With no user root configured, resolution is the plain package-relative one.
  assert.equal(resolveAudioPath('audio/complete', { root, userRoot: '', cache }), bundled);
  // Nothing exists at all: the bundled path is still reported.
  assert.equal(resolveAudioPath('audio/missing', { root, userRoot, cache }), join(root, 'audio', 'missing'));
});
