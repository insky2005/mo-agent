# Mo Agent

**Mo Agent，让智能随行，让掌控随心。**

Mo Agent 是你电脑上的一位 AI Agent 小监理，叫 Momo，也叫“默默”。

Momo 不替 Agent 干活，也不改变你的工作方式。Agent 照旧在终端和 IDE 里忙碌；Momo 守在旁边，安静看着进度，在它需要授权、等待回答、完成任务或失败的那一刻，把消息递到你面前。你只需一次轻触、一句回应，事情就能继续。

> 智能随行，让距离消失；掌控随心，让决定权在你。

## 你会感受到的变化

| 以前 | 现在 |
|---|---|
| 离开电脑，Agent 卡在授权上，任务停住 | 手机收到提醒，随手批准，任务继续 |
| 同时开着几个 Agent，不知道谁在等 | 一个入口看清谁在跑、谁卡住、谁完成 |
| 想看一眼进度，要切回终端 | 锁屏、后台、耳机里都能收到关键进展 |
| 把电脑交给 Agent，又怕它一路放行 | 每一步放行都由你决定，超时自动交回终端 |

## 它如何做到

### 看见

Mo Agent 从进程、会话记录和 Agent hooks 三个层面观察，不要求 Agent 改造，也不改变它的运行方式。Claude Code、Qoder CN、WorkBuddy、DeepSeek Harness 的会话，会汇到同一个入口。

### 抵达

关键事件按重要程度分级，只把真正需要你的那一刻送到你身边：

- **手机（当前 Android）**：扫码配对；锁屏、后台也能收到系统推送；
- **耳机**：关键提醒可以念出来，也能用一句话回应（当前 macOS）；
- **桌面**：菜单栏常驻，不占 Dock，不打断你手头的事；需要时打开实时监控屏，所有会话的运行状态、最近一轮和等待项一屏看清。

### 决定

手机上允许或拒绝，直接回答 Agent 的提问；戴着耳机时，用口令完成确认；不方便时，超时自动交回本地终端。

**没有你的决定，它不会替你放行。**

## 支持的 Agent

| Agent | 能力 |
|---|---|
| Claude Code | 会话观察；手机批准 / 拒绝 |
| Qoder CN | 桌面端与 IDE 会话观察；批准 / 拒绝；手机回答问题 |
| WorkBuddy | 会话观察；批准 / 拒绝（放行仍在真机验证） |
| DeepSeek Harness | 会话观察；发送指令 / 中断 |
| 其他 Agent | 进程发现；可按模板继续接入 |

## 开始使用

> 只想要命令：安装看 [INSTALL.md](INSTALL.md)，用法看 [USAGE.md](USAGE.md)，发版看 [RELEASE.md](RELEASE.md)。

### 1. 安装桌面端

当前以 macOS 桌面版为主。从发布产物安装后，菜单栏会出现 Mo Agent 图标，不占 Dock；如需从源码构建，见 [DEVELOPMENT.md](DEVELOPMENT.md)。Linux / Windows 正在适配，方案见 [docs/plans/desktop-cross-platform.md](docs/plans/desktop-cross-platform.md)。

### 2. 手机扫码

打开「设置（安装与配对）」：

1. 扫第一个码，安装手机 App；
2. 打开 App，扫第二个码，完成配对。

配对二维码是一次性令牌，默认 5 分钟有效，兑换一次即作废。

### 3. 一键接入 Agent

菜单栏 →「一键配置 Agent…」→ 选择要接入的 Agent。

只写入 Mo Agent 自己的 hook，改动前自动备份，不会碰其它配置。

### 4. 继续工作

Agent 卡住时，手机会亮起。点一下，或在耳机边说一句，任务继续。

## 典型场景

- **会议室里**：电脑留在工位，Agent 需要授权；手机在桌上，一次轻触，任务继续。
- **戴着耳机时**：手上正忙，Agent 卡住；它念出请求，你说一句口令，完成确认。
- **多 Agent 并行**：一个在跑、一个在等、一个完成了；不用切窗口，一眼看清。

## 隐私与安全

- **本机优先**：管理页只允许电脑本机访问，并且必须携带本机令牌；局域网访问一律拒绝。
- **不自动放行**：没有你的决定，不会替 Agent 点头；超时或无法确认，交回本地终端。
- **语音有分寸**：批准需要复述口令；音频只在本机识别，不上传。
- **改动可回退**：只增删自己写入的 hook，修改前自动备份，坏 JSON 不覆盖。
- **配对一次性**：二维码令牌默认 5 分钟、兑换即失效。

## 平台状态

| 平台 | 状态 |
|---|---|
| macOS | 可用：桌面托盘、远程批准、语音免手确认 |
| Android | 可用：扫码配对、锁屏推送、远程批准 |
| Linux | 适配中 |
| Windows | 适配中 |
| iOS | 暂缓 |

## 许可证

Mo Agent 采用 **PolyForm Noncommercial 1.0.0**：个人与非商业用途免费；公司业务、客户交付、托管服务、转售等商业用途需要获得商业授权。

- 许可证全文：[LICENSE](LICENSE)
- 商业授权说明：[COMMERCIAL.md](COMMERCIAL.md)
- 品牌与商标：[TRADEMARKS.md](TRADEMARKS.md)
- 贡献与 CLA：[CONTRIBUTING.md](CONTRIBUTING.md)

> 本仓库是 **source-available**，不是 OSI 定义的开源项目。

## 进一步了解

- 开发、构建、接口、架构与排障：[DEVELOPMENT.md](DEVELOPMENT.md)
- 跨平台路径与 Agent 差异：[docs/plans/desktop-cross-platform.md](docs/plans/desktop-cross-platform.md)
- 语音手册：[docs/guides/voice.md](docs/guides/voice.md)
- 设计原则：[ADR-0001 观察优先](docs/adr/adr-0001-observational-first.md)
- 个人工作台 CLI（P0）：[cli/README.md](cli/README.md)
- 全部文档：[docs/README.md](docs/README.md)

---

**Mo Agent，你的 Agent 小监理。**