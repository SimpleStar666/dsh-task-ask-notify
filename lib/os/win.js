/**
 * dsh-task-ask-notify - OS adapter for Windows.
 *
 * Every "how does this machine actually pop a notification or make a sound"
 * decision lives in this module and in `./win-alert.ps1`. Nothing above it knows
 * about PowerShell, WinRT, or MediaPlayer, so replacing the transport (for
 * example with an Electron main-process IPC bridge) touches only these two files.
 *
 * The Host process that runs this plugin is spawned by the DSH desktop shell with
 * `ELECTRON_RUN_AS_NODE=1`, so `require('electron')` yields no Electron API and
 * `Notification` is unavailable. The plugin therefore asks the in-box Windows
 * PowerShell 5.1 engine (not PowerShell 7, which cannot project the WinRT toast
 * types) to show the toast and play the file.
 *
 * @module dsh-task-ask-notify/os/win
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exit code meaning the toast could not be shown. Mirrors `win-alert.ps1`. */
export const EXIT_TOAST_FAILED = 3;
/** Exit code meaning the audio could not be played. Mirrors `win-alert.ps1`. */
export const EXIT_AUDIO_FAILED = 4;
/** Exit code meaning both halves failed. Mirrors `win-alert.ps1`. */
export const EXIT_BOTH_FAILED = 12;
/** Exit code meaning the payload never reached the script intact. */
export const EXIT_BAD_PAYLOAD = 2;

/**
 * Absolute path of the in-box Windows PowerShell interpreter.
 * `%SystemRoot%` is used when present; the literal fallback is the documented
 * default location of the in-box engine, not a machine-specific path.
 * @returns the interpreter path
 */
export function defaultPowershellPath() {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Absolute path of the adapter script that ships next to this module.
 * @returns the script path
 */
export function alertScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'win-alert.ps1');
}

/**
 * @returns the current user's Start Menu `Programs` directory, or '' when it
 * cannot be determined
 */
export function defaultStartMenuPrograms() {
  const appData = process.env['APPDATA'];
  if (typeof appData !== 'string' || appData === '') return '';
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

/**
 * Decide whether a Start Menu shortcut registers the given AUMID.
 *
 * A non-packaged desktop app may only show a toast whose AUMID is registered by
 * a shortcut carrying `System.AppUserModel.ID`; otherwise Windows drops the
 * notification while `Show()` still reports success. A `.lnk` stores that
 * property as a NUL-terminated UTF-16LE string, so scanning the raw bytes is
 * enough — no Shell COM and no extra process.
 *
 * @param aumid Application User Model ID to look for
 * @param options lookup options
 * @param options.programsDir directory to scan; defaults to the current user's
 * @param options.maxDepth how many directory levels below it to scan
 * @param options.readImpl injectable reader, for tests
 * @param options.readdirImpl injectable directory lister, for tests
 * @returns true when a shortcut registers it, false when none does, null when the
 * answer is unknown (no Start Menu directory to inspect)
 */
export function isAumidRegistered(
  aumid,
  {
    programsDir = defaultStartMenuPrograms(),
    maxDepth = 2,
    readImpl = readFileSync,
    readdirImpl = readdirSync,
  } = {},
) {
  if (typeof aumid !== 'string' || aumid === '') return null;
  if (programsDir === '' || !existsSync(programsDir)) return null;

  // The trailing guard keeps "a.b" from matching the longer "a.b.c".
  const escaped = aumid.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`${escaped}(?![\\w.\\-])`, 'u');

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirImpl(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && walk(full, depth + 1)) return true;
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.lnk')) continue;
      try {
        if (pattern.test(readImpl(full).toString('utf16le'))) return true;
      } catch {
        /* an unreadable shortcut cannot register anything */
      }
    }
    return false;
  };

  return walk(programsDir, 0);
}

/**
 * Build the payload handed to `win-alert.ps1`.
 *
 * Fields are explicit and defaulted so the script never has to guess, and the
 * whole payload travels as one base64 argument rather than being interpolated
 * into a command line.
 *
 * @param options alert description
 * @param options.title toast title
 * @param options.body toast body
 * @param options.aumid Application User Model ID owning the toast
 * @param options.notify whether to show a toast
 * @param options.audio whether to play a sound
 * @param options.silent whether to suppress the Windows notification sound
 * @param options.audioPath absolute path of the WAV to play, or '' for none
 * @param options.volume playback volume in [0, 1]
 * @param options.durationMs audio length reported by the WAV header, or null
 * @param options.maxDurationMs hard cap on how long the child may live
 * @returns a JSON-serialisable payload object
 */
export function buildPayload({
  title,
  body,
  aumid,
  notify = true,
  audio = true,
  silent = true,
  audioPath = '',
  volume = 1,
  durationMs = null,
  maxDurationMs = 10000,
}) {
  return {
    title: typeof title === 'string' ? title : '',
    body: typeof body === 'string' ? body : '',
    aumid: typeof aumid === 'string' ? aumid : '',
    notify: Boolean(notify),
    audio: Boolean(audio),
    silent: Boolean(silent),
    audioPath: typeof audioPath === 'string' ? audioPath : '',
    volume: Number.isFinite(volume) ? volume : 1,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
    maxDurationMs:
      Number.isFinite(maxDurationMs) && maxDurationMs > 0 ? Math.round(maxDurationMs) : 10000,
  };
}

/**
 * Encode a payload as the single base64 argument `win-alert.ps1` expects.
 * UTF-8 in, base64 out: this is what keeps Chinese titles intact through
 * PowerShell 5.1, whose `-File` argument handling is ANSI-bound.
 * @param payload payload from {@link buildPayload}
 * @returns a base64 string
 */
export function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * Assemble the argument vector for one adapter run.
 * @param scriptPath absolute path of `win-alert.ps1`
 * @param payload payload from {@link buildPayload}
 * @returns an argument array
 */
export function buildArguments(scriptPath, payload) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    encodePayload(payload),
  ];
}

/**
 * Spawn one adapter run.
 *
 * ## Why this child is **not** detached
 *
 * `detached: true` looks like the right choice — the Host must not be kept alive
 * by a sound, and the adapter should outlive a Host shutdown. On Windows it is
 * fatal, and silently so: a `DETACHED_PROCESS` has no console, and in that state
 * `ToastNotificationManager.CreateToastNotifier(...).Show(...)` returns without
 * throwing while Windows drops the notification entirely. Measured on Windows 11
 * with seven spawn variants and the Action Center cleared between runs:
 *
 *   stdio:'ignore' + windowsHide                 -> delivered
 *   stdio:'ignore'                               -> delivered
 *   piped stdio                                  -> delivered
 *   stdio:'ignore' + windowsHide + unref()       -> delivered
 *   any of the above with detached: true         -> exit code 0, nothing shown
 *
 * So the child is a plain child that is `unref()`ed instead: `unref()` alone is
 * enough to keep the Host's event loop free of it, the `exit` listener still
 * reports its exit code, and — the part that actually matters — the toast arrives.
 * The trade-off is that a Host shutdown also ends an in-flight sound; a reminder
 * that never appears is far worse than one that is cut short.
 *
 * @param options spawn description
 * @param options.payload payload from {@link buildPayload}
 * @param options.powershellPath interpreter path; defaults to the in-box engine
 * @param options.scriptPath adapter script path; defaults to the shipped one
 * @param options.onExit optional `(code, signal)` observer
 * @param options.spawnImpl injectable spawn, for tests
 * @returns the child process handle
 */
export function spawnAlert({
  payload,
  powershellPath = defaultPowershellPath(),
  scriptPath = alertScriptPath(),
  onExit,
  spawnImpl = nodeSpawn,
}) {
  const child = spawnImpl(powershellPath, buildArguments(scriptPath, payload), {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (error) => {
    if (onExit !== undefined) onExit(-1, error);
  });
  child.on('exit', (code, signal) => {
    if (onExit !== undefined) onExit(code, signal);
  });
  child.unref();
  return child;
}
