/**
 * dsh-task-ask-notify - Host plugin entry.
 *
 * A Host-side DSH plugin that raises two kinds of reminder — a Windows system
 * notification and a sound — when a turn finishes cleanly, or when the model
 * calls `ask_user_question`. It is deliberately dependency-light: the only
 * runtime import is the configuration schema library the Loader itself needs in
 * order to validate and project this plugin's `Config`.
 *
 * Layout:
 *   signals.js  event -> scenario classification (pure)
 *   dispatch.js debounce, de-duplication, sound arbitration
 *   policy.js   directory convention, uniform choice, WAV duration
 *   config.js   schema, layered configuration, hot reload
 *   os/win.js   the one place that knows about Windows
 *
 * @module dsh-task-ask-notify
 */

import { Config, PLUGIN_ID, createConfigStore, pluginDataDir, pluginRoot } from './config.js';
import { Alerter } from './dispatch.js';
import { alertScriptPath, buildPayload, defaultPowershellPath, isAumidRegistered, spawnAlert } from './os/win.js';

/** Cordis plugin name, used by the Loader for diagnostics. */
export const name = PLUGIN_ID;

/** This plugin consumes no Host service; it only observes session events. */
export const inject = [];

export { Config };

/**
 * Minimal logger used when the Host has no logger service available.
 * @returns a console-backed logger
 */
function consoleLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

/**
 * Resolve a logger from the Host context without assuming its exact shape.
 * @param ctx the plugin context
 * @returns a logger with `debug`/`info`/`warn`/`error`
 */
function resolveLogger(ctx) {
  try {
    const service = ctx?.logger;
    if (service === undefined || service === null) return consoleLogger();
    if (typeof service === 'function') {
      const named = service(PLUGIN_ID);
      if (named !== undefined && named !== null && typeof named.warn === 'function') return named;
    }
    if (typeof service.warn === 'function') return service;
  } catch {
    /* fall through to the console logger */
  }
  return consoleLogger();
}

/**
 * Build the delivery callback that hands one decided alert to the OS adapter.
 * @param options delivery options
 * @param options.log logger
 * @param options.powershellPath interpreter path
 * @param options.scriptPath adapter script path
 * @param options.spawnImpl injectable spawn, for tests
 * @returns a callback accepting a decided alert
 */
export function createDeliver({ log, powershellPath = defaultPowershellPath(), scriptPath = alertScriptPath(), spawnImpl }) {
  return (alert) => {
    if (alert.notify !== true && alert.audio === null) return;

    const payload = buildPayload({
      title: alert.title,
      body: alert.body,
      aumid: alert.aumid,
      notify: alert.notify === true,
      audio: alert.audio !== null,
      silent: alert.silentSystemSound === true,
      audioPath: alert.audio?.path ?? '',
      // Configuration is a 0–100 percentage; the adapter's player takes a 0–1
      // fraction. This is the one place the two units meet.
      volume: Number.isFinite(alert.volume) ? Math.min(Math.max(alert.volume, 0), 100) / 100 : 1,
      durationMs: alert.audio?.durationMs ?? null,
      maxDurationMs: alert.maxDurationMs,
    });

    try {
      spawnAlert({
        payload,
        powershellPath,
        scriptPath,
        spawnImpl,
        onExit: (code, detail) => alert.onExit?.(code, detail),
      });
    } catch (error) {
      // A missing interpreter or a spawn refusal must surface in the log and free
      // the sound slot, not break the session.
      log?.warn?.(`${PLUGIN_ID}: could not start ${powershellPath}: ${error?.message ?? error}`);
      alert.onExit?.(-1, error?.message ?? String(error));
    }
  };
}

/**
 * Warn once when the configured AUMID cannot be found on a Start Menu shortcut.
 *
 * Windows shows a toast only for an AUMID that a shortcut registers, and when it
 * does not, `Show()` still reports success. Checking up front is what turns a
 * silent failure into an actionable log line. The notification-settings registry
 * key is deliberately *not* used as the signal: Windows creates it only after the
 * first successful delivery, so its absence means nothing.
 *
 * @param config effective configuration
 * @param log logger
 */
function checkAumid(config, log) {
  if (config.notify.enabled !== true) return;
  const registered = isAumidRegistered(config.notify.aumid);
  if (registered === false) {
    log?.warn?.(
      `${PLUGIN_ID}: no Start Menu shortcut registers the AUMID "${config.notify.aumid}", so Windows may silently ` +
        'drop the notifications. See the README section "Troubleshooting".',
    );
  }
}

/**
 * Wire the plugin into the Host.
 *
 * Everything is registered inside one effect so a single disposal removes the
 * event subscription, stops the configuration watcher, and cancels pending
 * timers.
 *
 * @param ctx the plugin context
 * @param config the resolved plugin configuration
 */
export function apply(ctx, config) {
  const log = resolveLogger(ctx);
  const root = pluginRoot();

  let store;
  try {
    store = createConfigStore({ rowConfig: config, log });
  } catch (error) {
    // Without configuration there is nothing sensible to do; report and stay inert
    // rather than taking the Host down.
    log?.error?.(`${PLUGIN_ID}: cannot resolve its configuration: ${error?.message ?? error}`);
    return;
  }

  const deliver = createDeliver({ log });
  const alerter = new Alerter({ store, deliver, log, root, userRoot: pluginDataDir() });

  ctx.effect(
    () => {
      // `global: true` is required: without it the scope filter would hide every
      // session other than the one this context belongs to.
      const off = ctx.on('session/event', (session, event) => alerter.handle(session, event), { global: true });

      // A settings-page edit arrives as a committed write into this row's volatile
      // references. Re-reading them is what applies it, live and without a reload.
      // A change to the audition trigger additionally plays one sound, which is how
      // the page's listen button reaches the user's speakers.
      const offVolatile = ctx.on('loader/volatile-update', () => {
        try {
          const before = store.config.sound.auditionAt;
          const next = store.refreshRow();
          if (next.sound.auditionAt !== before) alerter.audition();
        } catch (error) {
          log?.warn?.(`${PLUGIN_ID}: could not apply a configuration change: ${error?.message ?? error}`);
        }
      });

      store.start();
      try {
        checkAumid(store.config, log);
      } catch (error) {
        log?.debug?.(`${PLUGIN_ID}: AUMID self-check failed to run: ${error?.message ?? error}`);
      }

      return () => {
        off?.();
        offVolatile?.();
        store.dispose();
        alerter.dispose();
      };
    },
    `${PLUGIN_ID} lifecycle`,
  );

  log?.debug?.(`${PLUGIN_ID}: ready (config file: ${store.path})`);
}
