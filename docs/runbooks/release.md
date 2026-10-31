# 发布 Runbook（给 AI 执行）

> 面向执行 Agent 的操作手册：**逐步可执行、每步有判据、失败有分支**。
> 人类可读的版本见 [RELEASE.md](../../RELEASE.md)；版本号规则与分支模型见 [versioning.md](versioning.md)。

## 0. 你要交付什么

一次发布 = 三个 tag → 三个 Release：

| tag | workflow | 产物 |
|---|---|---|
| `cli-v<X.Y.Z>` | `cli-release.yml` | 5 个平台 `mo-*` + `.sha256` + `SHA256SUMS` |
| `apk-v<X.Y.Z>` | `apk-release.yml` | `mo-agent-android-<X.Y.Z>.apk` + `.sha256` |
| `desktop-v<X.Y.Z>` | `desktop-release.yml` | `mo-agent-desktop-<X.Y.Z>-macos-arm64.zip` + `.sha256` |

## 1. 开始前的判据（任一不满足就停，向人汇报）

```bash
git status --short                # 只允许未跟踪文件；有已跟踪改动先问人
git rev-parse --abbrev-ref HEAD   # 必须是 main
node scripts/check-version.mjs    # 输出「一致」
npm run check                     # exit 0
npm test                          # fail 0
node scripts/gh-status.mjs        # 最近一次 ci 结论是 success
```

若 `gh-status` 报「没有找到 GitHub token」：让人类把 token 放到
`~/.dsh/oh-my-dsh/tokens/<owner>-<repo>`（0600），不要自己造。

## 2. 确认版本号（通常已就位）

本仓库用**后置升级**：每次发版完成后立刻把开发版本号升到下一个补丁号。所以正常情况下
`package.json` 里的版本就已经是「这次要发的版本」，不需要改。

```bash
node scripts/check-version.mjs     # 一致即可
```

只有这两种情况需要手动改（两个文件必须一起改）：

- 跳号（比如补发一个 0.3.0）；
- 上一个版本漏了后置升级。

```bash
# 需要改时
node -e '...'   # 或直接编辑 package.json 与 cli/lib/version.mjs，两处必须一致
node scripts/check-version.mjs
```
## 2.5 更新 CHANGELOG（发版必须做）

`CHANGELOG.md` 的 `## [Unreleased]` 里放**还没发布**的变更。发版时：

1. 把 Unreleased 下的条目挪到新小节 `## [V] - YYYY-MM-DD`（日期用今天）；
2. 在文件顶部重新留一个空的 `## [Unreleased]`；
3. 只写**对外可见**的变化，分类用 `新增 / 变更 / 修复 / 移除`；
4. 校验：

```bash
node scripts/check-changelog.mjs --release   # 期望输出「发版检查通过：V」
```

三个发版 workflow 在构建前都会跑这条，缺小节会直接红。

没有用户可见变化时，在「变更」里写一行「内部重构，无用户可见变化」，不要留空小节。

> 这条已经挂进 `npm run check`，缺小节会直接失败。
## 3. （可选但推荐）先 dry run

拿构建矩阵练一遍，**不发 Release**。把下面三条里的 `0.2.0` 换成你的 V：

```bash
TOKEN=$(cat ~/.dsh/oh-my-dsh/tokens/insky2005-mo-agent)
API=https://api.github.com/repos/insky2005/mo-agent/actions/workflows

curl -s -o /dev/null -w 'cli %{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/cli-release.yml/dispatches" \
  -d '{"ref":"main","inputs":{"tag":"cli-v0.2.0","dry_run":"true"}}'

curl -s -o /dev/null -w 'apk %{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/apk-release.yml/dispatches" \
  -d '{"ref":"main","inputs":{"tag":"apk-v0.2.0","dry_run":"true"}}'

curl -s -o /dev/null -w 'desktop %{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/desktop-release.yml/dispatches" \
  -d '{"ref":"main","inputs":{"tag":"desktop-v0.2.0","dry_run":"true"}}'
```

判据：三次都返回 `http_code 204`；随后三个 run 的 job 全 `success`，`发布` job 为 `skipped`。

```bash
node scripts/gh-status.mjs --run <run-id>
```

> 404 = workflow 不在默认分支或名字写错；403 = token 缺 `Actions: write`。
## 4. 推代码（人类也可能自己做）

```bash
git push origin main
```

判据：`node scripts/gh-status.mjs` 显示远端 main 与本地 HEAD 一致。
> 若执行环境无法访问 git（`git ls-remote` 挂住），**停下来让人类执行这条**，不要尝试其他推送方式。

## 5. 打 tag 并推送

```bash
git tag cli-v$V
git tag apk-v$V
git tag desktop-v$V
git push origin cli-v$V apk-v$V desktop-v$V
```

判据：`git ls-remote --tags origin` 能看到三个 tag（或让人类确认）。

**禁止**：
- 不要复用已存在的 tag（会失败或覆盖语义）；
- 不要 `--force` 推 tag；
- 不要删别人的 tag。

## 6. 观察三个 workflow

```bash
node scripts/gh-status.mjs                 # 找到三个 run
node scripts/gh-status.mjs --run <id>      # 逐个看 job / 失败步骤
```

预期 job：

| workflow | jobs |
|---|---|
| cli | `版本与测试` + 5 个 `build *` + `发布` |
| apk | `build apk` + `发布` |
| desktop | `build macOS arm64` + `发布` |

### 失败分支

| 现象 | 判定 | 动作 |
|---|---|---|
| `版本一致性` 失败 | tag 与 package.json 不一致 | 停，汇报具体差异，不要改 tag |
| apk 报缺少 secret | 仓库 Secrets 未配 | 停，告诉人缺哪个（名字见 RELEASE.md） |
| desktop `ReleasePlatformMissing` | 跑了 x64 | 确认矩阵只有 macos-14；汇报 |
| 某 job 长时间 queued | runner 不存在/退役 | 汇报 job 名与 labels，不要自己改 workflow |
| 构建成功但 `发布` 失败 | 权限或资产不匹配 | 看 run 日志最后 20 行，汇报原文 |

**任何失败都不自行修改仓库代码**，先汇报；等人类决定是修补丁版本还是重跑。

## 7. 验收 Release

```bash
TOKEN=$(cat ~/.dsh/oh-my-dsh/tokens/insky2005-mo-agent)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/insky2005/mo-agent/releases?per_page=5" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s))console.log(r.tag_name, r.prerelease?"pre":"stable", r.assets.map(a=>a.name).join(", "))})'
```

每个 release 必须满足：

- `cli-v$V`：`mo-darwin-arm64`、`mo-darwin-x64`、`mo-linux-x64`、`mo-linux-arm64`、`mo-windows-x64.exe`，以及每个的 `.sha256` 和 `SHA256SUMS`；
- `apk-v$V`：`mo-agent-android-$V.apk` + `.sha256`；
- `desktop-v$V`：`mo-agent-desktop-$V-macos-arm64.zip` + `.sha256`。

## 8. 冒烟（能跑就跑）

```bash
MO_VERSION=cli-v$V bash installer/get-cli.sh   # 需要网络与写 ~/.local/bin 的权限
mo --version                                    # 期望输出 $V
```

没权限/没网络时跳过，并在汇报里注明「未做真机安装验证」。

## 9. 汇报格式（照抄模板）

```
发布 <V>（pre-release / stable）
- cli-v$V     ✅/❌  run <id>  资产 <n> 个
- apk-v$V     ✅/❌  run <id>  资产 <n> 个
- desktop-v$V ✅/❌  run <id>  资产 <n> 个
- 冒烟：已做 / 未做（原因）
- 遗留问题：<无 / 具体>
```

## 9.5 发版后：升开发版本（必做）

发版成功后立刻把开发版本号推到下一个，否则下次 tag 会撞车。

```bash
git switch main
node scripts/bump-version.mjs <下一个版本>   # 有功能 → 次版本 +1；纯修复 → 修订号 +1
node scripts/check-version.mjs
node scripts/check-changelog.mjs
git add package.json package-lock.json cli/lib/version.mjs CHANGELOG.md
git commit -m "chore: 开始 <下一个版本> 开发"
git push origin main
```

完整规则与分支模型见 [versioning.md](versioning.md)。
## 10. 收尾

- 若本次是第一次正式版，提醒人类把三个 workflow 里的 `prerelease: true` 改成 `false`；
- 不要清理 `~/.mo-agent/`、不要删 tag、不要改分支保护；
- 若过程中用了 `gh-status --run`，把失败的 run id 留在汇报里。

## 11. 维护分支：发布后并回 main

补丁版本（0.2.x）在独立分支上做，main 继续走下一个次版本。发完之后必须并回去，
否则 main 会缺这些修复，下一个版本会把它们丢掉。

### 分支上应该有的顺序

```
chore: 开始 0.2.1 开发        ← 先升版本号
fix(...): 修复 1              ← 再落修复
fix(...): 修复 2
chore(release): 0.2.1        ← 最后收口 CHANGELOG
```

### 发版

按第 5–8 步打 `cli-v0.2.1` / `apk-v0.2.1` / `desktop-v0.2.1`，验收同上。

### 并回 main

```bash
git switch main
git merge --no-ff release/0.2.1 -m "merge: 0.2.1 修复并回 main"
```

冲突基本只出现在两处：

| 文件 | 怎么解 |
|---|---|
| `package.json` / `cli/lib/version.mjs` / `package-lock.json` | 保留 **main 的版本号**（更高那个），不要回退到 0.2.1 |
| `CHANGELOG.md` | 两个小节都保留：`[0.3.0]`（未发时可以还是 Unreleased）在上，`[0.2.1]` 在下 |

### 合并后必须验证

```bash
node scripts/check-version.mjs        # 还是 main 的版本号
npm test
npm run check
grep -c 'label:' cli/commands/doctor.mjs   # 修复确实回来了（数量大于 0）
```

### 三条禁止

- 不要 `git merge --squash`：会丢掉「哪个提交属于哪个版本」的信息，以后查账很难；
- 不要在 main 上再 cherry-pick 同一批修复：会和这次合并打架；
- 不要在确认不再发 0.2.x 之前删维护分支。
## 附：执行约定

| 规则 | 原因 |
|---|---|
| 输入与流程冲突时先问，不要直接执行 | 版本号说错、pre/正式不分都会让 tag 打歪 |
| `git add` 只列具体文件 | 目录会带上未跟踪文件（曾经把内部预研提交进仓库） |
| 只出索引用 `git rm --cached` | `git rm` 会删工作区文件 |
| 改历史前 `git bundle create --all` 备份 | 重写后旧提交只能靠 bundle 找回 |
| reset 前先看会丢哪些提交 | 覆盖分支时丢失的提交需要 cherry-pick 才能找回 |
| 执行环境推不了远端就停下 | 换推送方式只会浪费轮次 |

## 附：本仓库的既定约束

| 约束 | 原因 |
|---|---|
| 安装脚本按资产解析，不依赖 `releases/latest` | 三个组件的 Release 会互相抢 latest |
| desktop 只出 macOS arm64 | Electrobun 没有 x64 运行时 |
| APK 构建不带 `agconnect-services.json` | 避免把 AGC 凭据打进分发包 |
| 分发构建 `MO_AGENT_DESKTOP_HMS=0` | 同上，HMS App Secret 不进包 |
| 发布前跑 `check-artifacts --enforce` | 拦密钥（SEC-001） |
