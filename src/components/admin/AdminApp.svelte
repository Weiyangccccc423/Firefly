<script lang="ts">
import { marked } from "marked";
import { onMount, tick } from "svelte";

type Session = { authenticated: boolean; login: string | null };
type PostSummary = { path: string; sha: string; size: number; title: string };
type PostFile = { path: string; sha: string; content: string };
type AdminConfig = {
	music: { enabled: boolean };
	pages: Record<string, boolean>;
	sidebar: { enabled: boolean };
};
type DeployRun = {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	createdAt: string;
	url: string;
};
type Analytics = {
	configured: boolean;
	message?: string;
	pageviews?: number;
	visitors?: number;
	visits?: number;
	bounces?: number;
};
type ViewMode = "edit" | "split" | "preview";
type AiMode = "polish" | "concise" | "expand" | "proofread" | "custom";
type AiStatus = { configured: boolean; model: string | null };
type AiRewrite = { result: string; model: string };

const pageLabels: Record<string, string> = {
	friends: "友链页面",
	sponsor: "赞助页面",
	guestbook: "留言板",
	bangumi: "番组计划",
	gallery: "相册",
	anime: "追番页面",
	dynamic: "动态页面",
	rss: "RSS 订阅",
};
const defaultMarkdown = [
	"---",
	`title: "新文章"`,
	`published: ${new Date().toISOString().slice(0, 10)}`,
	`description: ""`,
	"tags: []",
	'category: ""',
	"draft: true",
	"---",
	"",
	"开始写作。",
].join("\n");

let session: Session | null = null;
let posts: PostSummary[] = [];
let selectedPath = "";
let editorPath = "";
let editorContent = "";
let editorFrontmatter = "";
let editorBody = "";
let editorSha = "";
let activeTab: "posts" | "settings" | "analytics" = "posts";
let adminConfig: AdminConfig | null = null;
let analytics: Analytics | null = null;
let deployRuns: DeployRun[] = [];
let busy = false;
let notice = "";
let errorMessage = "";
let viewMode: ViewMode = "edit";
let previewHtml = "";
let editorTextarea: HTMLTextAreaElement | null = null;
let bodySelectionLength = 0;
let frontmatterValid = true;
let frontmatterStatus = "格式有效";
let aiStatus: AiStatus | null = null;
let aiPanelOpen = false;
let aiMode: AiMode = "polish";
let aiInstruction = "";
let aiBusy = false;
let aiResult = "";
let aiErrorMessage = "";
let aiScopeLabel = "";
let aiSourceText = "";
let aiSourceDocument = "";
let aiSelectionStart = -1;
let aiSelectionEnd = -1;

const aiModeLabels: Record<AiMode, string> = {
	polish: "润色表达",
	concise: "精简内容",
	expand: "扩写内容",
	proofread: "校对纠错",
	custom: "自定义修改",
};

const frontmatterPattern = /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/;
const standaloneFrontmatterPattern = /^---\s*\n[\s\S]*\n---\s*$/;
const blockedPreviewTags =
	"script,style,iframe,object,embed,form,link,meta,base,svg,math";
const urlAttributes = new Set(["href", "src", "cite", "action", "formaction"]);

function splitMarkdownDocument(value: string) {
	const match = value.match(frontmatterPattern);
	if (match) {
		return {
			frontmatter: match[0].trim(),
			body: value.slice(match[0].length).replace(/^\n/, ""),
		};
	}
	if (!/^---\s*\n/.test(value)) return { frontmatter: "", body: value };
	return { frontmatter: value.trim(), body: "" };
}

function joinMarkdownDocument(frontmatter: string, body: string) {
	const normalizedFrontmatter = frontmatter.trim();
	if (!normalizedFrontmatter) return body;
	return `${normalizedFrontmatter}\n\n${body.replace(/^\n+/, "")}`;
}

function setEditorDocument(value: string) {
	const document = splitMarkdownDocument(value);
	editorContent = value;
	editorFrontmatter = document.frontmatter;
	editorBody = document.body;
	bodySelectionLength = 0;
}

function rebuildEditorDocument() {
	editorContent = joinMarkdownDocument(editorFrontmatter, editorBody);
}

function updateFrontmatter(event: Event) {
	editorFrontmatter = (event.currentTarget as HTMLTextAreaElement).value;
	rebuildEditorDocument();
}

function updateBody(event: Event) {
	editorBody = (event.currentTarget as HTMLTextAreaElement).value;
	bodySelectionLength = 0;
	rebuildEditorDocument();
}

function updateBodySelection() {
	const start = editorTextarea?.selectionStart ?? 0;
	const end = editorTextarea?.selectionEnd ?? 0;
	bodySelectionLength = Math.max(0, end - start);
}

function isSafePreviewUrl(value: string, attribute: string) {
	const normalized = value.trim().toLowerCase();
	if (
		!normalized ||
		normalized.startsWith("#") ||
		normalized.startsWith("/") ||
		normalized.startsWith("./") ||
		normalized.startsWith("../")
	)
		return true;
	if (/^(https?:|mailto:|tel:)/.test(normalized)) return true;
	return attribute === "src" && normalized.startsWith("data:image/");
}

function escapeHtml(value: string) {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
}

function sanitizePreview(value: string) {
	if (typeof DOMParser === "undefined")
		return `<p>${escapeHtml(value).replace(/\n/g, "<br />")}</p>`;

	const document = new DOMParser().parseFromString(value, "text/html");
	document.body.querySelectorAll(blockedPreviewTags).forEach((element) => {
		element.remove();
	});

	for (const element of Array.from(document.body.querySelectorAll("*"))) {
		for (const attribute of Array.from(element.attributes)) {
			const name = attribute.name.toLowerCase();
			if (
				name.startsWith("on") ||
				name === "style" ||
				name === "srcset" ||
				name === "srcdoc"
			) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if (urlAttributes.has(name) && !isSafePreviewUrl(attribute.value, name))
				element.removeAttribute(attribute.name);
		}
		if (
			element.tagName === "A" &&
			element.getAttribute("href")?.startsWith("http")
		) {
			element.setAttribute("target", "_blank");
			element.setAttribute("rel", "noreferrer noopener");
		}
	}

	return document.body.innerHTML;
}

function renderPreview(value: string) {
	if (!value.trim()) return '<p class="preview-empty">暂无可预览内容。</p>';
	const html = marked.parse(value, {
		async: false,
		breaks: true,
		gfm: true,
	}) as string;
	return sanitizePreview(html);
}

$: previewHtml = renderPreview(editorBody);
$: frontmatterValid =
	!editorFrontmatter.trim() ||
	standaloneFrontmatterPattern.test(editorFrontmatter.trim());
$: frontmatterStatus = !editorFrontmatter.trim()
	? "未设置"
	: frontmatterValid
		? "格式有效"
		: "检查分隔线";

function resetAiAssistant() {
	aiPanelOpen = false;
	aiMode = "polish";
	aiInstruction = "";
	aiResult = "";
	aiErrorMessage = "";
	aiScopeLabel = "";
	aiSourceText = "";
	aiSourceDocument = "";
	aiSelectionStart = -1;
	aiSelectionEnd = -1;
	bodySelectionLength = 0;
}

function openAiAssistant() {
	aiPanelOpen = true;
	aiResult = "";
	aiErrorMessage = "";
	aiSourceDocument = editorBody;

	const selectionStart = editorTextarea?.selectionStart ?? -1;
	const selectionEnd = editorTextarea?.selectionEnd ?? -1;
	const selected =
		selectionStart >= 0 && selectionEnd > selectionStart
			? editorBody.slice(selectionStart, selectionEnd)
			: "";
	if (selected.trim()) {
		aiSelectionStart = selectionStart;
		aiSelectionEnd = selectionEnd;
		aiSourceText = selected;
		aiScopeLabel = `当前选区 · ${selected.length} 字符`;
	} else {
		aiSelectionStart = -1;
		aiSelectionEnd = -1;
		aiSourceText = editorBody;
		aiScopeLabel = `文章正文 · ${aiSourceText.length} 字符`;
	}

	if (!aiSourceText.trim()) aiErrorMessage = "当前没有可处理的正文。";
	else if (!aiStatus?.configured)
		aiErrorMessage = "AI 文本助手尚未在服务器配置。";
}

async function loadAiStatus() {
	try {
		aiStatus = await api<AiStatus>("/api/ai/status");
	} catch (error) {
		aiStatus = { configured: false, model: null };
		aiErrorMessage = error instanceof Error ? error.message : "AI 状态加载失败";
	}
}

async function generateAiRewrite() {
	if (!aiSourceText.trim()) return;
	if (editorBody !== aiSourceDocument) {
		aiErrorMessage = "正文已变化，请关闭助手后重新选择文本。";
		return;
	}
	if (aiMode === "custom" && !aiInstruction.trim()) {
		aiErrorMessage = "请输入具体的修改要求。";
		return;
	}
	aiBusy = true;
	aiErrorMessage = "";
	aiResult = "";
	try {
		const response = await api<AiRewrite>("/api/ai/rewrite", {
			method: "POST",
			body: JSON.stringify({
				mode: aiMode,
				instruction: aiInstruction,
				content: aiSourceText,
			}),
		});
		aiResult = response.result;
		aiStatus = { configured: true, model: response.model };
	} catch (error) {
		aiErrorMessage = error instanceof Error ? error.message : "AI 修改失败";
	} finally {
		aiBusy = false;
	}
}

async function applyAiResult() {
	if (!aiResult.trim()) return;
	if (editorBody !== aiSourceDocument) {
		aiErrorMessage = "正文在生成期间已发生变化，请重新生成以避免覆盖新内容。";
		return;
	}

	const replacement = aiResult.trim();
	let focusStart = 0;
	if (aiSelectionStart >= 0 && aiSelectionEnd > aiSelectionStart) {
		editorBody = `${editorBody.slice(0, aiSelectionStart)}${replacement}${editorBody.slice(aiSelectionEnd)}`;
		focusStart = aiSelectionStart;
	} else {
		editorBody = `${replacement}\n`;
	}
	rebuildEditorDocument();
	const focusEnd = focusStart + replacement.length;
	viewMode = "edit";
	resetAiAssistant();
	notice = "AI 建议已应用到编辑器，保存前仍可继续修改。";
	await tick();
	editorTextarea?.focus();
	editorTextarea?.setSelectionRange(focusStart, focusEnd);
	bodySelectionLength = replacement.length;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
	const response = await fetch(`/admin-api${path}`, {
		credentials: "include",
		headers: { "content-type": "application/json", ...(options.headers || {}) },
		...options,
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok)
		throw new Error(data.error || `请求失败 (${response.status})`);
	return data as T;
}

function fail(error: unknown) {
	errorMessage = error instanceof Error ? error.message : "操作失败";
	notice = "";
}

async function loadSession() {
	try {
		session = await api<Session>("/auth/session");
		if (session.authenticated) await Promise.all([loadPosts(), loadAiStatus()]);
	} catch (error) {
		fail(error);
	}
}

async function loadPosts() {
	const data = await api<{ posts: PostSummary[] }>("/api/posts");
	posts = data.posts;
	if (selectedPath && !posts.some((post) => post.path === selectedPath))
		newPost();
}

async function loadPost(path: string) {
	busy = true;
	try {
		const data = await api<PostFile>(
			`/api/post?path=${encodeURIComponent(path)}`,
		);
		selectedPath = data.path;
		editorPath = data.path.replace(/^src\/content\/posts\//, "");
		setEditorDocument(data.content);
		editorSha = data.sha;
		resetAiAssistant();
		errorMessage = "";
	} catch (error) {
		fail(error);
	} finally {
		busy = false;
	}
}

function newPost() {
	selectedPath = "";
	editorPath = `new-post-${Date.now()}.md`;
	setEditorDocument(defaultMarkdown);
	editorSha = "";
	resetAiAssistant();
}

async function savePost() {
	const path = editorPath.trim().replace(/^\/+/, "");
	if (!/^[-a-zA-Z0-9_/]+\.(md|mdx)$/.test(path))
		return fail(
			new Error("文章路径只能使用字母、数字、短横线、下划线和 .md/.mdx"),
		);
	if (!frontmatterValid)
		return fail(new Error("Frontmatter 必须以 --- 开始和结束"));
	busy = true;
	try {
		await api("/api/post", {
			method: "PUT",
			body: JSON.stringify({
				path: `src/content/posts/${path}`,
				content: editorContent,
				sha: editorSha || undefined,
				message: `${selectedPath ? "docs: update " : "docs: add "}${path}`,
			}),
		});
		notice = "文章已提交到 GitHub，OSS 部署会自动开始。";
		errorMessage = "";
		await loadPosts();
		await loadPost(`src/content/posts/${path}`);
	} catch (error) {
		fail(error);
	} finally {
		busy = false;
	}
}

async function deletePost() {
	if (!selectedPath || !confirm(`确定删除 ${editorPath} 吗？`)) return;
	busy = true;
	try {
		await api("/api/post", {
			method: "DELETE",
			body: JSON.stringify({
				path: selectedPath,
				sha: editorSha,
				message: `docs: delete ${editorPath}`,
			}),
		});
		notice = "文章已删除并提交到 GitHub。OSS 中的旧对象需要清理。";
		newPost();
		await loadPosts();
	} catch (error) {
		fail(error);
	} finally {
		busy = false;
	}
}

async function loadSettings() {
	try {
		adminConfig = await api<AdminConfig>("/api/config");
	} catch (error) {
		fail(error);
	}
}

async function saveSettings() {
	if (!adminConfig) return;
	busy = true;
	try {
		await api("/api/config", {
			method: "PUT",
			body: JSON.stringify({
				...adminConfig,
				message: "chore: update site feature settings",
			}),
		});
		notice = "功能设置已提交，构建完成后生效。";
		errorMessage = "";
	} catch (error) {
		fail(error);
	} finally {
		busy = false;
	}
}

async function loadAnalytics() {
	try {
		analytics = await api<Analytics>("/api/analytics/summary");
	} catch (error) {
		fail(error);
	}
}

async function loadDeployRuns() {
	try {
		deployRuns = (await api<{ runs: DeployRun[] }>("/api/deploy/status")).runs;
	} catch (error) {
		fail(error);
	}
}

async function dispatchDeploy() {
	busy = true;
	try {
		await api("/api/deploy", { method: "POST", body: "{}" });
		notice = "已请求重新部署。";
		await loadDeployRuns();
	} catch (error) {
		fail(error);
	} finally {
		busy = false;
	}
}

function switchTab(tab: "posts" | "settings" | "analytics") {
	activeTab = tab;
	if (tab === "settings" && !adminConfig) loadSettings();
	if (tab === "analytics") {
		loadAnalytics();
		loadDeployRuns();
	}
}

onMount(loadSession);
</script>

<svelte:head><meta name="theme-color" content="#102421" /></svelte:head>

{#if !session?.authenticated}
	<main class="shell login-shell"><section class="login-panel"><p class="eyebrow">FIREFLY ADMIN</p><h1>博客管理后台</h1><p class="muted">使用指定的 GitHub 账号登录，文章和设置会以提交的方式进入发布流程。</p><a class="primary" href="/admin-api/auth/github">使用 GitHub 登录</a>{#if errorMessage}<p class="error">{errorMessage}</p>{/if}</section></main>
{:else}
	<main class="shell">
		<header class="header"><div><p class="eyebrow">FIREFLY ADMIN</p><h1>内容与站点控制台</h1></div><div class="header-actions"><span class="user">{session.login}</span><button class="quiet" type="button" on:click={() => api("/auth/logout", { method: "POST" }).then(() => (session = null))}>退出</button></div></header>
		<nav class="tabs" aria-label="后台模块"><button class:active={activeTab === "posts"} type="button" on:click={() => switchTab("posts")}>文章</button><button class:active={activeTab === "settings"} type="button" on:click={() => switchTab("settings")}>站点能力</button><button class:active={activeTab === "analytics"} type="button" on:click={() => switchTab("analytics")}>访问与部署</button></nav>
		{#if notice}<div class="notice">{notice}</div>{/if}{#if errorMessage}<div class="error">{errorMessage}</div>{/if}

		{#if activeTab === "posts"}
			<section class="workspace">
				<aside class="panel post-list"><div class="panel-heading"><h2>Markdown 文章</h2><button class="small" type="button" on:click={newPost}>新建</button></div>{#if posts.length === 0}<p class="muted">还没有 Markdown 文章。</p>{/if}<div class="post-items">{#each posts as post}<button class="post-item" class:chosen={selectedPath === post.path} type="button" on:click={() => loadPost(post.path)}><strong>{post.title}</strong><span>{post.path.replace("src/content/posts/", "")}</span></button>{/each}</div></aside>
				<section class="panel editor">
					<div class="panel-heading"><div><h2>{selectedPath ? "编辑文章" : "新建文章"}</h2><p class="muted">元数据与正文分区编辑，保存后会提交到 GitHub 并触发 OSS 构建。</p></div><div class="actions">{#if selectedPath}<button class="danger" type="button" on:click={deletePost} disabled={busy}>删除</button>{/if}<button class="primary" type="button" on:click={savePost} disabled={busy || !frontmatterValid}>保存</button></div></div>
					<label for="post-path">文件路径</label><input id="post-path" class="input" bind:value={editorPath} placeholder="my-article.md" />
					<section class:invalid={!frontmatterValid} class="frontmatter-panel" aria-labelledby="frontmatter-title"><div class="section-heading"><div><p class="section-kicker">受保护区块</p><h3 id="frontmatter-title">Frontmatter</h3></div><span class:invalid={!frontmatterValid} class="status-badge">{frontmatterValid ? "AI 不处理" : "格式需修正"}</span></div><textarea id="post-frontmatter" class="frontmatter-editor" value={editorFrontmatter} on:input={updateFrontmatter} spellcheck="false" aria-describedby="frontmatter-status" aria-invalid={!frontmatterValid}></textarea><div id="frontmatter-status" class="field-meta"><span>{frontmatterStatus} · 标题、日期、标签等元数据</span><span>{editorFrontmatter.split("\n").length} 行</span></div></section>
					<div class="editor-toolbar"><div class="view-switcher" role="tablist" aria-label="文章视图"><button type="button" role="tab" aria-selected={viewMode === "edit"} class:active={viewMode === "edit"} on:click={() => (viewMode = "edit")}>编辑</button><button type="button" role="tab" aria-selected={viewMode === "split"} class:active={viewMode === "split"} on:click={() => (viewMode = "split")}>并排</button><button type="button" role="tab" aria-selected={viewMode === "preview"} class:active={viewMode === "preview"} on:click={() => (viewMode = "preview")}>预览</button></div><div class="editor-tools"><span class="preview-status">{bodySelectionLength ? `已选 ${bodySelectionLength} 字符` : `${editorBody.length} 字符正文`}</span><button class="small ai-trigger" type="button" on:click={openAiAssistant} disabled={aiStatus === null || viewMode === "preview"} title={viewMode === "preview" ? "切换到编辑或并排模式后选择正文" : aiStatus?.configured ? "使用 AI 修改正文选区或全文" : "需要先在服务器配置 AI 模型"}>{aiStatus?.configured ? (bodySelectionLength ? "AI 修改选区" : "AI 修改正文") : aiStatus === null ? "AI 加载中" : "AI 未配置"}</button></div></div>
					{#if aiPanelOpen}<section class="ai-assistant" aria-labelledby="ai-assistant-title"><div class="ai-heading"><div><h3 id="ai-assistant-title">AI 文本助手</h3><p>{aiScopeLabel}{#if aiStatus?.model} · {aiStatus.model}{/if}</p></div><button class="quiet" type="button" on:click={resetAiAssistant}>关闭</button></div><div class="ai-controls"><label for="ai-mode">修改方式<select id="ai-mode" class="input" bind:value={aiMode}>{#each Object.entries(aiModeLabels) as [value, label]}<option value={value}>{label}</option>{/each}</select></label><label for="ai-instruction">补充要求<textarea id="ai-instruction" class="ai-instruction" bind:value={aiInstruction} maxlength="1000" placeholder="例如：保持技术术语不变，语气更自然"></textarea></label><button class="primary ai-generate" type="button" on:click={generateAiRewrite} disabled={aiBusy || !aiSourceText.trim() || !aiStatus?.configured}>{aiBusy ? "生成中..." : "生成建议"}</button></div>{#if aiErrorMessage}<p class="ai-error" role="alert">{aiErrorMessage}</p>{/if}{#if aiResult}<div class="ai-result-heading"><div><h4>建议稿</h4><span>可先修改，再应用到编辑器</span></div><div class="actions"><button class="quiet" type="button" on:click={() => (aiResult = "")}>清空</button><button class="primary" type="button" on:click={applyAiResult}>{aiSelectionStart >= 0 ? "应用到选区" : "替换正文"}</button></div></div><textarea class="ai-result-text" bind:value={aiResult} spellcheck="false" aria-label="AI 建议稿"></textarea>{/if}</section>{/if}
					<div class:split={viewMode === "split"} class:preview-only={viewMode === "preview"} class="editor-canvas">{#if viewMode !== "preview"}<div class="editor-pane"><div class="body-heading"><label for="post-content">正文 Markdown</label><span>{bodySelectionLength ? `选中 ${bodySelectionLength} 字符` : `${editorBody.length} 字符`}</span></div><textarea id="post-content" class="markdown" bind:this={editorTextarea} value={editorBody} on:input={updateBody} on:select={updateBodySelection} on:keyup={updateBodySelection} on:mouseup={updateBodySelection} spellcheck="false" aria-describedby="body-status"></textarea><div id="body-status" class="field-meta body-meta"><span>AI 仅处理正文，不会读取 Frontmatter</span><span>选中片段后可定向修改</span></div></div>{/if}{#if viewMode !== "edit"}<article class="preview-pane" aria-label="Markdown 正文预览"><div class="markdown-preview">{@html previewHtml}</div></article>{/if}</div>
				</section>
			</section>
		{:else if activeTab === "settings"}
			<section class="panel settings"><div class="panel-heading"><div><h2>站点能力</h2><p class="muted">设置通过 GitHub 提交，下一次构建后生效。</p></div><button class="primary" type="button" on:click={saveSettings} disabled={busy || !adminConfig}>保存设置</button></div>{#if adminConfig}<label class="toggle"><span><strong>音乐播放器</strong><small>控制导航栏音乐入口和音乐功能</small></span><input type="checkbox" bind:checked={adminConfig.music.enabled} /></label><label class="toggle"><span><strong>侧栏</strong><small>控制全局侧栏布局</small></span><input type="checkbox" bind:checked={adminConfig.sidebar.enabled} /></label><h3>页面开关</h3>{#each Object.entries(adminConfig.pages) as [key, enabled]}<label class="toggle"><span><strong>{pageLabels[key] || key}</strong><small>关闭后页面返回 404 并从导航中隐藏</small></span><input type="checkbox" bind:checked={adminConfig.pages[key]} /></label>{/each}{:else}<p class="muted">正在加载设置...</p>{/if}</section>
		{:else}
			<section class="analytics-grid"><div class="panel metrics"><div class="panel-heading"><div><h2>访问统计</h2><p class="muted">最近 7 天，数据来自 Umami。</p></div><button class="small" type="button" on:click={loadAnalytics}>刷新</button></div>{#if analytics?.configured}<div class="metric-grid"><div><strong>{analytics.pageviews ?? 0}</strong><span>页面浏览</span></div><div><strong>{analytics.visitors ?? 0}</strong><span>访客</span></div><div><strong>{analytics.visits ?? 0}</strong><span>访问次数</span></div><div><strong>{analytics.bounces ?? 0}</strong><span>跳出</span></div></div>{:else}<p class="muted">{analytics?.message || "正在加载统计..."}</p>{/if}</div><div class="panel metrics"><div class="panel-heading"><div><h2>部署</h2><p class="muted">触发 GitHub Actions 的 OSS 发布工作流。</p></div><button class="primary" type="button" on:click={dispatchDeploy} disabled={busy}>重新部署</button></div>{#if deployRuns.length}<div class="runs">{#each deployRuns as run}<a href={run.url} target="_blank" rel="noreferrer"><strong>{run.name}</strong><span>{run.status} / {run.conclusion || "进行中"} · {new Date(run.createdAt).toLocaleString()}</span></a>{/each}</div>{:else}<p class="muted">暂无部署记录。</p>{/if}</div></section>
		{/if}
	</main>
{/if}

<style>
	:global(*) { box-sizing: border-box; } :global(body) { margin: 0; background: #f4f7f6; color: #13201f; font-family: Inter, ui-sans-serif, system-ui, sans-serif; } :global(button), :global(input), :global(textarea) { font: inherit; }
	.shell { min-height: 100vh; max-width: 1500px; margin: 0 auto; padding: 32px clamp(18px, 4vw, 64px) 64px; } .login-shell { display: grid; place-items: center; max-width: none; background: #102421; } .login-panel { width: min(440px, 100%); padding: 38px; border-radius: 18px; background: #fff; box-shadow: 0 24px 70px #0003; }
	.eyebrow { margin: 0 0 8px; color: #16866f; font-size: 12px; font-weight: 800; letter-spacing: .12em; } h1 { margin: 0 0 10px; font-size: clamp(28px, 4vw, 42px); } h2 { margin: 0; font-size: 20px; } h3 { margin: 26px 0 10px; color: #53716c; font-size: 14px; } .muted { color: #6c817d; line-height: 1.6; }
	.header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 28px; } .header-actions, .actions { display: flex; align-items: center; gap: 10px; } .user { padding: 8px 12px; border-radius: 999px; background: #deeee9; color: #236257; font-size: 13px; }
	.tabs { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid #d6e2df; } .tabs button { border: 0; border-bottom: 3px solid transparent; padding: 12px 16px; background: transparent; color: #638078; cursor: pointer; } .tabs button.active { border-color: #16866f; color: #0d5145; font-weight: 700; }
	.panel { border: 1px solid #dbe7e3; border-radius: 14px; background: #fff; box-shadow: 0 8px 26px #2049410f; } .workspace { display: grid; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); gap: 16px; } .post-list, .editor, .settings, .metrics { padding: 20px; } .panel-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
	.post-items { display: grid; gap: 6px; max-height: 70vh; overflow: auto; } .post-item { display: grid; gap: 4px; padding: 11px 12px; border: 1px solid transparent; border-radius: 9px; background: transparent; text-align: left; color: #23413b; cursor: pointer; } .post-item:hover, .post-item.chosen { border-color: #a9d5ca; background: #eff9f5; } .post-item span { overflow: hidden; color: #78918b; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
	.editor label, .input, .markdown, .frontmatter-editor { display: block; width: 100%; } .editor label { margin: 12px 0 6px; color: #41655d; font-size: 13px; font-weight: 700; } .input, .markdown, .frontmatter-editor { border: 1px solid #cadbd6; border-radius: 9px; background: #fbfdfc; color: #19342f; outline: none; } .input { padding: 11px 12px; } .markdown { min-height: 62vh; padding: 16px; resize: vertical; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 13px; line-height: 1.65; } .input:focus, .markdown:focus, .frontmatter-editor:focus { border-color: #16866f; box-shadow: 0 0 0 3px #16866f1f; }
	.frontmatter-panel { margin: 20px 0 4px; padding: 16px 0 14px; border-top: 1px solid #dbe7e3; border-bottom: 1px solid #dbe7e3; } .frontmatter-panel.invalid { border-color: #e6b8b2; } .section-heading, .body-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; } .section-heading h3 { margin: 0; color: #214b42; font-size: 15px; } .section-kicker { margin: 0 0 4px; color: #a13b31; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; } .status-badge { padding: 5px 8px; border-radius: 999px; background: #e4f2ee; color: #176b5a; font-size: 11px; font-weight: 700; white-space: nowrap; } .status-badge.invalid { background: #fbe8e6; color: #a13b31; } .frontmatter-editor { min-height: 168px; max-height: 280px; margin-top: 10px; padding: 13px 14px; resize: vertical; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; line-height: 1.6; } .field-meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 7px; color: #78918b; font-size: 11px; } .body-heading label { margin-bottom: 0; } .body-heading span { color: #78918b; font-size: 11px; } .body-meta { margin-bottom: 4px; }
	.editor-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 20px; } .view-switcher { display: inline-flex; padding: 3px; border: 1px solid #cfe0db; border-radius: 9px; background: #f1f7f5; } .view-switcher button { border: 0; border-radius: 6px; padding: 7px 12px; background: transparent; color: #58766e; cursor: pointer; } .view-switcher button:hover { color: #176b5a; } .view-switcher button.active { background: #fff; color: #0d5145; box-shadow: 0 1px 4px #2049411a; font-weight: 700; } .view-switcher button:focus-visible { outline: 2px solid #16866f; outline-offset: 2px; } .editor-tools { display: flex; align-items: center; gap: 10px; } .preview-status { color: #78918b; font-size: 12px; }
	.ai-assistant { margin: 16px 0 4px; padding: 18px 0; border-top: 1px solid #dbe7e3; border-bottom: 1px solid #dbe7e3; } .ai-heading, .ai-result-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; } .ai-heading h3, .ai-result-heading h4 { margin: 0; color: #214b42; font-size: 15px; } .ai-heading p, .ai-result-heading span { margin: 5px 0 0; color: #78918b; font-size: 12px; } .ai-controls { display: grid; grid-template-columns: minmax(160px, 220px) minmax(0, 1fr) auto; align-items: end; gap: 12px; margin-top: 14px; } .ai-controls label { margin: 0; } .ai-instruction, .ai-result-text { display: block; width: 100%; border: 1px solid #cadbd6; border-radius: 9px; background: #fbfdfc; color: #19342f; outline: none; } .ai-instruction { min-height: 72px; margin-top: 6px; padding: 10px 12px; resize: vertical; } .ai-result-heading { margin-top: 16px; } .ai-result-text { min-height: 220px; margin-top: 10px; padding: 14px; resize: vertical; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 13px; line-height: 1.65; } .ai-instruction:focus, .ai-result-text:focus { border-color: #16866f; box-shadow: 0 0 0 3px #16866f1f; } .ai-generate { min-height: 42px; } .ai-error { margin: 12px 0 0; color: #a13b31; font-size: 13px; }
	.editor-canvas { min-width: 0; } .editor-canvas.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; } .editor-canvas.preview-only { display: block; } .editor-pane, .preview-pane { min-width: 0; } .preview-pane { max-height: 62vh; overflow: auto; border: 1px solid #cadbd6; border-radius: 9px; background: #fff; color: #213c36; } .markdown-preview { padding: 22px 24px; line-height: 1.75; overflow-wrap: anywhere; } .markdown-preview :global(h1), .markdown-preview :global(h2), .markdown-preview :global(h3), .markdown-preview :global(h4) { margin: 0 0 12px; color: #163d35; line-height: 1.3; } .markdown-preview :global(h1) { font-size: 28px; } .markdown-preview :global(h2) { margin-top: 22px; font-size: 23px; } .markdown-preview :global(h3) { margin-top: 18px; font-size: 19px; } .markdown-preview :global(p), .markdown-preview :global(ul), .markdown-preview :global(ol), .markdown-preview :global(blockquote) { margin: 0 0 14px; } .markdown-preview :global(ul), .markdown-preview :global(ol) { padding-left: 24px; } .markdown-preview :global(a) { color: #08745f; text-decoration: underline; text-underline-offset: 2px; } .markdown-preview :global(blockquote) { padding: 10px 16px; border-left: 3px solid #7eb9aa; background: #eff8f5; color: #527069; } .markdown-preview :global(code) { padding: 2px 5px; border-radius: 4px; background: #edf3f1; color: #8a3c55; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: .9em; } .markdown-preview :global(pre) { margin: 0 0 16px; padding: 15px 17px; overflow: auto; border-radius: 8px; background: #182c28; color: #e8f5f0; } .markdown-preview :global(pre code) { padding: 0; background: transparent; color: inherit; } .markdown-preview :global(img) { display: block; max-width: 100%; height: auto; margin: 14px 0; border-radius: 8px; } .markdown-preview :global(hr) { margin: 24px 0; border: 0; border-top: 1px solid #dbe7e3; } .markdown-preview :global(table) { display: block; max-width: 100%; margin: 0 0 16px; overflow-x: auto; border-collapse: collapse; } .markdown-preview :global(th), .markdown-preview :global(td) { padding: 8px 10px; border: 1px solid #cfe0db; text-align: left; } .markdown-preview :global(th) { background: #eff8f5; } .preview-empty { color: #78918b; font-style: italic; }
	.primary, .quiet, .small, .danger { border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; text-decoration: none; white-space: nowrap; } .primary { background: #126f5c; color: #fff; } .primary:hover { background: #0b594a; } .small { background: #e4f2ee; color: #176b5a; } .quiet { background: #edf3f1; color: #466861; } .danger { background: #fbe8e6; color: #a13b31; } button:disabled { cursor: wait; opacity: .55; }
	.notice, .error { margin: 0 0 16px; padding: 12px 14px; border-radius: 9px; } .notice { background: #e6f6ee; color: #176445; } .error { background: #fff0ee; color: #a13b31; } .toggle { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 15px 0; border-bottom: 1px solid #e2ece9; } .toggle strong, .toggle small { display: block; } .toggle small { margin-top: 4px; color: #78918b; } .toggle input { width: 20px; height: 20px; accent-color: #16866f; }
	.analytics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; } .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; } .metric-grid div { padding: 16px 12px; border-radius: 10px; background: #eff9f5; } .metric-grid strong, .metric-grid span { display: block; } .metric-grid strong { font-size: 26px; color: #126f5c; } .metric-grid span { margin-top: 5px; color: #66847c; font-size: 12px; } .runs { display: grid; gap: 8px; } .runs a { display: grid; gap: 4px; padding: 10px; border-radius: 8px; background: #f3f8f6; color: #24594e; text-decoration: none; } .runs span { color: #718b84; font-size: 12px; }
	@media (max-width: 900px) { .workspace, .analytics-grid { grid-template-columns: 1fr; } .post-items { max-height: 260px; } .markdown { min-height: 55vh; } .editor-canvas.split { grid-template-columns: 1fr; } .preview-pane { max-height: none; } .ai-controls { grid-template-columns: 1fr; } .ai-generate { justify-self: start; } } @media (max-width: 560px) { .shell { padding: 22px 14px 42px; } .header { display: block; } .header-actions { margin-top: 16px; } .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .panel-heading { display: block; } .actions { margin-top: 12px; } .editor-toolbar { align-items: flex-start; flex-direction: column; } .editor-tools { justify-content: space-between; width: 100%; } .section-heading, .body-heading { align-items: flex-start; flex-direction: column; gap: 4px; } .field-meta { align-items: flex-start; flex-direction: column; gap: 3px; } .ai-heading, .ai-result-heading { flex-direction: column; } .markdown-preview { padding: 18px; } }
</style>
