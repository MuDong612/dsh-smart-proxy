/**
 * dsh-smart-proxy 插件入口。
 *
 * 在 DSH 宿主进程里起一个选择性代理：白名单域名走上游代理，其余一律直连。
 *
 * `Config` 的每个字段都标记为 `.volatile()`：这是 DSH 设置页生成表单的前提，
 * 也让修改立即生效而不用重启插件。代理在每次连接时读取最新值；端口 / 监听
 * 地址 / `.env` 同步这类需要重新绑定的改动由下面的轮询负责落盘并提示重启。
 */
import z from "@deepseek-ai/schemastery";
import { createSelectiveProxy, DEFAULT_PATTERNS } from "./proxy.js";
import {
  readEnvProxy,
  removeHarnessEnv,
  resolveHarnessHome,
  syncHarnessEnv,
} from "./env.js";

export const name = "dsh-smart-proxy";

/** 不依赖任何宿主服务，纯后台守护。 */
export const inject = [];

/** 兼容旧版 schemastery：没有 volatile() 时保持普通字段。 */
function volatile(schema) {
  const mark = schema.volatile;
  return typeof mark === "function" ? mark.call(schema) : schema;
}

export const Config = z.object({
  enabled: volatile(
    z
      .boolean()
      .default(true)
      .description("启用选择性代理。关闭后插件仍然监听端口，但所有域名都直连（不会影响 DSH 联网）。"),
  ),
  upstream: volatile(
    z
      .string()
      .default("http://127.0.0.1:7890")
      .description("上游代理地址，例如 Clash 的 http://127.0.0.1:7890；也支持 http://user:pass@host:port。"),
  ),
  upstreamAuth: volatile(
    z
      .string()
      .default("")
      .description("上游代理需要认证时填写 user:password；地址里已经带账号密码时留空。"),
  ),
  patterns: volatile(
    z
      .array(z.string())
      .default([...DEFAULT_PATTERNS])
      .description("走上游代理的域名后缀列表；其余域名一律直连。每行一个，例如 googleapis.com。"),
  ),
  port: volatile(
    z
      .number()
      .default(17890)
      .description("本地监听端口，必须与 ~/.dsh/.env 的 HTTP_PROXY 一致。插件会自动维护 .env；改端口后需重启 DSH。"),
  ),
  listenHost: volatile(
    z
      .string()
      .default("127.0.0.1")
      .description("本地监听地址。保持 127.0.0.1 可避免被局域网其他设备当作代理使用。"),
  ),
  syncEnv: volatile(
    z
      .boolean()
      .default(true)
      .description("自动维护 ~/.dsh/.env 里的 HTTP_PROXY / NO_PROXY。关闭后需要自己配置 .env。"),
  ),
  logConnections: volatile(
    z
      .boolean()
      .default(false)
      .description("把每次直连 / 走代理的域名写进 DSH 日志，排查问题时打开。"),
  ),
});

function validPort(value) {
  const port = Number(value ?? 17890);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : 17890;
}

/** 读取一次配置；volatile 字段是 `{ get() }` 盒子，普通字段直接取值。 */
function readConfig(config) {
  const get = (key, fallback) => {
    const value = config?.[key];
    if (value !== null && typeof value === "object" && typeof value.get === "function") {
      const resolved = value.get();
      return resolved === undefined ? fallback : resolved;
    }
    return value === undefined ? fallback : value;
  };

  const patterns = get("patterns", DEFAULT_PATTERNS);
  return {
    enabled: get("enabled", true) !== false,
    upstream: String(get("upstream", "http://127.0.0.1:7890") ?? "http://127.0.0.1:7890"),
    upstreamAuth: String(get("upstreamAuth", "") ?? ""),
    patterns:
      Array.isArray(patterns) && patterns.length > 0
        ? patterns.map((value) => String(value)).filter(Boolean)
        : [...DEFAULT_PATTERNS],
    port: validPort(get("port", 17890)),
    listenHost: String(get("listenHost", "127.0.0.1") ?? "127.0.0.1"),
    syncEnv: get("syncEnv", true) !== false,
    logConnections: get("logConnections", false) === true,
  };
}

export function apply(ctx, rawConfig = {}) {
  const logger = ctx.logger;
  const initial = readConfig(rawConfig);

  if (initial.syncEnv) {
    try {
      const result = syncHarnessEnv({ home: resolveHarnessHome(), port: initial.port });
      if (result.changed) {
        logger?.warn?.(
          `dsh-smart-proxy: 已更新 ${result.envPath}（备份：${result.backupPath ?? "首次创建，无备份"}）。` +
            `请重启一次 DSH，代理设置才会生效。`,
        );
      }
      const activeProxy = readEnvProxy({ home: resolveHarnessHome() });
      if (activeProxy && !activeProxy.includes(`:${initial.port}`)) {
        logger?.warn?.(
          `dsh-smart-proxy: 当前 .env 指向 ${activeProxy}，与插件端口 ${initial.port} 不一致；重启 DSH 后会修正。`,
        );
      }
    } catch (error) {
      logger?.warn?.(`dsh-smart-proxy: 同步 .env 失败：${error?.message ?? error}`);
    }
  }

  const proxy = createSelectiveProxy({
    port: initial.port,
    listenHost: initial.listenHost,
    resolve: () => {
      const current = readConfig(rawConfig);
      return {
        enabled: current.enabled,
        upstream: current.upstream,
        upstreamAuth: current.upstreamAuth,
        patterns: current.patterns,
      };
    },
    log: (level, message) => {
      if (level === "debug" && !readConfig(rawConfig).logConnections) return;
      if (level === "debug") logger?.debug?.(`dsh-smart-proxy: ${message}`);
      else logger?.[level]?.(`dsh-smart-proxy: ${message}`);
    },
  });

  ctx.effect(() => {
    let disposed = false;

    proxy
      .listen()
      .then(async (address) => {
        if (disposed) return;
        logger?.info?.(
          `dsh-smart-proxy: 已监听 http://${address.host}:${address.port}，` +
            `上游 ${proxy.upstream.display}，白名单 ${initial.patterns.length} 条，` +
            `${initial.enabled ? "选择性代理模式" : "全部直连模式（插件已关闭代理）"}`,
        );
        const health = await proxy.checkUpstream();
        if (disposed) return;
        if (health.ok) {
          logger?.info?.(`dsh-smart-proxy: 上游代理 ${proxy.upstream.display} 可达。`);
        } else {
          logger?.warn?.(
            `dsh-smart-proxy: 上游代理 ${proxy.upstream.display} 当前不可达（${health.error ?? "未知原因"}）。` +
              `只有白名单域名会受影响，其余域名照常直连。`,
          );
        }
      })
      .catch((error) => {
        if (disposed) return;
        if (error?.code === "EADDRINUSE") {
          logger?.warn?.(
            `dsh-smart-proxy: 端口 ${initial.port} 已被占用，本次没有启动代理。` +
              `请关闭占用该端口的程序，或在插件设置里换一个端口后重启 DSH。`,
          );
        } else {
          logger?.warn?.(`dsh-smart-proxy: 启动代理失败：${error?.message ?? error}`);
        }
      });

    return () => {
      disposed = true;
      void proxy.close();
    };
  }, "dsh-smart-proxy: selective proxy server");

  // Volatile fields update in place. Observe the ones that need a side effect
  // (rebinding or rewriting .env); the routing fields are read per connection.
  ctx.effect(() => {
    let lastPort = initial.port;
    let lastHost = initial.listenHost;
    let lastSyncEnv = initial.syncEnv;
    const timer = setInterval(() => {
      const current = readConfig(rawConfig);
      const portChanged = current.port !== lastPort;
      const hostChanged = current.listenHost !== lastHost;
      const syncChanged = current.syncEnv !== lastSyncEnv;
      if (!portChanged && !hostChanged && !syncChanged) return;
      lastPort = current.port;
      lastHost = current.listenHost;
      lastSyncEnv = current.syncEnv;

      try {
        if (current.syncEnv) {
          const result = syncHarnessEnv({ home: resolveHarnessHome(), port: current.port });
          if (result.changed) {
            logger?.warn?.(
              `dsh-smart-proxy: 已把 .env 更新为 http://127.0.0.1:${current.port}；重启 DSH 后生效。`,
            );
          }
        } else if (syncChanged) {
          const result = removeHarnessEnv({ home: resolveHarnessHome() });
          if (result.changed) {
            logger?.warn?.("dsh-smart-proxy: 已移除 .env 中的代理配置；重启 DSH 后恢复直连。");
          }
        }
      } catch (error) {
        logger?.warn?.(`dsh-smart-proxy: 更新 .env 失败：${error?.message ?? error}`);
      }

      if (portChanged || hostChanged) {
        logger?.warn?.(
          `dsh-smart-proxy: 监听地址已改为 ${current.listenHost}:${current.port}，` +
            `但当前进程仍监听 ${initial.listenHost}:${initial.port}；重启 DSH 后生效。`,
        );
      }
    }, 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, "dsh-smart-proxy: config watcher");
}
