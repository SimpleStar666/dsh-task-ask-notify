/**
 * Alert scheduling: the debounce, the de-duplication, sound arbitration, and the
 * notification text. Everything runs on a fake clock, so no test waits for real
 * time.
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { schemaDefaults } from '../lib/config.js';
import { Alerter, applyCount, truncate } from '../lib/dispatch.js';
import { WavDirectoryCache } from '../lib/policy.js';
import { cleanupTempDirs, fakeClock, makeTempDir, recordingLogger, writeWav } from './helpers.mjs';

after(cleanupTempDirs);

/**
 * Build an alerter wired to a fake clock and a recording delivery callback.
 * @param overrides configuration overrides merged onto the schema defaults
 * @param options harness options
 * @param options.createDirs whether to materialise the scenario sound directories
 * @param options.random random source, for tests that need variety
 */
function harness(overrides = {}, { createDirs = true, random = () => 0 } = {}) {
  const config = structuredClone(schemaDefaults());
  config.complete.debounceMs = 2000;
  deepMerge(config, overrides);

  const clock = fakeClock();
  const delivered = [];
  const log = recordingLogger();
  const root = makeTempDir();
  // A separate user audio root, empty unless a test fills it.
  const userRoot = makeTempDir();
  const cache = new WavDirectoryCache();

  // A real directory layout with one file per scenario, so audio selection runs
  // for real rather than being stubbed out.
  if (createDirs) {
    for (const [scenario, dir] of [
      ['complete', config.complete.dir],
      ['ask-single', config.askSingle.dir],
      ['ask-multiple', config.askMultiple.dir],
      ['failed', config.failed.dir],
    ]) {
      if (dir === '' || dir.includes(':')) continue;
      const full = join(root, dir);
      mkdirSync(full, { recursive: true });
      writeWav(full, `${scenario}.wav`, 0.3);
    }
    mkdirSync(join(root, 'audio', '_default'), { recursive: true });
    writeWav(join(root, 'audio', '_default'), 'chime.wav', 0.6);
  }

  const alerter = new Alerter({
    store: { config },
    deliver: (alert) => delivered.push(alert),
    log,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random,
    cache,
    root,
    userRoot,
  });

  return { alerter, clock, delivered, log, config, root, userRoot, cache };
}

/** @param target object to mutate @param patch values to merge in */
function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      target[key] ??= {};
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

const session = (overrides = {}) => ({
  id: 's1',
  header: { id: 's1', cwd: 'C:/work/project', ...overrides },
});

const turnEnd = (reason = { kind: 'completed' }) => ({ type: 'turn/end', data: { turn: 1, reason } });
const turnStart = () => ({ type: 'turn/start', data: { turn: 2 } });
const ask = (count, callId = 'call-1') => ({
  type: 'tool/call',
  data: {
    turn: 1,
    step: 1,
    callId,
    name: 'ask_user_question',
    arguments: JSON.stringify({
      questions: Array.from({ length: count }, (_, index) => ({ id: `q${index}`, question: `问题 ${index}` })),
    }),
  },
});

test('a clean turn end alerts only after the quiet period', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), turnEnd());

  clock.advance(1999);
  assert.equal(delivered.length, 0, 'nothing may fire before the debounce elapses');

  clock.advance(1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].scenario, 'complete');
  assert.equal(delivered[0].title, '任务完成');
  assert.equal(delivered[0].notify, true);
  assert.match(delivered[0].audio.path, /complete[\\/]complete\.wav$/);
  assert.equal(delivered[0].audio.durationMs, 300);
});

test('a new turn cancels a pending completion', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), turnEnd());
  clock.advance(1000);
  alerter.handle(session(), turnStart());
  clock.advance(60000);
  assert.equal(delivered.length, 0);
});

test('a non-clean turn end cancels a pending completion', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), turnEnd());
  clock.advance(1000);
  alerter.handle(session(), turnEnd({ kind: 'aborted', reason: 'user' }));
  clock.advance(60000);
  assert.equal(delivered.length, 0);
});

test('repeated clean turn ends extend the quiet period instead of alerting twice', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), turnEnd());
  clock.advance(1500);
  alerter.handle(session(), turnEnd());
  clock.advance(1999);
  assert.equal(delivered.length, 0);
  clock.advance(1);
  assert.equal(delivered.length, 1, 'a multi-turn stretch must produce one alert, not one per turn');
});

test('the completion de-duplication window swallows a repeat inside it', () => {
  const { alerter, clock, delivered } = harness({ dedup: { completeMs: 5000 } });
  alerter.handle(session(), turnEnd());
  clock.advance(2000);
  assert.equal(delivered.length, 1);

  alerter.handle(session(), turnEnd());
  clock.advance(2000);
  assert.equal(delivered.length, 1, 'still inside the de-duplication window');

  clock.advance(5000);
  alerter.handle(session(), turnEnd());
  clock.advance(2000);
  assert.equal(delivered.length, 2, 'the window has passed');
});

test('a failing turn alerts immediately, with the reason in the body', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), { type: 'session/title', data: { title: '修复编译错误' } });
  alerter.handle(session(), turnEnd({ kind: 'error', error: { message: 'API key invalid', code: 'AUTH' } }));

  assert.equal(delivered.length, 1, 'a failure must not wait for a quiet period that will never come');
  const alert = delivered[0];
  assert.equal(alert.scenario, 'failed');
  assert.equal(alert.title, '本轮运行失败');
  assert.equal(alert.notify, true);
  assert.match(alert.audio.path, /failed[\\/]failed\.wav$/, 'the failure cue, not the completion chime');
  assert.equal(alert.body, '修复编译错误 — API key invalid');

  clock.advance(60000);
  assert.equal(delivered.length, 1, 'and it is not repeated afterwards');
});

test('a failure cancels a pending completion, so one turn never alerts twice', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), turnEnd());
  clock.advance(1000);
  alerter.handle(session(), turnEnd({ kind: 'error', error: { message: 'boom' } }));
  clock.advance(60000);
  assert.equal(delivered.length, 1, 'only the failure may be announced');
  assert.equal(delivered[0].scenario, 'failed');
});

test('the failure de-duplication window swallows a retry loop', () => {
  const { alerter, clock, delivered } = harness({ dedup: { failedMs: 5000 } });
  const failure = { kind: 'error', error: { message: 'upstream 500', code: 'UPSTREAM' } };

  alerter.handle(session(), turnEnd(failure));
  alerter.handle(session(), turnEnd(failure));
  assert.equal(delivered.length, 1, 'a retry loop must not become a wall of sound');

  clock.advance(5000);
  alerter.handle(session(), turnEnd(failure));
  assert.equal(delivered.length, 2, 'the window has passed');
});

test('only the configured reasons count as a failure, and the set is configurable', () => {
  const { alerter, delivered } = harness();
  for (const kind of ['aborted', 'blocked', 'max-tokens', 'interrupted', 'forked']) {
    alerter.handle(session(), turnEnd({ kind }));
  }
  assert.equal(delivered.length, 0, 'stopping the run, waiting for approval, or a truncated answer are not failures');

  const widened = harness({ failed: { reasons: ['error', 'max-tokens'] } });
  widened.alerter.handle(session(), turnEnd({ kind: 'max-tokens' }));
  assert.equal(widened.delivered.length, 1, 'the list is configuration, not a hard-coded enum');
});

test('the failure alert can be switched off, and its reason left out of the body', () => {
  const off = harness({ failed: { enabled: false } });
  off.alerter.handle(session(), turnEnd({ kind: 'error', error: { message: 'boom' } }));
  assert.equal(off.delivered.length, 0);

  const noReason = harness({ failed: { includeReason: false } });
  noReason.alerter.handle(session(), { type: 'session/title', data: { title: 's1' } });
  noReason.alerter.handle(session(), turnEnd({ kind: 'error', error: { message: 'boom' } }));
  assert.equal(noReason.delivered.length, 1);
  assert.equal(noReason.delivered[0].body, 's1');
});

test('a failure with no readable reason still alerts', () => {
  const { alerter, delivered } = harness();
  alerter.handle(session(), turnEnd({ kind: 'error' }));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].title, '本轮运行失败');
  assert.equal(delivered[0].body, 'project', 'the workspace name is the body when nothing else is known');
});

test('a question alerts immediately, with the count in the title', () => {
  const { alerter, delivered } = harness();
  alerter.handle(session(), ask(1));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].scenario, 'ask-single');
  assert.equal(delivered[0].title, '需要你回复');
  assert.match(delivered[0].audio.path, /ask-single[\\/]ask-single\.wav$/);

  const second = harness();
  second.alerter.handle(session(), ask(3));
  assert.equal(second.delivered[0].scenario, 'ask-multiple');
  assert.equal(second.delivered[0].title, '有 3 个问题等你回复');
});

test('the same question call never alerts twice', () => {
  const { alerter, delivered } = harness();
  alerter.handle(session(), ask(1, 'call-7'));
  alerter.handle(session(), ask(1, 'call-7'));
  assert.equal(delivered.length, 1);

  alerter.handle(session(), ask(1, 'call-8'));
  assert.equal(delivered.length, 2, 'a different call is a different question');
});

test('a question cancels a pending completion', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), turnEnd());
  clock.advance(1000);
  alerter.handle(session(), ask(1));
  assert.equal(delivered.length, 1, 'only the question alerts');

  clock.advance(60000);
  assert.equal(delivered.length, 1);
});

test('a completed turn is suppressed while a question is still unanswered', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), ask(2, 'call-open'));
  assert.equal(delivered.length, 1);

  alerter.handle(session(), turnEnd());
  clock.advance(5000);
  assert.equal(delivered.length, 1, 'the user is still being waited on');

  // Once the tool returns, the bookkeeping is retired.
  alerter.handle(session(), { type: 'tool/result', data: { message: { toolCallId: 'call-open' } } });
  alerter.handle(session(), turnEnd());
  clock.advance(2000);
  assert.equal(delivered.length, 2);
});

test('alerts are suppressed when the master switch or a scenario switch is off', () => {
  const off = harness({ enabled: false });
  off.alerter.handle(session(), ask(1));
  off.alerter.handle(session(), turnEnd());
  off.clock.advance(10000);
  assert.equal(off.delivered.length, 0);

  const completeOff = harness({ complete: { enabled: false } });
  completeOff.alerter.handle(session(), turnEnd());
  completeOff.clock.advance(10000);
  assert.equal(completeOff.delivered.length, 0);

  const askOff = harness({ askSingle: { enabled: false }, askMultiple: { enabled: false } });
  askOff.alerter.handle(session(), ask(1));
  askOff.alerter.handle(session(), ask(2, 'call-2'));
  assert.equal(askOff.delivered.length, 0);
});

test('subagent sessions are filtered by configuration', () => {
  const filtered = harness();
  filtered.alerter.handle(session({ origin: 'subagent' }), ask(1));
  assert.equal(filtered.delivered.length, 0);

  const included = harness({ sessions: { includeSubagents: true } });
  included.alerter.handle(session({ origin: 'subagent' }), ask(1));
  assert.equal(included.delivered.length, 1);
});

test('notification and sound can be turned off independently', () => {
  const noSound = harness({ sound: { enabled: false } });
  noSound.alerter.handle(session(), ask(1));
  assert.equal(noSound.delivered[0].audio, null);
  assert.equal(noSound.delivered[0].notify, true);

  const noNotify = harness({ notify: { enabled: false } });
  noNotify.alerter.handle(session(), ask(1));
  assert.equal(noNotify.delivered[0].notify, false);
  assert.notEqual(noNotify.delivered[0].audio, null);

  const neither = harness({ notify: { enabled: false }, sound: { enabled: false } });
  neither.alerter.handle(session(), ask(1));
  assert.equal(neither.delivered.length, 0, 'nothing to do means no process is started');
});

test('alerts play the user’s own audio root in preference to the bundled sounds', () => {
  const { alerter, clock, delivered, userRoot, cache } = harness();
  // What `tools/import-audio.mjs` does: import into the user's audio root.
  const mine = join(userRoot, 'audio', 'complete');
  mkdirSync(mine, { recursive: true });
  writeWav(mine, 'Mine.wav', 0.5);
  cache.clear();

  alerter.handle(session(), turnEnd());
  clock.advance(2000);

  assert.match(delivered[0].audio.path, /Mine\.wav$/u, 'the imported file is what plays');
  assert.equal(delivered[0].audio.durationMs, 500);
  assert.match(delivered[0].audio.path, /dsh-task-ask-notify-/u, 'it came from the user root, not the package');
});

test('an audition plays one sound and never raises a notification', () => {
  const { alerter, delivered } = harness();

  assert.equal(alerter.audition('complete'), true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].notify, false, 'a listen must not add a toast to the Action Center');
  assert.notEqual(delivered[0].audio, null);
  assert.equal(delivered[0].volume, 100, 'it plays at the configured volume');
  assert.match(delivered[0].audio.path, /complete[\\/]/u);

  // One at a time, so holding the button cannot stack playback processes.
  assert.equal(alerter.audition('complete'), false);
  delivered[0].onExit(0);
  assert.equal(alerter.audition('ask-single'), true);
  assert.match(delivered[1].audio.path, /ask-single[\\/]/u);
});

test('an audition picks a scenario at random when none is named', () => {
  let draw = 0;
  const { alerter, delivered } = harness({}, { random: () => {
    draw += 1;
    return (draw % 7) / 7;
  } });

  const seen = new Set();
  for (let index = 0; index < 21; index += 1) {
    const before = delivered.length;
    if (alerter.audition() !== true) {
      // A previous sound must be retired before the next attempt.
      delivered[delivered.length - 1]?.onExit(0);
      alerter.audition();
    }
    assert.equal(delivered.length, before + 1, 'each audition starts exactly one sound');
    const alert = delivered[delivered.length - 1];
    seen.add(alert.scenario);
    alert.onExit(0);
  }
  assert.deepEqual([...seen].sort(), ['ask-multiple', 'ask-single', 'complete', 'failed'], 'the listen button draws from every scenario');
});

test('an audition still works when sound is switched off, because it is an explicit action', () => {
  const { alerter, delivered } = harness({ sound: { enabled: false } });
  assert.equal(alerter.audition('complete'), true);
  assert.equal(delivered.length, 1);
  assert.notEqual(delivered[0].audio, null);
});

test('an audition reports rather than throwing when nothing is playable', () => {
  const { alerter, delivered, log } = harness(
    { complete: { dir: 'audio/does-not-exist' }, sound: { fallback: '' } },
    { createDirs: false },
  );
  assert.equal(alerter.audition('complete'), false);
  assert.equal(delivered.length, 0);
  assert.match(log.text(), /no playable WAV to audition/);
});

test('two alerts closer than the minimum gap share one sound but both notify', () => {
  const { alerter, clock, delivered } = harness({ sound: { minGapMs: 400 } });
  alerter.handle(session(), ask(1, 'a'));
  delivered[0].onExit(0);

  clock.advance(100);
  alerter.handle(session(), ask(2, 'b'));
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].audio, null, 'the second sound is skipped');
  assert.equal(delivered[1].notify, true, 'the notification still happens');

  clock.advance(1000);
  alerter.handle(session(), ask(1, 'c'));
  assert.notEqual(delivered[2].audio, null, 'the gap has passed again');
});

test('only one playback process runs at a time', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), ask(1, 'a'));
  assert.notEqual(delivered[0].audio, null);

  // The first child has not exited yet, so its sound is still in flight.
  clock.advance(10_000);
  alerter.handle(session(), ask(1, 'b'));
  assert.equal(delivered[1].audio, null);

  delivered[0].onExit(0);
  clock.advance(10_000);
  alerter.handle(session(), ask(1, 'c'));
  assert.notEqual(delivered[2].audio, null);
});

test('the body is the session title, with workspace and fixed-label fallbacks', () => {
  const titled = harness();
  titled.alerter.handle(session(), { type: 'session/title', data: { title: '修复登录流程' } });
  titled.alerter.handle(session(), ask(1));
  assert.equal(titled.delivered[0].body, '修复登录流程');

  const unlitled = harness();
  unlitled.alerter.handle(session({ cwd: 'C:/work/my-project' }), ask(1));
  assert.equal(unlitled.delivered[0].body, 'my-project');

  const bare = harness();
  bare.alerter.handle(session({ cwd: '' }), ask(1));
  assert.equal(bare.delivered[0].body, 'DeepSeek Harness');
});

test('a title already in the session log is used without a live title event', () => {
  const { alerter, delivered } = harness();
  const withLog = {
    id: 's1',
    header: { id: 's1', cwd: 'C:/work/project' },
    snapshotEvents: () => [{ type: 'session/title', data: { title: '来自日志的标题' } }],
  };
  alerter.handle(withLog, ask(1));
  assert.equal(delivered[0].body, '来自日志的标题');
});

test('long bodies are truncated and the question can be appended on request', () => {
  const long = harness({ notify: { bodyMaxChars: 20 } });
  long.alerter.handle(session(), { type: 'session/title', data: { title: 'a'.repeat(200) } });
  long.alerter.handle(session(), ask(1));
  assert.equal(long.delivered[0].body.length, 20);
  assert.ok(long.delivered[0].body.endsWith('…'));

  const withQuestion = harness({ notify: { includeQuestionInBody: true, bodyMaxChars: 200 } });
  withQuestion.alerter.handle(session(), { type: 'session/title', data: { title: '标题' } });
  withQuestion.alerter.handle(session(), ask(1));
  assert.equal(withQuestion.delivered[0].body, '标题 — 问题 0');
});

test('a missing sound is not fatal: the notification still goes out', () => {
  const { alerter, clock, delivered, log } = harness(
    { complete: { dir: 'audio/does-not-exist' }, sound: { fallback: '' } },
    { createDirs: false },
  );
  alerter.handle(session(), turnEnd());
  clock.advance(2000);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].audio, null, 'no WAV was playable');
  assert.equal(delivered[0].notify, true);
  assert.match(log.text(), /no playable WAV/);
});

test('the adapter exit code is reported, and repeated failures raise the AUMID hint', () => {
  const { alerter, log } = harness();
  alerter.reportDeliveryExit(0);
  assert.equal(log.entries.filter((entry) => entry.level === 'warn').length, 0);

  for (let index = 0; index < 3; index += 1) alerter.reportDeliveryExit(3);
  assert.equal(log.entries.filter((entry) => entry.message.includes('exited with code 3')).length, 3);
  assert.match(log.text(), /AUMID/);

  alerter.reportDeliveryExit(0);
  for (let index = 0; index < 3; index += 1) alerter.reportDeliveryExit(4);
  assert.equal(
    log.entries.filter((entry) => entry.message.includes('AUMID')).length,
    2,
    'the hint must not repeat after a successful delivery resets the counter',
  );
});

test('a broken event or a throwing delivery never escapes handle()', () => {
  const { alerter, log } = harness();
  for (const event of [null, undefined, {}, { type: 42 }, { type: 'turn/end', data: null }, { type: 'tool/call', data: null }]) {
    assert.doesNotThrow(() => alerter.handle(session(), event));
  }
  assert.doesNotThrow(() => alerter.handle(null, turnEnd()));

  const throwing = new Alerter({
    store: { config: schemaDefaults() },
    deliver: () => {
      throw new Error('adapter refused');
    },
    log,
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
    random: () => 0,
    root: makeTempDir(),
  });
  assert.doesNotThrow(() => throwing.handle(session(), ask(1)));
  assert.match(log.text(), /could not start the alert adapter/);
});

test('dispose cancels pending work', () => {
  const { alerter, clock, delivered } = harness();
  alerter.handle(session(), turnEnd());
  alerter.dispose();
  clock.advance(60000);
  assert.equal(delivered.length, 0);
  alerter.handle(session(), ask(1));
  assert.equal(delivered.length, 0, 'a disposed alerter stays silent');
});

test('message helpers behave at their edges', () => {
  assert.equal(truncate('  a \n b  ', 100), 'a b');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abcdef', 0), 'abcdef');
  assert.equal(truncate(undefined, 4), '');
  assert.equal(applyCount('有 {count} 个问题', 3), '有 3 个问题');
  assert.equal(applyCount('没有占位符', 3), '没有占位符');
});
