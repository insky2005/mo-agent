# 语音免手确认

目标：**不打字、不按键**。Agent 卡在授权时，host 用 TTS 把动作、目标和口令念出来；你复述口令，它才放行。

设计取舍见 [ADR-0002](adr/adr-0002-hands-free-voice.md)。本文是使用与排障手册。

## 架构

    host (Node) ──TCP 127.0.0.1──► mo-agent 语音.app（常驻 helper）
                                        │ AVAudioEngine 录音 + VAD 断句
                                        ▼
                                   utterance.wav
                                        │
                                        ▼
                              whisper.cpp（本机离线）
                                        │ 文本 + 置信度
                                        ▼
                              两段式确认状态机 ──► approvals 中枢
                                        │
    say → .aiff → afplay ───────────────┘（播报草稿与提示音）

- **helper**：`mo-agent 语音.app` 是唯一直接碰麦克风的进程。host 通过 `127.0.0.1` 的一行 JSON 协议发
  `ping / selftest / record / quit`；端口和随机 token 写在 `~/.mo-agent/voice-bridge.json`（0600）。
  helper 空闲 5 分钟自动退出，host 每分钟 ping 一次保持热状态。
- **识别**：whisper.cpp + `ggml-small-q8_0`，全部在本机完成，音频不上传、不落长期存储；
  临时 wav 识别完立即删除。
- **播报**：`say` 先合成 aiff，再用 `afplay` 阻塞播完，最后留 150ms 收尾，避免蓝牙路由切换吃掉尾音。
- **串行**：播报与录音严格互斥；同一时间只处理一个语音请求。

## 权限（macOS TCC）

只需要给 **mo-agent 语音.app** 麦克风权限，不需要给外层 mo-agent.app。

- 首次录音会弹系统授权框，点「允许」即可；
- 没弹窗时：系统设置 → 隐私与安全性 → 麦克风 → 打开「mo-agent 语音」；
- 未授权时 helper 返回 `mic-denied`，host 日志写「语音未启用：麦克风权限被拒绝」，不会放行任何操作。

重建或升级会重置权限，原因见下文「升级后权限没了」。

## 使用

1. `./scripts/install-desktop.sh` 安装并启动桌面 App；
2. 菜单栏托盘 → **语音** → 勾选 **「启用语音」**（会重启 host）；
3. 首次授权：系统弹出「mo-agent 语音」麦克风请求，点允许；
4. Agent 卡住时，host 念出「批准 <动作> <目标>，请复述口令 4 7 2 9」；
5. 听到提示音后复述口令。说「拒绝」可直接拒绝；说「重复」会重念草稿。

同一子菜单还有：

- **麦克风权限设置…**：直接打开系统设置的麦克风页；
- **语音测试**：念一个随机口令，让你复述后返回结果，用来验证整条链路。

规则：

- 最多 **3 次尝试**（`MO_AGENT_VOICE_ATTEMPTS` 可改）；口令错、低置信度、超时、听不懂都只重试或丢弃，
  **绝不返回放行**；
- 超时、取消、麦克风不可用时不落任何决策，请求仍留给手机或 broker 超时处理；
- 授权类不叠加第三次确认：草稿回读 + 口令复述就是最终确认；
- 语音子菜单的勾选状态存在 `~/.mo-agent/voice.json`，取消勾选会重启 host 并关闭语音。

## 配置

`~/.mo-agent/voice.json`（由托盘写入）：

    { "enabled": true }

常用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MO_AGENT_VOICE` | 读 voice.json | `1` 强制开启，`0` 强制关闭 |
| `MO_AGENT_VOICE_ATTEMPTS` | 3 | 口令/识别失败后的最大尝试次数 |
| `MO_AGENT_VOICE_TIMEOUT_MS` | 15000 | 单次等待语音的时长 |
| `MO_AGENT_WHISPER_MODEL` | 内置 small 模型 | 覆盖模型路径（开发或换模型用） |
| `MO_AGENT_VOICE_BRIDGE` | 包内 helper | 覆盖语音桥可执行文件路径 |
| `MO_AGENT_WHISPER_BIN` | 包内 whisper-cli | 覆盖 whisper 可执行文件路径 |
| `MO_AGENT_TTS_SETTLE_MS` | 150 | 播完后等待音频排空的余量 |
| `MO_AGENT_VOICE_SCRIPT` | 无 | 用脚本台词代替麦克风（调试） |
| `MO_AGENT_VOICE_NONCE` | 随机 | 固定口令（配合脚本调试） |
| `MO_AGENT_VOICE_DRY` | 无 | `1` 时只记录播报文本，不出声 |

## 日志

host 日志：`~/Library/Logs/mo-agent/host.log`，超过 5MB 轮转，保留 `host.log.1` ~ `host.log.3`。
桌面壳自己的启动/退出/崩溃信息写到同目录的 `desktop.log`（同样 5MB × 3），两者不再互相覆盖。

托盘「查看日志」打开的 `/logs` 页面看的是 host.log。语音相关行：

    第 1 次 语音输入: 「四七二九」 意图=approval 置信度=0.76 期望口令=4729
    第 1 次 语音输入置信度低: 「四七二九」 置信度=0.31 期望口令=4729
    语音输入失败: {"type":"asr-error",...}
    语音询问: Bash，口令 4729
    语音结果: allow
    语音测试，口令 4729
    语音测试结果: allow
    语音已启用
    语音未启用：麦克风权限被拒绝

怎么判断：

- **没听到**：没有「语音输入」行，只有「语音结果: timeout」——看提示音后是否真的开始说话；
- **听错**：有「语音输入」但文本不对，或置信度低——缩短口令、换安静环境；
- **权限问题**：启动时「语音未启用：麦克风权限被拒绝」，或 helper 返回 `mic-denied`；
- **桥没起来**：「语音桥自检失败」/「helper-unavailable」，检查 `~/.mo-agent/voice-bridge.json` 是否存在，
  以及 helper 的 .app 是否还在包内。

## 构建

    npm run voice:build          # 编译 Swift 桥（.build/mo-agent 语音.app）
    npm run voice:build:whisper  # whisper.cpp + ggml-small-q8_0（约 252MB，走 hf-mirror）
    ./scripts/build-desktop.sh   # 默认 WITH_VOICE=1，把上面两样一起打进 App

- 模型是**内置**的，不做首次下载：语音资源约 254MB，成品 App 约 282MB；不带语音约 46MB。
- 升级 App 会带全量模型重新解包，没有增量更新。
- 不想带语音：`WITH_VOICE=0 ./scripts/build-desktop.sh`（此时语音开关会报不可用）。
- 模型选择顺序：`MO_AGENT_WHISPER_MODEL` > `runtime/voice/models/ggml-small-q8_0.bin` >
  `runtime/voice/models/ggml-base.bin`。

## 开发诊断

`host/voice/p0.mjs` 是开发诊断工具，不是用户入口：

    npm run voice:demo   # 不碰麦克风，用脚本台词跑完整确认流程
    npm run voice:live   # 真实麦克风 + 真实 broker

`npm run voice:live` 首次会请求麦克风权限；未授权时返回 `mic-denied`，不会放行。

## 故障排查

### 没弹麦克风权限

- 确认用的是打包后的 App（裸命令行进程访问麦克风会被 macOS 直接终止）；
- 系统设置 → 隐私与安全性 → 麦克风，看「mo-agent 语音」是否在列表里；
- 重装后系统可能仍记着旧签名副本，先彻底退出再启动；仍不行时用
  `tccutil reset Microphone cn.mocampus.moagent.voicebridge` 重置后重试。

### 播报尾音被吃

- 默认已用「先合成再 afplay + 150ms 收尾」；蓝牙耳机切换 A2DP/HFP 仍可能慢，
  可调大 `MO_AGENT_TTS_SETTLE_MS`（如 300）；
- 有线耳机通常没有这个问题。

### 口令失败率高

- 先看日志里的「语音输入」行，确认是**没听到**还是**听错**；
- 口令用 4 位数字，逐位念，不要连读；
- 环境噪声大时靠近麦克风，或改用手机批准；
- 连续 3 次失败会放弃并交回手机，这是预期行为。

### 升级后权限没了

当前是 **ad-hoc 签名**。重建/升级后 macOS 可能把 helper 当成新 App，麦克风权限随之重置。
重新授权一次即可；正式 Developer ID 签名与「升级后权限保留」的验证暂缓。

### 托盘里没有语音子菜单

确认运行的是带语音资源的构建（`WITH_VOICE=1`），并重启一次 App。仍没有时看 `desktop.log`。

## 已知限制

- 仅 macOS；
- 目前只覆盖**授权确认**，状态查询/切换会话/自由口述仍在 ADR 的 P1/P2；
- 从播报结束到真正开麦约 1 秒延迟（音频路由切换）；
- 模型约 252MB，随包分发；
- 中文技术词、路径仍可能听错，所以保留回读与 4 位口令；口令错或置信度低一律不放行。
