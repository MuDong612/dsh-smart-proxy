/**
 * 维护 DeepSeek Harness 的 ~/.dsh/.env。
 *
 * DSH 只会在进程启动时读取这个文件，所以插件运行期间写进去的值要等下一次
 * 重启 DSH 才生效。插件只管理自己的代理块（marker 之间），不会删除用户
 * 的其他变量（例如 GEMINI_API_KEY）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BLOCK_START = "# >>> dsh-smart-proxy managed block >>>";
export const BLOCK_END = "# <<< dsh-smart-proxy managed block <<<";

/** 这些国内域名永远直连，避免插件意外退出时连不上国内 API。 */
export const DOMESTIC_NO_PROXY = Object.freeze([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "deepseek.com",
  "deepseeksvc.com",
  "volces.com",
  "volcengine.com",
  "aliyuncs.com",
  "aliyun.com",
  "bigmodel.cn",
  "zhipuai.cn",
  "moonshot.cn",
  "kimi.com",
  "siliconflow.cn",
  "siliconflow.com",
  "minimaxi.com",
  "minimax.io",
  "baichuan-ai.com",
  "tencentcloudapi.com",
  "baidubce.com",
  "xfyun.cn",
  "01.ai",
  "modelscope.cn",
]);

/** `~/.dsh`，或 DSH_HOME 指定的目录。 */
export function resolveHarnessHome() {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
}

function splitList(value) {
  return String(value ?? "")
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueCaseInsensitive(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function buildBlock({ port, noProxy }) {
  const url = `http://127.0.0.1:${port}`;
  return [
    BLOCK_START,
    "# 由 dsh-smart-proxy 自动生成；要改代理请改插件配置，不要手改这一段。",
    `HTTP_PROXY=${url}`,
    `HTTPS_PROXY=${url}`,
    `ALL_PROXY=${url}`,
    "NODE_USE_ENV_PROXY=1",
    `NO_PROXY=${noProxy.join(",")}`,
    BLOCK_END,
  ].join("\n");
}

/**
 * 去掉托管块和代理变量，保留其余行，并收集所有 NO_PROXY 条目。
 * @returns {{ kept: string[], noProxy: string[], newline: string }}
 */
function stripManaged(content) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const kept = [];
  const noProxy = [];
  let inBlock = false;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === BLOCK_START) {
      inBlock = true;
      continue;
    }
    if (trimmed === BLOCK_END) {
      inBlock = false;
      continue;
    }

    // 托管块里的 NO_PROXY 也要收集，否则第二次同步会把用户自定义条目丢掉。
    const noProxyMatch = line.match(/^\s*(?:export\s+)?NO_PROXY\s*=\s*(.*)$/i);
    if (noProxyMatch) {
      noProxy.push(...splitList(noProxyMatch[1]));
      continue;
    }
    if (inBlock) continue;

    if (/^\s*(?:export\s+)?(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY)\s*=/i.test(line)) {
      continue;
    }
    kept.push(line);
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return { kept, noProxy, newline };
}

function readEnv(envPath) {
  try {
    return { content: fs.readFileSync(envPath, "utf8"), existed: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { content: "", existed: false };
    throw error;
  }
}

function writeEnv(envPath, content, backupPath) {
  if (backupPath) {
    try {
      fs.copyFileSync(envPath, backupPath);
    } catch {
      // 备份失败不阻塞主流程
    }
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const tempPath = `${envPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  try {
    fs.renameSync(tempPath, envPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    fs.writeFileSync(envPath, content, { mode: 0o600 });
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
  }
}

/**
 * 把插件所需的代理配置同步进 `.env`。
 *
 * @param {object} [options]
 * @param {string} [options.home] Harness home，默认 resolveHarnessHome()
 * @param {number} [options.port] 本地监听端口
 * @returns {{ envPath: string, backupPath: string | null, changed: boolean, noProxy: string[] }}
 */
export function syncHarnessEnv(options = {}) {
  const home = options.home ?? resolveHarnessHome();
  const port = Number(options.port ?? 17890);
  const envPath = path.join(home, ".env");
  const backupPath = `${envPath}.bak-dsh-smart-proxy`;
  const { content: original, existed } = readEnv(envPath);

  const { kept, noProxy: collectedNoProxy, newline } = stripManaged(original);
  const noProxy = uniqueCaseInsensitive([...collectedNoProxy, ...DOMESTIC_NO_PROXY]);
  const block = buildBlock({ port, noProxy });
  const content = `${kept.join(newline)}${kept.length > 0 ? newline + newline : ""}${block}${newline}`;

  if (existed && content === original) {
    return {
      envPath,
      backupPath: fs.existsSync(backupPath) ? backupPath : null,
      changed: false,
      noProxy,
    };
  }

  if (!existed) {
    writeEnv(envPath, content, null);
    return { envPath, backupPath: null, changed: true, noProxy };
  }

  writeEnv(envPath, content, backupPath);
  return { envPath, backupPath, changed: true, noProxy };
}

/**
 * 卸载插件时调用：删掉托管块和代理变量，让 DSH 回到直连。
 * 会先把当前 `.env` 备份到 `.env.bak-dsh-smart-proxy-removed`。
 */
export function removeHarnessEnv(options = {}) {
  const home = options.home ?? resolveHarnessHome();
  const envPath = path.join(home, ".env");
  const backupPath = `${envPath}.bak-dsh-smart-proxy-removed`;
  const { content: original, existed } = readEnv(envPath);
  if (!existed) return { envPath, backupPath: null, changed: false };

  const { kept, newline } = stripManaged(original);
  const content = kept.length > 0 ? `${kept.join(newline)}${newline}` : "";
  if (content === original) return { envPath, backupPath: null, changed: false };

  writeEnv(envPath, content, backupPath);
  return { envPath, backupPath, changed: true };
}

/** 读取当前 `.env` 里的 HTTP_PROXY，用于诊断（不修改文件）。 */
export function readEnvProxy(options = {}) {
  const home = options.home ?? resolveHarnessHome();
  const envPath = path.join(home, ".env");
  try {
    const content = fs.readFileSync(envPath, "utf8");
    const match = content.match(/^\s*(?:export\s+)?HTTPS?_PROXY\s*=\s*(\S+)\s*$/im);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
