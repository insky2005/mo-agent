# P1 语音命令任务书（状态查询 / 暂停继续 / 切换会话）

- 基线：HEAD 9cfe758，版本 0.2.0，npm test 92 项通过，工作树干净
- 本轮不涨版本号，仍用 0.2.0
- 不引入唤醒词，不做常开麦克风
- 不破坏现有审批与语音测试

## 先读

- docs/adr/adr-0001-observational-first.md
- docs/adr/adr-0002-hands-free-voice.md
- docs/cleanup-plan.md
- host/voice/channel.mjs、confirm.mjs、text.mjs、io.mjs、helper-client.mjs
- host/index.mjs、host/http.mjs
- desktop/src/bun/index.ts

## 0. 先确认三个定义（不要直接写代码）

### 0.1 P1 怎么触发

现在语音只在审批卡点时听。状态查询是用户主动发起，但还没有唤醒词（P3）。

推荐：

- 托盘「语音」子菜单新增「语音命令」；
- 点击后进入一次监听，说一条命令；
- 这是 click-to-talk，不是免手唤醒；
- 唤醒词、常开监听留到 P3。

### 0.2 “暂停 / 继续”暂停什么

ADR-0001 是观察优先，host 不控制 Agent 进程。

不要用 SIGSTOP/SIGCONT 暂停 Claude Code / DSH。

推荐 P1 语义：

- 暂停/恢复「语音播报与语音提醒」；
- 默认 15 分钟，可配置；
- 审批仍进入 pending，手机/终端仍可处理；
- 只是不再用语音念、不再用语音接审批；
- 状态查询要能报告当前是否静音。

如果用户要的是“暂停 Agent 执行”，那是另一个任务，需要 adapter 能力声明。

### 0.3 “切换会话”切换什么

host 没有前台窗口，不能真的把某个 Agent 提到前台。

推荐 P1 语义：

- 设置“当前关注会话”（voiceTargetSessionId）；
- 后续状态查询围绕它汇报；
- P2 口述任务默认发给它；
- 不改变审批归属，审批仍是逐请求的。

如果用户没有另行说明，按以上推荐实现，并在文档写清边界。

## 1. 命令范围

| 命令 | 示例 | 副作用 | 确认 |
|---|---|---|---|
| 状态查询 | 汇报状态 / 现在怎么样 / 几个会话 | 无 | 不需要 |
| 暂停 | 暂停 / 停一下 / 静音 | 静音 15 分钟 | 需要回读确认 |
| 继续 | 继续 / 恢复 | 取消静音 | 需要回读确认 |
| 切换会话 | 切到第 2 个 / 切换到登录页 | 设置当前关注会话 | 需要回读确认 |
| 帮助 | 你能做什么 | 无 | 不需要 |

未知、低置信度、歧义：不执行任何动作，只提示没听懂。

## 2. 实现建议

### 2.1 抽取“听一次”

从 host/voice/confirm.mjs 抽出 listenOnce：

- 只负责：开麦、VAD、ASR、返回 text/confidence；
- runVoiceConfirm 和命令流程共用；
- 不要复制录音逻辑；
- 保持审批流程原有口令、次数、结束语义不变。

### 2.2 新增 host/voice/commands.mjs

导出：

- parseCommand(text) -> { intent, sessionHint }
- intent: status | pause | resume | switch | help | unknown

匹配建议：

- status: 汇报状态、现在怎么样、什么情况、几个会话
- pause: 暂停、停一下、静音
- resume: 继续、恢复
- switch: 切到第 N 个、切换到 X
- help: 帮助、能做什么

注意优先级：先 switch，再 pause/resume，最后 status；不要用过度宽泛的单字匹配。

新增 commands.test.mjs，覆盖：

- 常见说法
- 数字序号
- 标题片段
- 未知/歧义
- 不会被“暂停一下看看状态”误判

### 2.3 host 侧命令执行器

在 host/index.mjs 里维护：

- voiceTargetSessionId
- voiceMutedUntil

status：

- hub.list() 统计运行中/等待；
- broker.list() 统计待授权；
- 当前关注会话标题；
- 是否静音；
- 生成一句可播报的摘要。

pause / resume：

- 设置/清除 voiceMutedUntil；
- 静音时：
  - broker 的 isClientConnected 不再把语音算作在线；
  - onPending 跳过语音；
  - notifier 的语音通道跳过播报；
- 审批仍然 pending，手机/终端可处理。

switch：

- 按 hub.list() 的活跃会话排序，1-based 序号；
- 或按标题片段匹配；
- 多个候选时列出来，不猜；
- 找不到时给出候选，不切换。

### 2.4 触发入口

host/http.mjs 新增：

    POST /local/voice-command

- 本机 token 校验；
- 一次请求 = 提示音/提示语 + 听一次 + 解析 + 执行 + 返回 JSON；
- 返回 { ok, intent, heard, reply }。

desktop 托盘「语音」子菜单新增「语音命令」：

- 点击后 POST；
- 用 showMessageBox 显示 reply；
- 和「语音测试」并列，不要混淆。

### 2.5 确认流程

- status / help：直接播报结果，不确认；
- pause / resume / switch：
  - TTS 回读将要执行的动作；
  - 听一次“确认/取消”；
  - 只有明确确认才执行；
  - 不使用数字口令，口令只留给审批。

### 2.6 日志

host.log 每次命令输出：

    语音命令: 文本=「汇报状态」 intent=status 结果=...
    语音命令: 文本=「暂停」 intent=pause 结果=muted 15min

未知/低置信度也要记录。

## 3. 验收

- 托盘「语音」菜单出现「语音命令」；
- 说“汇报状态”能听到并看到正确计数；
- 说“暂停”后 critical 通知不再语音播报，说“继续”恢复；
- 静音期间审批仍进 pending，手机/终端可用；
- 说“切到第 2 个”后，状态查询围绕第 2 个会话汇报；
- 找不到/歧义时给候选，不误切；
- 所有命令写 host.log；
- npm test、npm run check 通过；
- ./scripts/build-desktop.sh 通过，codesign 校验通过。

## 4. 不做

- 唤醒词、常开麦克风
- SIGSTOP/SIGCONT 控制 Agent
- 真正的前台窗口切换
- P2 口述任务
- Windows/Linux

## 5. 提交

    feat(voice): P1 语音命令（状态/暂停/切换）

不要顺手改版本号；需要刷新壳缓存用 ./scripts/install-desktop.sh。
重建 helper 后麦克风权限可能重置，提醒用户重新授权。
