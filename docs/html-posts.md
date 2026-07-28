# HTML 原文文章

Firefly 支持将原生 `.html` 文件直接放入 `src/content/posts/`。HTML 文章与 Markdown 文章共用文章列表、归档、分类、标签、搜索、RSS、相关文章、评论与 OpenGraph 图片。

## 文件结构

每篇 HTML 文章使用一个 `.html` 文件；推荐为它提供同名 `.meta.json` 文件。

```text
src/content/posts/
  legacy/
    my-old-post.html
    my-old-post.meta.json
```

文件路径决定文章 URL：`legacy/my-old-post.html` 对应 `/posts/legacy/my-old-post/`。

不要同时创建同一路径的 Markdown 和 HTML 文章，例如 `my-post.md` 与 `my-post.html`，构建会因路由冲突而失败。

## 元数据

同名 `.meta.json` 的字段与 Markdown Frontmatter 对应：

```json
{
  "title": "旧博客文章标题",
  "published": "2024-03-15",
  "updated": "2025-01-08",
  "description": "文章摘要",
  "tags": ["技术", "随笔"],
  "category": "技术",
  "image": "/images/legacy-cover.webp",
  "draft": false,
  "pinned": false,
  "comment": true
}
```

`published` 为必填字段。元数据文件不存在时，加载器会读取 HTML 中的 `<title>`、`<meta name="description">`、`<meta name="published">`、`<meta name="tags">` 和 `<meta name="category">`；其中发布日期仍然必须提供。

`.meta.json` 中的值优先于 HTML 的 `meta` 标签。推荐始终保留 `.meta.json`，便于维护日期、标签、封面、草稿和置顶状态。

## 渲染规则

HTML 文件可以是完整页面，也可以是正文片段。完整页面会只使用 `<body>` 的内容；`<head>`、`<html>`、`<body>` 外层标签不会出现在文章页中。

构建期会安全清理 HTML：

- 保留常见的文本、表格、图片、音视频、代码和详情折叠标签，以及无脚本的基础 SVG 图元。
- 自动为 `h1` 至 `h6` 添加锚点，并生成文章目录。
- 自动计算摘要、字数和阅读时间。
- 移除 `script`、事件属性和不安全 URL，避免旧页面影响主题、Swup 页面切换或引入 XSS。

HTML 会保留正文语义（标题、段落、列表、表格、代码、图片、音视频和基础 SVG 图元），并使用博客现有的 Markdown 文章排版。页面内 `<style>` 标签和元素内联 `style` 会被移除，因此旧页面的配色、卡片、双栏、动画和定位布局不会带入博客；旧页面的 hero、目录和翻页控件也会由统一内容样式隐藏。JavaScript 不会直接执行；需要 Mermaid、公式、提示块等 Markdown 专属能力时，应将对应内容改为 Markdown，或实现项目内的 Astro / Svelte 组件。

## 图片和资源

建议将旧文章图片、音视频等静态资源放入 `public/`，并使用以 `/` 开头的站点绝对路径：

```html
<img src="/images/legacy/diagram.webp" alt="架构图" />
<video controls src="/media/demo.mp4"></video>
```

不要依赖 HTML 文件旁边的相对资源路径，例如 `./image.webp`；它们不会自动复制到构建产物。
