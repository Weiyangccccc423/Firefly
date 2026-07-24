# HTML 原文文章支持交接

## 当前状态

HTML 原文文章支持已完成源码改造、说明、示例与构建验证。`pnpm astro sync`、`pnpm check` 和 `pnpm build` 均已通过；生产构建已生成 HTML 示例文章、RSS 条目与 Pagefind 索引。

本次工作还完成了 OSS CI 部署工作流，见 `.github/workflows/deploy-oss.yml` 和 `docs/oss-ci-deployment-plan.md`。实际部署前仍需在 GitHub 配置 OSS Secrets、Variables 与 `production` Environment。

## 已完成改动

- 新增 `parse5` 直接依赖，用于结构化解析 HTML。
- 新增 `src/loaders/html-posts.ts`：
  - 扫描 `src/content/posts/**/*.html`。
  - 支持同名 `.meta.json` 元数据文件，例如 `legacy/post.html` 对应 `legacy/post.meta.json`。
  - 元数据文件缺失时，读取 HTML 的 `title` 和常用 `meta` 标签。
  - 要求提供 `published` 日期；缺失时构建应明确报错。
  - 只保留 HTML 的 `body` 内容，构建期通过 `sanitize-html` 移除脚本、页面级样式、事件属性和不安全 URL。
  - 使用 `parse5` 提取标题层级、生成 heading ID、摘要、字数和阅读时间，并将结果写入 Astro Content Layer 的 `rendered` 数据。
  - 开发模式中监听 `.html` 和 `.meta.json` 变动并重新加载 HTML 文章。
- 修改 `src/content.config.ts`：
  - 保留原有 `posts` Markdown/MDX 集合。
  - 新增 `htmlPosts` 集合，使用自定义加载器。
  - 两类文章共用字段，并以 `contentType` 区分 `markdown` 和 `html`。
- 修改 `src/utils/content-utils.ts`：
  - 引入 `PostEntry` 联合类型。
  - 合并 Markdown 与 HTML 文章用于排序、首页分页、标签、分类、相关文章和随机文章。
  - 检测 Markdown/HTML 生成相同 URL 的冲突，并在构建时抛错。
- 修改文章调用点：
  - 文章卡片、文章分页、评论、RSS 页面、OpenGraph 图片均使用统一文章类型。
  - HTML 文章评论路径保持为 `/posts/<slug>`。
  - RSS 页面链接改为使用 `getPostUrlBySlug()`。
  - `removeFileExtension()` 新增 `.html` 支持。
- 新增示例：
  - `src/content/posts/html-original-example.html`
  - `src/content/posts/html-original-example.meta.json`
- 新增使用说明：`docs/html-posts.md`。
- 修复 `parse5` 文本节点的严格类型缩窄，确保正文、摘要和字数提取可通过 Astro 诊断。
- 新增 OSS GitHub Actions 工作流：在 `master` 推送或手动触发时构建、保留构建产物并以增量方式同步到 OSS。

## 本地验证步骤

已在本地仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm astro sync
pnpm check
pnpm build
```

`pnpm type-check` 仍因仓库既有的 `--isolatedDeclarations` 标注缺失而失败，涉及 `src/constants/constants.ts`、多个既有 API 路由与工具模块；HTML 加载器本身不再有诊断错误。该问题不影响 Astro 诊断或生产构建。

然后用以下命令检查渲染：

```bash
pnpm dev
```

重点访问：

- `/posts/html-original-example/`
- 首页文章卡片中的 HTML 示例
- `/rss.xml`
- 标签、分类和归档页

## 已验证的重点

- 自定义加载器返回的 `rendered.html` 能被 Astro `render()` 用于文章页、文章卡片和 RSS。
- `CollectionEntry<"posts"> | CollectionEntry<"htmlPosts">` 可被文章页面、列表、评论、RSS 和 OG 图调用点正确消费。
- `parse5` 类型与 `sanitize-html` 选项通过 `pnpm check`，并且完整构建成功。
- Pagefind 索引已生成，HTML 示例文章包含在构建产物中。
- 开发模式下修改 HTML 文件会触发加载器重新读取文章，示例文章随后可正常响应。

## 尚未验证的重点

- 通过浏览器验证真实旧 HTML 文章的图片、嵌入内容和移动端样式迁移。

## HTML 文章作者约定

- 将原 HTML 放进 `src/content/posts/`，路径决定 `/posts/` 下的 URL。
- 推荐同名 `.meta.json`，其中至少含有 `published`；完整示例见 `docs/html-posts.md`。
- 不要同时放置同一 URL 的 `.md` 与 `.html` 文件。
- 图片、音视频等静态资源建议放入 `public/` 并以 `/images/...` 或 `/media/...` 引用；HTML 相对资源不会自动复制到构建产物。
- 原页面的全局 CSS 与 JavaScript 不会保留。需要的样式应迁移至 `src/styles/`，交互应改造成 Astro/Svelte 组件。

## 建议的后续处理顺序

1. 使用浏览器验证示例文章的目录、表格、元数据、RSS 和搜索。
2. 选取一篇真实旧 HTML 文章试迁移，确认图片和嵌入内容策略。
3. 在 GitHub 配置 `production` Environment、OSS Secrets 和 Variables 后，手动触发 OSS 工作流完成首次上传验证。
