# 使用

一句话：**你把想法写成卡，派给任意 Agent，等它交回执，`mo` 按你定的标准验收，全过程记账。**

```
想法 → 任务卡(draft) → 人批准 → 派单 → 回执 → 验收 → 账本
                    ↑ 手机/终端
```

---

## 1. 第一次用

```bash
mo setup          # 幂等：目录、配置、记忆骨架、默认执行者、技能、MCP
mo doctor         # 自检
```

`mo setup` 不会碰仓库（不建 `.mo-agent/`、不改 `AGENTS.md`），这些由 `mo project init` 做。

---

## 2. 认领一个项目

```bash
cd ~/code/my-project
mo project init          # 写 .mo-agent/project.json 与 AGENTS.md 里的说明段
```

`mo project list` 看已登记的项目，`mo project remove <名称>` 从本机登记表移除（`--purge` 才删仓库里的文件）。

---

## 3. 一张卡的一生

```bash
mo task create --title "给 CLI 加 daemon 命令" \
              --deliverable "cli/commands/daemon.mjs" \
              --verify "run:npm test" \
              --workdir .

mo task confirm <id>     # 发起确认请求（Agent 也能做，只写 approvals/，状态不变）
mo task approve <id>     # 人来批准（必须 TTY，会校验卡片指纹）
mo task dispatch <id>    # 派单，前台阻塞到回执 + 验收完成
mo task status <id>      # 状态、验收结果、待批请求
```

其它：`mo task list`、`mo task cancel <id>`、`mo task verify <id>`（对已 done 的卡重跑验收）、`mo task logs <id>`（执行者原始日志）。

### 验收项怎么写

| 写法 | 含义 |
|---|---|
| `run:npm test` | 跑命令，退出码 0 才算过 |
| `check:dist/index.html` | 检查产出物存在（也可写 `check:<路径> 存在`） |
| `check:<路径> 包含 <文本>` | 检查文件内容 |
| `human:看起来对不对` | 留给人判断 |

没有 `--verify` 会警告 `W_NO_VERIFY`——卡还是能建，但结论要自己看。

---

## 4. 常驻服务（daemon）

```bash
mo daemon start        # 后台起 host；顺手把 APK 下到 ~/.mo-agent/app.apk
mo daemon status       # 在不在跑、谁的进程、健康检查、访问地址
mo daemon open         # 打开监控屏（无地址栏的小窗口）
mo daemon stop         # 只停自己拉起的
```

`start` 是幂等的：已经有一个 host 在跑（比如桌面 App 开着）就只打印访问信息，不会再起第二个。

### 页面在哪

| 页面 | 地址 | 说明 |
|---|---|---|
| 监控屏 | `/monitor` | 所有会话的运行状态、最近一轮、待处理 |
| 设置 | `/settings?tab=app` | 安装与配对 |
| 钉钉 | `/settings?tab=dingtalk` | 机器人绑定 |
| Agent | `/settings?tab=agents` | 一键写 hook |
| 语音 | `/settings?tab=voice` | 语音命令与测试 |
| 系统 | `/settings?tab=system` | 重启、看日志 |

`mo daemon open` 后面跟 `app` / `dingtalk` / `agents` / `voice` / `system` / `monitor` 直接打开对应页；默认监控屏。

> `/monitor`、`/settings` 只允许本机 + 本机令牌访问，令牌在 `~/.mo-agent/session.json`。

---

## 5. 手机与远程批准

1. `mo daemon start`（或打开桌面 App）；
2. 打开设置页「安装与配对」，扫第一个码装 App；
3. 扫第二个码配对（一次性令牌，默认 5 分钟有效）。

配对后：Agent 请求授权时手机会亮；批准/拒绝/回答问题都在手机上完成。

没手机在线时，超时会把请求**交回本地终端**——不会卡死，也不会替你放行。

任务卡也能在手机上批：`mo task confirm <id>` 发出请求后，host 常驻时会推一条「有任务卡等你批准」，手机/网页的「需要你决定」里有两个选择：

- **允许并派单**：批准 + 立刻派出去，全流程不用回终端；
- **只允许**：只把卡推到 `confirmed`，稍后自己 `mo task dispatch <id>`（或 `--detach` 后台跑）。

卡片上会直接显示**交付物与验收项**，不用回终端看 `mo task status` 再决定。

> 派单失败（比如卡上没执行者、也没设默认执行者）不会回滚批准：批准已经落盘，错误原因会显示在手机上。
> 这两种选择都不改变"没有你的决定就不放行"——只是把批准之后那一步也搬到了同一个点击里。

---

## 6. 配置

```bash
mo config list            # 值 + 来源（默认 / config.json / 环境变量）
mo config set port 7789
mo config unset port
```

优先级：**默认值 < `~/.mo-agent/config.json` < 环境变量 < 命令行参数**（命令行只对 daemon 生效）。

---

## 7. 记忆

```bash
mo memory init             # 建骨架
mo memory propose --file - # 提一条候选（缺 trigger 会被拒收）
mo memory candidates       # 看待裁决的候选
mo memory accept <id>      # 采纳（冲突会拒写）
mo memory recall "关键词"   # 召回；派单时也会自动带上同一批
```

记忆目录默认 `~/.mo-agent/memory/`，`MO_AGENT_MEMORY` 可覆盖。

---

## 8. 接一个 Agent

```bash
mo agent describe            # 能做什么、三种接法
mo agent add --prompt        # 打印可粘贴的提示词
mo agent add --mcp mcp.json  # 合并 mcpServers 配置（幂等 + 备份）
mo skill install             # 给 Claude / Codex / Qoder 等装技能
mo mcp                       # stdio 服务，给支持 MCP 的 Agent
```

---

## 9. 协作与通知

```bash
mo inbox pull                # 拉任务通知（done / blocked / failed）
mo inbox pull --wait 60s     # 没有就等
mo ledger query --task <id>  # 一条任务的时间线
```

### 静音时段

`~/.mo-agent/notify.json` 里可以配一段不受打扰的时间（默认 22:30–08:00，新装才有）：

```json
{ "quietHours": { "start": "22:30", "end": "08:00", "allowCritical": true } }
```

静音时段只挡"不紧急"的通知（任务完成、取消这类 normal）；**授权请求、报错仍然是 critical，照常送达**——
半夜卡住的事不能等到早上。想连 critical 也一起静音，把 `allowCritical` 设成 `false`；
`"enabled": false` 直接关掉。老配置文件没有这一项时不会静音。

---

## 10. 排障

| 想看什么 | 命令 / 位置 |
|---|---|
| 环境是否正常 | `mo doctor` |
| daemon 是否在跑 | `mo daemon status` |
| host 日志 | `~/Library/Logs/mo-agent/host.log`（macOS） |
| daemon 启动失败 | `~/.mo-agent/daemon.log` |
| 任务执行日志 | `mo task logs <id>`、`.mo-agent/logs/<id>.log` |
| 账本 | `mo ledger query`、`~/.mo-agent/ledger/YYYY-MM.jsonl` |

---

## 命令速查

| 组 | 子命令 |
|---|---|
| `task` | create confirm approve reject requests dispatch **show** list cancel verify logs |
| `project` | **create** agent list remove |
| `memory` | init list recall path migrate propose candidates accept reject |
| `worker` | list add remove use current |
| `terminal` | list add remove use current |
| `serve` | start stop restart status open · `serve router …` |
| `skill` | list install uninstall |
| `connect` | describe add |
| `ledger` | query |
| `inbox` | pull |
| `config` | list get set unset |
| `setup` | `--dry-run` / `--only` / `--json` |
| `doctor` | 直接跑 |
| `internal` | mcp · receipt submit/apply · watchdog run · completion bash/zsh · memory-migrate · note-write |

**旧名字仍可用**：`task status` = `task show`、`project init`/`add` = `project create`、`daemon` = `serve`、`agent` = `connect`、`receipt`/`watchdog`/`completion` = `internal …`（后三者会打一行 `[deprecated]` 提示）。

每组细节：`mo help <组>`，例如 `mo help task`。

更完整的 CLI 参考见 [docs/guides/mo-cli.md](docs/guides/mo-cli.md)。
