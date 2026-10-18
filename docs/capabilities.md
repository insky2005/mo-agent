# Agent 能力表

由 `scripts/gen-capabilities.mjs` 从 `adapters/profiles/*.json` 生成，勿手改。

| Agent | 名称 | 观测 | runEnd | 注意 | 批准 | 控制 | 数据源 | 模块 |
|---|---|---|---|---|---|---|---|---|
| `claude-code` | Claude Code | `process`, `transcript` | `explicit` | `hook` | `allow` | — | `jsonl-transcript` | `./claude-code.mjs` |
| `dsh` | DeepSeek Harness | `process`, `native-api` | `inferred` | `native` | `allow` | `prompt`, `cancel` | `native-api` | `./dsh-monitor.mjs` |
