# HTML 原文文章支持交接

## 当前状态

已完成 HTML 原文文章支持的第一轮源码改造，并加入说明和示例；尚未完成 Astro 类型检查或生产构建验证。

本次工作还包含此前创建的 OSS CI 部署执行计划，见 `docs/oss-ci-deployment-plan.md`。该计划尚未实现为 GitHub Actions 工作流。

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

## 本地验证步骤

在本地仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm astro sync
pnpm check
pnpm type-check
pnpm build
```

然后用以下命令检查渲染：

```bash
pnpm dev
```

重点访问：

- `/posts/html-original-example/`
- 首页文章卡片中的 HTML 示例
- `/rss.xml`
- 标签、分类和归档页

## 尚未验证的重点

- 自定义加载器返回的 `rendered.html` 能否被 Astro 的 `render()` 在文章页、卡片和 RSS 中正确渲染。
- `CollectionEntry<"posts"> | CollectionEntry<"htmlPosts">` 在 Astro 生成类型后的所有组件类型是否完全兼容。
- 自定义加载器的开发模式 watcher 是否在添加、修改、删除 HTML 文章或元数据文件时正确刷新。
- `parse5` 的类型、`sanitize-html` 选项和 Biome 格式是否满足项目检查。
- 完整构建是否能生成 Pagefind 索引，并正确收录 HTML 文章。

## 当前服务器的验证阻塞

服务器带宽压力较大，已按要求停止验证。

此前 `pnpm astro sync` 未能完成，原因不是项目代码，而是受限环境无法创建 `/root/.config` 下的 Astro/Wrangler 日志和遥测目录。可在本地直接运行；若仍在受限环境执行，可临时指定：

```bash
XDG_CONFIG_HOME=/tmp/firefly-xdg-config pnpm astro sync
```

该命令随后被中断，未得到源码诊断结果。

## HTML 文章作者约定

- 将原 HTML 放进 `src/content/posts/`，路径决定 `/posts/` 下的 URL。
- 推荐同名 `.meta.json`，其中至少含有 `published`；完整示例见 `docs/html-posts.md`。
- 不要同时放置同一 URL 的 `.md` 与 `.html` 文件。
- 图片、音视频等静态资源建议放入 `public/` 并以 `/images/...` 或 `/media/...` 引用；HTML 相对资源不会自动复制到构建产物。
- 原页面的全局 CSS 与 JavaScript 不会保留。需要的样式应迁移至 `src/styles/`，交互应改造成 Astro/Svelte 组件。

## 建议的后续处理顺序

1. 在本地运行上述四个验证命令，先修复类型或构建错误。
2. 使用浏览器验证示例文章的目录、表格、元数据、RSS 和搜索。
3. 选取一篇真实旧 HTML 文章试迁移，确认图片和嵌入内容策略。
4. 确认 HTML 文章功能稳定后，再实现 `docs/oss-ci-deployment-plan.md` 中的 OSS GitHub Actions 工作流。
