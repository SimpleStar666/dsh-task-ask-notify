/**
 * The bundled default chime.
 *
 * Two things are checked: that the renderer really produces the reference
 * frequencies, and that the committed `audio/_default/chime.wav` is byte-for-byte
 * what the renderer produces now. The second assertion is what makes the audio
 * asset reviewable — a binary in the repository that no script can reproduce is
 * an unreviewable blob, and this one is not.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GAIN_FLOOR,
  GAIN_PEAK,
  SAMPLE_RATE,
  TONES,
  TOTAL_SECONDS,
  defaultChimePath,
  encodeWavPcm16,
  estimatePeakHz,
  exponentialRamp,
  renderChimeSamples,
  toneGain,
} from '../tools/gen-default-chime.mjs';
import { readWavDurationMs } from '../lib/policy.js';

test('the two reference tones are 880 Hz then 1318.5 Hz', () => {
  assert.deepEqual(
    TONES.map((tone) => [tone.frequency, tone.start, tone.duration]),
    [
      [880, 0, 0.18],
      [1318.5, 0.18, 0.35],
    ],
  );
});

test('the rendered chime peaks at the reference frequencies', () => {
  const samples = renderChimeSamples(SAMPLE_RATE, TONES, TOTAL_SECONDS);
  const firstEnd = Math.round(SAMPLE_RATE * 0.17);
  const secondStart = Math.round(SAMPLE_RATE * 0.19);
  const secondEnd = Math.round(SAMPLE_RATE * 0.52);

  const peakA = estimatePeakHz(samples, SAMPLE_RATE, 0, firstEnd, 400, 2000, 2);
  const peakB = estimatePeakHz(samples, SAMPLE_RATE, secondStart, secondEnd, 400, 2500, 2);

  assert.ok(Math.abs(peakA - 880) <= 2, `tone 1 peak was ${peakA} Hz`);
  assert.ok(Math.abs(peakB - 1318.5) <= 2, `tone 2 peak was ${peakB} Hz`);
});

test('the envelope matches Web Audio exponential ramps', () => {
  assert.equal(toneGain(TONES[0], -0.001), 0, 'silent before the tone starts');
  assert.equal(toneGain(TONES[0], TONES[0].duration), 0, 'silent at the end of the tone');

  const midAttack = toneGain(TONES[0], 0.01);
  assert.ok(midAttack > GAIN_FLOOR && midAttack < GAIN_PEAK, 'the attack interpolates between the two gains');

  // Halfway through the ramp the value is the geometric mean, which is what makes
  // it exponential rather than linear.
  assert.ok(Math.abs(midAttack - Math.sqrt(GAIN_FLOOR * GAIN_PEAK)) < 1e-9);
  assert.equal(exponentialRamp(1e-4, 0.25, 0, 0.02, 0.02), 0.25);
  assert.equal(exponentialRamp(1e-4, 0.25, 0, 0.02, -5), 1e-4);
  assert.equal(exponentialRamp(1e-4, 0.25, 0, 0.02, 5), 0.25);
});

test('the committed WAV is exactly what the generator produces today', () => {
  const expected = encodeWavPcm16(renderChimeSamples(SAMPLE_RATE, TONES, TOTAL_SECONDS), SAMPLE_RATE);
  const actual = readFileSync(defaultChimePath());
  assert.equal(
    actual.equals(expected),
    true,
    'audio/_default/chime.wav differs from a fresh render; run `npm run chime` and commit the result',
  );
});

test('the committed WAV is 22050 Hz mono 16-bit PCM with the documented length', () => {
  const buffer = readFileSync(defaultChimePath());
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.readUInt16LE(20), 1, 'uncompressed PCM');
  assert.equal(buffer.readUInt16LE(22), 1, 'mono');
  assert.equal(buffer.readUInt32LE(24), 22050, 'sample rate');
  assert.equal(buffer.readUInt16LE(34), 16, 'bits per sample');
  assert.equal(buffer.readUInt32LE(40), buffer.length - 44, 'data chunk covers the rest of the file');

  const duration = readWavDurationMs(defaultChimePath());
  assert.equal(duration, Math.round(TOTAL_SECONDS * 1000));
});

test('rendering is deterministic', () => {
  const first = encodeWavPcm16(renderChimeSamples(SAMPLE_RATE, TONES, TOTAL_SECONDS), SAMPLE_RATE);
  const second = encodeWavPcm16(renderChimeSamples(SAMPLE_RATE, TONES, TOTAL_SECONDS), SAMPLE_RATE);
  assert.equal(first.equals(second), true);
});
