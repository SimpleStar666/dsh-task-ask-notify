/**
 * dsh-task-ask-notify - configuration.
 *
 * Two layers, in increasing precedence:
 *
 *   1. the plugin row's `config` in `cordis.patch.yml` (validated by the Loader
 *      through the exported `Config` schema, and visible through DSH's own
 *      configuration surfaces),
 *   2. an optional JSON file the user owns, outside this repository:
 *
 *        <DSH_HOME>/plugin-data/dsh-task-ask-notify/config.json
 *
 *      It is read on startup and re-read whenever it changes, so a value can be
 *      corrected without restarting DSH. A syntax error or an invalid value is
 *      reported and then ignored; the last good configuration stays in force.
 *
 * The file deliberately lives outside the plugin directory: the repository then
 * contains source and documentation only, and nothing a user edits locally can
 * end up in a commit.
 *
 * @module dsh-task-ask-notify/config
 */

import z from '@deepseek-ai/schemastery';
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable plugin identity; also the `plugin-data` subdirectory name. */
export const PLUGIN_ID = 'dsh-task-ask-notify';

/** Environment variable that overrides the configuration file location. */
export const CONFIG_PATH_ENV = 'DSH_TASK_ASK_NOTIFY_CONFIG';

/** AUMID registered by the DSH desktop shell's Start Menu shortcut. */
export const DEFAULT_AUMID = 'com.deepseek.dsh';

/**
 * The plugin's configuration schema.
 *
 * Exported as `Config` from the package entry because Cordis reads it to
 * validate the row config before `apply()` runs, and DSH projects it into the
 * JSON Schema its configuration surfaces show. It must be a real Schemastery
 * schema: the kernel calls `Config['~standard'].validate(...)`, and DSH's
 * projection only recognises native schema nodes.
 *
 * ## Why some fields are `.volatile()`
 *
 * DSH's settings service only offers a form for fields declared volatile
 * (`dsh-settings` builds its form from `volatileForm(schema)` and refuses writes
 * to anything else), and volatility is what makes an edit take effect **without
 * reloading the plugin**: the Loader turns such a field into a live reference it
 * writes into in place, then announces `loader/volatile-update`. So exactly the
 * fields the configuration page edits are volatile, and no others — the rest
 * (sound directories, notification wording, AUMID) stay ordinary configuration
 * and are changed in the configuration file or the bundle's own patch.
 *
 * A volatile field must sit at a fixed object path with no volatile ancestor,
 * which every field below satisfies.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Master switch for every alert.').volatile(),

  complete: z.object({
    enabled: z.boolean().default(true).description('Alert when a turn ends cleanly.').volatile(),
    dir: z.string().default('audio/complete').description('Sound directory, relative to the plugin or absolute.'),
    debounceMs: z
      .natural()
      .max(600000)
      .default(2000)
      .description('Quiet period after a clean turn end before the completion alert fires.')
      .volatile(),
  }),

  askSingle: z.object({
    enabled: z.boolean().default(true).description('Alert when the model asks one question.').volatile(),
    dir: z.string().default('audio/ask-single').description('Sound directory, relative to the plugin or absolute.'),
  }),

  askMultiple: z.object({
    enabled: z.boolean().default(true).description('Alert when the model asks two or more questions.').volatile(),
    dir: z.string().default('audio/ask-multiple').description('Sound directory, relative to the plugin or absolute.'),
  }),

  failed: z.object({
    enabled: z.boolean().default(true).description('Alert when a turn ends with an error (本轮运行失败).').volatile(),
    dir: z.string().default('audio/failed').description('Sound directory, relative to the plugin or absolute.'),
    reasons: z
      .array(z.string())
      .default(['error'])
      .description('Turn-end reason kinds treated as a failure; DSH itself renders 本轮运行失败 for "error".'),
    includeReason: z
      .boolean()
      .default(true)
      .description('Append the failure message to the notification body.')
      .volatile(),
  }),

  sound: z.object({
    enabled: z.boolean().default(true).description('Play a sound at all.').volatile(),
    volume: z
      .number()
      .min(0)
      .max(100)
      .default(100)
      .description('Playback volume: 0 is silent, 100 is the file at full amplitude.')
      .volatile(),
    minGapMs: z
      .natural()
      .max(600000)
      .default(400)
      .description('Two alerts closer than this share one sound; both still notify.')
      .volatile(),
    auditionAt: z
      .natural()
      .default(0)
      .description(
        'Diagnostic, not a preference: the configuration page’s listen button sets this to the time of the click, ' +
          'and the plugin plays one sound whenever it changes.',
      )
      .volatile(),
    fallback: z
      .string()
      .default('audio/_default/chime.wav')
      .description('Played when a scenario directory is missing or holds no WAV.'),
    maxDurationMs: z
      .natural()
      .min(500)
      .max(120000)
      .default(10000)
      .description('Hard cap on how long a playback process may live.'),
  }),

  notify: z.object({
    enabled: z.boolean().default(true).description('Show a Windows notification.').volatile(),
    aumid: z.string().default(DEFAULT_AUMID).description('Application User Model ID owning the notification.'),
    silentSystemSound: z
      .boolean()
      .default(true)
      .description('Suppress the Windows notification sound, because the plugin plays its own.'),
    bodyMaxChars: z
      .natural()
      .min(16)
      .max(400)
      .default(80)
      .description('Longest notification body kept before it is truncated.'),
    includeQuestionInBody: z
      .boolean()
      .default(false)
      .description('Append the first question to the body. Off by default: the body is the session title.')
      .volatile(),
  }),

  dedup: z.object({
    completeMs: z
      .natural()
      .max(600000)
      .default(3000)
      .description('Repeat completion alerts for one session inside this window are dropped.'),
    failedMs: z
      .natural()
      .max(600000)
      .default(5000)
      .description('Repeat failure alerts for one session inside this window are dropped. Guards against a retry loop.'),
  }),

  sessions: z.object({
    includeSubagents: z.boolean().default(false).description('Also alert for subagent sessions.').volatile(),
  }),

  messages: z.object({
    completeTitle: z.string().default('任务完成').description('Notification title for a finished turn.'),
    failedTitle: z.string().default('本轮运行失败').description('Notification title for a failed turn.'),
    askSingleTitle: z.string().default('需要你回复').description('Notification title for a single question.'),
    askMultipleTitleTemplate: z
      .string()
      .default('有 {count} 个问题等你回复')
      .description('Notification title for several questions; {count} is replaced.'),
    fallbackBody: z
      .string()
      .default('DeepSeek Harness')
      .description('Notification body when the session has no title and no workspace.'),
  }),
});

/**
 * Fully-defaulted configuration, derived from the schema itself so the defaults
 * cannot drift away from what the Loader validates.
 *
 * Volatile fields are unwrapped: Schemastery substitutes a live reference for
 * every field declared `.volatile()`, on each validation, so the schema's own
 * output is not a plain document.
 *
 * @returns a plain object holding every default
 */
export function schemaDefaults() {
  const result = Config['~standard'].validate({});
  if (result.issues !== undefined || result.value === undefined) {
    throw new Error('dsh-task-ask-notify: the Config schema rejected its own empty document');
  }
  return unwrapVolatileDeep(result.value);
}

/** Absolute directory of this package. */
export function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Resolve the DSH home directory without importing any DSH package.
 * @param env environment to inspect
 * @returns an absolute directory
 */
export function resolveDshHome(env = process.env) {
  if (typeof env['DSH_HOME'] === 'string' && env['DSH_HOME'] !== '') return env['DSH_HOME'];
  // <home>/profiles/<profile> is the documented layout of DSH_PROFILE_DIR.
  if (typeof env['DSH_PROFILE_DIR'] === 'string' && env['DSH_PROFILE_DIR'] !== '') {
    return dirname(dirname(env['DSH_PROFILE_DIR']));
  }
  return join(homedir(), '.dsh');
}

/**
 * The directory this plugin owns for user data: the configuration file, and any
 * sound files the user keeps outside the package.
 *
 * Derived from {@link configFilePath} rather than hard-coded, so overriding
 * `DSH_TASK_ASK_NOTIFY_CONFIG` moves the configuration and the audio root
 * together with it.
 *
 * @param env environment to inspect
 * @returns an absolute directory
 */
export function pluginDataDir(env = process.env) {
  return dirname(configFilePath(env));
}

/**
 * @param env environment to inspect
 * @returns the absolute path of the optional JSON configuration file
 */
export function configFilePath(env = process.env) {
  const override = env[CONFIG_PATH_ENV];
  if (typeof override === 'string' && override !== '') return override;
  return join(resolveDshHome(env), 'plugin-data', PLUGIN_ID, 'config.json');
}

/**
 * @param value candidate
 * @returns true for a plain object (not null, not an array)
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Symbol cosmokit uses to mark a live configuration reference. Obtained from the
 * global symbol registry, so recognising one needs no import.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * Read a configuration field, unwrapping a `.volatile()` reference.
 *
 * A field declared volatile does not reach the plugin as a value: the Loader
 * substitutes a frozen `{ get(), [write](value) }` reference so it can commit a
 * settings-page edit into the running plugin without reloading it. Reading such a
 * field therefore means calling `get()` — and calling it again later is what makes
 * the edit visible.
 *
 * @param value a raw configuration field
 * @returns the current value, or undefined when an unreadable reference throws
 */
export function readConfigValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.get === 'function' && VOLATILE_WRITE in value) {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Deep-copy a configuration document, replacing every volatile reference with
 * the value it currently holds.
 *
 * Needed because Schemastery wraps a `.volatile()` field on every validation, so
 * both `Config['~standard'].validate(...)` and the config the Loader hands to
 * `apply()` contain references rather than values.
 *
 * @param value a configuration document, or a leaf value
 * @returns a plain, freshly allocated equivalent
 */
export function unwrapVolatileDeep(value) {
  const plain = readConfigValue(value);
  if (Array.isArray(plain)) return plain.map((entry) => unwrapVolatileDeep(entry));
  if (!isPlainObject(plain)) return plain;
  const output = {};
  for (const key of Object.keys(plain)) output[key] = unwrapVolatileDeep(plain[key]);
  return output;
}

/**
 * Project a candidate onto the shape of `shape`, dropping unknown keys.
 *
 * Schemastery keeps unknown keys in its validated output, so this projection is
 * what stops a stray field in one configuration layer from leaking into the
 * effective config or into a later merge step. Volatile references are unwrapped
 * on the way through, so every layer above works with plain values.
 *
 * @param candidate raw values
 * @param shape template to follow (the schema defaults)
 * @returns a new object containing only recognised keys, or undefined if nothing matched
 */
export function projectOntoShape(candidate, shape) {
  if (!isPlainObject(candidate)) return undefined;
  const output = {};
  for (const key of Object.keys(shape)) {
    const value = readConfigValue(candidate[key]);
    if (value === undefined) continue;
    if (isPlainObject(shape[key])) {
      const nested = projectOntoShape(value, shape[key]);
      if (nested !== undefined) output[key] = nested;
    } else {
      output[key] = value;
    }
  }
  return Object.keys(output).length === 0 ? {} : output;
}

/**
 * Deep-merge configuration layers, later layers winning per leaf.
 * @param shape template describing recognised keys
 * @param layers layers in increasing precedence
 * @returns the merged object
 */
export function mergeLayers(shape, ...layers) {
  const output = {};
  for (const key of Object.keys(shape)) {
    if (isPlainObject(shape[key])) {
      output[key] = mergeLayers(shape[key], ...layers.map((layer) => (isPlainObject(layer?.[key]) ? layer[key] : {})));
    } else {
      output[key] = shape[key];
      for (const layer of layers) {
        const value = layer?.[key];
        if (value !== undefined) output[key] = value;
      }
    }
  }
  return output;
}

/**
 * Read a stored volume that predates the 0–100 scale on the new one.
 *
 * The scale changed from a 0–1 fraction to 0–100 so the page can show a number a
 * person can reason about. A value in `(0, 1]` can only be the old scale — under
 * the new one it would mean "essentially silent" — so it is multiplied by 100 and
 * the perceived loudness is preserved. `0` means silent in both scales, and
 * anything above `1` is already the new scale. The conversion is idempotent, so a
 * value written by the page is never scaled twice.
 *
 * @param candidate a projected configuration document (mutated in place)
 */
export function migrateVolumeScale(candidate) {
  const volume = candidate?.sound?.volume;
  if (typeof volume === 'number' && volume > 0 && volume <= 1) {
    candidate.sound.volume = Math.round(volume * 100);
  }
}

/**
 * Normalise an arbitrary candidate into a complete, validated configuration.
 * @param candidate raw configuration
 * @returns `{ config }` on success or `{ issues }` on failure
 */
export function normalizeConfig(candidate) {
  const shape = schemaDefaults();
  const projected = projectOntoShape(candidate, shape) ?? {};
  migrateVolumeScale(projected);
  const result = Config['~standard'].validate(projected);
  if (result.issues !== undefined) return { issues: result.issues };
  // Validation re-wraps volatile fields as references; everything above this
  // point works with plain values.
  return { config: unwrapVolatileDeep(result.value) };
}

/**
 * Parse the contents of the optional JSON file.
 * @param text file contents
 * @returns `{ values }` on success, `{ error }` when the text is not a JSON object
 */
export function parseConfigText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `not valid JSON (${error.message})` };
  }
  if (!isPlainObject(parsed)) return { error: 'the top level must be a JSON object' };
  return { values: parsed };
}

/**
 * Formats validation issues the way Cordis does, so log lines read the same as a
 * Loader startup failure.
 * @param issues issues returned by the schema
 * @returns a single-line summary
 */
export function formatIssues(issues) {
  return issues
    .map((issue) => (Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

/**
 * Holds the effective configuration and keeps both layers fresh.
 *
 * Two things can change the configuration while the plugin runs: the JSON file
 * (re-read by the watcher) and a settings-page edit, which the Loader commits into
 * the row's volatile references and announces as `loader/volatile-update` — the
 * entry point for that is {@link ConfigStore.refreshRow}.
 */
export class ConfigStore {
  #rowRaw;
  #rowValues;
  #fileValues = {};
  #effective;
  #watcher = null;
  #reloadTimer = null;

  /**
   * @param options store options
   * @param options.rowConfig configuration from the plugin row (already validated by the Loader)
   * @param options.log minimal logger with `warn`/`debug`
   * @param options.path absolute path of the JSON override file
   * @param options.watchImpl injectable `fs.watch`, for tests
   * @param options.readImpl injectable `fs.readFileSync`, for tests
   * @param options.mkdirImpl injectable `fs.mkdirSync`, for tests
   * @param options.debounceMs debounce applied to filesystem change events
   */
  constructor({
    rowConfig,
    log,
    path = configFilePath(),
    watchImpl = watch,
    readImpl = readFileSync,
    mkdirImpl = mkdirSync,
    debounceMs = 200,
  }) {
    // The row object is kept, not just its values: volatile fields are live
    // references, so reading them again is what picks up a settings-page edit.
    this.#rowRaw = rowConfig;
    this.#rowValues = projectOntoShape(rowConfig, schemaDefaults()) ?? {};
    this.log = log;
    this.path = path;
    this.watchImpl = watchImpl;
    this.readImpl = readImpl;
    this.mkdirImpl = mkdirImpl;
    this.debounceMs = debounceMs;

    const initial = normalizeConfig(this.#rowValues);
    if (initial.issues !== undefined) {
      // The Loader already validated the row config, so this only happens if the
      // schema and the row drifted apart; falling back to pure defaults keeps the
      // plugin loaded and says why.
      this.log?.warn?.(`${PLUGIN_ID}: row config rejected (${formatIssues(initial.issues)}); using defaults`);
      this.#effective = schemaDefaults();
    } else {
      this.#effective = initial.config;
    }
  }

  /**
   * Re-read the row's volatile fields after the Loader committed a settings-page
   * edit into them, and recompute the effective configuration.
   *
   * Called from the `loader/volatile-update` listener. The values are read
   * through the same references the Loader writes into, so no reload and no
   * restart is involved and the change applies to the very next alert.
   *
   * @returns the effective configuration after the refresh
   */
  refreshRow() {
    const next = projectOntoShape(this.#rowRaw, schemaDefaults()) ?? {};
    const changed = JSON.stringify(next) !== JSON.stringify(this.#rowValues);
    this.#rowValues = next;
    const effective = this.#recompute();
    if (changed) this.log?.debug?.(`${PLUGIN_ID}: configuration refreshed from the plugin row`);
    return effective;
  }

  /**
   * Read the JSON layer and recompute the effective configuration.
   * A missing file clears the layer; a broken or invalid file is reported and
   * otherwise ignored, leaving the previous effective configuration in force.
   * @returns the effective configuration after the attempt
   */
  reloadFromFile() {
    let text = null;
    try {
      text = this.readImpl(this.path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.log?.warn?.(`${PLUGIN_ID}: cannot read ${this.path} (${error.message}); ignoring the file layer`);
      }
      this.#fileValues = {};
      return this.#recompute();
    }

    const parsed = parseConfigText(String(text));
    if (parsed.error !== undefined) {
      this.log?.warn?.(`${PLUGIN_ID}: ${this.path} ${parsed.error}; ignoring the file layer`);
      this.#fileValues = {};
      return this.#recompute();
    }

    const projected = projectOntoShape(parsed.values, schemaDefaults()) ?? {};
    const unknown = Object.keys(parsed.values).filter((key) => !(key in schemaDefaults()));
    if (unknown.length > 0) {
      this.log?.warn?.(`${PLUGIN_ID}: ${this.path} has unknown fields (${unknown.join(', ')}); they are ignored`);
    }

    const previous = this.#fileValues;
    this.#fileValues = projected;
    const next = this.#recompute();
    if (!this.#fileAccepted) {
      this.#fileValues = previous;
      this.#recompute();
    } else {
      this.log?.debug?.(`${PLUGIN_ID}: configuration reloaded from ${this.path}`);
    }
    return next;
  }

  /** @returns the effective configuration */
  get config() {
    return this.#effective;
  }

  /**
   * Start watching the JSON file's directory, creating it if needed.
   * Watching the directory rather than the file means creating, replacing, or
   * deleting the file are all seen. The watcher is unref'd so it never keeps the
   * Host process alive.
   */
  start() {
    try {
      this.mkdirImpl(dirname(this.path), { recursive: true });
    } catch (error) {
      this.log?.debug?.(`${PLUGIN_ID}: cannot create ${dirname(this.path)} (${error.message}); hot reload disabled`);
      return;
    }
    try {
      this.#watcher = this.watchImpl(dirname(this.path), () => this.#scheduleReload());
      this.#watcher?.unref?.();
    } catch (error) {
      this.log?.debug?.(`${PLUGIN_ID}: cannot watch ${dirname(this.path)} (${error.message}); hot reload disabled`);
    }
  }

  /** Stop watching and cancel a pending reload. */
  dispose() {
    if (this.#reloadTimer !== null) {
      clearTimeout(this.#reloadTimer);
      this.#reloadTimer = null;
    }
    try {
      this.#watcher?.close?.();
    } catch {
      /* already closed */
    }
    this.#watcher = null;
  }

  /** @returns the merged, validated configuration, or null when the file layer is invalid */
  #recompute() {
    const merged = mergeLayers(schemaDefaults(), this.#rowValues, this.#fileValues);
    const result = normalizeConfig(merged);
    if (result.issues !== undefined) {
      this.#fileAccepted = false;
      this.log?.warn?.(
        `${PLUGIN_ID}: ${this.path} has an invalid value (${formatIssues(result.issues)}); keeping the previous configuration`,
      );
      return this.#effective;
    }
    this.#fileAccepted = true;
    this.#effective = result.config;
    return this.#effective;
  }

  #fileAccepted = true;

  /** Coalesce bursts of filesystem events into one reload. */
  #scheduleReload() {
    if (this.#reloadTimer !== null) clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null;
      this.reloadFromFile();
    }, this.debounceMs);
    this.#reloadTimer?.unref?.();
  }
}

/**
 * Create a store and load the JSON layer once.
 * @param options see {@link ConfigStore}
 * @returns the store
 */
export function createConfigStore(options) {
  const store = new ConfigStore(options);
  store.reloadFromFile();
  return store;
}
