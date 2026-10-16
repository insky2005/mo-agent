# 预研：桌面端外壳选型（Tauri vs Electrobun）

日期：2026-10-16　环境：macOS 26.5 / arm64 / Xcode 16.2 / Node 20.19.6 / Bun 1.3.14

## 0. 结论先行

1. **体积瓶颈不是「壳」，是「JS 运行时」。** Tauri 壳只有 3–10MB，但我们的后端是 TypeScript；一旦要把 JS 运行时一起发出去，Tauri 的体积优势基本被吃掉。
2. **Electrobun 已实测可用**：内置 tray 模板，构建产出 **18MB** 的 .app（压缩运行时 + 760KB 原生 launcher），压缩更新包 18.3MB。
3. **推荐**：主选 Electrobun（TS 后端零改写、自带托盘），备选 Tauri（更成熟，但需 Rust 或 sidecar）。建议再做一次 Tauri 侧 spike 后再定稿。

## 1. 实测数据

### 1.1 Bun 运行时下限（本机实测）

    bun build --compile 一个最小 node:http 服务
    产物：63,446,114 字节（63.4MB）
    gzip 后：23.9MB

含义：任何「把 JS 运行时打进包里」的方案，大约要从 24MB（压缩）起步。

### 1.2 Electrobun 2.0.2 tray-app 模板（实测）

    脚手架：hutch electrobun init sentinel-spike --template=tray-app
    主进程运行时：cottontail（Zig + JavaScriptCore）
    .app 落盘：18MB（launcher 760KB + 运行时压缩包 17MB）
    压缩更新包 tray-app.app.tar.zst：18,336,534 字节（18.3MB）
    构建耗时：压缩阶段约 10 秒

备注：
- 模板自带 tray 支持（electrobun.config.ts 里有 runtime.exitOnLastWindowClosed=false），正好是我们「托盘 + 引导窗」的形态。
- 主进程用的是 Cottontail 而非 Bun；若改用 Bun 主进程，按 1.1 估约 25MB 级（压缩）。
- 在本次沙箱里 DMG 打包步骤因 hdiutil 报错失败（Environment 问题，非框架缺陷），.app 本身构建成功。
- Cottontail 在官方文档中标注为 experimental；macOS 上小是因为 JavaScriptCore 是系统库，Windows/Linux 可能变大，需另测。

### 1.3 Tauri（未构建）

- 本机没有 Rust 工具链（rustc/cargo = none），且沙箱禁止写 ~/.cargo、~/.rustup，未做构建实测。
- 官方与第三方对比给出的壳体积为 3–10MB（不含 sidecar）。
- 官方文档：Node 作为 sidecar 走 Tauri shell/sidecar 机制，sidecar 二进制需按目标三元组命名。

## 2. 方案与体积算术

| 方案 | 壳 | 后端 | 估算总体积 | 集成成本 |
|---|---|---|---|---|
| A. Tauri + Rust 后端 | 3–10MB | Rust 重写 | **最小，约 5–12MB** | 最高（后端用 Rust 重写） |
| B. Tauri + JS sidecar | 3–10MB | Node SEA 或 Bun 编译产物 | 约 30–35MB | 中高（sidecar 打包/签名/生命周期） |
| C. Electrobun + Bun 主进程 | 系统 WebView | 现有 TS 原样跑 | 约 25MB 级（估） | 低 |
| D. Electrobun + Cottontail 主进程 | 系统 WebView | 现有 TS 原样跑 | **约 18MB（实测）** | 低 |
| E. Electron（基线） | 自带 Chromium | 现有 TS 原样跑 | 150MB+ | 最低 |

## 3. 逐项对比

| 维度 | Tauri v2 | Electrobun 2.x |
|---|---|---|
| 壳体积 | 3–10MB | 系统 WebView，实测 18MB |
| 后端语言 | Rust，或 sidecar 外部二进制 | TS 直接在 Bun / Cottontail 上跑 |
| 托盘 | 支持 | 支持（模板自带） |
| 开机自启 | 官方插件 tauri-plugin-autostart | 需确认 |
| 系统通知 | 官方插件 | 需确认 |
| 自动更新 | 官方且成熟 | 内置（实测已生成更新包） |
| 成熟度/生态 | 很高（111k star，插件生态大） | 较新，社区小 |
| 移动端 | v2 支持 Android/iOS | 仅桌面 |
| 签名/公证 | 文档完善 | 需自行摸索 |
| 主要风险 | 需装 Rust；sidecar 打包链路复杂 | 项目较新；Cottontail 标注实验性；跨平台体积待测 |

## 4. 风险清单

1. Electrobun 较新，且模板默认的 Cottontail 是 experimental，长期维护性要评估。
2. Cottontail 在 Windows / Linux 上可能因缺少系统 JavaScriptCore 而变大，需实测。
3. Tauri 侧需安装 Rust 工具链，并用 sidecar 方式打包 Node/Bun 产物，链路更长。
4. 两者在 macOS 分发都需要签名 + 公证。
5. 音频改走系统默认设备后，先前担心的 setSinkId 兼容问题已消除。

## 5. Tauri 侧待做 Spike（建议下一步）

目标：拿到 Tauri 的真实体积与集成难度，与 Electrobun 对齐比较。

步骤：
1. 用 RUSTUP_HOME / CARGO_HOME 指向工作区目录再安装 Rust（规避沙箱对 HOME 的写限制）。
2. 建一个 Tauri v2 最小工程，只做托盘 + 一个引导窗。
3. 把现有 server/index.mjs 用 bun build --compile 打成二进制，作为 sidecar 接入并拉起。
4. 测量：.app 体积、压缩包体积、冷启动时间、sidecar 生命周期是否可控。
5. 同样测一次 Electrobun 的 Bun 主进程变体，做 A/B。

判据：若 Tauri 总体积 <= Electrobun 且 sidecar 链路可接受，则选 Tauri（更成熟）；否则选 Electrobun。

## 6. 复现命令

    # 安装 Hutch（把工具链放在工作区内）
    export HUTCH_HOME=$PWD/.prestudy/hutch
    curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh
    export PATH=$HUTCH_HOME/bin:$PATH

    # 脚手架 + 构建
    hutch electrobun init sentinel-spike --template=tray-app
    cd sentinel-spike && hutch run build

产物位置：.prestudy/spike/sentinel-spike/build/stable-macos-arm64/
