#!/usr/bin/env node
/**
 * Renders the bundled failure alert: audio/failed/alert-fail.wav
 *
 * Why a second sound exists
 * -------------------------
 * The completion chime *rises* (880 Hz → 1318.5 Hz). Playing it when a turn
 * fails would be actively misleading: the same ear that learned "rising means
 * done" would report success on an error. So the failure cue *falls* instead —
 * a descending three-note figure over the same envelope, same sample rate, same
 * gain parameters, so the two are obviously siblings and obviously opposed:
 *
 *     completion:  880.00 Hz (0.18 s) → 1318.50 Hz (0.35 s)   rising
 *     failure:     659.25 Hz (0.14 s) →  554.37 Hz (0.14 s)   falling
 *                              →  440.00 Hz (0.30 s)
 *
 * Why generate it rather than commit an opaque blob
 * -------------------------------------------------
 * Same reason as `gen-default-chime.mjs`: a binary nobody can re-render is not
 * reviewable. This script is the source of `audio/failed/alert-fail.wav`, and
 * `--check` re-renders it and proves the committed bytes still match.
 *
 * Usage:
 *   node tools/gen-failure-alert.mjs [--out <path>] [--check] [--quiet]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SAMPLE_RATE,
  encodeWavPcm16,
  estimatePeakHz,
  renderChimeSamples,
} from './gen-default-chime.mjs';

/** The three falling tones of the failure alert. */
export const FAILURE_TONES = Object.freeze([
  Object.freeze({ frequency: 659.25, start: 0, duration: 0.14 }),
  Object.freeze({ frequency: 554.37, start: 0.14, duration: 0.14 }),
  Object.freeze({ frequency: 440, start: 0.28, duration: 0.3 }),
]);
/** Total rendered length; the last tone ends at 0.58 s, the rest is silent tail. */
export const FAILURE_TOTAL_SECONDS = 0.65;

/** Sample windows used by `--check` to prove each note is where it should be. */
const CHECK_WINDOWS = [
  { label: 'note 1', from: 0, to: 0.13, expected: 659.25 },
  { label: 'note 2', from: 0.15, to: 0.27, expected: 554.37 },
  { label: 'note 3', from: 0.3, to: 0.57, expected: 440 },
];

/** @returns the absolute path of the committed failure alert. */
export function defaultFailureAlertPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'audio', 'failed', 'alert-fail.wav');
}

function main(argv) {
  const quiet = argv.includes('--quiet');
  const check = argv.includes('--check');
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? defaultFailureAlertPath() : argv[outIndex + 1];
  if (out === undefined) {
    console.error('--out needs a path');
    return 2;
  }

  const samples = renderChimeSamples(SAMPLE_RATE, FAILURE_TONES, FAILURE_TOTAL_SECONDS);
  const wav = encodeWavPcm16(samples, SAMPLE_RATE);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, wav);
  if (!quiet) {
    console.log(`wrote ${out} (${wav.length} bytes, ${SAMPLE_RATE} Hz mono 16-bit PCM, ${FAILURE_TOTAL_SECONDS}s)`);
  }

  if (check) {
    let ok = true;
    for (const window of CHECK_WINDOWS) {
      const peak = estimatePeakHz(
        samples,
        SAMPLE_RATE,
        Math.round(SAMPLE_RATE * window.from),
        Math.round(SAMPLE_RATE * window.to),
        300,
        1000,
        2,
      );
      const close = Math.abs(peak - window.expected) <= 2;
      ok = ok && close;
      console.log(`${window.label} peak: ${peak.toFixed(2)} Hz (expected ${window.expected})${close ? '' : '  <-- MISMATCH'}`);
    }
    console.log(ok ? 'CHECK OK' : 'CHECK FAILED');
    return ok ? 0 : 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
