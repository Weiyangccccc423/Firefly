# Firefly OSS 自动部署执行计划

## 目标

当 `master` 分支的新提交推送到 GitHub 时，GitHub Actions 自动安装依赖、构建静态站点，并将 `dist/` 内容同步至阿里云 OSS Bucket 根目录。网站由阿里云 CDN 提供 HTTPS 访问，绑定个人域名。

```text
git push origin master
        |
        v
GitHub Actions: pnpm install -> pnpm build -> OSS sync
        |
        v
OSS Bucket -> 阿里云 CDN -> https://www.example.com
```

本计划只描述待执行工作，不会改动现有工作流或阿里云资源。

## 已确认的项目条件

- 站点为 Astro 静态站点；不设置 `CF_WORKERS` 时，构建产物在 `dist/`。
- 项目要求 Node.js 22+ 和 pnpm 9+。
- 完整构建命令为 `pnpm build`，其中包含图标、LQIP、字体子集和 Pagefind 索引生成。
- 当前仓库已有 GitHub Pages 工作流 `.github/workflows/deploy.yml`。OSS 工作流应作为新的独立文件加入，避免修改或干扰它。
- 当前默认发布分支为 `master`。

## 部署架构决策

1. 使用 GitHub-hosted runner 执行构建，而不是在 ECS 上执行。ECS 可以不再承担网站运行职责。
2. 使用 OSS 私有 Bucket 作为 CDN 源站，并配置 CDN 回源访问；不要将写入密钥保存在仓库或构建日志中。
3. 使用 `www.example.com` 作为主域名。裸域 `example.com` 跳转到 `www`，避免根域无法使用标准 CNAME 的问题。
4. GitHub Actions 每次只上传新文件或已变更文件，不在第一版工作流中自动删除 OSS 上的旧对象。确认发布稳定后，再评估是否启用带删除行为的同步。
5. 生产构建失败时不上传任何文件；上传失败时保留 OSS 上的上一版可访问站点。

## 第一阶段：阿里云资源准备

- [ ] 创建 OSS Bucket，例如 `my-personal-blog`。
- [ ] 选择访客主要所在地域；中国大陆访问需先完成 ICP 备案，并选择满足备案要求的地域。
- [ ] 在 Bucket 中开启静态网站托管：默认首页为 `index.html`，默认 404 页为 `404.html`。
- [ ] 创建 CDN 域名，源站选择该 OSS Bucket；配置 OSS 回源授权。
- [ ] 申请并在 CDN 域名上绑定 SSL 证书。
- [ ] 在阿里云 DNS 中为 `www` 配置 CDN 控制台给出的 CNAME 记录。
- [ ] 为裸域配置跳转至 `https://www.example.com`，或使用 DNS 服务支持的 ALIAS/ANAME 功能。
- [ ] 设置 CDN 缓存规则：HTML 和首页使用短缓存，`/_astro/*`、图片、字体等静态资源使用长缓存。

## 第二阶段：创建最小权限凭证

推荐创建独立 RAM 用户或 RAM 角色，仅允许写入目标 Bucket。不要使用阿里云主账号 AccessKey。

需要的权限范围：

- 列出目标 Bucket 的对象。
- 上传和覆盖目标 Bucket 中的对象。
- 读取对象元数据以支持增量同步。

第一版不需要删除对象权限。权限策略中的 Bucket 名称必须替换为实际名称。

需要在 GitHub 中保存的信息：

```text
ALIYUN_ACCESS_KEY_ID
ALIYUN_ACCESS_KEY_SECRET
OSS_BUCKET
OSS_REGION
OSS_SITE_URL (可选)
```

`ALIYUN_ACCESS_KEY_ID` 和 `ALIYUN_ACCESS_KEY_SECRET` 必须存入 GitHub 仓库或 `production` Environment 的 Secrets；绝不写入 `.env`、工作流文件或 Git 历史。`OSS_BUCKET`、`OSS_REGION` 和可选的 `OSS_SITE_URL` 应存入 GitHub Actions Variables，方便在部署摘要中核对目标。

## 第三阶段：GitHub Actions 工作流实现

已新增 `.github/workflows/deploy-oss.yml`，触发条件如下：

```yaml
on:
  push:
    branches: [master]
  workflow_dispatch:
```

工作流已实现以下步骤：

- [x] 检出提交的精确版本。
- [x] 配置 Node.js 22 和 pnpm 9.14.4。
- [x] 使用 `pnpm install --frozen-lockfile` 安装依赖。
- [x] 执行 `pnpm build`，并确认 `dist/index.html` 和 `dist/404.html` 存在。
- [x] 通过官方 `github.com/aliyun/ossutil@v1.7.19` 源码安装 `ossutil`。
- [x] 从 GitHub Secrets 读取 AccessKey，并从 GitHub Variables 读取 Bucket、Region 和可选站点 URL。
- [x] 在 `dist/` 目录执行 `ossutil cp . oss://<bucket>/ --recursive --update`，以增量模式把构建产物直接同步到 Bucket 根目录。
- [x] 输出本次提交 SHA、Bucket、Region 和可选站点 URL；不输出密钥。
- [x] 使用生产环境和并发控制，避免多个推送同时上传导致版本交错。
- [x] 在上传前保留 30 天的 `dist/` 构建产物，作为 Git 提交回滚之外的恢复材料。

建议的工作流权限：

```yaml
permissions:
  contents: read
```

## 第四阶段：验证与上线

- [ ] 手动触发一次工作流，检查构建和 OSS 上传日志。
- [ ] 检查 Bucket 根目录是否直接包含 `index.html`，而不是 `dist/index.html`。
- [ ] 使用 OSS 静态网站地址验证首页、`/posts/.../`、`/search/`、`/404/` 和静态资源。
- [ ] 通过 CDN 域名验证 HTTPS、首页、文章深链、搜索和移动端资源加载。
- [ ] 提交一篇测试文章并 `git push`，确认 CDN 可看到最新内容。
- [ ] 发布后按需刷新 CDN 的首页和已变更 HTML 路径；首次上线可刷新 `/*`。

## 回滚方案

第一版自动部署前，保留每个成功构建的 `dist/` 压缩包或 OSS 版本化副本。若新版本异常：

1. 在 Git 中回退到上一条已验证提交，推送到 `master`。
2. 等待 OSS 工作流重新构建并覆盖文件。
3. 刷新 CDN 中受影响的 HTML 路径。

启用 OSS 版本控制后，也可以从 Bucket 中恢复单个对象版本，但 Git 提交回滚仍是主恢复方式。

## 不在第一期范围内

- 网页后台/CMS 编辑文章。
- 服务端 API、数据库、用户登录。
- 多环境（预览、测试、生产）发布。
- 自动删除 OSS 中不再由构建产物引用的旧对象。
- 通过 ECS 本机密钥执行上传。

## 执行前需确定的参数

在实现工作流前，准备以下实际值：

```text
主域名：例如 www.example.com
OSS Bucket：例如 my-personal-blog
OSS 地域：例如 cn-hangzhou
是否已完成 ICP 备案：是/否/不需要
是否保留当前 GitHub Pages 部署：是/否
```
