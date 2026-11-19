/**
 * The OS boundary: the plugin's configuration is a 0–100 percentage while the
 * adapter's player takes a 0–1 fraction, so the handover is worth pinning down.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliver } from '../lib/index.js';
import { recordingLogger } from './helpers.mjs';

/**
 * Build a deliver function whose spawned payloads are captured instead of run.
 * @returns `{ deliver, payloads }`
 */
function captureDeliver() {
  const payloads = [];
  const deliver = createDeliver({
    log: recordingLogger(),
    powershellPath: 'C:/ps.exe',
    scriptPath: 'C:/win-alert.ps1',
    spawnImpl: (_command, args) => {
      // The payload travels as the single base64 argument after `-File <script>`.
      payloads.push(JSON.parse(Buffer.from(args[6], 'base64').toString('utf8')));
      return { on: () => {}, unref: () => {} };
    },
  });
  return { deliver, payloads };
}

/** @param overrides fields to override on a complete alert description */
function alert(overrides = {}) {
  return {
    scenario: 'complete',
    title: '任务完成',
    body: 'a session',
    notify: true,
    audio: { path: 'C:/sounds/complete/a.wav', durationMs: 1234 },
    volume: 100,
    aumid: 'com.deepseek.dsh',
    silentSystemSound: true,
    maxDurationMs: 10000,
    ...overrides,
  };
}

test('the configured 0–100 volume reaches the adapter as a 0–1 fraction', () => {
  const { deliver, payloads } = captureDeliver();

  deliver(alert({ volume: 50 }));
  deliver(alert({ volume: 0 }));
  deliver(alert({ volume: 100 }));
  deliver(alert({ volume: 5 }));
  assert.deepEqual(
    payloads.map((payload) => payload.volume),
    [0.5, 0, 1, 0.05],
  );

  // Out of range clamps instead of silencing by accident, and a missing value
  // means full amplitude rather than zero.
  deliver(alert({ volume: 500 }));
  deliver(alert({ volume: -20 }));
  deliver(alert({ volume: undefined }));
  deliver(alert({ volume: Number.NaN }));
  assert.deepEqual(
    payloads.slice(4).map((payload) => payload.volume),
    [1, 0, 1, 1],
  );
});

test('the payload carries the resolved audio and its duration', () => {
  const { deliver, payloads } = captureDeliver();
  deliver(alert());
  assert.equal(payloads[0].audioPath, 'C:/sounds/complete/a.wav');
  assert.equal(payloads[0].durationMs, 1234);
  assert.equal(payloads[0].notify, true);
  assert.equal(payloads[0].silent, true);
  assert.equal(payloads[0].title, '任务完成');
});

test('an audio-only alert is delivered, and an empty one starts no process', () => {
  const { deliver, payloads } = captureDeliver();

  // The listen button: sound, no notification.
  deliver(alert({ notify: false }));
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].notify, false);
  assert.equal(payloads[0].audio, true);

  // A notification with no sound.
  deliver(alert({ audio: null }));
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].audio, false);
  assert.equal(payloads[1].audioPath, '');
  assert.equal(payloads[1].durationMs, null);

  // Nothing to do: no child process at all.
  deliver(alert({ notify: false, audio: null }));
  assert.equal(payloads.length, 2, 'a delivery with neither half must not spawn');
});

test('a spawn failure is reported to the caller instead of escaping', () => {
  const exits = [];
  const deliver = createDeliver({
    log: recordingLogger(),
    powershellPath: 'C:/ps.exe',
    scriptPath: 'C:/win-alert.ps1',
    spawnImpl: () => {
      throw new Error('spawn refused');
    },
  });
  assert.doesNotThrow(() => deliver(alert({ onExit: (code, detail) => exits.push([code, detail]) })));
  assert.equal(exits.length, 1);
  assert.equal(exits[0][0], -1);
  assert.match(String(exits[0][1]), /spawn refused/);
});
