/**
 * The Windows adapter: payload construction, base64 transport (which is what
 * keeps non-ASCII text intact through PowerShell 5.1), spawn options, and the
 * AUMID shortcut check.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import {
  alertScriptPath,
  buildArguments,
  buildPayload,
  defaultPowershellPath,
  defaultStartMenuPrograms,
  encodePayload,
  isAumidRegistered,
  spawnAlert,
} from '../lib/os/win.js';
import { cleanupTempDirs, makeTempDir } from './helpers.mjs';

after(cleanupTempDirs);

test('the interpreter path points at the in-box Windows PowerShell', () => {
  const path = defaultPowershellPath().replace(/\\/gu, '/');
  assert.match(path, /System32\/WindowsPowerShell\/v1\.0\/powershell\.exe$/);
});

test('the adapter script ships next to its module', () => {
  assert.match(alertScriptPath().replace(/\\/gu, '/'), /lib\/os\/win-alert\.ps1$/);
});

test('the payload is fully defaulted and never carries a non-serialisable value', () => {
  const payload = buildPayload({ title: 't', body: 'b', aumid: 'com.example' });
  assert.deepEqual(payload, {
    title: 't',
    body: 'b',
    aumid: 'com.example',
    notify: true,
    audio: true,
    silent: true,
    audioPath: '',
    volume: 1,
    durationMs: null,
    maxDurationMs: 10000,
  });

  const coerced = buildPayload({ notify: 1, audio: 0, silent: 0, volume: Number.NaN, durationMs: -5, maxDurationMs: 0 });
  assert.equal(coerced.notify, true);
  assert.equal(coerced.audio, false);
  assert.equal(coerced.silent, false);
  assert.equal(coerced.volume, 1);
  assert.equal(coerced.durationMs, null);
  assert.equal(coerced.maxDurationMs, 10000);

  // An omitted field takes its default; an explicit value is honoured.
  assert.equal(buildPayload({ notify: undefined, silent: undefined }).silent, true);
  assert.equal(buildPayload({ title: 42, body: null, aumid: undefined }).title, '');
  assert.equal(buildPayload({ body: null }).body, '');
  assert.equal(buildPayload({ aumid: undefined }).aumid, '');
  assert.equal(buildPayload({ audioPath: undefined }).audioPath, '');

  const rounded = buildPayload({ durationMs: 1234.6 });
  assert.equal(rounded.durationMs, 1235);
});

test('Chinese text survives the base64 round trip byte for byte', () => {
  const payload = buildPayload({ title: '任务完成', body: '有 3 个问题等你回复', aumid: 'com.example' });
  const encoded = encodePayload(payload);
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/u);
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  assert.equal(decoded.title, '任务完成');
  assert.equal(decoded.body, '有 3 个问题等你回复');
  assert.deepEqual(decoded, payload);
});

test('the argument vector hands the payload over as one argument', () => {
  const payload = buildPayload({ title: 'x', body: 'y' });
  const args = buildArguments('C:/p/win-alert.ps1', payload);
  assert.deepEqual(args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:/p/win-alert.ps1']);
  assert.equal(args.length, 7);
  assert.equal(args[6], encodePayload(payload));
});

test('spawnAlert hides the window, ignores stdio, unrefs, and reports the exit code', () => {
  const calls = [];
  const listeners = new Map();
  const child = {
    on: (event, listener) => {
      listeners.set(event, listener);
      return child;
    },
    unref: () => {
      calls.push('unref');
    },
  };
  const exits = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };

  const returned = spawnAlert({
    payload: buildPayload({ title: 't', body: 'b' }),
    powershellPath: 'C:/ps.exe',
    scriptPath: 'C:/win-alert.ps1',
    spawnImpl,
    onExit: (code, detail) => exits.push([code, detail]),
  });

  assert.equal(returned, child);
  assert.equal(calls[0].command, 'C:/ps.exe');
  assert.deepEqual(calls[0].options, { stdio: 'ignore', windowsHide: true });
  assert.equal(calls[1], 'unref');

  listeners.get('exit')(0, null);
  listeners.get('exit')(3, null);
  const failure = new Error('nope');
  listeners.get('error')(failure);
  assert.deepEqual(exits[0], [0, null]);
  assert.deepEqual(exits[1], [3, null]);
  assert.equal(exits[2][0], -1, 'a spawn failure is reported as exit code -1');
  assert.equal(exits[2][1], failure, 'the error itself is handed to the caller');
});

test('the adapter child must never be detached: a DETACHED_PROCESS drops the toast silently', () => {
  // Measured on Windows 11 by running seven spawn variants with the Action Center
  // cleared between them and a distinct toast title each: every variant using
  // `detached: true` returned exit code 0 and delivered nothing, while every
  // variant without it delivered. `unref()` alone keeps the Host's event loop
  // free of the child, so detachment buys nothing and costs the whole feature.
  const captured = [];
  spawnAlert({
    payload: buildPayload({ title: 't', body: 'b' }),
    powershellPath: 'C:/ps.exe',
    scriptPath: 'C:/win-alert.ps1',
    spawnImpl: (_command, _args, options) => {
      captured.push(options);
      return { on: () => {}, unref: () => {} };
    },
  });

  assert.equal(captured.length, 1);
  assert.equal('detached' in captured[0], false, 'detached: true silently suppresses the notification');
  assert.notEqual(captured[0].detached, true);
});

test('a Start Menu shortcut can register an AUMID, and a longer AUMID does not match a shorter one', () => {
  const programs = makeTempDir();
  const nested = join(programs, 'Vendor');
  mkdirSync(nested);

  // A `.lnk` stores System.AppUserModel.ID as NUL-terminated UTF-16LE.
  const writeShortcut = (dir, name, aumid) => {
    const head = Buffer.from([0x4c, 0x00, 0x00, 0x00]);
    const body = Buffer.from(`${aumid}\0`, 'utf16le');
    writeFileSync(join(dir, name), Buffer.concat([head, body]));
  };

  writeShortcut(nested, 'Other App.lnk', 'com.example.other');
  writeShortcut(programs, 'Longer.lnk', 'com.deepseek.dsh.desktop.tauri');
  writeShortcut(programs, 'notes.txt', 'com.deepseek.dsh');

  assert.equal(
    isAumidRegistered('com.deepseek.dsh', { programsDir: programs }),
    false,
    'a prefix of a longer AUMID must not count as a match',
  );

  writeShortcut(programs, 'DeepSeek Harness.lnk', 'com.deepseek.dsh');
  assert.equal(isAumidRegistered('com.deepseek.dsh', { programsDir: programs }), true);
  assert.equal(isAumidRegistered('com.example.other', { programsDir: programs }), true, 'nested directories are scanned');
  assert.equal(isAumidRegistered('com.example.missing', { programsDir: programs }), false);
});

test('an uninspectable Start Menu means "unknown", not "missing"', () => {
  assert.equal(isAumidRegistered('', { programsDir: makeTempDir() }), null);
  assert.equal(isAumidRegistered('com.example', { programsDir: join(makeTempDir(), 'nope') }), null);
  assert.equal(isAumidRegistered('com.example', { programsDir: '' }), null);
});

test('an AUMID containing regular-expression characters is matched literally', () => {
  const programs = makeTempDir();
  writeFileSync(join(programs, 'app.lnk'), Buffer.from('com.example.app+beta\0', 'utf16le'));
  assert.equal(isAumidRegistered('com.example.app+beta', { programsDir: programs }), true);
  // "app+beta" as a regex would match "appppbeta"; the literal search must not.
  assert.equal(isAumidRegistered('com.example.appppppbeta', { programsDir: programs }), false);
});

test('the Start Menu directory comes from APPDATA', () => {
  const previous = process.env['APPDATA'];
  try {
    process.env['APPDATA'] = 'C:/test-appdata/Roaming';
    assert.equal(
      defaultStartMenuPrograms().replace(/\\/gu, '/'),
      'C:/test-appdata/Roaming/Microsoft/Windows/Start Menu/Programs',
    );
    delete process.env['APPDATA'];
    assert.equal(defaultStartMenuPrograms(), '');
  } finally {
    if (previous === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = previous;
  }
});
