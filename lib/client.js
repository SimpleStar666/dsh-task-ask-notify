/**
 * dsh-task-ask-notify - browser half: the plugin's configuration page.
 *
 * Where the page appears
 * ----------------------
 * Two seats, so it is reachable whichever way the user navigates:
 *
 *   `plugins.bundle.config`  keyed by the package name - rendered on the bundle's
 *                            own page in the Plugins list, which is the page the
 *                            user already opens to see the plugin;
 *   `plugins.row.config`     keyed `<package>#<row id>` - adds a configure
 *                            control to the loader row, opening the same page
 *                            headed by the plugin's display title.
 *
 * Both seats are dispatched with `view: 'summary'` (a one-liner for the collapsed
 * row) and `view: 'page'` (the form with its save control), so this module renders
 * both. Each view is its own component because switching a view must not change a
 * component's hook order.
 *
 * How an edit takes effect
 * ------------------------
 * Values come from DSH's settings service through `ctx.configForms`, bound to this
 * plugin's Loader row id - the same controller the Plugins page hands over as its
 * `form` prop when it has one. That path only exists for config fields declared
 * `.volatile()`, which is exactly the set rendered here; a write goes back as
 * `set` operations and the Host commits them into the running plugin's live
 * references, so the next alert already uses the new value. No reload, no restart.
 *
 * Constraints this file respects
 * ------------------------------
 *  - No Harness Client package is imported: React comes from the browser module
 *    table and everything else is theme CSS variables.
 *  - Every resource is registered through `ctx.effect`, so unmounting removes it.
 *  - Text goes through the locale service when the deployment has one.
 *
 * @module dsh-task-ask-notify/client
 */

window.__ModuleLoader__.load({
  // Must equal the package name: client halves are registered by package id.
  id: 'dsh-task-ask-notify',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Package name, and the Loader row id this bundle declares (they match). */
    const PACKAGE_NAME = 'dsh-task-ask-notify';
    const ROW_ID = 'dsh-task-ask-notify';
    /** Locale dictionary namespace owned by this plugin. */
    const NS = 'dsh-task-ask-notify';
    /**
     * The diagnostic trigger the listen button writes. Deliberately kept out of the
     * field table: it records that a listen was requested, it is not a preference,
     * and it must neither render as a row nor count as a pending change.
     */
    const AUDITION_PATH = ['sound', 'auditionAt'];

    const zh = {
      intro:
        '任务完成、模型向你提问、或本轮运行失败时，弹出 Windows 系统通知并播放提示音。此页改动立即生效，无需重启。',
      loading: '正在读取配置…',
      unavailable: '这个插件当前没有出现在部署的配置面里，暂时无法在这里修改。',
      readOnly: '当前 profile 不允许写入配置（可能有更高优先级的配置层覆盖）。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '部署没有接受这些值，已保留供你修改。',
      noChanges: '没有改动。',
      dirty: '有未保存的改动。',
      groupMaster: '总开关',
      groupComplete: '任务完成',
      groupAsk: '向你提问',
      groupSound: '提示音',
      groupNotify: '系统通知',
      groupSessions: '会话范围',
      enabled: '启用全部提醒',
      completeEnabled: '一轮结束时提醒',
      debounceMs: '静默期（毫秒）',
      debounceHelp: '一轮结束并安静这么久之后才提醒。多轮任务想合并成一次提醒就调大；代价是短任务也要等这么久。',
      askSingleEnabled: '只问一个问题时提醒',
      askMultipleEnabled: '问两个及以上问题时提醒',
      groupFailed: '运行失败',
      failedEnabled: '本轮运行失败时提醒',
      failedHelp: '一轮以「失败」收尾时立刻提醒，不等静默期；正文会附上失败原因。',
      includeReason: '在通知正文里附上失败原因',
      includeReasonHelp: '默认开启：只有一句「本轮运行失败」没用，得知道为什么。',
      soundEnabled: '播放提示音',
      volume: '音量（0–100，0 静音）',
      minGapMs: '两次提醒的最小声音间隔（毫秒）',
      minGapHelp: '间隔小于此值的两次提醒共用一次声音；两条通知照发。',
      listen: '试听',
      listening: '正在播放…',
      listenHelp: '按当前音量随机播放一段你已导入的提示音，并先保存本页改动。',
      notifyEnabled: '弹出系统通知',
      includeQuestionInBody: '在通知正文里附上首个问题',
      includeQuestionHelp: '默认关闭：通知正文是会话标题。',
      includeSubagents: '子代理会话也提醒',
      includeSubagentsHelp: '默认关闭，避免一堆后台助手刷屏。',
      summaryOff: '提醒已关闭',
      summaryOn: '完成 {debounce} · 提问 {ask} · 失败 {fail} · 声音 {volume}% · 通知 {notify}',
      on: '开',
      off: '关',
      soundNoteTitle: '提示音文件不在这里改',
      soundNote:
        '提示音按场景放在目录里，等概率随机取一个：相对路径先找你的音频目录（%DSH_HOME%\\plugin-data\\dsh-task-ask-notify\\audio\\…），再找到插件包内的 audio/…。用仓库里的 tools/import-audio.mjs 导入你自己的音频，或把 complete.dir / failed.dir / askSingle.dir / askMultiple.dir 指到你已有的目录。',
      advancedNote:
        '通知文案、AUMID、音效目录等字段不在本页，它们写在 %DSH_HOME%\\plugin-data\\dsh-task-ask-notify\\config.json（热重载）或本 bundle 的 cordis.patch.yml 里。',
    };

    const en = {
      intro:
        'A Windows notification and a sound when a turn finishes, when the model asks you a question, or when the turn fails. Edits here apply immediately, with no restart.',
      loading: 'Reading configuration…',
      unavailable: 'This plugin is not in the deployment’s configuration surface right now, so it cannot be edited here.',
      readOnly: 'This profile refuses configuration writes (a higher-priority layer may override it).',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      noChanges: 'No changes.',
      dirty: 'Unsaved changes.',
      groupMaster: 'Master switch',
      groupComplete: 'Finished turn',
      groupAsk: 'Question asked',
      groupSound: 'Sound',
      groupNotify: 'Notification',
      groupSessions: 'Session scope',
      enabled: 'Enable every alert',
      completeEnabled: 'Alert when a turn ends',
      debounceMs: 'Quiet period (ms)',
      debounceHelp:
        'Wait this long after a turn ends before alerting. Raise it to merge a multi-turn task into one alert; short tasks then wait that long too.',
      askSingleEnabled: 'Alert for a single question',
      askMultipleEnabled: 'Alert for two or more questions',
      groupFailed: 'Failed turn',
      failedEnabled: 'Alert when a turn fails',
      failedHelp: 'Fires as soon as the turn closes with a failure reason, with no quiet period; the body carries the reason.',
      includeReason: 'Append the failure reason to the body',
      includeReasonHelp: 'On by default: "this turn failed" is useless without why.',
      soundEnabled: 'Play a sound',
      volume: 'Volume (0–100, 0 is silent)',
      minGapMs: 'Minimum gap between sounds (ms)',
      minGapHelp: 'Two alerts closer than this share one sound; both still notify.',
      listen: 'Listen',
      listening: 'Playing…',
      listenHelp: 'Plays one of your imported sounds at the current volume, saving this page first.',
      notifyEnabled: 'Show a system notification',
      includeQuestionInBody: 'Append the first question to the body',
      includeQuestionHelp: 'Off by default: the body is the session title.',
      includeSubagents: 'Also alert for subagent sessions',
      includeSubagentsHelp: 'Off by default, so a fan-out of helpers does not flood you.',
      summaryOff: 'Alerts are off',
      summaryOn: 'complete {debounce} · questions {ask} · failure {fail} · sound {volume}% · notification {notify}',
      on: 'on',
      off: 'off',
      soundNoteTitle: 'Sound files are not edited here',
      soundNote:
        'Sounds sit in per-scenario directories and one is chosen uniformly at random: a relative path looks in your audio folder (%DSH_HOME%\\plugin-data\\dsh-task-ask-notify\\audio\\…) first, then in the package’s own audio/…. Import your own with the repository’s tools/import-audio.mjs, or point complete.dir / failed.dir / askSingle.dir / askMultiple.dir at a folder you already have.',
      advancedNote:
        'Notification wording, the AUMID, and the sound directories are not on this page: they live in %DSH_HOME%\\plugin-data\\dsh-task-ask-notify\\config.json (hot-reloaded) or in this bundle’s cordis.patch.yml.',
    };

    /** Theme tokens, so the page inherits light/dark instead of hard-coding colours. */
    const css = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', color: 'var(--dsw-alias-label-primary)' },
      summary: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      intro: {
        margin: 0,
        fontSize: '13px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
        maxWidth: '62ch',
      },
      group: { display: 'flex', flexDirection: 'column', gap: '10px' },
      groupTitle: { margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      rowText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      label: { fontSize: '13px' },
      help: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      number: {
        width: '120px',
        padding: '5px 8px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
      },
      notice: {
        margin: 0,
        padding: '10px 12px',
        fontSize: '12px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
      },
      noticeTitle: { display: 'block', marginBottom: '4px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      footer: { display: 'flex', alignItems: 'center', gap: '12px' },
      button: {
        padding: '6px 16px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      statusError: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      statusOk: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' },
    };

    /**
     * The editable fields. Every path here is declared `.volatile()` in the Host
     * schema, and the settings service refuses a write to any path that is not;
     * `test/config.test.mjs` fails if this list and the schema drift apart.
     */
    const FIELDS = [
      { group: 'groupMaster', items: [{ path: ['enabled'], kind: 'boolean', label: 'enabled' }] },
      {
        group: 'groupComplete',
        items: [
          { path: ['complete', 'enabled'], kind: 'boolean', label: 'completeEnabled' },
          { path: ['complete', 'debounceMs'], kind: 'number', label: 'debounceMs', help: 'debounceHelp', min: 0, max: 600000 },
        ],
      },
      {
        group: 'groupAsk',
        items: [
          { path: ['askSingle', 'enabled'], kind: 'boolean', label: 'askSingleEnabled' },
          { path: ['askMultiple', 'enabled'], kind: 'boolean', label: 'askMultipleEnabled' },
        ],
      },
      {
        group: 'groupFailed',
        items: [
          { path: ['failed', 'enabled'], kind: 'boolean', label: 'failedEnabled', help: 'failedHelp' },
          { path: ['failed', 'includeReason'], kind: 'boolean', label: 'includeReason', help: 'includeReasonHelp' },
        ],
      },
      {
        group: 'groupSound',
        items: [
          { path: ['sound', 'enabled'], kind: 'boolean', label: 'soundEnabled' },
          { path: ['sound', 'volume'], kind: 'number', label: 'volume', help: 'listenHelp', min: 0, max: 100, step: 5, action: 'listen' },
          { path: ['sound', 'minGapMs'], kind: 'number', label: 'minGapMs', help: 'minGapHelp', min: 0, max: 600000 },
        ],
      },
      {
        group: 'groupNotify',
        items: [
          { path: ['notify', 'enabled'], kind: 'boolean', label: 'notifyEnabled' },
          {
            path: ['notify', 'includeQuestionInBody'],
            kind: 'boolean',
            label: 'includeQuestionInBody',
            help: 'includeQuestionHelp',
          },
        ],
      },
      {
        group: 'groupSessions',
        items: [
          { path: ['sessions', 'includeSubagents'], kind: 'boolean', label: 'includeSubagents', help: 'includeSubagentsHelp' },
        ],
      },
    ];

    /** @returns every editable field descriptor, flattened. */
    const allItems = () => FIELDS.flatMap((group) => group.items);

    /**
     * @param object source object
     * @param path key path
     * @returns the value at the path, or undefined
     */
    function at(object, path) {
      let cursor = object;
      for (const key of path) {
        if (cursor === null || typeof cursor !== 'object') return undefined;
        cursor = cursor[key];
      }
      return cursor;
    }

    /**
     * @param snapshot form snapshot
     * @param t dictionary lookup
     * @returns the values the summary template interpolates
     */
    function summaryValues(snapshot, t) {
      const values = snapshot?.value;
      const onOff = (value) => (value === true ? t('on') : t('off'));
      const debounceMs = values?.complete?.debounceMs;
      return {
        debounce: Number.isFinite(debounceMs) ? `${Math.round(debounceMs / 100) / 10}s` : '?',
        ask: onOff(values?.askSingle?.enabled === true || values?.askMultiple?.enabled === true),
        fail: onOff(values?.failed?.enabled === true),
        volume: Number.isFinite(values?.sound?.volume) ? String(Math.round(values.sound.volume)) : '?',
        notify: onOff(values?.notify?.enabled),
      };
    }

    /**
     * @param snapshot form snapshot
     * @param t dictionary lookup
     * @returns the one-line summary a collapsed row shows
     */
    function summarise(snapshot, t) {
      const values = snapshot?.value;
      if (values === undefined || values === null) return t('loading');
      if (values.enabled !== true) return t('summaryOff');
      const filled = summaryValues(snapshot, t);
      return t('summaryOn')
        .replace('{debounce}', filled.debounce)
        .replace('{ask}', filled.ask)
        .replace('{volume}', filled.volume)
        .replace('{notify}', filled.notify);
    }

    /**
     * Read the form snapshot, tolerating a controller that is not ready yet.
     * @param scope configuration form controller, or undefined
     * @returns a snapshot-shaped object
     */
    function readSnapshot(scope) {
      const fallback = { status: 'loading', writable: false, value: undefined };
      if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') return fallback;
      try {
        return scope.getSnapshot() ?? fallback;
      } catch {
        return fallback;
      }
    }

    /**
     * Keep a component subscribed to the form.
     * @param scope configuration form controller, or undefined
     * @returns the current snapshot
     */
    function useSnapshot(scope) {
      const [snapshot, setSnapshot] = React.useState(() => readSnapshot(scope));
      React.useEffect(() => {
        setSnapshot(readSnapshot(scope));
        if (scope === undefined || scope === null || typeof scope.subscribe !== 'function') return undefined;
        return scope.subscribe(() => setSnapshot(readSnapshot(scope)));
      }, [scope]);
      return snapshot;
    }

    /** The one-liner shown in a collapsed row or as a bundle's configuration line. */
    function Summary(props) {
      const snapshot = useSnapshot(props.scope);
      return h('span', { style: css.summary }, summarise(snapshot, props.t));
    }

    /** One labelled row with a boolean or numeric control, and an optional action. */
    function Field(props) {
      const { item, value, disabled, onChange, t } = props;
      const invalid = item.kind === 'number' && !Number.isFinite(value);
      const control =
        item.kind === 'boolean'
          ? h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled,
              style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary)' },
              onChange: (event) => onChange(item.path, event.target.checked),
            })
          : h('input', {
              type: 'number',
              value: Number.isFinite(value) ? String(value) : '',
              min: item.min,
              max: item.max,
              step: item.step ?? 1,
              disabled,
              'aria-invalid': invalid ? 'true' : undefined,
              style: invalid ? { ...css.number, borderColor: 'var(--dsw-alias-state-error-primary)' } : css.number,
              onChange: (event) => {
                const text = event.target.value;
                return onChange(item.path, text === '' ? Number.NaN : Number(text));
              },
            });

      // An audition control sits beside the value it is judged by, so one drag and
      // one click is the whole loop: set the number, hear it, keep or change it.
      const action =
        item.action === 'listen'
          ? h(
              'button',
              {
                type: 'button',
                style: { ...css.button, marginLeft: '8px', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap' },
                disabled,
                onClick: () => props.onListen(),
              },
              t(props.listening === true ? 'listening' : 'listen'),
            )
          : null;

      return h(
        'div',
        { style: css.row },
        h(
          'div',
          { style: css.rowText },
          h('span', { style: css.label }, t(item.label)),
          item.help === undefined ? null : h('span', { style: css.help }, t(item.help)),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', flex: 'none' } }, control, action),
      );
    }

    /** The form itself, with its save control. */
    function FormBody(props) {
      const { scope, t } = props;
      const snapshot = useSnapshot(scope);
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [outcome, setOutcome] = React.useState(null);
      const [listening, setListening] = React.useState(false);

      // A committed revision retires whatever draft was in flight.
      React.useEffect(() => {
        setDraft(null);
        setOutcome(null);
      }, [snapshot?.revision]);

      const values = snapshot?.value;
      const available = typeof values === 'object' && values !== null;
      const source = draft ?? values ?? {};
      const dirty = draft !== null && allItems().some((item) => !Object.is(at(draft, item.path), at(values, item.path)));
      const invalid = allItems().some((item) => item.kind === 'number' && !Number.isFinite(at(source, item.path)));
      const disabled = !available || snapshot.writable !== true || saving;

      const edit = (path, value) => {
        const next = JSON.parse(JSON.stringify(draft ?? values ?? {}));
        let cursor = next;
        for (const key of path.slice(0, -1)) {
          cursor[key] = cursor[key] ?? {};
          cursor = cursor[key];
        }
        cursor[path[path.length - 1]] = value;
        setDraft(next);
        setOutcome(null);
      };

      /**
       * Apply the draft and play one sound at the resulting volume.
       *
       * Both go out as one revisioned write, so what is heard is exactly what the
       * page shows — a half-applied volume would make the audition a lie.
       */
      const listen = async () => {
        if (!available || snapshot.writable !== true || saving) return;
        const operations = [];
        for (const item of allItems()) {
          const next = at(source, item.path);
          if (item.kind === 'number' && !Number.isFinite(next)) continue;
          if (Object.is(next, at(values, item.path))) continue;
          operations.push({ op: 'set', path: item.path, value: next });
        }
        operations.push({ op: 'set', path: AUDITION_PATH, value: Date.now() });
        setSaving(true);
        setListening(true);
        setOutcome(null);
        try {
          await scope.mutate(operations, snapshot.revision);
          setDraft(null);
        } catch {
          setOutcome('failed');
        } finally {
          setSaving(false);
          // The sound outlives the write, so hold the label a little longer.
          setTimeout(() => setListening(false), 1200);
        }
      };

      const save = async () => {
        if (disabled || draft === null) return;
        const operations = [];
        for (const item of allItems()) {
          const next = at(draft, item.path);
          if (item.kind === 'number' && !Number.isFinite(next)) continue;
          if (Object.is(next, at(values, item.path))) continue;
          operations.push({ op: 'set', path: item.path, value: next });
        }
        if (operations.length === 0) {
          setDraft(null);
          return;
        }
        setSaving(true);
        setOutcome(null);
        try {
          await scope.mutate(operations, snapshot.revision);
          setOutcome('saved');
          setDraft(null);
        } catch {
          setOutcome('failed');
        } finally {
          setSaving(false);
        }
      };

      return h(
        'div',
        { style: css.root },
        h('p', { style: css.intro }, t('intro')),
        !available ? h('p', { style: css.notice }, t(snapshot?.status === 'loading' ? 'loading' : 'unavailable')) : null,
        available && snapshot.writable !== true ? h('p', { style: css.notice }, t('readOnly')) : null,

        ...FIELDS.map((group) =>
          h(
            'div',
            { key: group.group, style: css.group },
            h('h4', { style: css.groupTitle }, t(group.group)),
            ...group.items.map((item) =>
              h(Field, {
                key: item.path.join('.'),
                item,
                t,
                disabled,
                listening,
                onListen: listen,
                value: at(source, item.path),
                onChange: edit,
              }),
            ),
          ),
        ),

        h('p', { style: css.notice }, h('span', { style: css.noticeTitle }, t('soundNoteTitle')), t('soundNote')),
        h('p', { style: css.notice }, t('advancedNote')),

        h(
          'div',
          { style: css.footer },
          h(
            'button',
            {
              type: 'button',
              style: { ...css.button, opacity: disabled || !dirty || invalid ? 0.5 : 1 },
              disabled: disabled || !dirty || invalid,
              onClick: save,
            },
            t(saving ? 'saving' : 'save'),
          ),
          outcome === 'failed'
            ? h('span', { style: css.statusError }, t('saveFailed'))
            : outcome === 'saved'
              ? h('span', { style: css.statusOk }, t('saved'))
              : dirty
                ? h('span', { style: css.status }, t('dirty'))
                : h('span', { style: css.status }, t('noChanges')),
        ),
      );
    }

    /**
     * The contribution itself.
     *
     * Holds no hooks of its own: each view is a separate component, because a view
     * switch must not change a component's hook order.
     *
     * @param props owner props (`view`, `form`) merged with the injected face
     * @returns the view the owning page asked for
     */
    function ConfigPage(props) {
      const scope = props.form ?? props.resolveScope();
      if (props.view === 'summary') return h(Summary, { scope, t: props.t });
      return h(FormBody, { scope, t: props.t });
    }

    /**
     * Mount the configuration page.
     *
     * Registration is unconditional and the settings controller is resolved lazily
     * at render, so the page is visible whenever this bundle is installed; a
     * deployment without a settings service gets a page that says so, rather than
     * no page at all.
     *
     * @param ctx browser plugin context
     */
    function apply(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      let t = (key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key);
      if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh, en }), `${PACKAGE_NAME}: dictionaries`);
        if (typeof locale.bind === 'function') {
          const bound = locale.bind(NS);
          t = (key) => bound(key);
        }
      }

      /** @returns this plugin's settings form controller, or undefined when absent. */
      const resolveScope = () => {
        const service = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined;
        if (service === undefined || service === null || typeof service.get !== 'function') return undefined;
        try {
          return service.get(ROW_ID);
        } catch {
          return undefined;
        }
      };

      const face = { t, resolveScope };

      ctx.effect(
        () => {
          const bundle = ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              { name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS, inject: () => face },
              ConfigPage,
            ),
          );
          const row = ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register(
              { name: 'plugins.row.config', key: `${PACKAGE_NAME}#${ROW_ID}`, locale: NS, inject: () => face },
              ConfigPage,
            ),
          );
          return () => {
            bundle?.();
            row?.();
          };
        },
        `${PACKAGE_NAME}: configuration page`,
      );
    }

    return { inject: ['slots'], apply };
  },
});
