# 用 GitHub Pages 托管站点并绑定自定义域名

本站（`site/`）就是这么搭的。新仓库照抄一遍即可，全程不需要构建工具。

## 0. 前置

- 仓库可开 Pages：公开仓库免费；私有仓库需要 GitHub Pro/Team 及以上。
- 域名已在你手上（本例用 `mocampus.cn` 下的子域）。

## 1. 站点目录

源码放 `site/`，**不要叫 `pages/`**（和产品和框架路由概念撞车），也不要指望 `docs/`
（GitHub 原生支持从 `/docs` 发布，但本仓库的 `docs/` 已经放了内部文档）。

```
site/
  index.html
  CNAME                    # 一行，自定义域名
  assets/style.css
  assets/icon.svg
```

**所有资源用相对路径**（`assets/style.css`，不要 `/assets/style.css`）。绑自定义域名后
站点从子路径 `/<repo>/` 变成根路径 `/`，写死根路径的站点一换域名就整站 404。

## 2. CNAME 文件

```
mo-agent.mocampus.cn
```

只能一行、只能一个域名、文件名必须全大写。**它必须跟着部署产物一起上传**，否则每次
发布都会把后台登记的域名清掉，站点退回 `<user>.github.io/<repo>`。

## 3. DNS

| 类型 | 主机记录 | 记录值 | TTL |
|---|---|---|---|
| CNAME | `mo-agent` | `insky2005.github.io` | 600 |

- 记录值不带 `https://`、不带路径、不带仓库名。
- CNAME 目标永远是 `<用户名>.github.io`，与仓库名无关。
- 同一主机名下不能存在别的记录（A / TXT / 泛解析 `*` 都不行）。
- Cloudflare 托管的话先把代理切成 DNS only（灰云），否则证书签发会失败。

## 4. 仓库设置（人工，一次性）

1. Settings → Pages → **Source** 选 **GitHub Actions**。
2. 首次部署跑通后，Settings → Pages → Custom domain 应自动变成 `CNAME` 里的域名；
   若没变，手动填一次。
3. 等 DNS check 变绿，勾 **Enforce HTTPS**（证书由 GitHub 自动签发与续期，通常几分钟）。

## 5. 工作流

见 `.github/workflows/pages.yml`。关键点：

- `upload-pages-artifact` 的 `path` 是 `site`，CNAME 因此天然进产物；
- 部署前显式校验 `site/CNAME` 存在且内容正确（少了会静默丢域名）；
- `permissions` 必须有 `pages: write` 和 `id-token: write`；
- 只监听 `main`，功能分支不发布。

## 6. 验收

```bash
dig +short mo-agent.mocampus.cn CNAME      # → insky2005.github.io.
curl -sI https://mo-agent.mocampus.cn/     # → 200，证书有效
curl -sI https://insky2005.github.io/mo-agent/  # → 301，Location 指向自定义域名
```

## 7. 排障

| 现象 | 原因 |
|---|---|
| `http` 返回 404，响应头 `Server: GitHub.com` | 请求到了 GitHub，但没有站点认领该域名：Pages 没开，或 Custom domain 没填 |
| `https` 报证书 subject 不匹配 | 证书还没签。填好域名后等，最长约 24h；卡住就把域名删掉重填一次 |
| 每次发布后域名又没了 | `CNAME` 没进 artifact |
| 自定义域名下 404、`github.io` 正常 | 站点内部用了绝对根路径/写死了 `/repo/` 前缀 |
| Cloudflare 后面一直签不下来 | 代理开着（橙云），切 DNS only |

## 8. 换域名 / 撤域名

- 换：改 `site/CNAME` → 改 DNS → Pages 后台重填。旧 `github.io` 地址会 301 到新域名，
  但 **301 会被浏览器长期缓存**，来回试要谨慎。
- 撤：`site/CNAME` 和 Pages 后台**一起**撤。只撤一处会出现「新域名解析不到、
  `github.io` 又一直 301」的双向不通。
