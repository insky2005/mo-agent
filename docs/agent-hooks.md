# Agent hooks 配置管理

> 目标：把「手动合并 settings.snippet.json + 替换绝对路径」变成一次点击，并且随时能安全改回。
>
> 入口：菜单栏托盘「一键配置 Agent…」· 页面 `/agents` · 终端 `npm run hooks` / `npm run hooks:install` / `npm run hooks:qoder-cn`
> 实现：`host/agent-hooks.mjs`（宿主与 CLI 共用）· 测试：`host/agent-hooks.test.mjs`、`host/pair-http.test.mjs`
>
> 页面结构：单个列表列出所有**已启用**的 Agent。需要 hook 的 Agent 写清会写入哪些 hook、事件含义、
> 超时、配置文件路径、当前状态，并带「一键配置」按钮；原生接入的 Agent 只显示状态和接入方式，
> 不显示按钮与配置说明。未启用的档案不出现。

## 为什么需要它

远程批准依赖 Agent 的 hook 回调。以 Claude Code 为例，用户必须把两条 hook 合并进
`~/.claude/settings.json`，再把模板里的 `<ABSOLUTE_PATH>` 换成本机绝对路径。这一步：

- 容易写错路径（桌面版运行时目录还带空格）；
- 容易整体覆盖用户已有的 hooks / permissions；
- 升级或搬家后路径过期，表现为「hook 静默失效」；
- 想撤销时不知道该删哪一段。

配置管理把这些问题收进一份可测试的代码里。

## 写进去的是什么

对 `profile.hooks.kind` 在白名单里（目前 `claude-code`、`qoder-cn`）的 Agent，按 `profile.hooks.events` 写入：

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/绝对路径/approvals/hook-cli.mjs\" event PermissionRequest claude-code",
            "timeout": 600
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/绝对路径/approvals/hook-cli.mjs\" event Notification claude-code",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- 路径来自宿主启动时的 `root`：开发态是仓库目录，桌面分发态是
  `~/Library/Application Support/mo-agent/runtime`；
- 命令里的路径加双引号，`Application Support` 这类带空格的路径不会被拆开；
- 超时默认 `PermissionRequest: 600s`、`Notification: 10s`，可用
  `profile.hooks.timeouts[event]` 覆盖；
- 识别规则：命令里同时出现 `hook-cli.mjs` 与 `event <事件> <agent-id>`，才算 mo-agent 写的。
  所以路径变化后重装是「更新旧条目」，不会重复叠加；
- 一个 Agent 可以声明多个配置文件（`settingsFile` + `settingsFiles`），安装时每个都写一份、
  每个都先备份；**只要有一个文件不是合法 JSON，整次操作就中止**，不会出现只写了一半的情况；
- `approvals/` 会随桌面运行时一起打包（见 `scripts/build-desktop.sh`），
  因此分发版也能用一键配置；hook 用本机 `node` 执行（Claude Code 用户通常已装 Node）。
  如果 hook 入口不存在，配置管理会拒绝写入并提示重新构建，不会写出静默失效的配置。

## 安全边界

| 行为 | 处理 |
|---|---|
| 已有其它 hooks / permissions / model 等 | 原样保留，只动 mo-agent 自己的条目 |
| 已有 mo-agent 旧路径 | 先移除旧条目，再写入当前路径（幂等） |
| 配置文件不是合法 JSON | 拒绝写入，报错，绝不覆盖 |
| `hooks` 字段类型不对 / 事件不是数组 | 拒绝写入 |
| 每次真正改文件前 | 备份为 `settings.json.mo-agent.bak-<ISO 时间>`，权限 0600 |
| 没有变化 | 不写盘、不产生备份 |
| settings.json 是软链接（dotfiles） | 写穿到真实文件，链接本身保留 |
| 局域网 / 手机访问 `/agents` | 只读；POST 返回 403，页面按钮不渲染 |
| 卸载 | 只删 mo-agent 的 hook；空事件数组/空 hooks 一起清掉 |

备份文件不会被自动清理；确认配置稳定后可以手动删除旧的 `*.mo-agent.bak-*`。

## 支持的 Agent

| Agent | 状态 | 说明 |
|---|---|---|
| Claude Code | ✅ 一键配置 | `PermissionRequest` + `Notification` |
| Qoder CN（桌面端） | ✅ 一键配置 | 与 Claude Code 同格式；同时写 `~/.qoder-cn/settings.json` 与 `~/.qoder/settings.json` |
| DeepSeek Harness | — 无需配置 | 原生接入，不走 hooks |
| Codex CLI / Gemini CLI | ⏳ 暂不支持 | profile 已声明 `hooks.kind`，但厂商格式未验证，不猜 |

### Qoder CN 的两个注意点

1. **为什么要写两份 settings**：CN 版的运行时用户目录是 `~/.qoder-cn`（transcript、插件、settings 都在这里），
   但官方文档写的是 `~/.qoder/settings.json`。两处都写一份，避免版本/文档漂移导致 hook 静默不生效。
   状态页把两个路径都列出来；只装好其中一份时，状态显示「未配置」，再点一次会补齐。
2. **没有手机控制面**：Qoder CN 桌面端没有 prompt/cancel 的公开接口，
   所以手机上只做「看 + 批准/拒绝」，不显示发送/中断按钮（profile 里 `control: []`）。
   桌面端默认 `auto` 权限模式时很多操作由 AI 分类器自动放行，只有切到「询问审批」才会稳定出授权卡。

暂不支持的 Agent 不会报错退出：状态页显示「暂不支持一键配置」，批量配置时自动跳过。

## 终端用法

```bash
npm run hooks                                  # 查看状态
npm run hooks:install                          # 一键配置所有支持的 Agent
node scripts/configure-hooks.mjs --agent claude-code
npm run hooks:qoder-cn                         # 只配置 Qoder CN
node scripts/configure-hooks.mjs --all --dry-run   # 只预览，不写盘
node scripts/configure-hooks.mjs --all --uninstall
node scripts/configure-hooks.mjs --json        # 机器可读
```

宿主环境变量 `MO_AGENT_ROOT` 会改变写入的绝对路径；桌面分发时由壳自动设置。
在仓库里执行 CLI 时默认用仓库根目录。

## HTTP 接口（仅本机）

```
GET  /agents              配置管理页（非回环地址只读）
GET  /local/hooks         { ok, agents: [{id,label,supported,installed,outdated,events,...}] }
POST /local/hooks/apply   { agentId?: "all"|"claude-code", action?: "install"|"uninstall", dryRun?: boolean }
                          必须带请求头 x-mo-agent-hooks: 1
POST /setup/hooks/apply   设置页表单（application/x-www-form-urlencoded），303 回 /agents
                          必须带页面里的一次性 csrf 令牌
```

写接口都要求连接来自回环地址（`127.0.0.0/8` / `::1`）。API 的自定义头会触发浏览器预检，
表单则校验本进程生成的 csrf 令牌——这样即使用户在别的网站点了东西，也不能跨站改本机 hook 配置。
配置页本身公开只读，只有坐在电脑前的人能改。

## 新增一个可配置的 Agent

1. 在 `adapters/profiles/<id>.json` 里声明：
   ```json
   "hooks": {
     "kind": "<厂商格式>",
     "settingsFile": "~/.foo/settings.json",
     "settingsFiles": ["~/.foo-fallback/settings.json"],
     "events": { "BeforeTool": "approval.pending" }
   }
   ```
2. 在 `host/agent-hooks.mjs` 里为这个 `kind` 实现写入/识别规则
   （`MANAGED_KINDS`、安装时的 JSON 形状、`isManagedHook*` 的识别）；
3. 补测试：至少覆盖「首次安装 / 幂等 / 保留他人配置 / 卸载还原 / 坏 JSON 拒绝 / 路径更新」。

不要在没有实测的情况下把厂商格式加进白名单——写坏别人的 Agent 配置比不支持更糟。
