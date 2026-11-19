#!/usr/bin/env node
/**
 * End-to-end self-test for the Windows adapter: shows one real toast and plays
 * one real WAV, in the foreground, so the exit code and any stderr text are
 * visible.
 *
 * This is deliberately NOT part of `npm test`: it pops a notification and makes
 * a sound on the machine that runs it. Run it by hand after installing the
 * plugin, or when notifications stop appearing, to tell "the plugin is broken"
 * apart from "the AUMID is not registered on this machine".
 *
 * Usage:
 *   node tools/win-alert-selftest.mjs [--no-audio] [--no-toast] [--chime <file>]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { alertScriptPath, buildArguments, buildPayload, defaultPowershellPath } from '../lib/os/win.js';
import { defaultChimePath } from './gen-default-chime.mjs';

/** Default AUMID: the value DSH registers through its Start Menu shortcut. */
const DEFAULT_AUMID = 'com.deepseek.dsh';

const EXIT_MEANING = new Map([
  [0, 'adapter reported success'],
  [2, 'payload did not survive the trip (decode failure)'],
  [3, 'toast failed - most often an unregistered AUMID, but any WinRT error lands here'],
  [4, 'audio failed - check the WAV path, and that a media engine is available (WinRT media player, else SoundPlayer)'],
  [12, 'toast and audio both failed'],
]);

function main(argv) {
  const powershellPath = defaultPowershellPath();
  const scriptPath = alertScriptPath();
  const chimeIndex = argv.indexOf('--chime');
  const audioPath = chimeIndex === -1 ? defaultChimePath() : argv[chimeIndex + 1];

  if (!existsSync(powershellPath)) {
    console.error(`Windows PowerShell not found at ${powershellPath}`);
    return 2;
  }
  if (!existsSync(scriptPath)) {
    console.error(`adapter script not found at ${scriptPath}`);
    return 2;
  }

  const payload = buildPayload({
    // Chinese text on purpose: it is the exact case that a BOM-less script or a
    // non-base64 argument would turn into mojibake.
    title: '任务完成',
    body: '中文正文编码自检 / encoding self-test',
    aumid: DEFAULT_AUMID,
    notify: !argv.includes('--no-toast'),
    audio: !argv.includes('--no-audio'),
    silent: true,
    audioPath,
    volume: 0.6,
    durationMs: null,
    maxDurationMs: 10000,
  });

  console.log(`interpreter : ${powershellPath}`);
  console.log(`script      : ${scriptPath}`);
  console.log(`audio       : ${payload.audio ? audioPath : '(disabled)'}`);
  console.log(`aumid       : ${payload.aumid}`);
  console.log('showing one toast and playing one sound...');

  const started = Date.now();
  const child = spawn(powershellPath, buildArguments(scriptPath, payload), {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', (error) => {
    console.error(`spawn failed: ${error.message}`);
  });
  child.on('exit', (code) => {
    const elapsed = Date.now() - started;
    console.log(`exit code   : ${code} (${EXIT_MEANING.get(code) ?? 'unexpected'}) after ${elapsed} ms`);
    if (code === 3 || code === 12) {
      console.log('');
      console.log('A toast that fails this way is usually an AUMID mismatch. Verify with:');
      console.log('  powershell -NoProfile -Command "Get-ChildItem $env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs -Filter *.lnk"');
      console.log(`and confirm one shortcut carries "${DEFAULT_AUMID}". See README > Troubleshooting.`);
    }
  });
  return 0;
}

process.exitCode = main(process.argv.slice(2));
