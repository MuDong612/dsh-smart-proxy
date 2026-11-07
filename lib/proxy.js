/**
 * dsh-smart-proxy — 选择性 HTTP 代理核心。
 *
 * 规则：目标域名命中白名单 → 走上游代理（Clash 等）；否则 → 自己直连。
 * 这样即使上游代理关掉，也只有白名单里的域名失败，其余流量完全不受影响。
 *
 * 同时支持 HTTPS 隧道（CONNECT）与明文 HTTP（absolute-form）请求。
 * 这个文件不依赖 DeepSeek Harness，可以单独用 `node lib/proxy.js` 运行。
 */
import http from "node:http";
import net from "node:net";

/** 默认白名单：海外 AI 服务。其余域名一律直连。 */
export const DEFAULT_PATTERNS = Object.freeze([
  // Google / Gemini
  "google.com",
  "googleapis.com",
  "googleusercontent.com",
  "gstatic.com",
  "google.dev",
  "withgoogle.com",
  "ggpht.com",
  "youtube.com",
  "ytimg.com",
  "antigravity.google",
  "deepmind.com",
  // OpenAI / ChatGPT
  "openai.com",
  "chatgpt.com",
  "oaistatic.com",
  "oaiusercontent.com",
  // Anthropic / Claude
  "anthropic.com",
  "claude.ai",
]);

/** 常用分组，方便在 README 或脚本里组合。 */
export const PRESETS = Object.freeze({
  google: [
    "google.com",
    "googleapis.com",
    "googleusercontent.com",
    "gstatic.com",
    "google.dev",
    "withgoogle.com",
    "ggpht.com",
    "youtube.com",
    "ytimg.com",
    "antigravity.google",
    "deepmind.com",
  ],
  openai: ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com"],
  anthropic: ["anthropic.com", "claude.ai"],
  github: ["github.com", "githubusercontent.com", "githubassets.com"],
  telegram: ["telegram.org", "t.me", "telesco.pe"],
});

function normalizeHost(host) {
  if (typeof host !== "string") return "";
  let value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end !== -1) value = value.slice(1, end);
  }
  return value.replace(/\.$/, "");
}

/** 后缀匹配：`a.example.com` 命中 `example.com`，但 `notexample.com` 不命中。 */
export function makeMatcher(patterns) {
  const list = [];
  for (const raw of patterns ?? []) {
    let value = String(raw ?? "").trim().toLowerCase();
    if (value === "" || value.startsWith("#")) continue;
    value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const wildcard = value.startsWith("*.");
    value = value.replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "");
    if (value) list.push({ suffix: value, wildcard });
  }
  return function matches(targetHost) {
    const host = normalizeHost(targetHost);
    if (!host) return false;
    return list.some(({ suffix, wildcard }) =>
      wildcard ? host.endsWith(`.${suffix}`) : host === suffix || host.endsWith(`.${suffix}`),
    );
  };
}

/** 拆分 `host:port`、`[::1]:port`；裸 IPv6 视为 host。 */
export function splitHostPort(value, fallbackPort = 443) {
  const raw = String(value ?? "").trim();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end !== -1) {
      const host = normalizeHost(raw.slice(1, end));
      const rest = raw.slice(end + 1);
      const port = rest.startsWith(":") ? Number.parseInt(rest.slice(1), 10) : fallbackPort;
      return { host, port: validPort(port, fallbackPort) };
    }
  }
  const first = raw.indexOf(":");
  const last = raw.lastIndexOf(":");
  if (first === -1 || first !== last) {
    // 没有端口，或裸 IPv6 地址（多个冒号）
    return { host: normalizeHost(raw), port: fallbackPort };
  }
  const host = raw.slice(0, last);
  const port = Number.parseInt(raw.slice(last + 1), 10);
  return { host: normalizeHost(host), port: validPort(port, fallbackPort) };
}

function validPort(port, fallback) {
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : fallback;
}

/** 解析上游代理地址，支持 http://user:pass@host:port 或单独的 auth 字符串。 */
export function parseUpstream(upstream, upstreamAuth) {
  const raw = String(upstream ?? "").trim() || "http://127.0.0.1:7890";
  const withScheme = raw.includes("://") ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`上游代理地址不合法: ${raw}`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`只支持 http:// 协议的上游代理，收到: ${url.protocol}`);
  }
  const host = normalizeHost(url.hostname);
  const port = validPort(Number(url.port || 80), 80);

  let authHeader;
  if (url.username) {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password || "");
    authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  } else if (upstreamAuth) {
    const text = String(upstreamAuth).trim();
    if (text) {
      const token = text.includes(":") ? text : `${text}:`;
      authHeader = `Basic ${Buffer.from(token).toString("base64")}`;
    }
  }

  return { host, port, authHeader, display: `${host}:${port}` };
}

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function filterHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

/**
 * 创建选择性代理实例。
 *
 * @param {object} options
 * @param {number} [options.port] 监听端口，默认 17890
 * @param {string} [options.listenHost] 监听地址，默认 127.0.0.1
 * @param {string} [options.upstream] 形如 http://127.0.0.1:7890
 * @param {string} [options.upstreamAuth] 上游认证 "user:pass"
 * @param {string[]} [options.patterns] 走代理的域名后缀
 * @param {boolean} [options.enabled] false 时全部直连（仍监听端口）
 * @param {(level: string, message: string) => void} [options.log]
 */
export function createSelectiveProxy(options = {}) {
  const requestedPort = Number(options.port ?? 17890);
  // 0 表示让系统分配一个空闲端口（测试用）；其余非法值回落到 17890。
  const port =
    Number.isFinite(requestedPort) && requestedPort >= 0 && requestedPort < 65536
      ? requestedPort
      : 17890;
  const listenHost = options.listenHost ?? "127.0.0.1";
  const enabled = options.enabled !== false;
  const matchesProxy = makeMatcher(options.patterns ?? DEFAULT_PATTERNS);
  const log = options.log ?? (() => {});
  const upstream = parseUpstream(options.upstream, options.upstreamAuth);

  const stats = { direct: 0, proxied: 0, failed: 0, rejected: 0 };
  const sockets = new Set();
  let listening = false;

  function reject(socket, status, reason) {
    stats.rejected += 1;
    if (socket.writable) {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    }
    socket.destroy();
  }

  function tunnelDirect(clientSocket, host, targetPort) {
    const remote = net.connect({ host, port: targetPort });
    remote.setNoDelay(true);
    const timer = setTimeout(() => {
      log("debug", `直连 ${host}:${targetPort} 超时`);
      remote.destroy(new Error("connect timeout"));
    }, 15000);
    timer.unref?.();

    remote.once("connect", () => {
      clearTimeout(timer);
      stats.direct += 1;
      log("debug", `直连 ${host}:${targetPort}`);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      clientSocket.pipe(remote);
      remote.pipe(clientSocket);
    });

    const fail = (error) => {
      clearTimeout(timer);
      stats.failed += 1;
      log("debug", `直连失败 ${host}:${targetPort} ${error?.message ?? ""}`);
      reject(clientSocket, "502", "Bad Gateway");
      remote.destroy();
    };
    remote.once("error", fail);
    clientSocket.once("error", () => remote.destroy());
    clientSocket.once("close", () => remote.destroy());
  }

  function tunnelViaUpstream(clientSocket, host, targetPort) {
    const remote = net.connect({ host: upstream.host, port: upstream.port });
    remote.setNoDelay(true);
    const timer = setTimeout(() => {
      log("debug", `上游不可达 ${upstream.display}`);
      remote.destroy(new Error("upstream timeout"));
    }, 15000);
    timer.unref?.();

    remote.once("connect", () => {
      const auth = upstream.authHeader ? `Proxy-Authorization: ${upstream.authHeader}\r\n` : "";
      remote.write(
        `CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\nProxy-Connection: keep-alive\r\n${auth}\r\n`,
      );
    });

    let handshake = "";
    const onData = (chunk) => {
      handshake += chunk.toString("latin1");
      const end = handshake.indexOf("\r\n\r\n");
      if (end === -1) {
        if (handshake.length > 16384) {
          clearTimeout(timer);
          remote.destroy(new Error("handshake too large"));
        }
        return;
      }
      remote.off("data", onData);
      clearTimeout(timer);
      const statusLine = handshake.slice(0, handshake.indexOf("\r\n"));
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        stats.failed += 1;
        log("debug", `上游拒绝 ${host}:${targetPort} -> ${statusLine}`);
        reject(clientSocket, "502", "Bad Gateway");
        remote.destroy();
        return;
      }
      stats.proxied += 1;
      log("debug", `代理 ${host}:${targetPort}`);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = handshake.slice(end + 4);
      if (rest.length > 0) clientSocket.write(rest, "latin1");
      clientSocket.pipe(remote);
      remote.pipe(clientSocket);
    };

    remote.on("data", onData);
    remote.once("error", (error) => {
      clearTimeout(timer);
      stats.failed += 1;
      log("debug", `上游不可达 ${upstream.display} ${error?.message ?? ""}`);
      reject(clientSocket, "502", "Bad Gateway");
    });
    clientSocket.once("error", () => remote.destroy());
    clientSocket.once("close", () => remote.destroy());
  }

  const server = http.createServer((req, res) => {
    // 明文 HTTP：req.url 为 absolute-form（http://host/path）
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end("dsh-smart-proxy: 需要绝对 URL 的代理请求");
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(400).end("dsh-smart-proxy: 仅支持 http 明文代理，请使用 CONNECT");
      return;
    }

    const targetHost = normalizeHost(target.hostname);
    const viaProxy = enabled && matchesProxy(targetHost);
    const headers = filterHeaders(req.headers);
    headers.host = target.host;

    const requestOptions = viaProxy
      ? {
          host: upstream.host,
          port: upstream.port,
          method: req.method,
          path: target.toString(),
          headers: {
            ...headers,
            ...(upstream.authHeader ? { "proxy-authorization": upstream.authHeader } : {}),
          },
        }
      : {
          host: targetHost,
          port: validPort(Number(target.port || 80), 80),
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers,
        };

    const upstreamReq = http.request(requestOptions, (upstreamRes) => {
      if (viaProxy) stats.proxied += 1;
      else stats.direct += 1;
      res.writeHead(upstreamRes.statusCode ?? 502, filterHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstreamReq.setTimeout(30000, () => upstreamReq.destroy(new Error("request timeout")));
    upstreamReq.on("error", (error) => {
      stats.failed += 1;
      log("debug", `http ${targetHost} 失败 ${error?.message ?? ""}`);
      if (!res.headersSent) res.writeHead(502);
      res.end("dsh-smart-proxy: 上游请求失败");
    });
    req.pipe(upstreamReq);
  });

  server.on("connect", (req, clientSocket, head) => {
    clientSocket.on("error", () => {});
    const { host, port: targetPort } = splitHostPort(req.url, 443);
    if (!host) {
      reject(clientSocket, "400", "Bad Request");
      return;
    }
    if (head?.length) clientSocket.unshift(head);
    if (enabled && matchesProxy(host)) tunnelViaUpstream(clientSocket, host, targetPort);
    else tunnelDirect(clientSocket, host, targetPort);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  async function listen() {
    if (listening) {
      return { host: listenHost, port: server.address()?.port ?? port };
    }
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await new Promise((resolve, rejectPromise) => {
          const onError = (error) => {
            server.off("listening", onListening);
            rejectPromise(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, listenHost);
        });
        listening = true;
        return { host: listenHost, port: server.address()?.port ?? port };
      } catch (error) {
        lastError = error;
        if (error?.code !== "EADDRINUSE" || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError ?? new Error("监听失败");
  }

  function close() {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (!listening) return Promise.resolve();
    listening = false;
    return new Promise((resolve) => server.close(() => resolve()));
  }

  function checkUpstream(timeoutMs = 1500) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: upstream.host, port: upstream.port });
      let settled = false;
      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ ok, error: error ? String(error.message ?? error) : undefined });
      };
      socket.setTimeout(timeoutMs, () => finish(false, new Error("timeout")));
      socket.once("connect", () => finish(true));
      socket.once("error", (error) => finish(false, error));
    });
  }

  return {
    server,
    stats,
    matchesProxy,
    upstream,
    get enabled() {
      return enabled;
    },
    get port() {
      return server.address()?.port ?? port;
    },
    get listening() {
      return listening;
    },
    listen,
    close,
    checkUpstream,
  };
}

// 允许作为独立进程运行：node lib/proxy.js
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const proxy = createSelectiveProxy({
    port: Number(process.env.SMART_PROXY_PORT ?? 17890),
    listenHost: process.env.SMART_PROXY_HOST ?? "127.0.0.1",
    upstream: process.env.SMART_PROXY_UPSTREAM ?? "http://127.0.0.1:7890",
    upstreamAuth: process.env.SMART_PROXY_AUTH,
    patterns: process.env.SMART_PROXY_PATTERNS
      ? process.env.SMART_PROXY_PATTERNS.split(",")
      : undefined,
    log: (level, message) => console.log(`[${level}] ${message}`),
  });
  const address = await proxy.listen();
  console.log(`dsh-smart-proxy listening on http://${address.host}:${address.port}`);
  console.log(`upstream = http://${proxy.upstream.display}`);
  const shutdown = async () => {
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
