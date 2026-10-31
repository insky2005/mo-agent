# 版本管理（可执行）

> 面向执行 Agent：每一步都能直接跑，带判据和期望输出。
> 人类阅读版：[VERSIONING.md](../../VERSIONING.md)（规则与模型）、[RELEASE.md](../../RELEASE.md)（发布流程）。

## 0. 按场景跳转

| 你要做的事 | 去哪 |
|---|---|
| 只想改版本号 | `node scripts/bump-version.mjs X.Y.Z`（§1.2） |
| 发一个次版本（有新增功能） | §2 |
| 发一个补丁（只有修复） | §3 |
| 发完之后升版本号 | §4 |
| 维护分支并回 main | §5 |
| 遇到异常 | §6 |

## 1. 规则与判据

### 1.1 升哪一位

| 下一轮的改动 | 升位 | 例子 |
|---|---|---|
| 有新增功能 / 行为变化（常规迭代） | **次版本 +1**，补丁位归零 | 0.2.0 → 0.3.0 |
| 只有缺陷修复 | **修订号 +1** | 0.2.0 → 0.2.1 |
| 不兼容变更 | 主版本 +1 | 0.3.0 → 1.0.0 |

判据看**这一轮合进去的提交类型**：有 `feat` 或行为变化 → 次版本；全是 `fix` → 修订号。

### 1.2 改版本号（三处一次改齐）

```bash
node scripts/bump-version.mjs 0.2.1
```

它会改 `package.json`、`package-lock.json`、`cli/lib/version.mjs`，不动 CHANGELOG、不提交、不打 tag。

### 1.3 校验（每次都要过）

```bash
node scripts/check-version.mjs     # 期望：[version] 一致：X.Y.Z
```

不一致会打印三处各自的版本号，按提示补齐。

## 2. 发次版本（在 main 上）

前置：main 的版本号已经等于这次要发的版本（后置升级的约定）。

1. **确认版本**

```bash
node scripts/check-version.mjs     # 期望：[version] 一致：X.Y.Z
```

不是预期版本才需要跑 `bump-version.mjs`。

2. **收口 CHANGELOG**：把 `## [Unreleased]` 改成 `## [X.Y.Z] - <今天>`，并在顶部留一个空的 `## [Unreleased]`。

```bash
node scripts/check-changelog.mjs --release   # 期望：[changelog] 发版检查通过：X.Y.Z
```

3. **提交、推送、打 tag、观察**：按 [release.md](release.md) 第 4–8 步。

4. **发完立刻升号**：§4。

## 3. 发补丁（维护分支）

补丁不走 main，从上一个发布点拉分支。

1. **建分支**（`release/**` 会触发 CI，和 main 一样跑测试）

```bash
git switch -c release/0.2.1 <上一个发布点的提交>
```

2. **先升版本号**（顺序不能反）

```bash
node scripts/bump-version.mjs 0.2.1
node scripts/check-version.mjs
git add package.json package-lock.json cli/lib/version.mjs
git commit -m "chore: 开始 0.2.1 开发"
```

3. **再落修复**：`git cherry-pick` 或直接提交，提交类型用 `fix(...)`。

4. **最后收口 CHANGELOG**（`## [0.2.1] - 日期` + 新的空 Unreleased）

```bash
node scripts/check-changelog.mjs --release   # 期望：发版检查通过：0.2.1
npm test && npm run check
git add CHANGELOG.md
git commit -m "chore(release): 0.2.1"
```

5. **发版**：在**维护分支上**打 tag（不是在 main 上），workflow 会 checkout 这个 tag 校验版本号。

   ```bash
   git push origin release/0.2.1
   git rev-parse --abbrev-ref HEAD      # 期望：release/0.2.1
   node scripts/check-version.mjs       # 期望：一致：0.2.1
   git tag cli-v0.2.1
   git tag apk-v0.2.1
   git tag desktop-v0.2.1
   git push origin cli-v0.2.1 apk-v0.2.1 desktop-v0.2.1
   ```

   之后按 [release.md](release.md) 第 6–8 步观察与验收。

6. **并回 main**：§5。

## 4. 发布后升开发版本（必做）

发版成功后立刻把 main 的版本号推到下一个，否则下次 tag 会撞车。

```bash
git switch main
node scripts/bump-version.mjs <下一个版本>     # 有功能 → 次版本 +1；纯修复 → 修订号 +1
node scripts/check-version.mjs
node scripts/check-changelog.mjs               # 期望：有 Unreleased 段（--release 此时应当失败）
```

在 `CHANGELOG.md` 的 `[Unreleased]` 记一行「发布后升版本号到 X」，然后：

```bash
git add package.json package-lock.json cli/lib/version.mjs CHANGELOG.md
git commit -m "chore: 开始 <下一个版本> 开发"
git push origin main
```

## 5. 维护分支并回 main

```bash
git switch main
git merge --no-ff release/0.2.1 -m "merge: 0.2.1 修复并回 main"
```

冲突只会在两处：

| 文件 | 怎么解 |
|---|---|
| 版本文件 | 保留 **main 的版本号**（更高那个），不要回退 |
| `CHANGELOG.md` | 两个小节都留：新版本在上，0.2.1 在下 |

合并后验证：

```bash
node scripts/check-version.mjs      # 还是 main 的版本号
npm test && npm run check
git log --oneline -8                 # 能看到维护分支的提交
```

## 6. 异常处理

| 现象 | 判定 | 动作 |
|---|---|---|
| `check-version` 报三处不一致 | 只改了一两个文件 | 用 `bump-version.mjs` 重跑一遍 |
| `check-changelog --release` 报缺少小节 | 忘了收口 CHANGELOG | 按 §2 第 2 步补 |
| 平时 `check-changelog` 报缺 Unreleased | 收口后没留新的空段 | 在顶部补 `## [Unreleased]` |
| tag 已推送、想改版本号 | tag 不能复用 | 发新的补丁号，别 force push tag |
| 合并后 main 少了修复 | 用了 `--squash` 或漏合并 | 回退合并，用 `--no-ff` 重做 |

## 7. 一句话

> **main 永远挂着「下一个版本号」；发版 = 收口 CHANGELOG + 打三个 tag；发完立刻升号；
> 修复走维护分支，发完并回 main。**
