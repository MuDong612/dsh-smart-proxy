/**
 * dsh-smart-proxy — Client half.
 *
 * The Plugins page renders a row's configuration by looking up the
 * `plugins.row.config` occupant for `<package>#<row id>`. This module registers
 * that card. It reads the namespace through the shared `configForms` service
 * (so it does not depend on the exact settings entry id) and writes changed
 * fields back as one atomic mutation.
 */
window.__ModuleLoader__.load({
  id: 'dsh-smart-proxy',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-smart-proxy';
    const ROW_KEY = 'dsh-smart-proxy#smart-proxy';

    const DICT = {
      zh: {
        summary: '只让白名单域名走 Clash 等上游代理，其余域名永远直连。',
        title: '代理分流',
        subtitle: 'Gemini / OpenAI / Claude 走代理，DeepSeek / Seedream 直连。',
        enabled: '启用选择性代理',
        enabledHint: '关闭后插件仍监听端口，但所有域名都直连（不会影响 DSH 联网）。',
        upstream: '上游代理地址',
        upstreamHint: '例如 Clash 的 http://127.0.0.1:7890；也支持 http://user:pass@host:port。',
        upstreamAuth: '上游认证（可选）',
        upstreamAuthHint: 'user:password；地址里已经带账号密码时留空。',
        patterns: '走代理的域名',
        patternsHint: '每行一个域名后缀，命中才走上游；其余域名一律直连。',
        port: '本地监听端口',
        portHint: '默认 17890。改端口后需要重启 DSH 才会生效。',
        listenHost: '监听地址',
        listenHostHint: '保持 127.0.0.1，只允许本机使用。',
        syncEnv: '自动维护 ~/.dsh/.env',
        syncEnvHint: '把 HTTP_PROXY / NO_PROXY 写进 DSH 的环境文件，并保留其他变量。',
        logConnections: '记录连接日志',
        logConnectionsHint: '排查问题时打开，每次直连 / 走代理都会写进 DSH 日志。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存，插件会自动重启以应用新配置。',
        savedPort: '端口已修改：已同步到 .env，需要重启 DSH 才会生效。',
        noChanges: '没有修改。',
        saveFailed: '保存失败：配置可能被更高优先级的层覆盖，或连接已失效。请刷新后重试。',
        invalidPort: '端口必须是 1–65535 之间的整数。',
        loading: '正在读取配置…',
        unavailable: '暂时读不到配置，请刷新页面后重试。',
        headerPatterns: '规则',
        headerAdvanced: '网络',
      },
      en: {
        summary: 'Only whitelisted domains use your upstream proxy; everything else stays direct.',
        title: 'Proxy routing',
        subtitle: 'Gemini / OpenAI / Claude via proxy, DeepSeek / Seedream direct.',
        enabled: 'Enable selective proxy',
        enabledHint: 'When off, the port stays open but every domain goes direct.',
        upstream: 'Upstream proxy',
        upstreamHint: 'e.g. Clash http://127.0.0.1:7890; credentials may be embedded.',
        upstreamAuth: 'Upstream auth (optional)',
        upstreamAuthHint: 'user:password; leave blank when the URL already contains credentials.',
        patterns: 'Domains through the proxy',
        patternsHint: 'One suffix per line. Everything else connects directly.',
        port: 'Local port',
        portHint: 'Default 17890. A port change needs a DSH restart.',
        listenHost: 'Listen address',
        listenHostHint: 'Keep 127.0.0.1 so only this machine can use it.',
        syncEnv: 'Maintain ~/.dsh/.env',
        syncEnvHint: 'Writes HTTP_PROXY / NO_PROXY for DSH and keeps your other variables.',
        logConnections: 'Log connections',
        logConnectionsHint: 'Log every direct / proxied connection for troubleshooting.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved. The plugin restarts automatically to apply the change.',
        savedPort: 'Port changed: written to .env; restart DSH to apply it.',
        noChanges: 'No changes.',
        saveFailed: 'Save failed: a higher-priority layer may override this entry, or the connection was lost.',
        invalidPort: 'Port must be an integer between 1 and 65535.',
        loading: 'Reading configuration…',
        unavailable: 'Configuration is unavailable right now. Refresh the page and retry.',
        headerPatterns: 'Rules',
        headerAdvanced: 'Network',
      },
    };

    const S = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '16px 18px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        maxWidth: 760,
      },
      head: { display: 'flex', alignItems: 'flex-start', gap: 12 },
      headText: { flex: 1, minWidth: 0 },
      title: { fontSize: 15, fontWeight: 600, lineHeight: '22px' },
      subtitle: { marginTop: 2, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' },
      section: { display: 'flex', flexDirection: 'column', gap: 12 },
      sectionTitle: {
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 5 },
      label: { fontSize: 12, fontWeight: 500, lineHeight: '18px' },
      hint: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '18px',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 9px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: '19px',
        minHeight: 132,
        resize: 'vertical',
      },
      row2: { display: 'grid', gridTemplateColumns: 'minmax(0, 180px) minmax(0, 1fr)', gap: 12 },
      checkRow: { display: 'flex', alignItems: 'flex-start', gap: 9 },
      check: { marginTop: 2, accentColor: 'var(--dsw-alias-brand-primary, #4d6bfe)' },
      checkText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      footer: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      buttonPrimary: {
        appearance: 'none',
        border: '1px solid transparent',
        borderRadius: 7,
        padding: '6px 14px',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
        background: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
      },
      buttonDisabled: { opacity: 0.45, cursor: 'default' },
      ok: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #16a34a)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-danger-primary, #dc2626)' },
      muted: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    };

    function splitPatterns(text) {
      return String(text ?? '')
        .split(/[\n,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    function toDraft(value) {
      const source = value && typeof value === 'object' ? value : {};
      return {
        enabled: source.enabled !== false,
        upstream: String(source.upstream ?? 'http://127.0.0.1:7890'),
        upstreamAuth: String(source.upstreamAuth ?? ''),
        patterns: Array.isArray(source.patterns) ? source.patterns.join('\n') : '',
        port: String(source.port ?? 17890),
        listenHost: String(source.listenHost ?? '127.0.0.1'),
        syncEnv: source.syncEnv !== false,
        logConnections: source.logConnections === true,
      };
    }

    function same(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    function buildOps(draft, value) {
      const ops = [];
      const push = (field, next, previous) => {
        if (!same(next, previous)) ops.push({ op: 'set', path: [field], value: next });
      };
      push('enabled', draft.enabled, value.enabled !== false);
      push('upstream', draft.upstream.trim(), String(value.upstream ?? ''));
      push('upstreamAuth', draft.upstreamAuth.trim(), String(value.upstreamAuth ?? ''));
      push(
        'patterns',
        splitPatterns(draft.patterns),
        Array.isArray(value.patterns) ? value.patterns.map(String) : [],
      );
      push('port', Number(draft.port), Number(value.port ?? 17890));
      push('listenHost', draft.listenHost.trim(), String(value.listenHost ?? '127.0.0.1'));
      push('syncEnv', draft.syncEnv, value.syncEnv !== false);
      push('logConnections', draft.logConnections, value.logConnections === true);
      return ops;
    }

    /** Identify this plugin's namespace by the fields only its schema has. */
    function isOurView(candidate) {
      const value = candidate && candidate.value;
      return Boolean(
        value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          'upstream' in value &&
          'patterns' in value &&
          'listenHost' in value &&
          'syncEnv' in value,
      );
    }

    function TextField({ id, label, hint, value, onChange, type }) {
      return h(
        'label',
        { htmlFor: id, style: S.field },
        h('span', { style: S.label }, label),
        h('input', {
          id,
          type: type ?? 'text',
          value,
          onChange: (event) => onChange(event.target.value),
          style: S.input,
          spellCheck: false,
        }),
        hint ? h('span', { style: S.hint }, hint) : null,
      );
    }

    function CheckField({ id, label, hint, checked, onChange }) {
      return h(
        'label',
        { htmlFor: id, style: S.checkRow },
        h('input', {
          id,
          type: 'checkbox',
          checked,
          onChange: (event) => onChange(event.target.checked),
          style: S.check,
        }),
        h(
          'span',
          { style: S.checkText },
          h('span', { style: S.label }, label),
          hint ? h('span', { style: S.hint }, hint) : null,
        ),
      );
    }

    function ConfigCard({ t, configForms }) {
      const mirror = React.useMemo(() => configForms.describe(), [configForms]);
      const [snapshot, setSnapshot] = React.useState(() => mirror.getSnapshot());

      React.useEffect(() => {
        const unsubscribe = mirror.subscribe(() => setSnapshot(mirror.getSnapshot()));
        mirror.ensure();
        setSnapshot(mirror.getSnapshot());
        return unsubscribe;
      }, [mirror]);

      const namespaceView = React.useMemo(() => {
        const list = snapshot.view?.namespaces ?? [];
        return list.find(isOurView);
      }, [snapshot]);
      const namespace = namespaceView?.ns;

      const controller = React.useMemo(
        () => (namespace === undefined ? undefined : configForms.get(namespace)),
        [configForms, namespace],
      );

      const [draft, setDraft] = React.useState(() => toDraft(namespaceView?.value));
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const revision = namespaceView?.revision;

      React.useEffect(() => {
        if (namespaceView === undefined) return;
        setDraft(toDraft(namespaceView.value));
        setMessage(null);
      }, [revision]);

      if (namespaceView === undefined || controller === undefined) {
        return h(
          'p',
          { style: S.muted },
          snapshot.status === 'ready' ? t('unavailable') : t('loading'),
        );
      }

      const value = namespaceView.value;
      const set = (key, next) => {
        setMessage(null);
        setDraft((previous) => ({ ...previous, [key]: next }));
      };
      const portNumber = Number(draft.port);
      const portValid = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536;
      const ops = portValid ? buildOps(draft, value) : [];
      const dirty = portValid && ops.length > 0;

      const save = async () => {
        if (!portValid) {
          setMessage({ kind: 'error', text: t('invalidPort') });
          return;
        }
        if (!dirty || saving) {
          if (!dirty) setMessage({ kind: 'ok', text: t('noChanges') });
          return;
        }
        const portChanged = portNumber !== Number(value.port ?? 17890);
        setSaving(true);
        setMessage(null);
        try {
          const accepted = await controller.mutate(ops, namespaceView.revision);
          setMessage(
            accepted
              ? { kind: 'ok', text: portChanged ? t('savedPort') : t('saved') }
              : { kind: 'error', text: t('saveFailed') },
          );
        } catch {
          setMessage({ kind: 'error', text: t('saveFailed') });
        } finally {
          setSaving(false);
        }
      };

      return h(
        'div',
        { style: S.card, 'data-dsh-smart-proxy-form': true },
        h(
          'div',
          { style: S.head },
          h(
            'div',
            { style: S.headText },
            h('div', { style: S.title }, t('title')),
            h('div', { style: S.subtitle }, t('subtitle')),
          ),
        ),
        h(
          'div',
          { style: S.section },
          h('div', { style: S.sectionTitle }, t('headerAdvanced')),
          h(CheckField, {
            id: 'dsp-enabled',
            label: t('enabled'),
            hint: t('enabledHint'),
            checked: draft.enabled,
            onChange: (next) => set('enabled', next),
          }),
          h(TextField, {
            id: 'dsp-upstream',
            label: t('upstream'),
            hint: t('upstreamHint'),
            value: draft.upstream,
            onChange: (next) => set('upstream', next),
          }),
          h(TextField, {
            id: 'dsp-upstream-auth',
            label: t('upstreamAuth'),
            hint: t('upstreamAuthHint'),
            value: draft.upstreamAuth,
            onChange: (next) => set('upstreamAuth', next),
          }),
          h(
            'div',
            { style: S.row2 },
            h(TextField, {
              id: 'dsp-port',
              label: t('port'),
              hint: t('portHint'),
              type: 'number',
              value: draft.port,
              onChange: (next) => set('port', next),
            }),
            h(TextField, {
              id: 'dsp-host',
              label: t('listenHost'),
              hint: t('listenHostHint'),
              value: draft.listenHost,
              onChange: (next) => set('listenHost', next),
            }),
          ),
          h(CheckField, {
            id: 'dsp-sync-env',
            label: t('syncEnv'),
            hint: t('syncEnvHint'),
            checked: draft.syncEnv,
            onChange: (next) => set('syncEnv', next),
          }),
          h(CheckField, {
            id: 'dsp-log',
            label: t('logConnections'),
            hint: t('logConnectionsHint'),
            checked: draft.logConnections,
            onChange: (next) => set('logConnections', next),
          }),
        ),
        h(
          'div',
          { style: S.section },
          h('div', { style: S.sectionTitle }, t('headerPatterns')),
          h(
            'label',
            { htmlFor: 'dsp-patterns', style: S.field },
            h('span', { style: S.label }, t('patterns')),
            h('textarea', {
              id: 'dsp-patterns',
              value: draft.patterns,
              onChange: (event) => set('patterns', event.target.value),
              style: S.textarea,
              spellCheck: false,
            }),
            h('span', { style: S.hint }, t('patternsHint')),
          ),
        ),
        h(
          'div',
          { style: S.footer },
          h(
            'button',
            {
              type: 'button',
              onClick: save,
              disabled: saving || !portValid || !dirty,
              style: {
                ...S.buttonPrimary,
                ...(saving || !portValid || !dirty ? S.buttonDisabled : null),
              },
            },
            saving ? t('saving') : t('save'),
          ),
          message
            ? h('span', { style: message.kind === 'ok' ? S.ok : S.error }, message.text)
            : null,
        ),
      );
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-smart-proxy: locale');
        const t = ctx.locale.bind(NS);
        ctx.inject(['configForms'], (scoped) => {
          const configForms = scoped.configForms;
          scoped.slots.inject('plugins.row.config', () =>
            scoped.slots.register(
              {
                name: 'plugins.row.config',
                key: ROW_KEY,
                locale: NS,
              },
              (props) =>
                props.view === 'summary'
                  ? h('span', null, t('summary'))
                  : h(ConfigCard, { ...props, t, configForms }),
            ),
          );
        });
      },
    };
  },
});
