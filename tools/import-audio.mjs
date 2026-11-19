#!/usr/bin/env node
/**
 * Imports a local library of sound files into the plugin's scenario directories,
 * verifying every copy with SHA-256.
 *
 * Why this is a script and not a committed folder of audio
 * --------------------------------------------------------
 * The plugin plays whatever `.wav` files sit in `audio/complete/`,
 * `audio/ask-single/`, and `audio/ask-multiple/`. An author's own recordings or
 * synthesised voice prompts are personal media: they are not part of the source
 * code, they are not licensed for redistribution by this project, and they must
 * not end up in a public commit. This script therefore copies them from a
 * directory you name on the command line, and `.gitignore` keeps the result out
 * of version control. The command line is never written to disk, so no local path
 * is ever baked into the repository.
 *
 * Expected source layout (the pack this plugin was designed against):
 *
 *   <source>/complete/      *.wav   ->  audio/complete/
 *   <source>/ask/single/    *.wav   ->  audio/ask-single/
 *   <source>/ask/multiple/  *.wav   ->  audio/ask-multiple/
 *
 * A source directory that already *is* one scenario can be imported on its own:
 *
 *   node tools/import-audio.mjs --source <dir> --scenario complete
 *
 * Where the files land
 * --------------------
 * By default they go to the plugin's own data directory
 * (`<DSH_HOME>/plugin-data/dsh-task-ask-notify/audio/...`), which is where the
 * plugin looks first for a relative sound path. That is deliberate: a bundle
 * installed from a package directory runs from its installed copy, so writing
 * into the clone would have no effect until the bundle was reinstalled.
 * `--target package` writes into the clone instead, for a setup that loads the
 * plugin in place.
 *
 * Hashes are recorded in `.audio-import.json` (git-ignored). `--verify` re-checks
 * the imported files against that record without touching anything.
 *
 * Usage:
 *   node tools/import-audio.mjs --source <dir> [--dry-run] [--quiet]
 *   node tools/import-audio.mjs --source <dir> --scenario <complete|ask-single|ask-multiple>
 *   node tools/import-audio.mjs --verify
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDataDir } from '../lib/config.js';

/** Placeholder paths used in help text and errors, never real ones. */
const SOURCE_PLACEHOLDER = '<a directory you own>';

/** Scenario name -> destination directory, and the layouts recognised under `--source`. */
const SCENARIOS = [
  { name: 'complete', destination: join('audio', 'complete'), sourceCandidates: [['complete']] },
  { name: 'ask-single', destination: join('audio', 'ask-single'), sourceCandidates: [['ask', 'single'], ['ask-single']] },
  {
    name: 'ask-multiple',
    destination: join('audio', 'ask-multiple'),
    sourceCandidates: [['ask', 'multiple'], ['ask-multiple']],
  },
];

/** @returns the absolute plugin root */
function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * @param buffer bytes to hash
 * @returns the SHA-256 digest in lower-case hex
 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * @param filePath file to hash
 * @returns the SHA-256 digest of its contents
 */
function hashFile(filePath) {
  return sha256(readFileSync(filePath));
}

/**
 * @param dir absolute directory path
 * @returns the `.wav` file paths directly inside it, sorted
 */
function wavsIn(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => extname(name).toLowerCase() === '.wav')
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Locate the source directory for one scenario.
 * @param source absolute source root
 * @param scenario a scenario descriptor
 * @returns the absolute source directory, or null
 */
function findSourceDir(source, scenario) {
  for (const parts of scenario.sourceCandidates) {
    const candidate = join(source, ...parts);
    if (existsSync(candidate) && statSync(candidate).isDirectory() && wavsIn(candidate).length > 0) return candidate;
  }
  return null;
}

/**
 * Parse the command line.
 * @param argv raw arguments
 * @returns parsed options, or `{ error }`
 */
function parseArguments(argv) {
  const options = {
    source: null,
    scenario: null,
    target: 'user',
    dryRun: false,
    verify: false,
    quiet: false,
    manifest: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--source':
        options.source = argv[++index];
        break;
      case '--scenario':
        options.scenario = argv[++index];
        break;
      case '--target':
        options.target = argv[++index];
        break;
      case '--manifest':
        options.manifest = argv[++index];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verify':
        options.verify = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        return { error: `unknown argument "${token}"` };
    }
  }
  if (options.verify) return options;
  if (options.help === true) return options;
  if (options.target !== 'user' && options.target !== 'package') {
    return { error: `--target must be "user" or "package", not "${options.target}"` };
  }
  if (typeof options.source !== 'string' || options.source === '') {
    return { error: 'missing --source; see the header of this file for the accepted layout' };
  }
  if (options.scenario !== null && !SCENARIOS.some((scenario) => scenario.name === options.scenario)) {
    return { error: `unknown --scenario "${options.scenario}"` };
  }
  return options;
}

/**
 * Resolve where imported files should land.
 *
 * The default is the plugin's own data directory, because a bundle installed from
 * a package directory runs from that installed copy and relative sound paths
 * prefer the user's audio root — that is what makes an import take effect without
 * reinstalling. `--target package` writes into the clone instead, which is what a
 * development setup that loads the plugin in place wants.
 *
 * @param target `user` or `package`
 * @returns `{ dir, label }`
 */
function resolveTarget(target) {
  if (target === 'package') return { dir: pluginRoot(), label: 'the package directory' };
  return { dir: pluginDataDir(), label: 'the plugin data directory' };
}

/** @param _ unused @returns the help text */
function help() {
  return [
    'Import local sound files into the plugin and verify every copy with SHA-256.',
    '',
    `  node tools/import-audio.mjs --source ${SOURCE_PLACEHOLDER} [--dry-run] [--quiet]`,
    '  node tools/import-audio.mjs --source <dir> --scenario <complete|ask-single|ask-multiple>',
    '  node tools/import-audio.mjs --source <dir> --target package',
    '  node tools/import-audio.mjs --verify',
    '',
    'The imported files are intentionally ignored by git; the public repository ships',
    'only the generated audio/_default/chime.wav.',
  ].join('\n');
}

/**
 * Import every scenario found under the source directory.
 * @param options parsed options
 * @returns the process exit code
 */
function runImport(options) {
  const root = pluginRoot();
  const source = isAbsolute(options.source) ? options.source : resolve(process.cwd(), options.source);
  const manifestPath = options.manifest ?? join(root, '.audio-import.json');
  const target = resolveTarget(options.target);

  if (!existsSync(source) || !statSync(source).isDirectory()) {
    console.error(`--source is not a readable directory: ${SOURCE_PLACEHOLDER}`);
    return 2;
  }

  const wanted = options.scenario === null ? SCENARIOS : SCENARIOS.filter((scenario) => scenario.name === options.scenario);
  const manifest = { importedAt: new Date().toISOString(), target: options.target, scenarios: {} };
  let copied = 0;
  let unchanged = 0;
  let bytes = 0;
  let missing = 0;

  for (const scenario of wanted) {
    // `--scenario` treats the source directory itself as the scenario directory.
    const sourceDir = options.scenario === null ? findSourceDir(source, scenario) : source;
    const files = sourceDir === null ? [] : wavsIn(sourceDir);
    if (files.length === 0) {
      console.log(`${scenario.name}: no .wav found in the source; skipped`);
      missing += 1;
      continue;
    }

    const destination = join(target.dir, scenario.destination);
    if (options.dryRun !== true) mkdirSync(destination, { recursive: true });

    const entries = {};
    for (const file of files) {
      const name = basename(file);
      const destinationFile = join(destination, name);
      const sourceHash = hashFile(file);
      const size = statSync(file).size;
      bytes += size;

      const alreadyThere = existsSync(destinationFile) && hashFile(destinationFile) === sourceHash;
      if (alreadyThere) {
        unchanged += 1;
      } else if (options.dryRun === true) {
        copied += 1;
      } else {
        copyFileSync(file, destinationFile);
        // Prove the copy, do not assume it.
        const targetHash = hashFile(destinationFile);
        if (targetHash !== sourceHash) {
          console.error(`${scenario.name}/${name}: copy does not match the source (${sourceHash} vs ${targetHash})`);
          return 1;
        }
        copied += 1;
      }
      entries[name] = { sha256: sourceHash, bytes: size };
    }
    manifest.scenarios[scenario.name] = entries;
    console.log(`${scenario.name}: ${files.length} file(s) -> ${scenario.destination} under ${target.label}`);
  }

  if (options.dryRun !== true && copied + unchanged > 0) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  if (!options.quiet) {
    console.log(
      `\n${options.dryRun === true ? 'would copy' : 'copied'} ${copied}, already current ${unchanged}, ` +
        `${(bytes / 1024).toFixed(0)} KiB total`,
    );
    if (missing > 0) console.log(`${missing} scenario(s) had no source files`);
    if (options.dryRun !== true && copied + unchanged > 0) console.log(`hash record: ${basename(manifestPath)}`);
    console.log(`Imported into ${target.label}: ${target.dir}`);
    console.log('These files are local only: .gitignore keeps every .wav except audio/_default/chime.wav out of git.');
  }
  return 0;
}

/**
 * Re-verify previously imported files against the recorded hashes.
 * @param options parsed options
 * @returns the process exit code
 */
function runVerify(options) {
  const root = pluginRoot();
  const manifestPath = options.manifest ?? join(root, '.audio-import.json');
  if (!existsSync(manifestPath)) {
    console.error(`no hash record at ${basename(manifestPath)}; import some audio first`);
    return 2;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Older records predate the target stamp; assume the package directory then.
  const target = resolveTarget(manifest.target === 'package' ? 'package' : options.target);
  const base = manifest.target === undefined ? root : target.dir;
  let checked = 0;
  let failed = 0;

  for (const scenario of SCENARIOS) {
    const entries = manifest.scenarios?.[scenario.name] ?? {};
    const names = Object.keys(entries);
    if (names.length === 0) continue;
    for (const name of names) {
      const destinationFile = join(base, scenario.destination, name);
      checked += 1;
      if (!existsSync(destinationFile)) {
        console.error(`MISSING  ${scenario.name}/${name}`);
        failed += 1;
        continue;
      }
      const actual = hashFile(destinationFile);
      if (actual !== entries[name].sha256) {
        console.error(`CHANGED  ${scenario.name}/${name}`);
        failed += 1;
      } else if (options.quiet !== true) {
        console.log(`ok       ${scenario.name}/${name}`);
      }
    }
  }

  console.log(`\n${checked - failed}/${checked} file(s) match the recorded hashes in ${base}`);
  return failed === 0 ? 0 : 1;
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error !== undefined) {
    console.error(parsed.error);
    console.error(help());
    return 2;
  }
  if (parsed.help === true) {
    console.log(help());
    return 0;
  }
  return parsed.verify ? runVerify(parsed) : runImport(parsed);
}

process.exitCode = main();
