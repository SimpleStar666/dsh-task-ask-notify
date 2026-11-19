/**
 * dsh-task-ask-notify - audio selection policy.
 *
 * Maps a scenario to a directory, picks one WAV from it uniformly at random, and
 * reports that file's duration so the playback child process knows when it may
 * exit. Directory listings are cached against the directory's own mtime, so
 * dropping a new `.wav` into `audio/complete/` takes effect on the next alert
 * without restarting DSH.
 *
 * @module dsh-task-ask-notify/policy
 */

import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';

/** Bytes read from the front of a WAV when parsing its header. */
const WAV_HEADER_BYTES = 64 * 1024;
/** Declared `data` sizes at or above this are treated as "streaming/unknown". */
const MAX_PLAUSIBLE_DATA_BYTES = 0x7fffffff;

/**
 * Resolve a configured directory or file against one base directory.
 * Absolute paths pass through untouched, which is what lets a user point a
 * scenario straight at a folder they already have without copying anything.
 * @param target configured path
 * @param base absolute base directory
 * @returns an absolute path
 */
export function resolvePath(target, base) {
  if (typeof target !== 'string' || target === '') return '';
  return isAbsolute(target) ? target : resolve(base, target);
}

/**
 * @param candidate absolute path
 * @param cache directory cache, or undefined to accept any existing entry
 * @returns true when the path is a playable file, or a directory holding a WAV
 */
function isUsableAudioPath(candidate, cache) {
  let stats;
  try {
    stats = statSync(candidate);
  } catch {
    return false;
  }
  if (stats.isFile()) return true;
  if (!stats.isDirectory()) return false;
  // An empty directory must not shadow the bundled one, or importing nothing
  // would silently disable the scenario's sound.
  return cache === undefined ? true : cache.get(candidate).length > 0;
}

/**
 * Resolve a *relative* sound path against the user's audio root, then the package.
 *
 * A bundle installed from a package directory runs from that installed copy, so
 * files added to the clone afterwards are not visible to it. Relative paths
 * therefore prefer `<userRoot>/<relative>` when it actually holds something
 * playable, and otherwise fall back to the copy shipped inside the package. That
 * is what makes "drop a file in and it takes effect" true after installation,
 * while a fresh clone still works with no user directory at all.
 *
 * @param relative configured relative path
 * @param options resolution inputs
 * @param options.root absolute package root
 * @param options.userRoot absolute user audio root, or ''
 * @param options.cache directory cache used to tell an empty directory apart
 * @returns an absolute path, or '' when nothing was configured
 */
export function resolveAudioPath(relative, { root, userRoot, cache }) {
  if (typeof relative !== 'string' || relative === '') return '';
  if (isAbsolute(relative)) return relative;

  const candidates = [];
  if (typeof userRoot === 'string' && userRoot !== '') candidates.push(resolve(userRoot, relative));
  candidates.push(resolve(root ?? '', relative));

  for (const candidate of candidates) {
    if (isUsableAudioPath(candidate, cache)) return candidate;
  }
  // Nothing exists yet: report the bundled location, which the caller reports on.
  return candidates[candidates.length - 1];
}

/**
 * List the `.wav` files in one directory, sorted by name so a given random seed
 * always yields the same choice.
 * @param dir absolute directory path
 * @returns absolute file paths; an empty array when the directory is unusable
 */
export function listWavFiles(dir) {
  if (typeof dir !== 'string' || dir === '') return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => extname(name).toLowerCase() === '.wav')
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Pick one element from a list with equal probability.
 * @param items candidate list
 * @param random random source in [0, 1)
 * @returns the chosen element, or null for an empty list
 */
export function pickUniform(items, random = Math.random) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const value = random();
  const bounded = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.9999999999) : 0;
  return items[Math.floor(bounded * items.length)];
}

/**
 * Parse the duration of a RIFF/WAVE buffer from its headers.
 *
 * Duration is `data` bytes divided by the `fmt ` byte rate — the same arithmetic
 * as "bytes ÷ sample rate ÷ channels ÷ bits per sample" without needing to
 * understand the sample format. Anything this does not recognise returns null,
 * and the adapter script then falls back to the media engine's own duration.
 *
 * @param buffer at least the front of the file
 * @returns duration in milliseconds, or null when it cannot be determined
 */
export function parseWavDurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let byteRate = null;
  let dataBytes = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      if (body + 16 > buffer.length) return null;
      byteRate = buffer.readUInt32LE(body + 8);
    } else if (id === 'data') {
      if (size === 0 || size > MAX_PLAUSIBLE_DATA_BYTES) return null;
      dataBytes = size;
      break;
    }

    // Chunks are word-aligned: an odd size carries one pad byte.
    offset = body + size + (size % 2 === 1 ? 1 : 0);
  }

  if (byteRate === null || byteRate <= 0 || dataBytes === null) return null;
  return Math.round((dataBytes / byteRate) * 1000);
}

/**
 * Read just enough of a file to parse its WAV duration.
 * @param filePath absolute path
 * @returns duration in milliseconds, or null
 */
export function readWavDurationMs(filePath) {
  let descriptor;
  try {
    descriptor = openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(WAV_HEADER_BYTES);
    const read = readSync(descriptor, buffer, 0, WAV_HEADER_BYTES, 0);
    return parseWavDurationMs(read === WAV_HEADER_BYTES ? buffer : buffer.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* the descriptor is already gone; nothing to recover */
      }
    }
  }
}

/**
 * Caches directory listings so one alert does not list the same directory twice.
 *
 * Two details make this correct on Windows rather than merely fast:
 *
 *  - **An mtime check alone is not enough.** NTFS updates a directory's
 *    timestamp lazily, so adding a file to a directory can leave its mtime (and
 *    size) unchanged for a while. A cache keyed only on that would keep serving a
 *    stale listing and quietly miss a newly added sound. Every listing therefore
 *    also expires after `ttlMs`, so a directory is re-read at most once per alert
 *    rather than once per lookup.
 *  - **Deleting a file does not touch the parent's mtime at all** on NTFS. Adding
 *    one usually does, deleting one does not, so a key built from the directory's
 *    own stats cannot see a removal — a user who deleted a sound would keep hearing
 *    it until the ttl happened to expire, which is exactly the "I removed it and it
 *    is still playing" complaint. The signature therefore includes the newest file
 *    mtime *inside* the directory as well: removing the newest file changes it, and
 *    so does removing an older one when the listing is re-read for any other reason.
 *  - **An empty listing is never cached.** That is the "the scenario folder was
 *    empty, now I have dropped the first file in" case, and it must be picked up
 *    immediately rather than after a timeout.
 */
export class WavDirectoryCache {
  /** @type {Map<string, { key: string, files: string[], at: number }>} */
  #entries = new Map();

  /**
   * @param options cache options
   * @param options.listImpl injectable lister, for tests
   * @param options.ttlMs how long a non-empty listing may be reused, in milliseconds
   * @param options.now injectable clock, for tests
   */
  constructor({ listImpl = listWavFiles, ttlMs = 1000, now = () => Date.now() } = {}) {
    this.listImpl = listImpl;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /**
   * @param dir absolute directory path
   * @returns the currently valid listing for that directory
   */
  get(dir) {
    const key = WavDirectoryCache.#signature(dir);
    const at = this.now();
    const cached = this.#entries.get(dir);
    if (cached !== undefined && cached.key === key && at - cached.at < this.ttlMs) return cached.files;

    let files;
    try {
      files = this.listImpl(dir);
    } catch {
      files = [];
    }
    if (!Array.isArray(files)) files = [];
    if (files.length === 0) this.#entries.delete(dir);
    else this.#entries.set(dir, { key, files, at });
    return files;
  }

  /** Forget every cached listing. */
  clear() {
    this.#entries.clear();
  }

  /**
   * @param dir directory path
   * @returns a key that changes whenever the directory's contents may have changed
   */
  static #signature(dir) {
    try {
      const stats = statSync(dir);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch {
      return 'missing';
    }
  }
}

/**
 * Choose the file to play for one scenario.
 *
 * Preference order: the scenario directory, then the configured fallback (a
 * directory or a single file). A null result means "no sound" and is never an
 * error — audio problems must not disturb DSH.
 *
 * @param options selection inputs
 * @param options.dir absolute scenario directory
 * @param options.fallback absolute fallback file or directory, or ''
 * @param options.cache directory cache
 * @param options.random random source, for tests
 * @returns `{ path, durationMs, fallback }`, or null when nothing is playable
 */
export function chooseAudio({ dir, fallback, cache, random = Math.random }) {
  const candidates = cache.get(dir);
  if (candidates.length > 0) {
    const chosen = pickUniform(candidates, random);
    if (chosen !== null) {
      return { path: chosen, durationMs: readWavDurationMs(chosen), fallback: false };
    }
  }

  if (typeof fallback === 'string' && fallback !== '') {
    let stats = null;
    try {
      stats = statSync(fallback);
    } catch {
      stats = null;
    }
    if (stats?.isDirectory() === true) {
      const chosen = pickUniform(cache.get(fallback), random);
      if (chosen !== null) {
        return { path: chosen, durationMs: readWavDurationMs(chosen), fallback: true };
      }
    } else if (stats?.isFile() === true) {
      return { path: fallback, durationMs: readWavDurationMs(fallback), fallback: true };
    }
  }

  return null;
}

/**
 * Read a whole small file as a buffer, used by the AUMID shortcut check.
 * @param filePath absolute path
 * @returns the file contents, or null
 */
export function tryReadFile(filePath) {
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}
