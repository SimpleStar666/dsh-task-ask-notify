/**
 * Signal classification: the exact rules that decide whether a session event
 * deserves a reminder, and which one.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASK_TOOL_NAME,
  SCENARIOS,
  classify,
  fallbackLabelFromSession,
  isRootSession,
  readFailureMessage,
  readQuestions,
  titleFromSession,
} from '../lib/signals.js';

/** @param overrides partial session header */
function rootSession(overrides = {}) {
  return { id: 'session-1', header: { id: 'session-1', cwd: 'C:/work/project', ...overrides } };
}

/** @param overrides partial session header */
function subagentSession(overrides = {}) {
  return { id: 'session-2', header: { id: 'session-2', origin: 'subagent', ...overrides } };
}

/** @param data ask arguments */
function askEvent(data) {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: ASK_TOOL_NAME, ...data } };
}

test('a clean turn end is the only turn end that alerts', () => {
  assert.deepEqual(classify(rootSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), {
    kind: 'turn-end',
    completed: true,
    reasonKind: 'completed',
  });
});

test('a null reason is tolerated and never alerts', () => {
  // The agent loop initialises `turnEnds` to null, so `reason` really can be null.
  const signal = classify(rootSession(), { type: 'turn/end', data: { turn: 1, reason: null } });
  assert.equal(signal.completed, false);
  assert.equal(signal.reasonKind, null);
});

test('every non-completed turn end reason is treated as "not finished"', () => {
  for (const kind of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']) {
    const signal = classify(rootSession(), { type: 'turn/end', data: { turn: 1, reason: { kind } } });
    assert.equal(signal.completed, false, `${kind} must not alert`);
    assert.equal(signal.reasonKind, kind);
  }
});

test('a failing turn carries its reason out, and anything else carries none', () => {
  assert.equal(SCENARIOS.failed, 'failed');

  const failed = classify(rootSession(), {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: 'API key invalid', code: 'AUTH' } } },
  });
  assert.equal(failed.failureMessage, 'API key invalid');

  // A blank message falls back to the code: both are worth showing in a toast.
  assert.equal(
    classify(rootSession(), {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { message: '   ', code: 'ECONNRESET' } } },
    }).failureMessage,
    'ECONNRESET',
  );

  // Nothing usable must stay null, or the body would end in a dangling em-dash.
  assert.equal(classify(rootSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }).failureMessage, null);
  assert.equal(classify(rootSession(), { type: 'turn/end', data: { turn: 1, reason: null } }).failureMessage, null);
  assert.equal(readFailureMessage(null), null);
  assert.equal(readFailureMessage(undefined), null);
  assert.equal(readFailureMessage('not an object'), null);
  assert.equal(readFailureMessage({ message: 42, code: 7 }), null);
});

test('subagent sessions are ignored unless explicitly included', () => {
  const event = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } };
  assert.equal(classify(subagentSession(), event), null);
  assert.deepEqual(classify(subagentSession(), event, { includeSubagents: true }), {
    kind: 'turn-end',
    completed: true,
    reasonKind: 'completed',
  });
  assert.equal(isRootSession(subagentSession()), false);
  assert.equal(isRootSession(rootSession()), true);
});

test('a turn start is reported so a pending completion can be cancelled', () => {
  assert.deepEqual(classify(rootSession(), { type: 'turn/start', data: { turn: 2 } }), { kind: 'turn-start' });
});

test('one question maps to ask-single', () => {
  const signal = classify(rootSession(), askEvent({ arguments: JSON.stringify({ questions: [{ id: 'q1', question: '继续吗？' }] }) }));
  assert.equal(signal.kind, 'ask');
  assert.equal(signal.scenario, SCENARIOS.askSingle);
  assert.equal(signal.count, 1);
  assert.equal(signal.effectiveCount, 1);
  assert.equal(signal.callId, 'call-1');
  assert.equal(signal.firstQuestion, '继续吗？');
});

test('two or more questions map to ask-multiple and carry the count', () => {
  const questions = [1, 2, 3].map((n) => ({ id: `q${n}`, question: `问题 ${n}` }));
  const signal = classify(rootSession(), askEvent({ arguments: JSON.stringify({ questions }) }));
  assert.equal(signal.scenario, SCENARIOS.askMultiple);
  assert.equal(signal.count, 3);
  assert.equal(signal.effectiveCount, 3);
});

test('unreadable ask arguments still alert, as a single question', () => {
  // Staying silent would be worse than an approximate alert: the model is blocked.
  for (const bad of ['{not json', '', undefined, null, '{"questions":[]}', '{"questions":"nope"}', '{"questions":[{"noid":1}]}']) {
    const signal = classify(rootSession(), askEvent({ arguments: bad }));
    assert.equal(signal.kind, 'ask', `arguments ${JSON.stringify(bad)} must still alert`);
    assert.equal(signal.count, 0);
    assert.equal(signal.effectiveCount, 1);
    assert.equal(signal.scenario, SCENARIOS.askSingle);
  }
});

test('extra fields in a question do not break parsing', () => {
  const signal = classify(
    rootSession(),
    askEvent({ arguments: JSON.stringify({ questions: [{ id: 'q', question: 'q?', header: 'h', options: [], multi_select: true, extra: 1 }], other: 2 }) }),
  );
  assert.equal(signal.count, 1);
});

test('only the ask tool triggers the ask path', () => {
  assert.equal(classify(rootSession(), askEvent({ name: 'bash', arguments: '{}' })), null);
});

test('a tool result retires its question', () => {
  const event = { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-9' } } };
  assert.deepEqual(classify(rootSession(), event), { kind: 'tool-result', callId: 'call-9' });
  assert.equal(classify(rootSession(), { type: 'tool/result', data: { message: {} } }), null);
});

test('title events are reported, blank titles are not', () => {
  assert.deepEqual(classify(rootSession(), { type: 'session/title', data: { title: ' 修复登录 ' } }), {
    kind: 'title',
    title: '修复登录',
  });
  assert.equal(classify(rootSession(), { type: 'session/title', data: { title: '   ' } }), null);
});

test('unrelated events are ignored', () => {
  for (const type of ['step/start', 'assistant/message', 'user/message', 'tool/call']) {
    assert.equal(classify(rootSession(), { type, data: {} }), null, type);
  }
  assert.equal(classify(rootSession(), null), null);
  assert.equal(classify(rootSession(), { type: 42 }), null);
});

test('readQuestions accepts only a non-empty array of question objects', () => {
  assert.equal(readQuestions('{"questions":[{"question":"a"}]}').length, 1);
  assert.equal(readQuestions('{"questions":[]}'), null);
  assert.equal(readQuestions('{"questions":[{"question":5}]}'), null);
  assert.equal(readQuestions('nope'), null);
  assert.equal(readQuestions(undefined), null);
});

test('a session title can be recovered from an older log', () => {
  const session = {
    header: {},
    snapshotEvents: () => [
      { type: 'user/message', data: {} },
      { type: 'session/title', data: { title: '第一版' } },
      { type: 'session/title', data: { title: '第二版' } },
    ],
  };
  assert.equal(titleFromSession(session), '第二版');
  assert.equal(titleFromSession({ snapshotEvents: () => { throw new Error('boom'); } }), null);
  assert.equal(titleFromSession({}), null);
});

test('a workspace directory name is the last-resort label', () => {
  assert.equal(fallbackLabelFromSession(rootSession({ cwd: 'C:\\work\\my project' })), 'my project');
  assert.equal(fallbackLabelFromSession(rootSession({ cwd: '/srv/me/repo/' })), 'repo');
  assert.equal(fallbackLabelFromSession(rootSession({ cwd: '' })), null);
  assert.equal(fallbackLabelFromSession({ header: {} }), null);
});
