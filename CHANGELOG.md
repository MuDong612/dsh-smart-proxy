# Changelog

## 0.3.0

- 新增 Client 半边：在 DSH **插件页 → dsh-smart-proxy → smart-proxy → 配置** 提供可视化表单。
- 表单覆盖全部配置项：启用开关、上游地址、上游认证、域名白名单（每行一个）、端口、监听地址、`.env` 同步、连接日志。
- 保存时按字段生成原子 mutation；端口变化会提示需要重启 DSH。
- 修复 0.2.0 只有 Host 配置 schema、Plugins 页没有配置入口的问题。

## 0.2.0

首个公开版本。

- 选择性代理核心：CONNECT 隧道 + 明文 HTTP absolute-form。
- 域名后缀匹配，支持 `*.example.com`。
- 默认白名单覆盖 Google / Gemini、OpenAI、Anthropic。
- 自动维护 `~/.dsh/.env`（标记块 + 备份 + 保留其他变量），自动并入国内直连域名。
- 启动时探测上游可用性并写入日志。
- 支持上游代理认证。
- 端口占用、上游不可用都不会让 DSH 崩溃。
- `Config` 可视化配置：启用开关、上游地址、认证、域名列表、端口、监听地址、`.env` 同步、连接日志。
- 单元测试覆盖匹配、分流、上游失败与 `.env` 同步。
