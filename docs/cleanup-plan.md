# 语音工程清理任务书（0.2.0）

- 基线：HEAD 3163a38（语音提交 395d38c + 通知模板提交 b64c0f1），版本 0.2.0，npm test 92 项通过，工作树干净
- 本轮不涨版本号，仍用 0.2.0
- 需要刷新桌面壳缓存时用 ./scripts/install-desktop.sh，不要靠改版本号
- 重建语音桥后 macOS 可能要求重新授权麦克风，这是 ad-hoc 签名的已知代价

## 任务 1：日志轮转

### 现状

- host.log 只追加，不轮转
- desktop 把 host 的 stdout/stderr 重定向进 host.log，同时自己的 logLine 也 append 同一个文件
- 长时间运行会无限增长，两个写入方做轮转会打架

### 方案：host 自己写文件日志

1. 新增 host/log-file.mjs
   - createRotatingSink({ file, maxBytes: 5MB, keep: 3 })
   - 写入前检查大小，超过就 host.log.1 -> .2、host.log -> .1
   - 只保留最近 3 份
2. host/log.mjs 支持文件 sink
   - 有 MO_AGENT_LOG_FILE 时同时写文件
   - 没有时保持只写 console
3. host/index.mjs 初始化 logger 时创建 sink
4. desktop/src/bun/index.ts
   - spawn host 改为 stdio: ["ignore", "ignore", "ignore"]，不再重定向
   - desktop 自己的 logLine 写到 desktop.log，同样轮转
   - /logs 仍显示 host.log
5. 可选：/logs 增加“上一份日志”入口，读取 host.log.1

### 验收

- 造 6MB 日志，确认生成 .1/.2/.3，当前文件回落
- host 不再和 desktop 抢写 host.log
- npm test、npm run check 通过
- /logs 页面仍能打开

工作量：2–3 小时

## 任务 2：模型包体策略

### 决策：0.2.x 保持模型内置

理由：

- 语音低频但关键，装完即用优先
- 首次下载要处理进度、校验、断点、镜像、离线失败，收益只是包体
- 当前没有分发压力

本轮只做策略固化，不实现下载。

### 要做的

1. scripts/build-desktop.sh 明确两个开关并写注释
   - WITH_VOICE=0：不带语音资源
   - MO_AGENT_WHISPER_MODEL：模型路径覆盖
2. 文档写清楚
   - 语音资源约 254MB，App 约 282MB
   - 升级会带全量模型
   - 模型路径、校验方式、离线行为
3. docs/adr/adr-0002-hands-free-voice.md 的 P0.5 补一句：
   模型内置是 0.2.x 的明确决策，不是遗漏

### 以后要减包体（不在本轮）

单独开任务：首次启用时下载到
~/Library/Application Support/mo-agent/models/
带 SHA256、hf-mirror 回退、进度提示、失败降级。

工作量：文档 + 注释 1 小时

## 任务 3：删除无用 CLI / 死代码

### 已确认可删

1. host/voice/bridge.swift 的 record CLI 模式
   - host 只通过 TCP 发 record 命令
   - 没有脚本再调用 mo-voice-bridge record ...
   - 删除 case "record" 与对应参数解析，保留 serve / selftest
2. 确认 host/voice/shell-client.mjs 已删、无引用
3. 确认 scripts/build-voice-recorder.sh 已删、无引用
4. 检查 desktop 里是否还有 voiceServer / VOICE_SHELL_INFO / randomUUID 残留

### 保留但标记为开发工具

- host/voice/p0.mjs 保留
  - npm run voice:demo / voice:live 仍用它做离线与真机诊断
  - README 标记为“开发诊断”，不要当用户入口
- bridge.swift selftest 保留，用于排查权限

### 不要动

scripts/probe-dsh.mjs、inspect-sessions.mjs、network-report.mjs、
notify-test.mjs、tray-preview.mjs、icon-preview.mjs
都是开发工具，除非确认没人用。

### 验收

    grep -rn "mo-voice-bridge record\|voice-shell\|VOICE_SHELL" .
    npm test
    npm run check

无结果、测试通过。

工作量：1 小时

## 任务 4：补文档

### 新建 docs/voice.md

内容：

1. 架构：host -> 常驻 helper .app -> whisper；TTS 走 say + afplay
2. 权限：只给 mo-agent 语音.app 麦克风；TCC 重置场景
3. 使用：托盘「语音」子菜单、首次授权、提示音、3 次重试规则
4. 配置：~/.mo-agent/voice.json、MO_AGENT_VOICE、MO_AGENT_VOICE_ATTEMPTS、MO_AGENT_WHISPER_MODEL
5. 日志：host.log 路径、语音输入行格式、如何判断听错/没听到/权限问题
6. 构建：voice:build、voice:build:whisper、WITH_VOICE=0、模型大小
7. 故障排查
   - 没弹麦克风权限
   - 播报尾音被吃（afplay/提示音）
   - 口令失败率高（看日志、缩短口令）
   - 升级后权限重置（ad-hoc 签名）
8. 已知限制：仅 macOS、仅审批、约 1 秒开麦延迟、模型 252MB

### 更新

- README.md：语音章节压缩成“用法 + 链接到 docs/voice.md”
- docs/adr/adr-0002-hands-free-voice.md 补最终决策
  - 方案 B（外层 App 原生子进程录音）验证失败，原因是 cottontail 成为 TCC 责任主体
  - 最终保留方案 C（嵌套 helper）
  - 正式签名与 TCC 升级验证暂缓
  - 模型内置
- 全局 grep 清理旧名：MoVoiceBridge、语音批准、shell-client、过期的 P0 说法

### 验收

一个没参与过的人，只读 README + docs/voice.md，能完成：

    ./scripts/install-desktop.sh

然后托盘启用语音 -> 语音测试 -> 说口令。

工作量：2–3 小时

## 任务 5：回归与提交

    npm test
    npm run check
    ./scripts/build-desktop.sh
    codesign --verify --deep --strict desktop/build/stable-macos-arm64/mo-agent.app

手动冒烟：

1. 托盘「语音」子菜单三个入口都在
2. 语音测试能播报、能听、能返回结果
3. 日志里能看到“第 N 次 语音输入”

提交建议：

    chore(voice): 日志轮转、模型策略与文档清理

本轮不要改版本号，仍保持 0.2.0。

## 建议顺序

1. 任务 3 删死代码（最快）
2. 任务 1 日志轮转（影响 desktop/host，先稳定）
3. 任务 2 模型策略（脚本注释 + 文档）
4. 任务 4 文档（最后统一写）
5. 任务 5 回归提交

总工作量约 1 天。

## 待拍板

1. 模型：保持内置（推荐），还是本轮就做首次下载？
2. p0 CLI：保留为开发诊断（推荐），还是彻底删除？

如果没有新指示，新会话按推荐项执行：模型内置、p0 保留。
