# 发布流程

> 要让 AI 按步骤执行？用 [docs/runbooks/release.md](docs/runbooks/release.md)（含判据、失败分支和汇报模板）。
> 版本号规则与三条工作线：[VERSIONING.md](VERSIONING.md)；可执行版：[docs/runbooks/versioning.md](docs/runbooks/versioning.md)。

三个组件各自独立发版，互不阻塞：

| 组件 | tag | 产物 | 运行环境 |
|---|---|---|---|
| CLI | `cli-v0.2.0` | 5 个平台的 `mo-*` 单文件 | 任意 |
| APK | `apk-v0.2.0` | `mo-agent-android-0.2.0.apk` | ubuntu（带 Android SDK） |
| Desktop | `desktop-v0.2.0` | `mo-agent-desktop-0.2.0-macos-arm64.zip` | macos-14 |

顺序随意：安装脚本按**资产**解析，不依赖 `releases/latest`。

---

## 一次性准备

### 1. 仓库 Secrets（APK 签名必须有）

`Settings → Secrets and variables → Actions`：

| Name | 值 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i app/android/app/keystore/release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 通常是 `moagent` |
| `ANDROID_KEY_PASSWORD` | PKCS12 下与 keystore 密码相同 |

### 2. Actions 权限

`Settings → Actions → General → Workflow permissions` 选 **Read and write**（发 Release 需要）。

### 3. 分支保护（可选）

`Rules → main`：required checks 只勾 `test ubuntu-latest / node 22`、`test macos-14 / node 22`；**不要**勾 `windows baseline（不阻断）`。

---

## 发布前检查

```bash
npm run cli:version:check   # package.json 与 cli/lib/version.mjs 一致
npm run check               # 语法 + 生成物 + 内网地址/密钥护栏
npm test                    # 530+ 用例
```

还要确认 main 上的 CI 是绿的：

```bash
node scripts/gh-status.mjs
```

---

## 正式流程

### 第 1 步：确认版本号（通常已就位）

本仓库用**后置升级**：发版完成后立刻把开发版本升到下一个补丁号。所以正常发版时，
`package.json` 里的版本就是这次要发的版本，不需要改。

```bash
node scripts/check-version.mjs   # 一致即可
```

只有跳号（如补发 0.3.0）或上次漏了后置升级时才手动改，且两个文件必须一起改：

| 文件 | 改什么 |
|---|---|
| `package.json` | `"version": "X.Y.Z"` |
| `cli/lib/version.mjs` | `export const VERSION = "X.Y.Z"` |
### 第 1.5 步：更新 CHANGELOG

把 `CHANGELOG.md` 里 `## [Unreleased]` 的内容挪到 `## [新版本] - 日期`，并留一个新的空 `Unreleased`。

```bash
node scripts/check-changelog.mjs --release   # 发版时必须有本版本小节
```

平时 `npm run check` 只要求存在 `Unreleased` 段；`--release` 由三个发版 workflow 在构建前调用。

### 第 2 步：等 main 的 CI 绿

```bash
node scripts/gh-status.mjs        # 看最近 CI
```

### 第 3 步：打 tag 并推送

```bash
git tag cli-v0.2.1
git tag apk-v0.2.1
git tag desktop-v0.2.1
git push origin cli-v0.2.1 apk-v0.2.1 desktop-v0.2.1
```

三个 tag 会各自触发一个 workflow，并行跑。

### 第 4 步：观察

```bash
node scripts/gh-status.mjs                    # 列最近的 run
node scripts/gh-status.mjs --run <run-id>     # 逐个 job / 失败步骤
```

或用网页 Actions 页；每个 run 的 Summary 里也有结论。

---

## pre-release 与正式版

三个 workflow 的发布步骤当前是：

```yaml
prerelease: true      # 首次发版先按 pre-release 处理
```

含义：GitHub 上会显示 `Pre-release` 标签，**不会**成为 `releases/latest`。

想发正式版，把三个文件里的这一行改成 `prerelease: false`（或直接删掉）：

- `.github/workflows/cli-release.yml`
- `.github/workflows/apk-release.yml`
- `.github/workflows/desktop-release.yml`

> 安装脚本不依赖 `latest`，所以 pre-release 也能正常安装；`latest` 只影响手动点 Releases 页面的人。

---

## 发版后：升开发版本（必做）

Release 出来之后要让 main 的版本号前进一格，否则下一个 tag 会和已发布的撞车。

按下一轮**改动类型**决定升哪一位：

| 下一轮的改动 | 升位 | 例子 |
|---|---|---|
| 有新增功能 / 行为变化（常规迭代） | **次版本 +1**，补丁位归零 | 0.2.0 → 0.3.0 |
| 只有缺陷修复 | **修订号 +1** | 0.2.0 → 0.2.1 |

改了之后两处必须一致：

```bash
# 1) package.json / cli/lib/version.mjs / package-lock.json 三处改同一个版本号
node scripts/check-version.mjs        # 一致
node scripts/check-changelog.mjs      # 有 Unreleased 段；--release 此时应当失败

git add package.json cli/lib/version.mjs package-lock.json CHANGELOG.md
git commit -m "chore: 开始 <下一个版本> 开发"
git push origin main
```

在 `CHANGELOG.md` 的 `[Unreleased]` 里记一行「发布后升版本号到 X」。

## 只验证、不发布（dry run）

手动触发时 `dry_run` 默认勾选，只跑构建与校验，不建 tag、不发 Release：

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/insky2005/mo-agent/actions/workflows/cli-release.yml/dispatches \
  -d '{"ref":"main","inputs":{"tag":"cli-v0.2.1","dry_run":"true"}}'
```

产物仍然作为 artifact 挂在 run 页面上，可以下载来验。

---

## 发布后验收

### CLI

```bash
MO_VERSION=cli-v0.2.1 bash installer/get-cli.sh
mo --version
```

### APK

```bash
MO_APK_TAG=apk-v0.2.1 bash scripts/fetch-apk.sh
mo daemon start        # 起来后 /app.apk 可下载
```

### Desktop

```bash
unzip -q mo-agent-desktop-0.2.1-macos-arm64.zip -d /tmp/mo-desk
open /tmp/mo-desk/mo-agent.app
```

---

## 补发与回滚

| 情况 | 做法 |
|---|---|
| 某个平台构建失败 | 修完代码再打**新补丁版本**的 tag；不要复用已推的 tag |
| Release 资产缺了 | 修完推同版本 tag 会失败（tag 已存在）；改用 `workflow_dispatch` + `dry_run=false` 重发，或删 tag 重打 |
| 发布了严重问题 | GitHub 上把 Release 标为 pre-release 或删除；不要仅删资产，安装脚本仍会解析到它 |
| 想删 tag | `git tag -d cli-v0.2.1 && git push origin :refs/tags/cli-v0.2.1` |

---

## 常见失败

| 报错 | 原因 | 处理 |
|---|---|---|
| `tag cli-vX 与 package.json Y 不一致` | 版本号没改或改漏 | 同时改 `package.json` 与 `cli/lib/version.mjs` |
| `找不到 ANDROID_KEYSTORE_BASE64 secret` | Secrets 没配或名字不同 | 按上表核对 |
| APK 签名失败 | 两个密码不一致 | PKCS12 下 `KEY_PASSWORD` 必须等于 `STORE_PASSWORD` |
| `build darwin-x64` 一直 queued | `macos-13` 已退役 | 已改用 `macos-15-intel` |
| desktop 报 `ReleasePlatformMissing` | Electrobun 没有 macOS x64 运行时 | desktop 只发 arm64 |
| `setup-android` 失败：`Failed to find package 'tools'` | 该 action 内部命令失效 | 已改为直接用镜像自带 SDK |
| 产物扫描报密钥 | 桌面包带进了 HMS 配置 | 分发构建必须 `MO_AGENT_DESKTOP_HMS=0` |

---

## 当前状态（0.2.x）

- 三个 workflow 均为 **pre-release**；
- APK 签名走 Secrets，仓库里不放 keystore；
- desktop 只出 macOS arm64；
- CLI 五平台：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`windows-x64`。
