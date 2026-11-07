/**
 * dsh-smart-proxy 插件入口。
 *
 * 在 DSH 宿主进程里起一个选择性代理：白名单域名走上游代理，其余一律直连。
 * 宿主会根据下面的 `Config` 自动生成插件设置页，并负责持久化修改。
 */
import z from "@deepseek-ai/schemastery";
import { createSelectiveProxy, DEFAULT_PATTERNS } from "./proxy.js";
import { readEnvProxy, resolveHarnessHome, syncHarnessEnv } from "./env.js";

export const name = "dsh-smart-proxy";

/** 不依赖任何宿主服务，纯后台守护。 */
export const inject = [];

export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description("启用选择性代理。关闭后插件仍然监听端口，但所有域名都直连（不会影响 DSH 联网）。"),
  upstream: z
    .string()
    .default("http://127.0.0.1:7890")
    .description("上游代理地址，例如 Clash 的 http://127.0.0.1:7890；也支持 http://user:pass@host:port。"),
  upstreamAuth: z
    .string()
    .default("")
    .description("上游代理需要认证时填写 user:password；地址里已经带账号密码时留空。"),
  patterns: z
    .array(z.string())
    .default(DEFAULT_PATTERNS)
    .description("走上游代理的域名后缀列表；其余域名一律直连。每行一个，例如 googleapis.com。"),
  port: z
    .number()
    .default(17890)
    .description("本地监听端口，必须与 ~/.dsh/.env 的 HTTP_PROXY 一致。插件会自动维护 .env；改端口后需重启 DSH。"),
  listenHost: z
    .string()
    .default("127.0.0.1")
    .description("本地监听地址。保持 127.0.0.1 可避免被局域网其他设备当作代理使用。"),
  syncEnv: z
    .boolean()
    .default(true)
    .description("自动维护 ~/.dsh/.env 里的 HTTP_PROXY / NO_PROXY。关闭后需要自己配置 .env。"),
  logConnections: z
    .boolean()
    .default(false)
    .description("把每次直连 / 走代理的域名写进 DSH 日志，排查问题时打开。"),
});

function normalizeConfig(config = {}) {
  const patterns =
    Array.isArray(config.patterns) && config.patterns.length > 0
      ? config.patterns.map((value) => String(value)).filter(Boolean)
      : [...DEFAULT_PATTERNS];
  const port = Number(config.port ?? 17890);
  return {
    enabled: config.enabled !== false,
    upstream: String(config.upstream ?? "http://127.0.0.1:7890").trim() || "http://127.0.0.1:7890",
    upstreamAuth: String(config.upstreamAuth ?? "").trim(),
    patterns,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 17890,
    listenHost: String(config.listenHost ?? "127.0.0.1").trim() || "127.0.0.1",
    syncEnv: config.syncEnv !== false,
    logConnections: config.logConnections === true,
  };
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;

  if (config.syncEnv) {
    try {
      const result = syncHarnessEnv({ home: resolveHarnessHome(), port: config.port });
      if (result.changed) {
        logger?.warn?.(
          `dsh-smart-proxy: 已更新 ${result.envPath}（备份：${result.backupPath ?? "首次创建，无备份"}）。` +
            `请重启一次 DSH，代理设置才会生效。`,
        );
      }
      const activeProxy = readEnvProxy({ home: resolveHarnessHome() });
      if (activeProxy && !activeProxy.includes(`:${config.port}`)) {
        logger?.warn?.(
          `dsh-smart-proxy: 当前 .env 指向 ${activeProxy}，与插件端口 ${config.port} 不一致；重启 DSH 后会修正。`,
        );
      }
    } catch (error) {
      logger?.warn?.(`dsh-smart-proxy: 同步 .env 失败：${error?.message ?? error}`);
    }
  }

  const proxy = createSelectiveProxy({
    port: config.port,
    listenHost: config.listenHost,
    upstream: config.upstream,
    upstreamAuth: config.upstreamAuth,
    patterns: config.patterns,
    enabled: config.enabled,
    log: (level, message) => {
      if (level === "debug" && !config.logConnections) return;
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
            `上游 ${proxy.upstream.display}，白名单 ${config.patterns.length} 条，` +
            `${config.enabled ? "选择性代理模式" : "全部直连模式（插件已关闭代理）"}`,
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
            `dsh-smart-proxy: 端口 ${config.port} 已被占用，本次没有启动代理。` +
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
}
