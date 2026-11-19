/**
 * Configuration: schema defaults, layer precedence, validation reporting, and
 * hot reload of the user-owned JSON file.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  CONFIG_PATH_ENV,
  Config,
  ConfigStore,
  configFilePath,
  createConfigStore,
  formatIssues,
  mergeLayers,
  normalizeConfig,
  parseConfigText,
  pluginDataDir,
  pluginRoot,
  projectOntoShape,
  readConfigValue,
  resolveDshHome,
  schemaDefaults,
  unwrapVolatileDeep,
} from '../lib/config.js';
import { recordingLogger } from './helpers.mjs';

test('the schema defaults are complete and are the schema’s own output', () => {
  const defaults = schemaDefaults();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.complete.debounceMs, 2000);
  assert.equal(defaults.complete.dir, 'audio/complete');
  assert.equal(defaults.askSingle.dir, 'audio/ask-single');
  assert.equal(defaults.askMultiple.dir, 'audio/ask-multiple');
  assert.equal(defaults.failed.enabled, true);
  assert.equal(defaults.failed.dir, 'audio/failed');
  assert.deepEqual(defaults.failed.reasons, ['error']);
  assert.equal(defaults.failed.includeReason, true);
  assert.equal(defaults.sound.fallback, 'audio/_default/chime.wav');
  assert.equal(defaults.sound.volume, 100);
  assert.equal(defaults.notify.aumid, 'com.deepseek.dsh');
  assert.equal(defaults.notify.silentSystemSound, true);
  assert.equal(defaults.notify.includeQuestionInBody, false);
  assert.equal(defaults.dedup.completeMs, 3000);
  assert.equal(defaults.dedup.failedMs, 5000);
  assert.equal(defaults.messages.failedTitle, '本轮运行失败');
  assert.equal(defaults.sessions.includeSubagents, false);

  // Every default is a plain value, not the live reference Schemastery would
  // substitute for a volatile field — the whole layer above depends on that.
  assert.deepEqual(defaults, JSON.parse(JSON.stringify(defaults)));
  assert.deepEqual(defaults, unwrapVolatileDeep(Config['~standard'].validate({}).value));
  assert.notEqual(typeof defaults.enabled, 'object');
});

test('a partial configuration keeps every other default', () => {
  const result = normalizeConfig({ complete: { debounceMs: 15000 } });
  assert.equal(result.issues, undefined);
  assert.equal(result.config.complete.debounceMs, 15000);
  assert.equal(result.config.complete.dir, 'audio/complete');
  assert.equal(result.config.sound.volume, 100);
});

test('a stored 0–1 volume is carried onto the 0–100 scale without changing loudness', () => {
  // Values in (0, 1] can only be the old fraction: under the new scale they would
  // mean "essentially silent". 0 is silent in both, and anything above 1 is
  // already the new scale.
  assert.equal(normalizeConfig({ sound: { volume: 0.5 } }).config.sound.volume, 50);
  assert.equal(normalizeConfig({ sound: { volume: 1 } }).config.sound.volume, 100);
  assert.equal(normalizeConfig({ sound: { volume: 0 } }).config.sound.volume, 0);
  assert.equal(normalizeConfig({ sound: { volume: 0.25 } }).config.sound.volume, 25);
  // Idempotent: a value the page wrote is never scaled twice.
  assert.equal(normalizeConfig({ sound: { volume: 50 } }).config.sound.volume, 50);
  assert.equal(normalizeConfig({ sound: { volume: 100 } }).config.sound.volume, 100);
  assert.equal(normalizeConfig({ sound: { volume: 2 } }).config.sound.volume, 2);
  // A missing value keeps the full-amplitude default, as before.
  assert.equal(normalizeConfig({}).config.sound.volume, 100);
});

test('out-of-range and wrongly-typed values are reported with their path', () => {
  const volume = normalizeConfig({ sound: { volume: 101 } });
  assert.equal(volume.config, undefined);
  assert.deepEqual(volume.issues[0].path, ['sound', 'volume']);
  assert.match(formatIssues(volume.issues), /sound\.volume/);

  const type = normalizeConfig({ enabled: 'yes' });
  assert.match(formatIssues(type.issues), /enabled/);

  const debounce = normalizeConfig({ complete: { debounceMs: -1 } });
  assert.match(formatIssues(debounce.issues), /complete\.debounceMs/);
});

test('unknown fields are dropped rather than carried into the effective config', () => {
  const projected = projectOntoShape({ nope: 1, complete: { dir: 'x', extra: true } }, schemaDefaults());
  assert.deepEqual(projected, { complete: { dir: 'x' } });
  const result = normalizeConfig({ nope: 1, complete: { dir: 'x', extra: true } });
  assert.equal(result.config.nope, undefined);
  assert.equal(result.config.complete.extra, undefined);
  assert.equal(result.config.complete.dir, 'x');
});

test('later layers win per leaf, and unset leaves keep the layer beneath', () => {
  const shape = { a: 1, nested: { x: 1, y: 2 } };
  const merged = mergeLayers(shape, { a: 9 }, { nested: { y: 8 } });
  assert.deepEqual(merged, { a: 9, nested: { x: 1, y: 8 } });
});

test('the JSON file must be an object', () => {
  assert.deepEqual(parseConfigText('{"a":1}').values, { a: 1 });
  assert.match(parseConfigText('[1,2]').error, /object/);
  assert.match(parseConfigText('null').error, /object/);
  assert.match(parseConfigText('{oops').error, /not valid JSON/);
});

test('the config file location follows DSH_HOME, then the profile directory, then the home directory', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:/dsh-home' }), 'C:/dsh-home');
  assert.equal(resolveDshHome({ DSH_PROFILE_DIR: 'C:/dsh-home/profiles/desktop' }), 'C:/dsh-home');
  assert.ok(resolveDshHome({}).length > 0);

  // Separators are platform-specific; compare on a normalised form.
  const slashed = (value) => value.replace(/\\/gu, '/');
  assert.equal(
    slashed(configFilePath({ DSH_HOME: 'C:/dsh-home' })),
    'C:/dsh-home/plugin-data/dsh-task-ask-notify/config.json',
  );
  assert.equal(
    configFilePath({ [CONFIG_PATH_ENV]: 'D:/elsewhere/config.json', DSH_HOME: 'C:/dsh-home' }),
    'D:/elsewhere/config.json',
  );
});

test('the user data directory follows the configuration file', () => {
  assert.equal(
    pluginDataDir({ DSH_HOME: 'C:/dsh-home' }).replace(/\\/gu, '/'),
    'C:/dsh-home/plugin-data/dsh-task-ask-notify',
  );
  // Overriding the configuration path moves the audio root with it.
  assert.equal(pluginDataDir({ [CONFIG_PATH_ENV]: 'D:/elsewhere/config.json' }).replace(/\\/gu, '/'), 'D:/elsewhere');
});

test('pluginRoot points at the package directory, whatever that directory is called', () => {
  // The clone directory is typically named after the repository, not after the
  // package, so assert the manifest contract instead of a directory name.
  const root = pluginRoot();
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-task-ask-notify');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.exports['.'], './lib/index.js');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(existsSync(join(root, 'lib', 'index.js')), true);
  assert.equal(existsSync(join(root, 'cordis.patch.yml')), true);
  assert.equal(existsSync(join(root, 'audio', '_default', 'chime.wav')), true);
  assert.equal(existsSync(join(root, 'locale', 'en.json')), true);
});

test('the JSON layer overrides the plugin row, and an invalid value never takes effect', () => {
  const log = recordingLogger();
  const store = new ConfigStore({
    rowConfig: { complete: { debounceMs: 5000 }, sound: { volume: 0.5 } },
    log,
    path: 'X:/never/read.json',
  });
  assert.equal(store.config.complete.debounceMs, 5000);
  assert.equal(store.config.sound.volume, 50, 'the row carried an old-scale 0.5');

  store.readImpl = () => JSON.stringify({ complete: { debounceMs: 15000 } });
  store.reloadFromFile();
  assert.equal(store.config.complete.debounceMs, 15000);
  assert.equal(store.config.sound.volume, 50, 'the row value must survive a partial file');

  store.readImpl = () => JSON.stringify({ sound: { volume: 101 } });
  store.reloadFromFile();
  assert.equal(store.config.sound.volume, 50, 'an invalid file must not change the effective config');
  assert.match(log.text(), /invalid value/);

  store.readImpl = () => JSON.stringify({ sound: { volume: 30 } });
  store.reloadFromFile();
  assert.equal(store.config.sound.volume, 30, 'the file wins over the row on the new scale');

  store.readImpl = () => '{ not json';
  store.reloadFromFile();
  assert.equal(store.config.complete.debounceMs, 5000, 'unreadable JSON drops the file layer');
  assert.match(log.text(), /not valid JSON/);

  store.readImpl = () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  store.reloadFromFile();
  assert.equal(store.config.complete.dir, 'audio/complete');
});

test('unknown fields in the JSON file are reported once and ignored', () => {
  const log = recordingLogger();
  const store = new ConfigStore({ rowConfig: {}, log, path: 'X:/never/read.json' });
  store.readImpl = () => JSON.stringify({ nope: true, complete: { debounceMs: 1000 } });
  store.reloadFromFile();
  assert.match(log.text(), /unknown fields \(nope\)/);
  assert.equal(store.config.complete.debounceMs, 1000);
});

test('a rejected plugin row falls back to defaults instead of failing the plugin', () => {
  const log = recordingLogger();
  // Bypass the Loader by handing the store a row that the schema rejects.
  const store = new ConfigStore({ rowConfig: { enabled: 'nope' }, log, path: 'X:/never/read.json' });
  assert.equal(store.config.enabled, true);
  assert.match(log.text(), /row config rejected/);
});

test('the configuration file is reloaded when it changes, and a later good value replaces a bad one', async () => {
  const log = recordingLogger();
  let contents = JSON.stringify({ complete: { debounceMs: 8000 } });
  let trigger = null;
  const store = createConfigStore({
    rowConfig: {},
    log,
    path: join('X:/cfg', 'config.json'),
    readImpl: () => contents,
    mkdirImpl: () => {},
    watchImpl: (_dir, listener) => {
      trigger = listener;
      return { close: () => {}, unref: () => {} };
    },
    debounceMs: 5,
  });
  assert.equal(store.config.complete.debounceMs, 8000);

  store.start();
  assert.equal(typeof trigger, 'function', 'start() must install a watcher');

  contents = JSON.stringify({ complete: { debounceMs: 12000 } });
  trigger();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(store.config.complete.debounceMs, 12000);

  contents = '{ broken';
  trigger();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(store.config.complete.debounceMs, 2000, 'a broken file drops back to the row/default layer');

  store.dispose();
});

test('a failing watcher or unwritable directory disables hot reload without throwing', () => {
  const log = recordingLogger();
  const store = new ConfigStore({ rowConfig: {}, log, path: join('X:/cfg', 'config.json'), readImpl: () => '{}' });
  store.mkdirImpl = () => {
    throw new Error('read-only');
  };
  store.start();
  assert.match(log.text(), /hot reload disabled/);

  const store2 = new ConfigStore({ rowConfig: {}, log, path: join('X:/cfg2', 'config.json'), readImpl: () => '{}' });
  store2.mkdirImpl = () => {};
  store2.watchImpl = () => {
    throw new Error('no watcher');
  };
  store2.start();
  assert.match(log.text(), /cannot watch/);
});

/**
 * The paths the configuration page edits. DSH only offers a settings form for
 * volatile fields and refuses writes to anything else, so this list, the schema
 * markers, and `lib/client.js` must agree — a mismatch would show as a page whose
 * save always fails.
 */
const PAGE_FIELDS = [
  'enabled',
  'complete.enabled',
  'complete.debounceMs',
  'askSingle.enabled',
  'askMultiple.enabled',
  'failed.enabled',
  'failed.includeReason',
  'sound.enabled',
  'sound.volume',
  'sound.minGapMs',
  'notify.enabled',
  'notify.includeQuestionInBody',
  'sessions.includeSubagents',
];

/**
 * @param path dotted key path
 * @returns the Schemastery node at that path
 */
function schemaNode(path) {
  let cursor = Config;
  for (const key of path.split('.')) {
    cursor = cursor.dict?.[key] ?? cursor.inner?.dict?.[key];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

test('exactly the configuration-page fields are volatile', () => {
  // The listen button writes this one; it is not a preference, so it is volatile
  // without appearing as a row in the field table.
  assert.equal(
    schemaNode('sound.auditionAt')?.meta?.volatile,
    true,
    'sound.auditionAt must be volatile: the listen button reaches the plugin by writing it',
  );

  for (const path of PAGE_FIELDS) {
    assert.equal(
      schemaNode(path)?.meta?.volatile,
      true,
      `${path} must be .volatile(): the settings service only offers a form for volatile fields`,
    );
  }

  for (const path of [
    'complete.dir',
    'askSingle.dir',
    'failed.dir',
    'failed.reasons',
    'sound.fallback',
    'sound.maxDurationMs',
    'notify.aumid',
    'notify.silentSystemSound',
    'notify.bodyMaxChars',
    'dedup.completeMs',
    'dedup.failedMs',
    'messages.completeTitle',
    'messages.failedTitle',
    'messages.fallbackBody',
  ]) {
    assert.notEqual(
      schemaNode(path)?.meta?.volatile,
      true,
      `${path} must stay ordinary configuration: it is edited in the profile patch or the JSON file, not on the page`,
    );
  }
});

test('the client page declares exactly the volatile paths', () => {
  const source = readFileSync(join(pluginRoot(), 'lib', 'client.js'), 'utf8');
  const declared = new Set();
  for (const match of source.matchAll(/path:\s*\[([^\]]*)\]/gu)) {
    const keys = [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]);
    if (keys.length > 0) declared.add(keys.join('.'));
  }
  assert.deepEqual(
    [...declared].sort(),
    [...PAGE_FIELDS].sort(),
    'lib/client.js and the schema have drifted apart',
  );
});

test('a volatile reference is unwrapped, and refreshRow picks up a committed edit', () => {
  const write = Symbol.for('cosmokit.volatile.write');
  /** Build the frozen reference the Loader substitutes for a volatile field. */
  const volatileRef = (initial) => {
    let current = initial;
    return Object.freeze({
      get: () => current,
      [write]: (next) => {
        current = next;
      },
    });
  };

  // Reading a reference yields its value; an ordinary value passes through.
  const ref = volatileRef(2000);
  assert.equal(readConfigValue(ref), 2000);
  assert.equal(readConfigValue('plain'), 'plain');
  assert.equal(readConfigValue(undefined), undefined);
  ref[write](15000);
  assert.equal(readConfigValue(ref), 15000);

  // The row arrives with volatile references in place of values.
  const row = {
    enabled: volatileRef(true),
    complete: { enabled: volatileRef(true), debounceMs: volatileRef(2000), dir: 'audio/complete' },
  };
  assert.deepEqual(projectOntoShape(row, schemaDefaults()), {
    enabled: true,
    complete: { enabled: true, debounceMs: 2000, dir: 'audio/complete' },
  });

  const log = recordingLogger();
  const store = new ConfigStore({ rowConfig: row, log, path: 'X:/never/read.json', readImpl: () => '{}' });
  store.reloadFromFile();
  assert.equal(store.config.complete.debounceMs, 2000);

  // The Loader commits a settings-page edit into the same reference...
  row.complete.debounceMs[write](30000);
  // ...and re-reading the row is what applies it, with no reload.
  store.refreshRow();
  assert.equal(store.config.complete.debounceMs, 30000);
  assert.match(log.text(), /refreshed from the plugin row/);

  // A JSON-file value still wins over the row, and survives a refresh.
  store.readImpl = () => JSON.stringify({ complete: { debounceMs: 9000 } });
  store.reloadFromFile();
  assert.equal(store.config.complete.debounceMs, 9000);
  row.complete.enabled[write](false);
  store.refreshRow();
  assert.equal(store.config.complete.debounceMs, 9000);
  assert.equal(store.config.complete.enabled, false);
});
