# dsh-task-ask-notify

[English](README.en.md) | [中文](README.md)

> **Provenance and credit**
>
> This repository is a fork of [**deadbushxw/dsh-task-ask-notify**](https://github.com/deadbushxw/dsh-task-ask-notify).
> The upstream author is **deadbushxw**, who wrote the vast majority of this code, and the
> copyright notice in `LICENSE` is his.
>
> What I added on top of upstream is **failure alerting**: a failed turn now pops a
> notification immediately, plays a *descending* three-note cue that is the deliberate
> mirror image of the rising completion chime, and carries the failure reason in the body.
> I also fixed a "popup but no sound" defect (WPF `MediaPlayer` failing silently on trimmed
> Windows installs). The exact change list is in
> [`dsh-task-ask-notify-LOCAL-CHANGES.md`](dsh-task-ask-notify-LOCAL-CHANGES.md).
>
> If you want the original, go to the upstream repository; the value of this fork is the
> failure alerting it adds.

A Host-side [DeepSeek Harness](https://github.com/deepseek-ai) plugin for Windows:
when a turn **finishes**, **fails**, or when the model **asks you a question**, it pops a
real Windows 11 notification and plays a sound at the same time.

- **Completion** — the model handed control back and nothing else happened for a
  configurable quiet period.
- **Failure** — the turn closed with `turn/end` and `reason.kind === 'error'`, which is
  exactly what DSH's own red "This turn failed" line means. It alerts **immediately**,
  with no quiet period, and the body carries the failure reason
  (`reason.error.message`).
- **A question** — the model called `ask_user_question` and is now blocked waiting
  for you, so this alert fires immediately instead of after a delay.

Notifications are ordinary Windows toasts owned by DSH's own Application User
Model ID, so they land in the Action Center and follow your Focus Assist settings
like any other app's notification. The sound is a WAV you control: drop files into
four directories, or point a directory at a folder you already have. Failure uses a
*descending* cue, so it can never be mistaken for the rising completion chime.

![The notification and the sounds](icon.svg)

<!-- The image above is the plugin icon; screenshots are intentionally not committed,
     because they would show the author's desktop. -->

**Requirements**

| | |
|---|---|
| OS | Windows 10 2004+ or Windows 11 |
| DSH | 0.2.0-rc.2 or newer (Host plugins with `Config` and `session/event`) |
| PowerShell | the in-box Windows PowerShell 5.1 (`%SystemRoot%\System32\WindowsPowerShell\v1.0\`) |
| Node.js | 20+ — only for the tests and the bundled tools, not to run the plugin |

The package name, the repository directory, the Loader row, the display name, and
the configuration page all use the same identifier — **`dsh-task-ask-notify`** —
so there is exactly one name to search for. The directory name is irrelevant to
the loader: `file:` installs are keyed by path, and everything DSH reads comes
from `package.json`.

---

## Install

Installation is a bundle install: DSH writes the package into the active profile,
registers the loader row, and hot-applies it. Do not hand-edit the profile.

### 1. Get the code onto the machine

```sh
git clone https://github.com/SimpleStar666/dsh-task-ask-notify.git "%USERPROFILE%\.dsh\dsh-plugins\dsh-task-ask-notify"
```

Any directory works; the path below is only an example. There is no build step and
no `npm install` is required — DSH's own installer resolves the single dependency.

### 2. Install it into a profile

Ask the Agent in the profile you want the alerts in:

> Install the bundle at `%USERPROFILE%\.dsh\dsh-plugins\dsh-task-ask-notify` with
> `plugin_manager install_bundle`.

Or, in the GUI: **Settings → Plugins**, add the package directory
`%USERPROFILE%\.dsh\dsh-plugins\dsh-task-ask-notify` as a local bundle and enable it.

`plugin_manager` reports `application: "applied"` when the change is live. If it
reports `restart-required`, restart DSH. Replacing an already-installed package
with new code also requires a restart, because the Host caches module instances.

### 3. Confirm it works

1. Start a short task and let it finish. One toast and one sound.
2. Or run the adapter's own self-test, which shows a toast and plays the bundled
   chime without involving DSH at all:

   ```sh
   node tools/win-alert-selftest.mjs
   ```

   Exit code `0` means the adapter reported success. Note that exit code `0` is
   *not* proof the toast was visible — see [Troubleshooting](#troubleshooting) for
   how to check that from the system side.

Both signals must be true: the reminder appears, and the exit code is `0`. If
nothing appears, the [Troubleshooting](#troubleshooting) section starts with the
one cause that fails silently.

### Uninstall

```
plugin_manager remove_bundle dsh-task-ask-notify
```

Nothing is left behind inside the profile. Your configuration file (below) is not
part of the install and is not removed; delete it if you want it gone too.

---

## Sounds

### The directory convention

The plugin looks for these four directories, by relative name:

| Directory | Played when |
|---|---|
| `audio/complete/` | a turn finished |
| `audio/failed/` | a turn ended in an error (`reason.kind` listed in `failed.reasons`, `error` by default) |
| `audio/ask-single/` | the model asked exactly one question |
| `audio/ask-multiple/` | the model asked two or more questions |

One file from the matching directory is chosen **uniformly at random**, ordered by
name so a given choice is reproducible. `.wav` only. Adding, replacing, or removing
files takes effect on the next alert — no restart, because the listing is keyed to
the directory's modification time.

A relative path is looked up in **two** places, in this order:

1. **your audio folder** — `%DSH_HOME%\plugin-data\dsh-task-ask-notify\` — used
   when the path exists there and holds at least one `.wav`;
2. **the package folder** — the copy shipped inside the plugin.

Your folder comes first because an installed bundle runs from the profile's copy of
the package: a file added to your clone afterwards is not visible to it and would
otherwise need a reinstall. Because a relative path only wins when it actually
holds a sound, an empty folder never silently disables a scenario. An **absolute**
path in `complete.dir`, `failed.dir`, `askSingle.dir`, `askMultiple.dir`, or
`sound.fallback` bypasses this order entirely.

**This repository ships exactly two sound files**, both generated and reproducible:

- `audio/_default/chime.wav` — the completion fallback, a rising two-tone chime
  (880 Hz then 1318.5 Hz) rendered by `tools/gen-default-chime.mjs`, used whenever a
  scenario directory is missing or empty.
- `audio/failed/alert-fail.wav` — the failure cue, a descending three-note figure
  (659.25 → 554.37 → 440 Hz) rendered by `tools/gen-failure-alert.mjs`, deliberately
  the opposite contour of the completion chime: rising means it worked, falling
  means it did not.

The other three scenario directories exist but are empty by design, and their
contents are ignored by git; see [Repository boundary](#repository-boundary).

### Adding your own sounds

Two ways, both with no configuration required:

**Import them.** If you keep a pack laid out as `<pack>/complete/`,
`<pack>/ask/single/`, and `<pack>/ask/multiple/`, the bundled importer copies them
into your audio folder and verifies every copy with SHA-256:

```sh
node tools/import-audio.mjs --source "<path to your sound pack>"
node tools/import-audio.mjs --verify
```

It writes to `%DSH_HOME%\plugin-data\dsh-task-ask-notify\audio\...` by default, so
the next alert uses the new sounds without a reinstall. Use `--target package` if
you load the plugin in place from your clone instead. `--dry-run` reports what
would happen without writing. The importer never records where the files came from,
so a path from your machine cannot end up in a commit.

**Or point at a directory you already have** — see `complete.dir`, `failed.dir`,
`askSingle.dir`, and `askMultiple.dir` below. Absolute paths are supported, so
nothing needs to be copied at all.

### Regenerating the sounds

```sh
node tools/gen-default-chime.mjs --check    # completion chime
node tools/gen-failure-alert.mjs --check    # failure cue
```

The `--check` flag re-renders the file, reports the dominant frequency of each
tone, and fails if the committed WAV no longer matches what the generator
produces. That is deliberate: a binary asset nobody can reproduce is an
unreviewable blob. Tone parameters:

| | note 1 | note 2 | note 3 |
|---|---|---|---|
| completion `chime.wav` | 880 Hz / 0.18 s | 1318.5 Hz / 0.35 s | — |
| failure `alert-fail.wav` | 659.25 Hz / 0.14 s | 554.37 Hz / 0.14 s | 440 Hz / 0.30 s |

Each with a 20 ms exponential attack and an exponential decay to −80 dB. See
[Credits](#credits).

---

## Configuration

### The configuration page in DSH

The plugin ships a browser half, so it is configured from the interface:

**Plugins list → `dsh-task-ask-notify`** — the form is rendered directly on the
bundle's page, and the same page is also reachable from the configure control on
the plugin's row. It edits the everyday settings: the master switch, the
completion alert and its quiet period, the single/multiple question alerts, the
**failure alert and whether the reason goes into the body**, sound on/off, volume
and the minimum gap, notification on/off, the question-in-body option, and whether
subagent sessions alert.

Saving takes effect **immediately**: a change is committed into the running
plugin, so the next alert already uses it. No restart, no reload, no file editing.

**Listen.** Next to the volume number, one button plays a sound so the setting can
be judged by ear instead of guessed at. One click applies whatever is on the page
and plays one sound through the *same* path a real alert takes — same directories,
same uniform choice, same adapter, same volume — with the notification suppressed,
so what you hear is what you will hear. It draws its sound from a randomly chosen
scenario (`complete`, `failed`, `ask-single`, `ask-multiple`), which means it plays one of the
sounds you imported, not a sample shipped with the plugin. It deliberately still
works when `sound.enabled` is off, since calibrating the volume before switching
sound on is a reasonable order to do things in.

Those fields are declared `.volatile()` in the exported schema, which is what
makes DSH offer a form for them at all and what lets an edit reach a running
plugin; the page writes through DSH's own settings service, so a refused or
conflicting write is reported rather than silently lost. Everything not on the
page — sound directories, notification wording, the AUMID — is changed in the
layers below, because those need a reload rather than a live update.

### The file layers

Two layers, the later one winning per field:

1. the plugin row's `config` in `cordis.patch.yml` (validated by the Loader
   against the exported `Config` schema — this is the same schema DSH's own
   configuration surfaces project); and
2. an optional JSON file you own, **outside this repository**:

   ```
   %DSH_HOME%\plugin-data\dsh-task-ask-notify\config.json
   ```

   `%DSH_HOME%` is `%USERPROFILE%\.dsh` by default. Override the whole path with
   the `DSH_TASK_ASK_NOTIFY_CONFIG` environment variable.

The JSON file is re-read whenever it changes, so you can correct a value while
DSH is running. A file that is not valid JSON, or holds a value the schema
rejects, is reported in the log and then **ignored** — the last good
configuration stays in force, and the reason is printed with the offending field
path. The JSON layer wins over the page and over the row, so a field you pin
there is not editable from the interface.

Every field is optional; omitted fields fall back to the value in the table. To
turn every alert off without uninstalling, write `{"enabled": false}`.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for all four scenarios. |
| `complete.enabled` | `true` | Alert when a turn ends cleanly. |
| `complete.dir` | `"audio/complete"` | Sound directory. Relative paths prefer your audio folder, then the package; absolute paths are used as given. |
| `complete.debounceMs` | `2000` | Quiet period after a clean turn end before alerting. Raise it (for example to `15000`) if a multi-turn goal task should produce one alert instead of several; short tasks then wait that long too. |
| `failed.enabled` | `true` | Alert when a turn ends in an error. **No quiet period** — after a failure there is nothing left to wait for. |
| `failed.dir` | `"audio/failed"` | Sound directory, resolved as above. |
| `failed.reasons` | `["error"]` | Which `turn/end` `reason.kind` values count as a failure. DSH itself shows its red failure line only for `error`; `aborted`/`interrupted` are you stopping it, `blocked` is waiting for an approval, `max-tokens` is a truncated-but-delivered answer. Add any of them here to alert on them too. |
| `failed.includeReason` | `true` | Append `reason.error.message` (falling back to `code`) to the body. Off means the body is just the session title. |
| `askSingle.enabled` | `true` | Alert when the model asks one question. |
| `askSingle.dir` | `"audio/ask-single"` | Sound directory. |
| `askMultiple.enabled` | `true` | Alert when the model asks two or more questions. |
| `askMultiple.dir` | `"audio/ask-multiple"` | Sound directory. |
| `sound.enabled` | `true` | Play a sound at all. |
| `sound.volume` | `100` | Playback volume on a `0`–`100` scale: `0` is silent, `100` is the file at full amplitude. A stored value in `(0, 1]` is read as the old `0`–`1` scale and multiplied by 100, so an existing setting keeps its loudness. |
| `sound.minGapMs` | `400` | Two alerts closer than this share one sound. Both still notify. |
| `sound.auditionAt` | `0` | Diagnostic, not a preference: the page's **Listen** button sets this to the time of the click, and the plugin plays one sound whenever it changes. |
| `sound.fallback` | `"audio/_default/chime.wav"` | Used when a scenario directory is empty or missing. A directory here is also accepted. Resolved the same way as the scenario directories. |
| `sound.maxDurationMs` | `10000` | Hard cap on how long a playback process may live. |
| `notify.enabled` | `true` | Show a Windows notification. |
| `notify.aumid` | `"com.deepseek.dsh"` | The AUMID that owns the toast. Change it only if DSH's shortcut changes; see Troubleshooting. |
| `notify.silentSystemSound` | `true` | Suppress the Windows notification sound, because the plugin plays its own file. |
| `notify.bodyMaxChars` | `80` | Longest notification body kept before truncation. |
| `notify.includeQuestionInBody` | `false` | Append the first question to the notification body. Off by default: the body is the session title. |
| `dedup.completeMs` | `3000` | Repeat completion alerts for one session inside this window are dropped. |
| `dedup.failedMs` | `5000` | Repeat failure alerts for one session inside this window are dropped, so an automatic retry loop cannot become a wall of sound. |
| `sessions.includeSubagents` | `false` | Also alert for subagent sessions. Off by default so a fan-out of background helpers does not produce a wall of notifications. |
| `messages.completeTitle` | `"任务完成"` | Notification title for a finished turn. |
| `messages.failedTitle` | `"本轮运行失败"` | Notification title for a failed turn. |
| `messages.askSingleTitle` | `"需要你回复"` | Notification title for one question. |
| `messages.askMultipleTitleTemplate` | `"有 {count} 个问题等你回复"` | Notification title for several; `{count}` is replaced. |
| `messages.fallbackBody` | `"DeepSeek Harness"` | Body used when the session has neither a title nor a workspace directory. |

Example — quieter, English wording, and a directory you already keep sounds in:

```json
{
  "complete": { "debounceMs": 15000, "dir": "D:\\my-sounds\\done" },
  "failed": { "dir": "D:\\my-sounds\\failed", "reasons": ["error", "max-tokens"] },
  "askSingle": { "dir": "D:\\my-sounds\\ask" },
  "askMultiple": { "dir": "D:\\my-sounds\\ask-many" },
  "sound": { "volume": 0.5 },
  "messages": {
    "completeTitle": "Task finished",
    "failedTitle": "This turn failed",
    "askSingleTitle": "Your input is needed",
    "askMultipleTitleTemplate": "{count} questions are waiting",
    "fallbackBody": "Session"
  }
}
```

The notification **body is the session title**, falling back to the name of the
session's workspace directory, then to `messages.fallbackBody`. **A failure alert
additionally carries its reason** (`failed.includeReason`, on by default), shaped
like `Fix the build — API key invalid`, truncated to `notify.bodyMaxChars`.

---

## Troubleshooting

### Nothing appears at all

The overwhelmingly likely cause is an AUMID that no Start Menu shortcut
registers. Windows will accept the toast and report success while showing
nothing, which is why the plugin checks this at startup and logs a warning. Verify
it yourself:

```powershell
# Which AUMIDs are registered on this machine?
$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace("$env:APPDATA\Microsoft\Windows\Start Menu\Programs")
$folder.Items() | ForEach-Object { "$($_.Name) -> $($folder.GetDetailsOf($_, 0))" }

# What has actually been delivered to the Action Center?
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
[Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('com.deepseek.dsh') |
  ForEach-Object { $_.Content.GetXml() }
```

The history query is the check that counts: if your notification is listed there
with the right title and body, the delivery path works and the problem is
elsewhere. `Notification.isSupported()` and a `Show()` call that returns without
throwing prove nothing.

If the history is empty, confirm that a shortcut under
`%APPDATA%\Microsoft\Windows\Start Menu\Programs` carries
`System.AppUserModel.ID = com.deepseek.dsh`. DSH's own shortcut
(`DeepSeek Harness.lnk`) does this at install time. If your DSH was installed
differently, set `notify.aumid` to the AUMID your shortcut actually carries.

### The adapter exits 0 but nothing is ever shown

Do not spawn the adapter with `detached: true`. A `DETACHED_PROCESS` has no
console, and in that state `ToastNotificationManager.CreateToastNotifier(...)
.Show(...)` returns without throwing while Windows discards the notification — the
script reports success and the exit code is `0`. This is measured on Windows 11
with the Action Center cleared between runs: every spawn variant using
`detached: true` delivered nothing, and every variant without it delivered. The
plugin therefore uses a plain child that is only `unref()`ed, which is enough to
keep it out of the Host's event loop; `lib/os/win.js` records the measurement and
`test/os-win.test.mjs` fails if detachment is reintroduced.

### The toast shows but there is no sound

- `sound.enabled` is `true` and `sound.volume` is above `0`.
- `sound.minGapMs`: a second alert within 400 ms of the first intentionally
  shares the first sound.
- A playback process is already running; two sounds never overlap.
- The scenario directory is empty and `sound.fallback` cannot be played. Check the
  log for `no playable WAV`.
- The file is not actually a WAV. `MediaPlayer` reads the file's own headers; the
  plugin's duration calculation is only a hint.

### Chinese text shows as mojibake

This is an encoding failure, and the plugin defends against it in two places: the
adapter script is stored as **UTF-8 with a BOM**, and all dynamic text reaches it
as a single base64(UTF-8) argument rather than being interpolated into a command
line. `.gitattributes` keeps the BOM intact for clones. If you see mojibake, your
copy of `lib/os/win-alert.ps1` has lost its BOM — re-clone, or re-add it while
saving the file as "UTF-8 with BOM".

### The alert arrives later than expected

A completion alert is deliberately debounced. It fires only after
`complete.debounceMs` of no further activity in that session, and any new turn, any
non-clean turn end, or any question cancels it. This is intentional: DSH's own
guidance is that `agent/status` must not be used as a completion signal, so the
plugin waits for quiet instead. Lower `complete.debounceMs` for a snappier feel.

### The plugin does not load at all

Check the log for `dsh-task-ask-notify`. A `Config` that fails validation, or a
missing `@deepseek-ai/schemastery` dependency, stops `apply()` from running.

> **Do not "fix" the plugin by importing `electron`.** The DSH Host runs with
> `ELECTRON_RUN_AS_NODE=1`, so `require('electron')` yields the executable path and
> nothing else — there is no `Notification`, `app`, or `BrowserWindow` in that
> process. That is exactly why this plugin talks to the in-box Windows PowerShell
> engine. PowerShell 7 (`pwsh`) also cannot project the WinRT toast types, which is
> why the interpreter is named explicitly as `powershell.exe` 5.1.

### No alert for a background helper's work

Subagent sessions are excluded by default. Set `sessions.includeSubagents` to
`true` if you want one alert per helper as well.

---

## Repository boundary

**This repository is safe to publish as-is, and this section is the contract that
makes that checkable rather than a claim.**

### What is committed

Source, tests, tooling, documentation, and metadata:

```
.gitattributes  .gitignore  LICENSE
README.md  README.en.md
package.json  cordis.patch.yml
icon.svg  locale/{en,zh}.json
lib/**                       the plugin itself
lib/client.js                the browser half: the configuration page
lib/os/win-alert.ps1         the Windows adapter script
audio/_default/chime.wav     generated, reproducible (completion fallback)
audio/failed/alert-fail.wav  generated, reproducible (failure cue, descending)
audio/{complete,ask-single,ask-multiple}/.gitkeep   empty directory placeholders
tools/**                     chime generator, audio importer, self-test,
                             boundary checker, profile rollback script
test/**                      the test suite
```

### What is deliberately not committed

| Kept out | Why |
|---|---|
| `DESIGN.md`, `docs/**` | Internal planning notes. They quote the absolute directories of the machine they were written on, so publishing them would leak that machine's layout. |
| `audio/complete/*.wav`, `audio/ask-single/*.wav`, `audio/ask-multiple/*.wav`, and `audio/failed/*.wav` (except `alert-fail.wav`) | Imported sound files are personal media, licensed to whoever made them. `tools/import-audio.mjs` puts them in your audio folder; `.gitignore` keeps them out of commits. `.audio-import.json` (the hash record) is excluded for the same reason — it lists those file names. |
| your audio folder and `config.json` | Both live under `%DSH_HOME%\plugin-data\dsh-task-ask-notify\`, outside any clone, and are ignored here as a second line of defence. |
| `node_modules/`, `coverage/`, `dist/`, `build/` | Reproducible from `package.json`; noise in a diff. |
| `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` | Installation is owned by DSH's `install_bundle` (pnpm). A second lockfile would describe a different resolver and drift. |
| `.env*`, `*.pem`, `*.key`, `.credentials.yaml`, … | Credentials and local environment. |

There are no secrets of any kind in this project: it stores no account, no token,
and no API key, and it makes no network requests.

### How to verify the boundary yourself

```sh
npm run verify-boundary   # fails on machine paths, credentials, state, big files
npm run verify-audio      # re-checks imported audio against its recorded hashes
```

`verify-boundary` reads the set of files **git would publish** (`git ls-files`),
not the working tree — untracked local files such as imported audio and your own
`config.json` are precisely what the boundary is meant to keep out. It reports
machine-specific absolute paths, credential-shaped text, runtime state, and
unexpectedly large files, and it exits non-zero on anything it finds. Run it
before every push.

The same check is what the layout above is designed to satisfy: a fresh clone
contains no local absolute path, no personal media, and no runtime data, and the
plugin works from that clone because both sounds are committed.

---

## Development

```sh
npm install     # the single runtime dependency, for the tests only
npm test        # 108 tests, no network and no side effects
```

Nothing in the test suite writes into the repository: fixtures go to the system
temporary directory. No test shows a notification or plays a sound — the things
that do are explicit, opt-in commands:

```sh
node tools/win-alert-selftest.mjs                # one real toast and one real sound
node tools/win-alert-selftest.mjs --no-audio     # toast only
node tools/gen-default-chime.mjs --check         # re-render and verify the chime
node tools/gen-failure-alert.mjs --check         # re-render and verify the failure cue
```

Structure, and why it is split this way:

| File | Responsibility |
|---|---|
| `lib/index.js` | Entry point. Reads `Config`, subscribes to `session/event`, owns teardown. |
| `lib/config.js` | Schema, layered configuration, hot reload. |
| `lib/signals.js` | Events to scenarios. Pure: no clock, no filesystem, no OS. |
| `lib/dispatch.js` | Debounce, de-duplication, sound arbitration. Owns no OS knowledge. |
| `lib/policy.js` | Directory convention, uniform choice, WAV duration. |
| `lib/os/win.js`, `lib/os/win-alert.ps1` | The only files that know Windows exists. Swapping the transport touches these two and nothing else. |

---

## Known limitations

- **Windows only.** The delivery channel is a Windows toast plus a WAV playback
  process; there is no macOS or Linux adapter.
- **Clicking the notification does nothing.** DSH registers no URI protocol, so
  there is nowhere for the toast to navigate to. The notification carries no
  buttons and no deep link by design.
- **The page edits switches and numbers only.** Notification wording, the AUMID,
  the sound directories, and the failure-reason list are not on the page: they live
  in `%DSH_HOME%\plugin-data\dsh-task-ask-notify\config.json` (re-read while DSH
  runs) or in this bundle's `cordis.patch.yml`. The schema is exported, so DSH's own
  configuration surfaces can see and validate them too.
- **Completion is a quiet-period judgement, not a state.** A multi-turn task whose
  turns are more than `complete.debounceMs` apart produces more than one alert.
  Raise `complete.debounceMs` to merge them; short tasks then wait that long.
- **Failure only counts the reasons in `failed.reasons` (`error` by default).**
  Stopping the run yourself (`aborted`/`interrupted`), waiting on an approval
  (`blocked`), and a truncated-but-delivered answer (`max-tokens`) stay silent —
  DSH itself only paints its red failure line for `error`. Add them to the array if
  you disagree.
- **Failure de-duplicates but never debounces.** `dedup.failedMs` (5000 by
  default) absorbs an automatic retry loop; a retry slower than that still alerts
  every time.
- **A notification is fire-and-forget.** No delivery receipt is available for a
  toast; the system-side history query above is the closest thing, and the plugin
  logs the adapter's exit code for its own half.

---

## Credits

- The default chime reproduces the tone and envelope of the "run finished" sound
  in the community plugin **`@yangzhe1991/dsh-web-enhance`** (MIT), which
  synthesises it in the browser with Web Audio. A Host plugin has no Web Audio, so
  this repository renders the same two tones offline and commits the WAV.
- Notification delivery follows the documented non-packaged Win32 desktop toast
  path: an in-box PowerShell 5.1 child process calling
  `ToastNotificationManager.CreateToastNotifier(aumid)` for the AUMID DSH already
  registers.

## License

[MIT](LICENSE) © 2026 deadbushxw.
