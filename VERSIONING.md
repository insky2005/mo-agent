# 版本管理

发布、升级、修复三条线怎么配合。要照着一步步执行（含命令与判据），看
[docs/runbooks/versioning.md](docs/runbooks/versioning.md)；一次完整发布看 [RELEASE.md](RELEASE.md)。

## 一、三个数字从哪来

```
x . y . z
│   │   └─ 修订号：只有缺陷修复
│   └───── 次版本：有新增功能 / 行为变化
└───────── 主版本：不兼容变更（目前未使用）
```

规则一句话：**下一轮有新增/行为变化 → `y+1`（`z` 归零）；只有修复 → `z+1`。**

版本号在三个文件里，必须一致：

| 文件 | 字段 |
|---|---|
| `package.json` | `"version"` |
| `cli/lib/version.mjs` | `export const VERSION` |
| `package-lock.json` | 根版本（两处） |

```bash
node scripts/bump-version.mjs 0.2.1   # 三处一次改齐
node scripts/check-version.mjs        # 校验：一致 / 不一致时列出三处
```

## 二、三条工作线

### 1. 正常迭代（main）

```
main:  0.3.0 开发中 ──→ 打 tag cli-v0.3.0 ──→ 发布 ──→ 升到 0.4.0
                         ↑ 发版时
```

- main 上的版本号**永远等于「下一个要发的版本」**（后置升级）；
- 发版当天只做三件事：收口 CHANGELOG → 打三个 tag → 发完立刻升号。

### 2. 缺陷修复（维护分支）

补丁版本不起在 main 上，从上一个发布点单开分支：

```
3403a6e (0.2.0 发布点)
   └─ release/0.2.1
        chore: 开始 0.2.1 开发      ← 先升版本号
        fix(...): 修复 1            ← 再落修复
        fix(...): 修复 2
        chore(release): 0.2.1       ← 最后收口 CHANGELOG
```

顺序不能反：**先声明版本 → 再落修复 → 最后收口**。

发版时**在维护分支上打 tag**（不是 main）：

```bash
git tag cli-v0.2.1
git tag apk-v0.2.1
git tag desktop-v0.2.1
git push origin cli-v0.2.1 apk-v0.2.1 desktop-v0.2.1
```

发完必须并回 main：

```bash
git merge --no-ff release/0.2.1
# 冲突：版本文件保留 main 的；CHANGELOG 两个小节都留
```

### 3. 多条线并存

| 分支 | 版本 | 用途 |
|---|---|---|
| `main` | 0.3.0 | 开发线，攒下一个次版本 |
| `release/0.2.1` | 0.2.1 | 维护线，只放修复 |

修复只提在维护分支，main 不重复 cherry-pick——否则合并时会打架。

## 三、一次发布的完整动作

```
① 判据      check-version / check / test / 远端 CI 绿
② CHANGELOG Unreleased → ## [X.Y.Z] - 日期，留新的空 Unreleased
③ 校验      check-changelog --release
④ dry run   可选，只构建不发布
⑤ 推代码    git push origin <分支>
⑥ 打 tag    cli-vX.Y.Z / apk-vX.Y.Z / desktop-vX.Y.Z
⑦ 观察      三个 workflow 的 job 全绿
⑧ 验收      Release 资产齐全（含 .sha256、SHA256SUMS）
⑨ 后置升级  升到下一个版本号，并开新的 Unreleased
```

## 四、五个容易踩的点

| 坑 | 正确做法 |
|---|---|
| CHANGELOG 提前写带日期的版本小节 | 没发就是 `[Unreleased]`，发了才收口 |
| 发完忘记升版本号 | 下一个 tag 会和已发版本撞车；发完立刻升 |
| 复用已推送的 tag | 版本号只增不减，修完发新补丁号 |
| 修复只在维护分支、忘记并回 main | 下个版本会把修复丢掉；发完就 merge |
| 三个版本文件只改一个 | `check-version` 会红，CI 会拦 |

## 五、三道自动闸

| 脚本 | 什么时候跑 | 拦什么 |
|---|---|---|
| `scripts/check-version.mjs` | 每次 `npm run check` | 三处版本号不一致 |
| `scripts/check-changelog.mjs` | 平时要 `Unreleased`；发版 `--release` 要本版本小节 | 忘了收口 CHANGELOG |
| `scripts/check-artifacts.mjs` | 发布 workflow | 产物里混进密钥 |

## 六、一句话记忆

> **main 永远挂着「下一个版本号」；发版 = 收口 CHANGELOG + 打三个 tag；发完立刻升号；
> 修复走维护分支，发完并回 main。**
