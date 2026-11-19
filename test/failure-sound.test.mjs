/**
 * The bundled failure alert: audio/failed/alert-fail.wav.
 *
 * Same contract as `chime.test.mjs` for the completion sound: the committed
 * binary must be exactly what `tools/gen-failure-alert.mjs` renders today, and
 * it must actually contain the descending notes it claims to — a repository
 * that ships an unreviewable sound is worse than one that ships none.
 *
 * The last assertion is the point of the whole file: the failure cue must not
 * be the completion chime wearing a different filename, because a rising tone
 * played on an error would tell the user the exact opposite of the truth.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readWavDurationMs } from '../lib/policy.js';
import { defaultChimePath, encodeWavPcm16, renderChimeSamples, SAMPLE_RATE as CHIME_RATE } from '../tools/gen-default-chime.mjs';
import {
  FAILURE_TOTAL_SECONDS,
  FAILURE_TONES,
  defaultFailureAlertPath,
} from '../tools/gen-failure-alert.mjs';
import { estimatePeakHz, SAMPLE_RATE } from '../tools/gen-default-chime.mjs';

test('the three notes fall instead of rising', () => {
  assert.deepEqual(
    FAILURE_TONES.map((tone) => [tone.frequency, tone.start, tone.duration]),
    [
      [659.25, 0, 0.14],
      [554.37, 0.14, 0.14],
      [440, 0.28, 0.3],
    ],
    'the completion chime rises 880 -> 1318.5; the failure cue must do the opposite',
  );
  assert.ok(FAILURE_TONES[0].frequency > FAILURE_TONES.at(-1).frequency, 'the figure must descend overall');
});

test('the rendered alert peaks at the documented frequencies', () => {
  const samples = renderChimeSamples(SAMPLE_RATE, FAILURE_TONES, FAILURE_TOTAL_SECONDS);
  const peaks = [
    [0, 0.13, 659.25],
    [0.15, 0.27, 554.37],
    [0.3, 0.57, 440],
  ].map(([from, to, expected]) => ({
    expected,
    actual: estimatePeakHz(samples, SAMPLE_RATE, Math.round(SAMPLE_RATE * from), Math.round(SAMPLE_RATE * to), 300, 1000, 2),
  }));

  for (const { expected, actual } of peaks) {
    assert.ok(Math.abs(actual - expected) <= 2, `peak was ${actual} Hz, expected ${expected} Hz`);
  }
});

test('the committed WAV is exactly what the generator produces today', () => {
  const expected = encodeWavPcm16(renderChimeSamples(SAMPLE_RATE, FAILURE_TONES, FAILURE_TOTAL_SECONDS), SAMPLE_RATE);
  const actual = readFileSync(defaultFailureAlertPath());
  assert.equal(
    actual.equals(expected),
    true,
    'audio/failed/alert-fail.wav differs from a fresh render; run node tools/gen-failure-alert.mjs and commit the result',
  );
});

test('the committed WAV is 22050 Hz mono 16-bit PCM of the documented length', () => {
  const buffer = readFileSync(defaultFailureAlertPath());
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.readUInt16LE(20), 1, 'uncompressed PCM');
  assert.equal(buffer.readUInt16LE(22), 1, 'mono');
  assert.equal(buffer.readUInt32LE(24), 22050, 'sample rate');
  assert.equal(buffer.readUInt16LE(34), 16, 'bits per sample');
  assert.equal(buffer.readUInt32LE(40), buffer.length - 44, 'data chunk covers the rest of the file');
  assert.equal(readWavDurationMs(defaultFailureAlertPath()), Math.round(FAILURE_TOTAL_SECONDS * 1000));
});

test('the failure cue is not the completion chime under another name', () => {
  const failure = readFileSync(defaultFailureAlertPath());
  const chime = readFileSync(defaultChimePath());
  assert.equal(failure.equals(chime), false, 'identical bytes would make the two situations indistinguishable by ear');
  assert.equal(CHIME_RATE, SAMPLE_RATE, 'both sounds must share a sample rate');
});
