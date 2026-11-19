/**
 * Shared helpers for the test suite.
 *
 * Everything here stays inside `os.tmpdir()`: the tests never write into the
 * repository, so running them cannot dirty the working tree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAMPLE_RATE, encodeWavPcm16, renderChimeSamples } from '../tools/gen-default-chime.mjs';

/** Temporary directories created by this run, removed by {@link cleanupTempDirs}. */
const created = [];

/**
 * @param prefix directory name prefix
 * @returns an absolute path to a fresh temporary directory
 */
export function makeTempDir(prefix = 'dsh-task-ask-notify-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Remove every temporary directory this run created. */
export function cleanupTempDirs() {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort: a leftover temp directory is harmless */
    }
  }
}

/**
 * Write a playable WAV into a directory.
 * @param dir target directory
 * @param fileName file name
 * @param seconds length in seconds
 * @param frequency tone frequency
 * @returns the absolute path written
 */
export function writeWav(dir, fileName, seconds = 0.25, frequency = 440) {
  const samples = renderChimeSamples(SAMPLE_RATE, [{ frequency, start: 0, duration: seconds }], seconds);
  const target = join(dir, fileName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, encodeWavPcm16(samples, SAMPLE_RATE));
  return target;
}

/**
 * Build a raw RIFF/WAVE header without any sample data, for header-parsing tests.
 * @param options header fields
 * @param options.sampleRate sample rate
 * @param options.channels channel count
 * @param options.bitsPerSample bits per sample
 * @param options.dataBytes declared size of the data chunk
 * @param options.fmtSize declared size of the fmt chunk
 * @param options.id leading chunk identifier
 * @param options.format WAVE format tag
 * @returns a buffer
 */
export function wavHeader({ sampleRate = 22050, channels = 1, bitsPerSample = 16, dataBytes = 22050, fmtSize = 16, id = 'RIFF', format = 1 } = {}) {
  const header = Buffer.alloc(44);
  header.write(id, 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(fmtSize, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * A fake logger that records what a module reported.
 * @returns `{ entries, debug, info, warn, error }`
 */
export function recordingLogger() {
  const entries = [];
  const record = (level) => (message) => entries.push({ level, message: String(message) });
  return {
    entries,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    text: () => entries.map((entry) => `${entry.level}: ${entry.message}`).join('\n'),
  };
}

/**
 * A deterministic clock and timer queue, so debounce behaviour can be tested
 * without waiting for real time to pass.
 * @returns `{ now, setTimer, clearTimer, advance }`
 */
export function fakeClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => current,
    setTimer: (callback, delay) => {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    /**
     * Move time forward, running every timer that becomes due.
     * @param ms milliseconds to advance
     */
    advance: (ms) => {
      const target = current + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (due === null || timer.at < due.timer.at) due = { id, timer };
        }
        if (due === null) break;
        timers.delete(due.id);
        current = Math.max(current, due.timer.at);
        due.timer.callback();
      }
      current = target;
    },
    /** @returns the number of timers still scheduled */
    pending: () => timers.size,
  };
}
