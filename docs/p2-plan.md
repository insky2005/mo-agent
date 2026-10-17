# P2 语音口述任务任务书

- 基线：HEAD d481c77，版本 0.2.0，npm test 151 项通过，工作树干净
- 本轮不涨版本号，仍用 0.2.0
- 不引入唤醒词，不做常开麦克风
- 不破坏 P1 语音命令、审批与现有测试
- 跑测试时使用 MO_AGENT_NOTIFY_DISABLE=1，避免测试 host 真的向手机推送

## 先读

- docs/adr/adr-0001-observational-first.md
- docs/adr/adr-0002-hands-free-voice.md
- docs/p1-plan.md
- docs/voice.md
- host/voice/text.mjs（buildDictationDraft、parseReply）
- host/voice/confirm.mjs（listenOnce、runVoiceConfirm 的 dictation 分支）
- host/voice/commands.mjs（P1 命令执行器、事件、目标会话）
- host/voice/channel.mjs（音频会话 open/close、listen）
- host/index.mjs、host/http.mjs
- app/web/voice-overlay.html
- desktop/src/bun/index.ts

## 0. 先确认四个定义（不要直接写代码）

### 0.1 怎么触发

托盘「语音」子菜单新增「语音口述任务」，与「语音命令」「语音测试」并列。

这是 click-to-talk：点一次、说一段、确认发送。不是唤醒词，不做常开麦克风。
一次点击 = 一次请求；失败后由用户重新点击，不在后台偷偷继续录。

### 0.2 发给哪个会话

host 没有前台窗口。沿用 P1 的「当前关注会话」（voiceTargetSessionId）。

推荐规则：

1. 有当前关注会话且在线：直接作为目标，回读目标标题；
2. 没有关注会话：如果恰好只有 1 个活跃会话，自动选它，并在回读里明确说「发给 X」；
3. 没有关注会话且有多个/零个活跃会话：不发送，列出候选，提示先说「切到第几个」；
4. 关注会话已离线：不发送，列出候选；
5. 目标在命令开始时捕获，中途切换关注会话不改变本次发送目标。

不要猜标题，不要发给「最近一个」之外的隐式目标。

### 0.3 草稿与确认

语音先转成草稿，绝不直接发送。

- 浮层显示草稿全文、目标会话、字数；
- TTS 回读：40 字以内全文；超过 40 字念前 40 字 + 共 N 个字；
- 只说「确认发送」才发送；
- 说「重说」丢弃当前草稿并重录一次（最多重录一次，避免无限循环）；
- 说「取消」丢弃；
- 超时、低置信度、听不懂、空文本：不发送；
- 不使用数字口令；数字口令只留给审批。

现有 runVoiceConfirm 的 dictation 分支接受泛化 CONFIRM（包含「同意」「确定」）。
P2 必须改成口述专用严格匹配，例如只认「确认发送」「发送」「确认发布」，
不能让「同意」「可以」直接发送。建议在 text.mjs 增加 isDictationConfirm，
或在 runVoiceConfirm 里对 dictation 使用单独的正则，并补测试。

### 0.4 发送语义

- 只走现有 DSH prompt：dsh.prompt(sessionId, text, mode)
- 只发送一次；失败就显示错误，不自动重试，不切换到别的 Agent；
- DSH 不可用、会话不存在、发送被拒绝：不发送，保留草稿并提示；
- P1 的「暂停语音」只静音播报/审批，不阻止用户主动口述；
- 口述结果不是通知，不走 HMS/Webhook；浮层显示结果后再 TTS。

## 1. 交互流程

1. 托盘「语音」→「语音口述任务」
2. 浮层出现，显示「正在准备麦克风」；host 打开音频会话并等麦克风出 buffer
3. 提示：「请说你要交给 Agent 的内容，说完停一下。」
4. 播放 120ms 短提示音，开始长口述录音
5. ASR 返回文本；浮层显示草稿、目标、字数
6. TTS 回读草稿；再听一次确认
7. 听到「确认发送」→ 发送；浮层显示「已发送给 X」→ TTS
8. 取消/超时/失败 → 不发送；浮层显示原因
9. 关闭音频会话，浮层自动隐藏

## 2. 实现拆分

### 2.1 长口述录音参数

现有 listenOnce 只把 timeoutMs 和 prompt 传给 io.listen；createVoiceListener
只把 prompt 传给 whisper，录音参数固定 silence 1.1 / max 12 秒。

需要打通：

- listenOnce 支持 silence、maxSeconds、threshold 透传；
- createVoiceListener / createMicCapture 把这些参数传给 client.record；
- 审批和 P1 命令保持现有默认（silence 1.1、max 12、timeout 15s）；
- 口述使用 silence 1.5～1.8 秒、max 30 秒、timeout 45 秒；
- 不修改 bridge.swift 的协议即可（record 已接受 silence/max/threshold）；
  如果确实改了 bridge.swift，重建 helper 后提醒用户重新授权麦克风。

### 2.2 新增 host/voice/dictate.mjs

导出 createDictationRunner(options)，建议依赖注入：

    {
      hub,                    // 查会话
      getTargetSessionId,     // P1 的当前关注会话
      sendPrompt,             // async (sessionId, text) => result
      listen, speak, prepare, // 复用语音通道
      log, onEvent, now,
      maxChars, maxAttempts, timeoutMs, silence, maxSeconds
    }

建议方法：

- runFromMicrophone() -> { ok, intent: "dictate", heard, draft, target, reply, error }
- resolveTarget() -> { ok, session } | { ok: false, reply, candidates }
- buildDraft()（复用 buildDictationDraft，必要时加目标）
- isDictationConfirm(text)（严格匹配）
- 事件：start / listening / heard / target / draft / confirm /
  confirm-heard / sending / result / done

测试文件 host/voice/dictate.test.mjs，覆盖下面的测试清单。

### 2.3 host 命令执行器

host/index.mjs 新增 runDictate()：

- 与 runVoiceCommand 一样走 voice.runExclusive，避免和审批/命令抢麦克风；
- 在 exclusive 内先 voice.open()，再执行 dictation，最后 voice.close()；
- 通过同一个 broadcastVoiceEvent / voiceEvents 广播浮层事件；
- 本机 token 校验；
- dsh 为 null 时直接返回错误，不发送。

host/http.mjs 新增：

    POST /local/dictate

返回：

    { ok, intent: "dictate", heard, draft, target, reply, error? }

### 2.4 desktop 托盘与浮层

desktop/src/bun/index.ts：

- 语音子菜单新增「语音口述任务」，action 用 dictate；
- 复用现有的浮层创建/显示/隐藏/位置记忆逻辑；
- runDictate() 与 runVoiceCommand() 类似，POST /local/dictate；
- 正常结果只用浮层显示，不用 showMessageBox。

app/web/voice-overlay.html：

- 复用现有面板和样式，不重新引入 backdrop-filter；
- 新增草稿区：显示全文、目标会话、字数；
- 新增「已发送给 X」结果；
- 新事件 phase 要与 host 一致；
- 保持固定透明度 rgba(20,20,28,0.96)，正常/错误/发送状态只改文字颜色。

## 3. 日志

host.log 每次口述至少记录：

    语音口述: 收到本机请求
    语音口述: 目标会话=标题(id) 来源=focus|single-active
    语音口述: 识别完成 耗时=... 字数=... 置信度=...
    语音口述: 草稿 目标=... 字数=...
    语音口述: 确认输入 文本=「确认发送」 判定=confirm
    语音口述: 已发送 目标=... 耗时=... 
    语音口述: 未发送 原因=timeout|cancel|low-confidence|no-target|dsh-unavailable
    语音口述: 请求结束 耗时=... ok=...

不要记录超过 200 字的全文预览；日志里最多 200 字，完整草稿只给浮层。

## 4. 测试清单

单元测试：

- 草稿：短句全文回读；长句前 40 字 + 共 N 字；
- 严格确认：「确认发送」「发送」放行；「同意」「确定」「好」不放行；
- 「重说」丢弃并重录一次；「取消」丢弃；超时不发送；
- 目标：有焦点、唯一活跃自动选、多个候选、零候选、目标离线，均符合 0.2；
- 发送只调用一次；DSH 抛错时不发送/只报错；
- 空文本、低置信度、超长文本（超过 maxChars）不发送；
- 事件顺序：draft 先于 confirm，result 先于 TTS。

集成测试：

- host 集成：脚本语音 → 草稿 → 确认发送 → 假 sendPrompt 只收到一次；
- 取消/超时路径：sendPrompt 调用次数为 0；
- 浮层 SSE：能收到 draft / target / result；
- 回归 P1 的 commands / approvals / host-e2e 测试。

## 5. 验收

- 托盘「语音」菜单出现「语音口述任务」；
- 说一段任务，浮层实时显示草稿、目标、字数；
- 回读后只有说「确认发送」才发送，且只发送一次；
- 说「取消」「重说」、超时、低置信度、无目标、DSH 不可用时都不发送；
- 发送成功显示「已发送给 X」再播报；
- 日志包含目标、草稿字数、确认判定和发送结果；
- MO_AGENT_NOTIFY_DISABLE=1 npm test、npm run check 通过；
- ./scripts/build-desktop.sh 通过，codesign 校验通过。

## 6. 不做

- 唤醒词、常开麦克风
- 边录边发的流式口述
- 语音编辑（改一个字、删一句）
- 发给未确认的多个会话 / 广播
- 自动重试发送
- Windows/Linux

## 7. 提交

    feat(voice): P2 语音口述任务

不要顺手改版本号；需要刷新壳缓存用 ./scripts/install-desktop.sh。
如果重建了 helper，麦克风权限可能重置，提醒用户重新授权。
