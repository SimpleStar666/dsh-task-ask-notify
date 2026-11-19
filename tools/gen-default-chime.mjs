#!/usr/bin/env node
/**
 * Renders the bundled fallback chime: audio/_default/chime.wav
 *
 * Why generate it instead of shipping a sound file
 * ------------------------------------------------
 * The reference DSH plugin `@yangzhe1991/dsh-web-enhance` synthesises its "run
 * finished" chime in the browser with Web Audio (`tone()` / `playChime()` in its
 * client bundle) and therefore ships no audio asset. A Host-side plugin has no
 * Web Audio, so this script renders the same two tones offline with the same
 * envelope parameters and writes a plain WAV next to the plugin.
 *
 * Keeping the generator in the repository means the committed audio is
 * reproducible: anyone can re-render it and compare, and no third-party sound
 * file had to be copied into the public tree.
 *
 * Reference parameters (880 Hz for 0.18 s, then 1318.5 Hz for 0.35 s; each tone
 * ramps 1e-4 -> 0.25 exponentially over 20 ms, then exponentially down to 1e-4).
 *
 * Usage:
 *   node tools/gen-default-chime.mjs [--out <path>] [--check] [--quiet]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Sample rate shared with the built-in directory convention (22 050 Hz mono). */
export const SAMPLE_RATE = 22050;
/** Gain ramp floor used by the reference Web Audio code (`1e-4`). */
export const GAIN_FLOOR = 1e-4;
/** Gain peak used by the reference Web Audio code (`0.25`). */
export const GAIN_PEAK = 0.25;
/** Attack length of each tone, in seconds. */
export const ATTACK_SECONDS = 0.02;
/** The two tones of the reference "finished, not failed" chime. */
export const TONES = Object.freeze([
  Object.freeze({ frequency: 880, start: 0, duration: 0.18 }),
  Object.freeze({ frequency: 1318.5, start: 0.18, duration: 0.35 }),
]);
/** Total rendered length; the second tone ends at 0.53 s, the rest is silent tail. */
export const TOTAL_SECONDS = 0.6;

/**
 * Web Audio `exponentialRampToValueAtTime` between two points.
 * @param fromValue value at fromTime (must be non-zero, as in Web Audio)
 * @param toValue value at toTime
 * @param fromTime ramp start, seconds
 * @param toTime ramp end, seconds
 * @param time evaluation time, seconds
 * @returns the interpolated value
 */
export function exponentialRamp(fromValue, toValue, fromTime, toTime, time) {
  if (toTime <= fromTime) return toValue;
  const ratio = (time - fromTime) / (toTime - fromTime);
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return fromValue * Math.pow(toValue / fromValue, clamped);
}

/**
 * Gain envelope of one reference tone at an absolute time.
 * @param tone tone specification ({ frequency, start, duration })
 * @param time absolute time in seconds
 * @returns the gain, or 0 outside the tone
 */
export function toneGain(tone, time) {
  const local = time - tone.start;
  if (local < 0) return 0;
  if (local >= tone.duration) return 0;
  if (local < ATTACK_SECONDS) {
    return exponentialRamp(GAIN_FLOOR, GAIN_PEAK, 0, ATTACK_SECONDS, local);
  }
  return exponentialRamp(
    GAIN_PEAK,
    GAIN_FLOOR,
    ATTACK_SECONDS,
    tone.duration,
    local,
  );
}

/**
 * Render the chime as floating point samples in [-1, 1].
 * @param sampleRate output sample rate
 * @param tones tones to mix (each has its own oscillator phase, as in Web Audio)
 * @param totalSeconds rendered length
 * @returns a Float64Array of samples
 */
export function renderChimeSamples(sampleRate, tones, totalSeconds) {
  const length = Math.round(sampleRate * totalSeconds);
  const samples = new Float64Array(length);
  for (const tone of tones) {
    const lastIndex = Math.min(length, Math.ceil(sampleRate * (tone.start + tone.duration)) + 1);
    const firstIndex = Math.max(0, Math.floor(sampleRate * tone.start));
    for (let index = firstIndex; index < lastIndex; index += 1) {
      const time = index / sampleRate;
      const gain = toneGain(tone, time);
      if (gain === 0) continue;
      samples[index] += gain * Math.sin(2 * Math.PI * tone.frequency * (time - tone.start));
    }
  }
  return samples;
}

/**
 * Encode mono float samples as a 16-bit PCM RIFF/WAVE buffer.
 * @param samples mono samples in [-1, 1]
 * @param sampleRate sample rate
 * @returns a Buffer holding the complete file
 */
export function encodeWavPcm16(samples, sampleRate) {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    const quantised = Math.round(clamped * (clamped < 0 ? 32768 : 32767));
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, quantised)), 44 + index * bytesPerSample);
  }
  return buffer;
}

/**
 * Estimate the dominant frequency of a sample window by a coarse-to-fine
 * magnitude search. Used by --check and by the test suite to prove the rendered
 * chime really contains 880 Hz and 1318.5 Hz.
 * @param samples mono samples
 * @param sampleRate sample rate
 * @param fromIndex first sample of the window
 * @param toIndex end of the window (exclusive)
 * @param minHz lowest candidate frequency
 * @param maxHz highest candidate frequency
 * @param coarseStepHz coarse search step
 * @returns the estimated dominant frequency in Hz
 */
export function estimatePeakHz(samples, sampleRate, fromIndex, toIndex, minHz, maxHz, coarseStepHz = 2) {
  const magnitude = (hz) => {
    let real = 0;
    let imaginary = 0;
    const omega = (2 * Math.PI * hz) / sampleRate;
    for (let index = fromIndex; index < toIndex; index += 1) {
      const angle = omega * (index - fromIndex);
      real += samples[index] * Math.cos(angle);
      imaginary += samples[index] * Math.sin(angle);
    }
    return Math.hypot(real, imaginary);
  };

  let bestHz = minHz;
  let bestMagnitude = -1;
  for (let hz = minHz; hz <= maxHz; hz += coarseStepHz) {
    const value = magnitude(hz);
    if (value > bestMagnitude) {
      bestMagnitude = value;
      bestHz = hz;
    }
  }
  for (let hz = bestHz - coarseStepHz; hz <= bestHz + coarseStepHz; hz += 0.05) {
    const value = magnitude(hz);
    if (value > bestMagnitude) {
      bestMagnitude = value;
      bestHz = hz;
    }
  }
  return bestHz;
}

/** @returns the absolute path of the committed default chime. */
export function defaultChimePath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'audio', '_default', 'chime.wav');
}

function main(argv) {
  const quiet = argv.includes('--quiet');
  const check = argv.includes('--check');
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? defaultChimePath() : argv[outIndex + 1];
  if (out === undefined) {
    console.error('--out needs a path');
    return 2;
  }

  const samples = renderChimeSamples(SAMPLE_RATE, TONES, TOTAL_SECONDS);
  const wav = encodeWavPcm16(samples, SAMPLE_RATE);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, wav);
  if (!quiet) {
    console.log(`wrote ${out} (${wav.length} bytes, ${SAMPLE_RATE} Hz mono 16-bit PCM, ${TOTAL_SECONDS}s)`);
  }

  if (check) {
    const firstEnd = Math.round(SAMPLE_RATE * 0.17);
    const secondStart = Math.round(SAMPLE_RATE * 0.19);
    const secondEnd = Math.round(SAMPLE_RATE * 0.52);
    const peakA = estimatePeakHz(samples, SAMPLE_RATE, 0, firstEnd, 400, 2000, 2);
    const peakB = estimatePeakHz(samples, SAMPLE_RATE, secondStart, secondEnd, 400, 2500, 2);
    console.log(`peak of tone 1: ${peakA.toFixed(2)} Hz (expected 880)`);
    console.log(`peak of tone 2: ${peakB.toFixed(2)} Hz (expected 1318.5)`);
    const okA = Math.abs(peakA - 880) <= 2;
    const okB = Math.abs(peakB - 1318.5) <= 2;
    console.log(okA && okB ? 'CHECK OK' : 'CHECK FAILED');
    return okA && okB ? 0 : 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
