# AGENTS.md

## 发布与 Git 操作约定

### 发版

- 版本与分支模型见 [VERSIONING.md](VERSIONING.md)；照着执行的版本见 [docs/runbooks/versioning.md](docs/runbooks/versioning.md)。
- 以 [docs/runbooks/release.md](docs/runbooks/release.md) 为准；**输入与流程冲突时先停下来问**，不要直接执行。
- 版本号**后置升级**：发版完成后按下一轮改动类型升位——常规迭代（有新增/行为变化）**次版本 +1**、纯缺陷修复**修订号 +1**；main 上永远是「下一个待发版号」。
- 发版前把 `CHANGELOG.md` 的 `[Unreleased]` 收进 `## [版本] - 日期` 并留新的 `Unreleased`；**没发就不要写带日期的版本小节**。
- 改版本号用 `node scripts/bump-version.mjs X.Y.Z`（三处一次改齐），再用 `node scripts/check-version.mjs` 校验；不要手改三处。
- 补丁版本走 `release/x.y.z` 维护分支：先升版本 → 再落修复 → 最后收口 CHANGELOG；发完用 `git merge --no-ff` 并回 main。
- 失败不自行改代码：按 runbook 的失败分支停下，汇报 run id 与原文。

### Git

- `git add` **只列具体文件**，不写目录（目录会把未跟踪文件一并加进来）。
- 只从索引移除用 `git rm --cached`；`git rm` 会连工作区文件一起删。
- 改历史前先 `git bundle create .cottontail-tmp/<名字>.bundle --all` 备份。
- `git reset` / 覆盖分支前，先 `git log --oneline <目标>..HEAD` 确认会丢哪些提交。
- 执行环境推不了远端就停下，交给人来推，不换别的推送方式硬试。
