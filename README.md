# dsh-smart-proxy

> 让 Gemini / GPT / Claude 走代理，让 DeepSeek / Seedream / 国内 API 永远直连。
> 关掉 Clash 时，只有白名单域名失败，DSH 的对话和国内模型完全不受影响。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

DeepSeek Harness（DSH）插件。它在 DSH 进程内起一个**本地选择性代理**，按域名分流：

```text
DSH 进程
  │  HTTP_PROXY=http://127.0.0.1:17890     ← 插件自动写进 ~/.dsh/.env
  ▼
dsh-smart-proxy (本插件，只监听 127.0.0.1)
  ├── googleapis.com / openai.com / …  → CONNECT 隧道 → Clash 127.0.0.1:7890
  └── api.deepseek.com / volces.com / … → 自己直连（不经过 Clash）
```

## 它解决什么问题

| 场景 | 没有插件 | 有插件 |
|---|---|---|
| Clash 开 TUN / 全局模式 | DeepSeek、Seedream 被送出国，连不上 | **不需要开 TUN**；规则模式即可 |
| Clash 只开规则模式 | DSH 不认系统代理，Google 连不上 | Google 走插件 → Clash，正常 |
| Clash 完全关掉 | 写了 `.env` 后所有流量都去连代理端口，国内 API 也挂 | 只有白名单失败，其余照常直连 |
| DeepSeek 对话 | 可能被代理绕断 | 永远直连 |

一句话：**代理开不开，只影响你在白名单里列出的域名。**

## 特性

- **按域名选择性代理**：后缀匹配，`a.google.com` 命中 `google.com`，`notgoogle.com` 不误伤；支持 `*.example.com`。
- **零手工配置 `.env`**：插件启动时自动维护 `~/.dsh/.env` 里的代理块，保留你的其他变量（比如 `GEMINI_API_KEY`），并自动备份。
- **可视化配置**：安装后在 DSH 的插件设置页直接改上游地址、端口、域名白名单，不用编辑文件。
- **上游可用性自检**：启动时探测 Clash 端口，日志里直接告诉你上游通不通。
- **支持上游认证**：`http://user:pass@host:port`，或单独填 `user:password`。
- **安全默认**：只监听 `127.0.0.1`，不暴露给局域网。
- **零依赖、零构建**：纯 Node ESM，`node --test` 覆盖核心分流逻辑。

## 安装

### 方式一：本地目录（推荐先这样用）

```bash
git clone https://github.com/MuDong612/dsh-smart-proxy.git
```

然后在 DSH 里对 Agent 说：

> 帮我把 `/绝对路径/dsh-smart-proxy` 安装成 DSH 插件。

Agent 会通过 DSH 的 `plugin_manager` 安装并注册 bundle。

> 注意：本地目录安装是**软链**到你的仓库，不是拷贝。安装后不要移动或删除这个目录，否则插件会失效。

如果你的机器上有 `dsh` 命令，也可以直接用命令行（Desktop 的 profile 名是 `desktop`）：

```bash
dsh plugin --profile desktop add /绝对路径/dsh-smart-proxy
```

### 方式二：直接从 GitHub 安装

仓库没有构建步骤，可以让 DSH 直接从 GitHub 拉取：

```bash
dsh plugin --profile desktop add github:MuDong612/dsh-smart-proxy
```

或者在 DSH 的插件安装入口填 `github:MuDong612/dsh-smart-proxy`。

### 方式三：发布到 npm 之后

```bash
npm publish
```

然后在 DSH 的 **设置 → 插件** 里按包名 `dsh-smart-proxy` 安装，或：

```bash
dsh plugin --profile desktop add dsh-smart-proxy
```

### 方式四：GitHub Release（不用 npm）

```bash
npm pack
# 生成 dsh-smart-proxy-0.2.0.tgz
gh release create v0.2.0 dsh-smart-proxy-0.2.0.tgz
```

安装这个 tarball：

```bash
dsh plugin --profile desktop add \
  https://github.com/MuDong612/dsh-smart-proxy/releases/download/v0.2.0/dsh-smart-proxy-0.2.0.tgz
```

> 安装/替换插件后，**重启一次 DSH**（⌘Q 完全退出再打开）。插件代码和 `.env` 都在启动时读取，重启后才会生效。

## 首次使用

1. 安装完成后**完全退出并重开 DSH**。
2. 打开 **设置 → 插件**，找到 **智能代理（dsh-smart-proxy）**，点配置。
3. 填上你 Clash 的 HTTP 代理端口（默认 `7890`），保存。
4. 日志里应该出现：

   ```text
   dsh-smart-proxy: 已监听 http://127.0.0.1:17890，上游 127.0.0.1:7890，白名单 17 条，选择性代理模式
   dsh-smart-proxy: 上游代理 127.0.0.1:7890 可达。
   ```

5. 验证分流（Clash 开着）：

   ```bash
   curl -sS -o /dev/null -w "deepseek %{http_code}\n" -x http://127.0.0.1:17890 https://api.deepseek.com
   curl -sS -o /dev/null -w "google   %{http_code}\n" -x http://127.0.0.1:17890 https://www.google.com
   ```

   - `deepseek 401`：直连可达（401 是没带 Key 的正常响应）。
   - `google 200`：白名单 → Clash 正常。
   - 把 Clash 关掉再看第二个，应该变成 `502`，而第一个仍然是 `401` —— 这就是「只影响白名单」的效果。

## 配置项

配置由 DSH 的插件设置页生成并持久化，改完即时生效（端口和 `.env` 相关的改动需要重启）。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后插件仍监听端口，但**所有域名直连**（不会把 DSH 网络弄断） |
| `upstream` | `http://127.0.0.1:7890` | Clash 的 HTTP 代理地址；也支持 `http://user:pass@host:port` |
| `upstreamAuth` | 空 | 上游需要认证时填 `user:password`；地址里已带账号密码就留空 |
| `patterns` | Google + OpenAI + Claude 共 17 条 | 走上游的域名后缀，其余一律直连 |
| `port` | `17890` | 本地监听端口，必须与 `.env` 的 `HTTP_PROXY` 一致；插件会自动同步 |
| `listenHost` | `127.0.0.1` | 监听地址，保持默认最安全 |
| `syncEnv` | `true` | 自动维护 `~/.dsh/.env`；关闭后需要自己写代理变量 |
| `logConnections` | `false` | 打开后每次直连/走代理都会写日志，排查时用 |

### 想再加一个域名

在配置页的 `patterns` 列表里加一行即可，例如：

```text
github.com
githubusercontent.com
```

保存后插件会自动重启监听（同端口），立即生效，不需要重启 DSH。

## 它怎么改你的 `.env`

插件只维护带标记的一段，不会动你的其他变量：

```bash
# >>> dsh-smart-proxy managed block >>>
HTTP_PROXY=http://127.0.0.1:17890
HTTPS_PROXY=http://127.0.0.1:17890
ALL_PROXY=http://127.0.0.1:17890
NODE_USE_ENV_PROXY=1
NO_PROXY=localhost,127.0.0.1,::1,…,deepseek.com,volces.com,…
# <<< dsh-smart-proxy managed block <<<
```

- 第一次写入前会备份到 `~/.dsh/.env.bak-dsh-smart-proxy`。
- `NO_PROXY` 会自动并入常见国内 API 域名（DeepSeek、火山方舟、阿里云、智谱、月之暗面等），这样即使插件异常退出，国内 API 也不会被代理端口拖死。
- `NODE_USE_ENV_PROXY=1` 让 Node 的 `fetch` 读取上面的代理变量。
- `.env` 只在 DSH 启动时读取，所以**改完 `.env` 要重启 DSH**。

## 常见问题

**Clash 的端口不是 7890？**

Clash Verge 的「混合端口」常见是 `7897`。在 Clash 设置里看，或者：

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E '7890|7897|7891'
```

把 `upstream` 改成对应端口即可。

**还需要开 TUN 吗？**

不需要，建议关掉。TUN 是系统级接管，所有进程（包括 DSH）都会走 Clash，插件就失去意义了。用 Clash 的**规则模式**，让插件决定哪些域名走代理。

**关掉 Clash 会怎样？**

- DeepSeek 对话：正常（直连）。
- Seedream / 通义 / 智谱：正常（直连）。
- Gemini / OpenAI / Claude：失败（白名单域名，没有上游可走）。

这正是设计目标：**把影响面限制在白名单内**。

**改了配置，为什么 Google 还是不通？**

按顺序检查：

1. Clash 是否在运行，`upstream` 端口对不对；
2. 插件日志是否显示「上游代理 … 可达」；
3. `patterns` 是否包含目标域名；
4. 改的是 `port` 吗？端口变了必须重启 DSH（`.env` 才会更新）。

**能直接用插件页的开关关掉它吗？**

不建议。关掉 bundle 后，`~/.dsh/.env` 仍然指向已经没人监听的 `17890`，DSH 会连不上任何
不在 `NO_PROXY` 里的域名。要临时停用，把配置里的 `enabled` 设为 `false`（插件仍监听，
但全部直连）；要彻底移除，按下面的「卸载与回滚」操作。

**端口 17890 被占用？**

插件会打一条警告并跳过监听，不会让 DSH 崩溃。把 `port` 改成别的（比如 `17891`），保存后重启 DSH。

**会不会影响整台电脑？**

不会。只有读取 `~/.dsh/.env` 的 DSH 进程会用它，系统代理、浏览器、其他 App 都不受影响。

**安全吗？**

默认只监听 `127.0.0.1`，且没有认证。不要改成 `0.0.0.0` 后暴露在公共网络。

## 卸载与回滚

1. 在 **设置 → 插件** 里卸载 `dsh-smart-proxy`。
2. 清掉 `.env` 里的代理配置（否则 DSH 还会去连已经没人监听的 17890）：

   ```bash
   cd /path/to/dsh-smart-proxy
   node scripts/restore-env.mjs
   ```

   它会删掉托管块和 `HTTP_PROXY` 等变量，保留 `GEMINI_API_KEY` 之类的其他内容，并备份到
   `~/.dsh/.env.bak-dsh-smart-proxy-removed`。
3. 重启 DSH。

> `~/.dsh/.env.bak-dsh-smart-proxy` 是**第一次写入前**的快照，可能还包含你安装本插件之前
> 的旧代理设置；除非你确定要回到那个状态，否则不要直接拿它覆盖 `.env`。

## 开发

```bash
cd dsh-smart-proxy
npm test                 # node --test，覆盖匹配、分流、上游失败、.env 同步
node lib/proxy.js        # 不依赖 DSH，单独跑代理
```

`lib/` 结构：

- `proxy.js` — 选择性代理核心（CONNECT + 明文 HTTP）。
- `env.js` — `~/.dsh/.env` 的读取、备份、托管块写入。
- `index.js` — DSH 插件入口与 `Config` schema。

## 发布到自己的 GitHub

```bash
cd dsh-smart-proxy
git init
git add .
git commit -m "feat: selective proxy plugin for DeepSeek Harness"
gh repo create dsh-smart-proxy --public --source=. --push
```

仓库地址已经写进 `package.json` 的 `repository` / `homepage`，需要改作者信息时直接编辑即可。

## License

[MIT](./LICENSE)
