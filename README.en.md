# dsh-smart-proxy

> Keep Gemini / GPT / Claude on your proxy, keep DeepSeek / Seedream / domestic APIs direct.
> With Clash off, only whitelisted domains fail — chat and domestic models keep working.

A DeepSeek Harness (DSH) plugin that runs a **local selective proxy** inside the DSH
process. Requests are routed by hostname:

```text
DSH process
  │  HTTP_PROXY=http://127.0.0.1:17890    ← managed by the plugin in ~/.dsh/.env
  ▼
dsh-smart-proxy (127.0.0.1 only)
  ├── googleapis.com / openai.com / …   → CONNECT tunnel → Clash 127.0.0.1:7890
  └── api.deepseek.com / volces.com / … → direct TCP (never through Clash)
```

## Why

- DSH does not read the macOS system proxy, so `dsh` needs `HTTP_PROXY`/`HTTPS_PROXY`.
- A global proxy or TUN mode sends DeepSeek and domestic APIs abroad, which breaks them.
- A plain `NO_PROXY` list cannot express "only these domains go through the proxy".
- This plugin can: everything goes to `127.0.0.1:17890`, and the plugin decides per host.
  When Clash is down, non-whitelisted domains still work — only the whitelist fails.

## Features

- Suffix-based whitelist (`a.google.com` matches `google.com`, `notgoogle.com` does not; `*.example.com` supported).
- No manual `.env` editing: a marked block is written on startup, other variables are preserved, and a backup is created.
- Visual settings page generated from the plugin `Config` (upstream URL, port, domain list, toggles).
- Upstream health probe in the log at startup.
- Optional upstream auth (`http://user:pass@host:port`).
- Listens on `127.0.0.1` by default; zero dependencies, zero build.

## Install

```bash
git clone https://github.com/MuDong612/dsh-smart-proxy.git
```

Then ask the DSH agent to install `dsh-smart-proxy` from that directory, or with the CLI:

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-smart-proxy
```

Directly from GitHub (no build step):

```bash
dsh plugin --profile desktop add github:MuDong612/dsh-smart-proxy
```

From npm: `dsh plugin --profile desktop add dsh-smart-proxy` after `npm publish`.
From a GitHub release: `dsh plugin --profile desktop add <tarball-url>`.

**Restart DSH once** after installing or replacing the plugin: both the plugin code
and `~/.dsh/.env` are read at startup.

## Configure

1. Open the **Plugins** page in the left sidebar (not **Settings → Built-in plugins**).
2. Open **dsh-smart-proxy**, then the **smart-proxy** row.
3. Click **Configure**; the form is rendered on the row page.
4. Set `upstream` to your Clash HTTP proxy (default `http://127.0.0.1:7890`).
5. Edit `patterns` to add or remove domains.
6. Save. Whitelist/upstream changes apply immediately; port changes need a DSH restart.

### Defaults

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When off, the proxy still listens but sends everything direct |
| `upstream` | `http://127.0.0.1:7890` | Clash HTTP proxy, optionally with credentials |
| `upstreamAuth` | empty | `user:password` if not embedded in `upstream` |
| `patterns` | Google + OpenAI + Claude (17 entries) | Domains routed to upstream |
| `port` | `17890` | Local port, mirrored into `.env` |
| `listenHost` | `127.0.0.1` | Bind address |
| `syncEnv` | `true` | Maintain `~/.dsh/.env` automatically |
| `logConnections` | `false` | Log every direct/proxied connection |

## Verify

With Clash running:

```bash
curl -sS -o /dev/null -w "deepseek %{http_code}\n" -x http://127.0.0.1:17890 https://api.deepseek.com
curl -sS -o /dev/null -w "google   %{http_code}\n" -x http://127.0.0.1:17890 https://www.google.com
```

`deepseek 401` (reachable, no key) and `google 200`. Turn Clash off: the second
becomes `502`, the first stays `401`.

## What it writes to `.env`

```bash
# >>> dsh-smart-proxy managed block >>>
HTTP_PROXY=http://127.0.0.1:17890
HTTPS_PROXY=http://127.0.0.1:17890
ALL_PROXY=http://127.0.0.1:17890
NODE_USE_ENV_PROXY=1
NO_PROXY=localhost,127.0.0.1,::1,…,deepseek.com,volces.com,…
# <<< dsh-smart-proxy managed block <<<
```

A backup is written to `~/.dsh/.env.bak-dsh-smart-proxy` before the first change.
Only DSH reads this file; the rest of the machine is unaffected.

## Uninstall

Remove the plugin, then run `node scripts/restore-env.mjs` to delete the managed block
and the proxy variables (a backup is written to `~/.dsh/.env.bak-dsh-smart-proxy-removed`),
then restart DSH.

## Development

```bash
npm test          # node --test: matching, routing, upstream failure, .env sync
node lib/proxy.js # run the proxy standalone
```

## License

[MIT](./LICENSE)
