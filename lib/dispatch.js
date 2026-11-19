/**
 * dsh-task-ask-notify - alert scheduling.
 *
 * Turns classified session events into at-most-one alert per real event, and
 * decides *when* an alert is warranted:
 *
 *   - a "task finished" alert is **debounced**, not edge-triggered. DSH's official
 *     guidance is explicit that `agent/status` must not be used as a completion
 *     signal ("`whenIdle()` does not mean one follow-up finished"), so this plugin
 *     waits for quiet instead: a clean `turn/end` starts a timer that any new
 *     turn, any non-clean turn end, or any new question cancels.
 *   - a question alert fires immediately, because the model is blocked waiting.
 *   - a failure alert fires immediately as well: `turn/end` with a reason in
 *     `failed.reasons` is DSH's own "本轮运行失败", the run is over, and there is
 *     no silence left to wait for.
 *
 * The module owns no OS knowledge: it hands a fully-decided alert to the injected
 * `deliver` callback, which is what makes the whole scheduling policy testable
 * with a fake clock.
 *
 * @module dsh-task-ask-notify/dispatch
 */

import { WavDirectoryCache, chooseAudio, pickUniform, resolveAudioPath } from './policy.js';
import { SCENARIOS, classify, fallbackLabelFromSession, titleFromSession } from './signals.js';

/** How many consecutive adapter failures trigger the AUMID hint. */
const FAILURE_HINT_THRESHOLD = 3;

/**
 * Scenarios an audition may draw from, so the listen button plays a real sound
 * from a real directory rather than a fixed sample.
 */
const AUDITION_SCENARIOS = [SCENARIOS.complete, SCENARIOS.askSingle, SCENARIOS.askMultiple, SCENARIOS.failed];

/**
 * @param value candidate
 * @param maxChars longest permitted body
 * @returns the body shortened to `maxChars`, with an ellipsis when it was cut
 */
export function truncate(value, maxChars) {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0 || collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * @param template message template
 * @param count number of questions
 * @returns the template with `{count}` replaced
 */
export function applyCount(template, count) {
  return typeof template === 'string' ? template.replace(/\{count\}/gu, String(count)) : String(count);
}

/**
 * Schedules and delivers alerts.
 */
export class Alerter {
  #states = new Map();
  #soundBusy = false;
  #lastSoundAt = null;
  #consecutiveFailures = 0;
  #hintShown = false;
  #disposed = false;

  /**
   * @param options alerter options
   * @param options.store configuration store
   * @param options.deliver callback receiving a fully-decided alert
   * @param options.log minimal logger
   * @param options.now clock, for tests
   * @param options.setTimer timer scheduler, for tests
   * @param options.clearTimer timer canceller, for tests
   * @param options.random random source, for tests
   * @param options.cache directory cache
   * @param options.root package root, for resolving relative sound paths
   * @param options.userRoot user audio root that takes precedence for relative paths
   */
  constructor({
    store,
    deliver,
    log,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    random = Math.random,
    cache = new WavDirectoryCache(),
    root,
    userRoot = '',
  }) {
    this.store = store;
    this.deliver = deliver;
    this.log = log;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.random = random;
    this.cache = cache;
    this.root = root;
    this.userRoot = userRoot;
  }

  /**
   * @param target configured sound path
   * @returns the absolute path to use, preferring the user's own audio root
   */
  #resolveSound(target) {
    return resolveAudioPath(target, { root: this.root, userRoot: this.userRoot, cache: this.cache });
  }

  /** @returns the current configuration */
  get #config() {
    return this.store.config;
  }

  /**
   * Observe one session event. Never throws: an alert is a convenience, and a
   * failure here must not be able to disturb a DSH write.
   * @param session the emitting session
   * @param event the session event
   */
  handle(session, event) {
    if (this.#disposed) return;
    try {
      const config = this.#config;
      if (config.enabled !== true) return;

      const signal = classify(session, event, { includeSubagents: config.sessions.includeSubagents });
      if (signal === null) return;

      switch (signal.kind) {
        case 'title':
          this.#state(session).title = signal.title;
          break;

        case 'turn-start':
          this.#cancel(session);
          this.#state(session).openAskCallIds.clear();
          break;

        case 'turn-end':
          if (signal.completed) {
            this.#scheduleCompletion(session);
          } else {
            // Any non-clean end kills the pending quiet-period alert — but a
            // *failure* is its own event and must be announced, not swallowed.
            this.#cancel(session);
            this.#onTurnFailure(session, signal);
          }
          break;

        case 'ask':
          this.#onAsk(session, signal);
          break;

        case 'tool-result':
          if (signal.callId !== null) this.#state(session).openAskCallIds.delete(signal.callId);
          break;

        default:
          break;
      }
    } catch (error) {
      this.log?.warn?.(`dsh-task-ask-notify: ignoring a session event after an internal error: ${error?.message ?? error}`);
    }
  }

  /**
   * Record the exit of one delivery child process.
   * @param exitCode adapter exit code, or -1 when the spawn itself failed
   * @param detail error or signal detail
   */
  reportDeliveryExit(exitCode, detail) {
    if (exitCode === 0) {
      this.#consecutiveFailures = 0;
      this.#hintShown = false;
      return;
    }
    this.#consecutiveFailures += 1;
    const suffix = detail === undefined || detail === null ? '' : ` (${detail})`;
    this.log?.warn?.(`dsh-task-ask-notify: notification adapter exited with code ${exitCode}${suffix}`);
    if (this.#consecutiveFailures >= FAILURE_HINT_THRESHOLD && !this.#hintShown) {
      this.#hintShown = true;
      this.log?.warn?.(
        'dsh-task-ask-notify: the last few notifications failed. A Windows toast is only shown when the AUMID is ' +
          'registered by a Start Menu shortcut; check "notify.aumid" and see the README section "Troubleshooting".',
      );
    }
  }

  /**
   * Play one sound on demand, for the configuration page's listen button.
   *
   * This is the same path a real alert takes — same directories, same uniform
   * choice, same adapter, same volume — with the notification suppressed, so what
   * the user hears is what they will hear. It deliberately ignores
   * `sound.enabled`: someone calibrating the volume may well be doing it before
   * turning sound on. It does respect the one-sound-at-a-time rule, so holding the
   * button cannot stack playback processes.
   *
   * @param scenario scenario to take the sound from, or null to pick one at random
   * @returns true when a sound was started, false when it could not be
   */
  audition(scenario = null) {
    if (this.#disposed) return false;
    const config = this.#config;

    if (this.#soundBusy) {
      this.log?.debug?.('dsh-task-ask-notify: listen skipped: a sound is already playing');
      return false;
    }

    const scenarioName = scenario ?? pickUniform(AUDITION_SCENARIOS, this.random) ?? SCENARIOS.complete;
    const name = AUDITION_SCENARIOS.includes(scenarioName) ? scenarioName : SCENARIOS.complete;
    const source =
      name === SCENARIOS.askSingle
        ? config.askSingle
        : name === SCENARIOS.askMultiple
          ? config.askMultiple
          : name === SCENARIOS.failed
            ? config.failed
            : config.complete;

    const audio = chooseAudio({
      dir: this.#resolveSound(source.dir),
      fallback: this.#resolveSound(config.sound.fallback),
      cache: this.cache,
      random: this.random,
    });
    if (audio === null) {
      this.log?.warn?.('dsh-task-ask-notify: no playable WAV to audition; check the sound directories');
      return false;
    }

    this.#soundBusy = true;
    this.#lastSoundAt = this.now();
    try {
      this.deliver({
        scenario: name,
        title: '',
        body: '',
        notify: false,
        audio,
        volume: config.sound.volume,
        aumid: config.notify.aumid,
        silentSystemSound: true,
        maxDurationMs: config.sound.maxDurationMs,
        onExit: (code, detail) => {
          this.#soundBusy = false;
          this.reportDeliveryExit(code, detail);
        },
      });
    } catch (error) {
      this.#soundBusy = false;
      this.log?.warn?.(`dsh-task-ask-notify: could not audition a sound: ${error?.message ?? error}`);
      return false;
    }
    this.log?.debug?.(`dsh-task-ask-notify: auditioning "${name}"`);
    return true;
  }

  /** Cancel every pending timer. */
  dispose() {
    this.#disposed = true;
    for (const state of this.#states.values()) {
      if (state.timer !== null) {
        this.clearTimer(state.timer);
        state.timer = null;
      }
    }
    this.#states.clear();
  }

  /**
   * @param session a session
   * @returns its mutable scheduling state, created on first use
   */
  #state(session) {
    const id = session?.id ?? session?.header?.id ?? 'unknown';
    let state = this.#states.get(id);
    if (state === undefined) {
      state = {
        timer: null,
        lastCompletionAt: null,
        lastFailureAt: null,
        title: null,
        titleSearched: false,
        openAskCallIds: new Set(),
      };
      this.#states.set(id, state);
    }
    return state;
  }

  /** @param session a session */
  #cancel(session) {
    const state = this.#state(session);
    if (state.timer !== null) {
      this.clearTimer(state.timer);
      state.timer = null;
    }
  }

  /**
   * (Re)start the quiet-period timer that precedes a completion alert.
   * @param session the session that finished a turn
   */
  #scheduleCompletion(session) {
    const state = this.#state(session);
    if (state.timer !== null) this.clearTimer(state.timer);
    const delay = this.#config.complete.debounceMs;
    state.timer = this.setTimer(() => {
      state.timer = null;
      this.#onQuiet(session);
    }, delay);
    state.timer?.unref?.();
  }

  /**
   * Quiet period elapsed: the session stopped doing anything, so the work is done.
   * @param session the session
   */
  #onQuiet(session) {
    const config = this.#config;
    const state = this.#state(session);

    if (config.complete.enabled !== true) return;
    const dedup = config.dedup.completeMs;
    const at = this.now();
    if (state.lastCompletionAt !== null && at - state.lastCompletionAt < dedup) return;
    state.lastCompletionAt = at;

    // A question that has not been answered yet is what the user is waiting on;
    // the turn end that follows it must not produce a second alert.
    if (state.openAskCallIds.size > 0) return;

    this.#fire(session, SCENARIOS.complete, {
      title: config.messages.completeTitle,
      question: null,
      count: 0,
    });
  }

  /**
   * A turn closed with a failure reason — DSH's own red "本轮运行失败".
   *
   * Unlike a completion there is **no quiet period**: the run is over, nothing
   * more is going to happen without the user, and waiting for silence would only
   * delay the one alert they most need. The pending completion timer has already
   * been cancelled by the caller, so this can never produce two alerts for one
   * turn.
   *
   * `dedup.failedMs` is what keeps an automatic retry loop from becoming a wall
   * of sound: a repeat inside the window is dropped, the notification and the
   * sound together.
   *
   * @param session the session that failed
   * @param signal the classified non-clean turn end
   */
  #onTurnFailure(session, signal) {
    const config = this.#config;
    if (config.failed.enabled !== true) return;

    const reasons = config.failed.reasons;
    if (!Array.isArray(reasons) || !reasons.includes(signal.reasonKind)) return;

    const state = this.#state(session);
    const dedup = config.dedup.failedMs;
    const at = this.now();
    if (state.lastFailureAt !== null && at - state.lastFailureAt < dedup) return;
    state.lastFailureAt = at;

    this.#fire(session, SCENARIOS.failed, {
      title: config.messages.failedTitle,
      question: null,
      detail: config.failed.includeReason === true ? signal.failureMessage : null,
      count: 0,
    });
  }

  /**
   * @param session the session
   * @param signal the classified ask signal
   */
  #onAsk(session, signal) {
    const state = this.#state(session);
    const callId = signal.callId;
    if (callId !== null) {
      // The same call must never alert twice, even if the event is replayed.
      if (state.openAskCallIds.has(callId)) return;
      state.openAskCallIds.add(callId);
    }

    // A question supersedes a pending completion: the session has not stopped, it
    // is waiting for the user.
    this.#cancel(session);

    const config = this.#config;
    const isMultiple = signal.scenario === SCENARIOS.askMultiple;
    const scenarioConfig = isMultiple ? config.askMultiple : config.askSingle;
    if (scenarioConfig.enabled !== true) return;

    this.#fire(session, signal.scenario, {
      title: isMultiple
        ? applyCount(config.messages.askMultipleTitleTemplate, signal.effectiveCount)
        : config.messages.askSingleTitle,
      question: signal.firstQuestion,
      count: signal.effectiveCount,
    });
  }

  /**
   * Assemble one alert and hand it to the delivery callback.
   * @param session the session
   * @param scenario the scenario being alerted
   * @param message title and question context
   */
  #fire(session, scenario, message) {
    const config = this.#config;
    const notifyEnabled = config.notify.enabled === true;
    const soundEnabled = config.sound.enabled === true;

    const scenarioConfig =
      scenario === SCENARIOS.complete
        ? config.complete
        : scenario === SCENARIOS.failed
          ? config.failed
          : scenario === SCENARIOS.askMultiple
            ? config.askMultiple
            : config.askSingle;

    if (scenarioConfig.enabled !== true) return;

    let soundSkippedReason = null;
    if (!soundEnabled) soundSkippedReason = 'sound disabled';
    else if (this.#soundBusy) soundSkippedReason = 'another sound is still playing';
    else if (this.#lastSoundAt !== null && this.now() - this.#lastSoundAt < config.sound.minGapMs) {
      soundSkippedReason = `within the ${config.sound.minGapMs} ms minimum gap`;
    }

    const audio = soundSkippedReason === null
      ? chooseAudio({
          dir: this.#resolveSound(scenarioConfig.dir),
          fallback: this.#resolveSound(config.sound.fallback),
          cache: this.cache,
          random: this.random,
        })
      : null;

    if (soundSkippedReason === null && audio === null) {
      this.log?.debug?.(`dsh-task-ask-notify: no playable WAV for scenario "${scenario}"; notifying without sound`);
    }
    if (soundSkippedReason !== null) {
      this.log?.debug?.(`dsh-task-ask-notify: sound skipped for "${scenario}": ${soundSkippedReason}`);
    }

    const body = this.#composeBody(session, config, message);

    if (!notifyEnabled && audio === null) return;

    if (audio !== null) {
      this.#soundBusy = true;
      this.#lastSoundAt = this.now();
    }

    try {
      this.deliver({
        scenario,
        title: typeof message.title === 'string' && message.title !== '' ? message.title : scenario,
        body,
        notify: notifyEnabled,
        audio,
        volume: config.sound.volume,
        aumid: config.notify.aumid,
        silentSystemSound: config.notify.silentSystemSound,
        maxDurationMs: config.sound.maxDurationMs,
        onExit: (code, detail) => {
          if (audio !== null) this.#soundBusy = false;
          this.reportDeliveryExit(code, detail);
        },
      });
    } catch (error) {
      if (audio !== null) this.#soundBusy = false;
      this.log?.warn?.(`dsh-task-ask-notify: could not start the alert adapter: ${error?.message ?? error}`);
    }
  }

  /**
   * Build the notification body: the session title, which is what the user asked
   * for; the workspace directory name and a fixed label are the fallbacks.
   *
   * A detail is appended only when it was asked for: a failure carries its own
   * `failed.includeReason` switch (a failure without its reason is barely worth
   * a notification), a question is gated by `notify.includeQuestionInBody`.
   *
   * @param session the session
   * @param config effective configuration
   * @param message alert context
   * @returns the body text
   */
  #composeBody(session, config, message) {
    const state = this.#state(session);
    let label = state.title;
    if (label === null && !state.titleSearched) {
      state.titleSearched = true;
      label = titleFromSession(session);
      state.title = label;
    }
    if (label === null) label = fallbackLabelFromSession(session);
    if (label === null) label = config.messages.fallbackBody;

    const detail =
      typeof message.detail === 'string' && message.detail !== ''
        ? message.detail
        : config.notify.includeQuestionInBody === true && typeof message.question === 'string' && message.question !== ''
          ? message.question
          : '';

    let body = label;
    if (detail !== '') body = `${label} — ${detail}`;
    return truncate(body, config.notify.bodyMaxChars);
  }
}
