#!/usr/bin/env node
/**
 * Fails when the tracked file set would publish something it should not.
 *
 * This is the machine-checkable half of the repository boundary described in
 * README.md > "Repository boundary". `npm run verify-boundary` scans every file
 * git would publish and reports:
 *
 *   1. machine-specific absolute paths (a user profile directory, a drive the
 *      author happens to use, the name of a private asset folder);
 *   2. credential-shaped text (private keys, common token prefixes, secret
 *      assignments);
 *   3. runtime state and generated artefacts that should never be committed;
 *   4. unexpectedly large files.
 *
 * It deliberately reads the *tracked* set rather than the working tree: untracked
 * local files, including imported audio and your own config.json, are exactly what
 * the boundary is supposed to keep out.
 *
 * Several search patterns below are assembled from fragments. That is not
 * obfuscation: it keeps this file from matching the very strings it looks for, so
 * the scan needs no exception list and can stay honest about its own source.
 *
 * Usage: node tools/verify-repo-boundary.mjs [--verbose]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Largest tracked file that is still plausible for a plugin like this. */
const MAX_TRACKED_BYTES = 2 * 1024 * 1024;
/** Extensions treated as binary: content rules do not apply to them. */
const BINARY_EXTENSIONS = new Set(['.wav', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif', '.zip', '.pdf']);
/** Files above this size are not read as text even when the extension allows it. */
const MAX_TEXT_BYTES = 1024 * 1024;

/**
 * User-profile directory shapes, in both separator styles.
 * Assembled from fragments so this file is not itself a match.
 */
const PROFILE_PATH_PATTERNS = [
  new RegExp(`[A-Za-z]:\\\\${'Us'}ers\\\\`, 'u'),
  new RegExp(`[A-Za-z]:/${'Us'}ers/`, 'u'),
  new RegExp(`/${'c'}/${'Us'}ers/`, 'u'),
  new RegExp(`/${'mn'}t/c/${'Us'}ers/`, 'u'),
  new RegExp(`/${'ho'}me/[a-z0-9._-]+/`, 'u'),
];

/** Markers of the author's machine that must never appear. */
const MACHINE_MARKERS = [
  'xia' + 'ow',
  'Index-' + 'TTS',
  'notify_' + 'delivery',
  '\\.z' + 'code',
  'Deepseek Harness ' + 'EAC',
  'Program Files\\\\' + 'DSH',
];

/** Credential shapes. Prefixes are split so this file does not match itself. */
const SECRET_PATTERNS = [
  new RegExp(`-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}`, 'u'),
  new RegExp(`\\b${'s'}k-[A-Za-z0-9]{16,}`, 'u'),
  new RegExp(`\\b${'gh'}p_[A-Za-z0-9]{20,}`, 'u'),
  new RegExp(`\\b${'AK'}IA[0-9A-Z]{12,}`, 'u'),
  new RegExp(`\\b${'xo'}xb-[A-Za-z0-9-]{10,}`, 'u'),
  new RegExp(`\\b${'pass'}word\\s*[:=]\\s*\\S`, 'iu'),
  new RegExp(`\\b${'sec'}ret\\s*[:=]\\s*\\S`, 'iu'),
  new RegExp(`\\b${'api'}Key\\s*[:=]\\s*\\S`, 'u'),
  new RegExp(`\\b${'tok'}en\\s*[:=]\\s*[A-Za-z0-9._-]{12,}`, 'u'),
];

/** Paths that indicate runtime state or build output slipped into the commit. */
const FORBIDDEN_TRACKED = [
  { label: 'installed dependencies', test: (path) => /(^|\/)node_modules\//u.test(path) },
  { label: 'build output', test: (path) => /(^|\/)(dist|build|coverage)\//u.test(path) },
  { label: 'runtime configuration', test: (path) => /(^|\/)config\.json$/u.test(path) },
  { label: 'a lockfile this project does not use', test: (path) => /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(path) },
  { label: 'a local backup', test: (path) => /\.(bak|orig|rej)(-|$)/u.test(path) || /\.bak$/u.test(path) },
  { label: 'a log file', test: (path) => /\.log$/u.test(path) },
  { label: 'internal planning notes', test: (path) => /(^|\/)DESIGN\.md$/u.test(path) || /^docs\//u.test(path) },
  {
    label: 'a personal sound file',
    // The two bundled cues are rendered by scripts in tools/ and their committed
    // bytes are re-proved by `--check`, so they are reviewable source rather than
    // opaque personal media. Everything else under audio/ is a user's own.
    test: (path) => {
      const normalized = path.replace(/\\/gu, '/').toLowerCase();
      if (!normalized.endsWith('.wav')) return false;
      return normalized !== 'audio/_default/chime.wav' && normalized !== 'audio/failed/alert-fail.wav';
    },
  },
];

/**
 * @param cwd repository directory
 * @returns the repository root reported by git
 */
function repoRoot(cwd) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
}

/**
 * @param root repository root
 * @returns tracked paths relative to the root, with forward slashes
 */
function trackedFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => entry.replace(/\\/gu, '/'));
}

/**
 * Scan one file.
 * @param root repository root
 * @param relative path relative to the root
 * @returns a list of findings
 */
function scanFile(root, relative) {
  const findings = [];
  const absolute = join(root, relative);

  for (const rule of FORBIDDEN_TRACKED) {
    if (rule.test(relative)) findings.push({ file: relative, line: 0, kind: 'tracked', message: rule.label });
  }

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    findings.push({ file: relative, line: 0, kind: 'missing', message: 'listed by git but not present in the working tree' });
    return findings;
  }

  if (stats.size > MAX_TRACKED_BYTES) {
    findings.push({
      file: relative,
      line: 0,
      kind: 'size',
      message: `${(stats.size / 1024 / 1024).toFixed(1)} MiB is larger than the ${MAX_TRACKED_BYTES / 1024 / 1024} MiB limit`,
    });
  }

  if (BINARY_EXTENSIONS.has(extname(relative).toLowerCase())) return findings;
  if (stats.size > MAX_TEXT_BYTES) return findings;

  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    return findings;
  }

  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const pattern of PROFILE_PATH_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ file: relative, line: index + 1, kind: 'path', message: `absolute user path matching ${pattern}` });
      }
    }
    for (const marker of MACHINE_MARKERS) {
      if (new RegExp(marker, 'u').test(line)) {
        findings.push({ file: relative, line: index + 1, kind: 'path', message: `machine-specific marker ${JSON.stringify(marker)}` });
      }
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ file: relative, line: index + 1, kind: 'secret', message: `credential-shaped text matching ${pattern}` });
      }
    }
  }

  return findings;
}

function main() {
  const verbose = process.argv.includes('--verbose');
  const cwd = dirname(fileURLToPath(import.meta.url));
  let root;
  try {
    root = repoRoot(cwd);
  } catch {
    console.error('verify-repo-boundary: not inside a git repository');
    return 2;
  }

  let files;
  try {
    files = trackedFiles(root);
  } catch (error) {
    console.error(`verify-repo-boundary: cannot list tracked files (${error.message})`);
    return 2;
  }

  const findings = [];
  let bytes = 0;
  for (const relative of files) {
    try {
      bytes += statSync(join(root, relative)).size;
    } catch {
      /* reported by scanFile */
    }
    findings.push(...scanFile(root, relative));
  }

  if (verbose) {
    for (const relative of files) console.log(`  tracked  ${relative}`);
  }

  console.log(`verify-repo-boundary: ${files.length} tracked file(s), ${(bytes / 1024).toFixed(0)} KiB`);

  if (findings.length === 0) {
    console.log('OK - no machine-specific path, credential, runtime state, or oversized file in the published set.');
    return 0;
  }

  console.error(`\nFAIL - ${findings.length} problem(s) would be published:\n`);
  for (const finding of findings) {
    const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  [${finding.kind}] ${location} - ${finding.message}`);
  }
  console.error('\nFix the file, or add it to .gitignore if it should stay local.');
  return 1;
}

process.exitCode = main();
