# 管理后台

后台地址为 `/admin/`，只允许 GitHub 账号 `Weiyangccccc423` 登录。

## GitHub OAuth

在 GitHub 创建 OAuth App，回调地址必须是：

```text
https://wiyac5.xyz/admin-api/auth/callback
```

将下面的变量放在 ECS 的 `/etc/firefly/admin-api.env`，不要提交到仓库：

```text
ADMIN_PUBLIC_ORIGIN=https://wiyac5.xyz
ADMIN_GITHUB_CLIENT_ID=...
ADMIN_GITHUB_CLIENT_SECRET=...
ADMIN_GITHUB_USER=Weiyangccccc423
ADMIN_GITHUB_REPO=Weiyangccccc423/Firefly
ADMIN_GITHUB_BRANCH=master
ADMIN_SESSION_SECRET=<至少 32 字节随机值>
```

`ADMIN_GITHUB_CLIENT_SECRET`、`ADMIN_SESSION_SECRET` 和 OAuth 访问令牌不能放在浏览器代码中。

## ECS 部署

将 `admin-api/server.mjs` 放到 `/opt/firefly-admin/server.mjs`，将
`ops/firefly-admin-api.service` 安装到 systemd，并将
`ops/nginx-admin-api.conf` 的 location 放进 `wiyac5.xyz` 的 HTTPS server
块。随后执行：

```bash
systemctl daemon-reload
systemctl enable --now firefly-admin-api
nginx -t && systemctl reload nginx
```

## 功能开关

后台修改会提交 `src/config/adminOverrides.json`，由下一次 Astro 构建生效。
当前支持音乐播放器、侧栏以及页面开关。文章修改会直接提交对应的 Markdown
文件，并触发已有的 OSS 发布工作流。

## 访问统计

访问统计使用 Umami API。配置以下变量后，后台会显示最近 7 天的页面浏览、访客、
访问次数和跳出数据：

```text
ADMIN_UMAMI_API_URL=https://api.umami.is/v1
ADMIN_UMAMI_WEBSITE_ID=...
ADMIN_UMAMI_API_TOKEN=...
```
