#!/usr/bin/env node
/**
 * 卸载 dsh-smart-proxy 后运行：把 ~/.dsh/.env 里的代理配置清掉，让 DSH 回到直连。
 *   node scripts/restore-env.mjs
 */
import { removeHarnessEnv } from "../lib/env.js";

const result = removeHarnessEnv();
if (!result.changed) {
  console.log(`无需修改：${result.envPath} 里没有 dsh-smart-proxy 的配置。`);
} else {
  console.log(`已清除代理配置：${result.envPath}`);
  console.log(`备份：${result.backupPath}`);
  console.log("请重启 DSH 让修改生效。");
}
