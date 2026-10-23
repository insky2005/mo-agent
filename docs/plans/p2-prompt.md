# P2 语音口述任务交接提示词

直接把下面整段贴给接手的 Agent。

---

先读 docs/p2-plan.md，按里面的定义、实现拆分和验收标准做 P2 语音口述任务。

基线：HEAD d481c77，版本 0.2.0，npm test 151 项通过，工作树干净。

先读这些文件，再动代码：

- docs/p2-plan.md
- docs/adr/adr-0001-observational-first.md
- docs/adr/adr-0002-hands-free-voice.md
- docs/plans/p1-plan.md
- docs/guides/voice.md
- host/voice/text.mjs
- host/voice/confirm.mjs
- host/voice/commands.mjs
- host/voice/channel.mjs
- host/index.mjs
- host/http.mjs
- app/web/voice-overlay.html
- desktop/src/bun/index.ts

默认决策（除非用户另行说明，按这些实现并在文档写清边界）：

- 触发：托盘「语音」→「语音口述任务」，click-to-talk，不做唤醒词、不做常开麦克风。
- 目标：沿用 P1 的「当前关注会话」。
  - 有焦点且在线：用它；
  - 没有焦点但恰好 1 个活跃会话：自动用它，并在回读里说「发给 X」；
  - 没有焦点且多个/零个候选：不发送，列候选；
  - 焦点会话离线：不发送，列候选；
  - 本次发送目标在开始时捕获，中途切换不影响。
- 草稿：ASR 文本先成草稿，绝不直接发送。浮层显示全文、目标、字数。
- 确认：只有「确认发送」才发送；「重说」重录一次；「取消」丢弃；超时/低置信度/空文本不发送。
  现有 runVoiceConfirm 的 dictation 分支接受泛化 CONFIRM，必须收紧为口述专用匹配，
  不能让「同意」「确定」「好」直接发送。
- 发送：只走现有 dsh.prompt(sessionId, text, mode)；只发一次；失败不自动重试、不换 Agent。
- 浮层：复用现有浮层，显示草稿/目标/结果；结果先显示再播报；不要用 showMessageBox。
  保持固定透明度 rgba(20,20,28,0.96)，不要重新引入 backdrop-filter。
- 语音静音：P1 的「暂停语音」只静音播报/审批，不阻止用户主动口述。
- 日志：目标、字数、确认判定、发送结果；全文预览最多 200 字。
- 不做：流式口述、语音编辑、多会话广播、自动重试发送、Windows/Linux。

实现顺序：

1. 打通长口述录音参数：listenOnce → io.listen → createVoiceListener → client.record
   支持 silence / maxSeconds / threshold 透传；口述用 silence 1.5～1.8s、max 30s、timeout 45s；
   审批和 P1 命令保持原默认。
2. 新增 host/voice/dictate.mjs + dictate.test.mjs：
   resolveTarget、严格 isDictationConfirm、草稿回读、确认、发送、事件。
3. host 执行器 + POST /local/dictate：
   与 runVoiceCommand 一样走 voice.runExclusive，内部 voice.open/close；
   复用 broadcastVoiceEvent 广播 draft/target/confirm/result；
   dsh 不可用时不发送。
4. 托盘「语音口述任务」+ 浮层扩展：
   desktop 复用现有浮层创建/位置记忆/隐藏逻辑；
   overlay 增加草稿区、目标会话、字数、「已发送给 X」。
5. npm test（加 MO_AGENT_NOTIFY_DISABLE=1）、npm run check、build-desktop、codesign，
   最后提交：

    feat(voice): P2 语音口述任务

约束：

- 不涨版本号，仍用 0.2.0。
- 不引入唤醒词、不做常开麦克风、不做后台偷偷录音。
- 不破坏 P1 的语音命令、审批、浮层和现有测试。
- 跑测试统一加 MO_AGENT_NOTIFY_DISABLE=1；host 集成测试 spawn host 时也要带上，
  避免测试真的向手机推送。
- 如果新增文件，把它们加进 package.json 的 check 脚本。
- 如果改了 host/voice/bridge.swift，重建 helper 后提醒用户重新授权麦克风。
- 口述发送是副作用操作：任何不确定、超时、低置信度、目标不明确，一律不发送。

验收以 docs/p2-plan.md 第 5 节为准。
