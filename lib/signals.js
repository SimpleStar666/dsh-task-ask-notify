/**
 * dsh-task-ask-notify - event signal extraction.
 *
 * Pure, dependency-free translation of DSH session events into the four alert
 * scenarios. Nothing here touches the filesystem, timers, or the OS, which is
 * what makes every rule in this file directly testable.
 *
 * Why no `@deepseek-ai/*` import
 * ------------------------------
 * The Host resolves plugin imports through the profile's `node_modules`, and on
 * some installations that directory holds symlinks into a *different, older* DSH
 * generation than the one actually running. Importing runtime packages from here
 * can therefore silently produce a second module instance whose constants and
 * event names disagree with the running Host. Event names, reason kinds, and tool
 * names below are string literals on purpose.
 *
 * @module dsh-task-ask-notify/signals
 */

/** Name of the tool whose call means the model is asking the user something. */
export const ASK_TOOL_NAME = 'ask_user_question';

/** Session event carrying a (possibly updated) session title. */
export const SESSION_TITLE_EVENT = 'session/title';

/** Session header value marking a session created by a subagent. */
export const SUBAGENT_ORIGIN = 'subagent';

/** The four alert scenarios, and the directory each one maps to by default. */
export const SCENARIOS = Object.freeze({
  complete: 'complete',
  askSingle: 'ask-single',
  askMultiple: 'ask-multiple',
  failed: 'failed',
});

/** @typedef {'complete' | 'ask-single' | 'ask-multiple' | 'failed'} Scenario */

/**
 * Turn-end reason kinds that count as "the turn failed", by default.
 *
 * `error` is the only one that matches DSH's own failure wording: the chat view
 * renders `message.turnError` ("本轮运行失败") exactly when a turn closes with
 * `reason.kind === 'error'`. The rest are deliberately not failures —
 * `aborted`/`interrupted` are the user stopping it, `blocked` is the run waiting
 * on an approval, `max-tokens` is a truncated-but-delivered answer. The list is
 * configurable (`failed.reasons`) so a user who disagrees can opt in.
 */
export const DEFAULT_FAILURE_REASONS = Object.freeze(['error']);

/**
 * Decide whether a session should be able to raise an alert at all.
 * Subagent sessions are excluded by default so a fan-out of background helpers
 * does not produce a wall of notifications.
 * @param session the emitting session
 * @param includeSubagents whether subagent sessions may alert
 * @returns true when this session may raise an alert
 */
export function isRootSession(session, includeSubagents = false) {
  if (includeSubagents) return true;
  return session?.header?.origin !== SUBAGENT_ORIGIN;
}

/**
 * Read the question batch out of logged `ask_user_question` arguments.
 *
 * Mirrors how the official `@deepseek-ai/dsh-user-questions` projection reads the
 * same event: `event.data.arguments` is a **JSON string**, not an object. This is
 * a hand-written, schema-free equivalent of its `questionsOf()`, accepting any
 * entry that carries a non-empty `questions` array of objects with a string
 * `question`, so a future extra field cannot make the plugin go silent.
 *
 * @param argumentsText raw `tool/call` arguments, a JSON string
 * @returns the question list, or null when the text is unreadable
 */
export function readQuestions(argumentsText) {
  if (typeof argumentsText !== 'string' || argumentsText === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return null;
  }
  const questions = parsed?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  if (!questions.every((item) => item !== null && typeof item === 'object' && typeof item.question === 'string')) {
    return null;
  }
  return questions;
}

/**
 * Read the human-readable reason out of a turn-end failure payload.
 *
 * DSH closes a failing turn with `reason.error: LlmFailure { message, code,
 * status?, … }`. The message is what a person wants in a toast ("API key
 * invalid"); the code is the fallback when the message is blank.
 *
 * @param error the `reason.error` payload, if any
 * @returns a short reason, or null when the payload carries neither
 */
export function readFailureMessage(error) {
  if (error === null || typeof error !== 'object') return null;
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  if (message !== '') return message;
  const code = typeof error.code === 'string' ? error.code.trim() : '';
  return code === '' ? null : code;
}

/**
 * Classify one session event.
 *
 * Returned shapes:
 *   `{ kind: 'turn-start' }`                 a new turn began; cancels a pending completion
 *   `{ kind: 'turn-end', completed: true }`   the turn handed control back cleanly
 *   `{ kind: 'turn-end', completed: false, reasonKind, failureMessage }`  aborted/error/max-tokens/blocked/…
 *   `{ kind: 'ask', scenario, count, callId, firstQuestion }`
 *   `{ kind: 'title', title }`                session title changed
 *   `null`                                    not interesting
 *
 * @param session the emitting session
 * @param event the session event
 * @param options includeSubagents toggles the subagent filter
 * @returns the classification, or null
 */
export function classify(session, event, { includeSubagents = false } = {}) {
  if (!isRootSession(session, includeSubagents)) return null;
  const type = event?.type;
  if (typeof type !== 'string') return null;

  switch (type) {
    case 'turn/start':
      return { kind: 'turn-start' };

    case 'turn/end': {
      // `reason` starts out null on the agent-loop side, so this must be optional-chained.
      const reasonKind = event.data?.reason?.kind;
      if (reasonKind === 'completed') return { kind: 'turn-end', completed: true, reasonKind };
      return {
        kind: 'turn-end',
        completed: false,
        reasonKind: typeof reasonKind === 'string' ? reasonKind : null,
        // `error` closes with an `LlmFailure { message, code, … }`; carrying the
        // message out is what lets the notification say *why* it failed.
        failureMessage: readFailureMessage(event.data?.reason?.error),
      };
    }

    case 'tool/call': {
      if (event.data?.name !== ASK_TOOL_NAME) return null;
      const questions = readQuestions(event.data?.arguments);
      // Unreadable arguments still mean "the model is asking"; treat the batch as
      // one question rather than staying silent.
      const count = questions === null ? 0 : questions.length;
      return {
        kind: 'ask',
        scenario: count >= 2 ? SCENARIOS.askMultiple : SCENARIOS.askSingle,
        count,
        effectiveCount: count === 0 ? 1 : count,
        callId: typeof event.data?.callId === 'string' ? event.data.callId : null,
        firstQuestion: questions?.[0]?.question ?? null,
      };
    }

    case 'tool/result': {
      // Used to retire a question from the "still waiting on the user" set.
      const callId = event.data?.message?.toolCallId;
      if (typeof callId !== 'string') return null;
      return { kind: 'tool-result', callId };
    }

    case SESSION_TITLE_EVENT: {
      const title = event.data?.title;
      if (typeof title !== 'string' || title.trim() === '') return null;
      return { kind: 'title', title: title.trim() };
    }

    default:
      return null;
  }
}

/**
 * Recover a session title from the session's own event log.
 *
 * `session/event` observers only see events appended while the plugin is loaded,
 * so a session that already had a title before the plugin started — or a session
 * restored from disk, whose seed events never publish — would otherwise look
 * untitled. Called at most once per session by the dispatcher.
 *
 * @param session the session to inspect
 * @returns the most recent title, or null
 */
export function titleFromSession(session) {
  try {
    const events = session?.snapshotEvents?.();
    if (!Array.isArray(events)) return null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === SESSION_TITLE_EVENT) {
        const title = event.data?.title;
        if (typeof title === 'string' && title.trim() !== '') return title.trim();
      }
    }
    return null;
  } catch {
    // A title is a nicety; never let recovery break the alert path.
    return null;
  }
}

/**
 * Derive a human-readable label from a session when no title exists.
 * @param session the session to describe
 * @returns the workspace directory name, or null
 */
export function fallbackLabelFromSession(session) {
  const cwd = session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd === '') return null;
  const parts = cwd.split(/[\\/]+/).filter((part) => part !== '');
  return parts.length === 0 ? null : parts[parts.length - 1];
}
