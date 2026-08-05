<script lang="ts">
import { onMount } from "svelte";
import ConfigFieldEditor from "./ConfigFieldEditor.svelte";
import type {
	ConfigDocument,
	ConfigField,
	ConfigFileSummary,
	ConfigUpdate,
	JsonValue,
	ManagedConfigFile,
	SaveFileResponse,
} from "./config-types";

type SettingsSection = "features" | "music" | "files";
type AdminConfig = {
	music: { enabled: boolean };
	pages: Record<string, boolean>;
	sidebar: { enabled: boolean };
	_sha?: string | null;
};
type MusicTrack = {
	name: string;
	artist: string;
	url: string;
	cover: string;
	lrc: string;
};
type MusicSettings = {
	mode: "meting" | "local";
	volume: number;
	playMode: "list" | "one" | "random";
	showLyrics: boolean;
	showInNavbar: boolean;
	showInSidebar: boolean;
	meting: {
		api: string;
		server: "netease" | "tencent" | "kugou" | "xiami" | "baidu";
		type: "song" | "playlist" | "album" | "search" | "artist";
		id: string;
		auth: string;
		fallbackApis: string[];
	};
	local: { playlist: MusicTrack[] };
};
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
const groupLabels: Record<string, string> = {
	core: "站点核心",
	media: "媒体",
	appearance: "外观",
	content: "内容",
	integrations: "集成",
};

let section: SettingsSection = "features";
let featureConfig: AdminConfig | null = null;
let featureSnapshot = "";
let catalog: ConfigFileSummary[] = [];
let musicSettings: MusicSettings | null = null;
let musicSha = "";
let musicSnapshot = "";
let musicDocument: ConfigDocument | null = null;
let selectedFile: ManagedConfigFile | null = null;
let fileOriginalValues: Record<string, JsonValue> = {};
let fileUpdates: Record<string, JsonValue> = {};
let fileFilter = "";
let busy = false;
let loadingFile = false;
let notice = "";
let errorMessage = "";

$: featureDirty = Boolean(
	featureConfig && featureSnapshot !== JSON.stringify(featureConfig),
);
$: musicDirty = Boolean(
	musicSettings && musicSnapshot !== JSON.stringify(musicSettings),
);
$: fileDirty = Boolean(selectedFile && Object.keys(fileUpdates).length > 0);
$: filteredCatalog = catalog.filter((file) => {
	const query = fileFilter.trim().toLowerCase();
	return (
		!query ||
		file.name.toLowerCase().includes(query) ||
		file.path.toLowerCase().includes(query) ||
		file.description.toLowerCase().includes(query)
	);
});
$: catalogGroups = Object.entries(groupLabels)
	.map(([key, label]) => ({
		key,
		label,
		files: filteredCatalog.filter((file) => file.group === key),
	}))
	.filter((group) => group.files.length > 0);

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

function startAction() {
	busy = true;
	notice = "";
	errorMessage = "";
}

function fail(error: unknown) {
	errorMessage = error instanceof Error ? error.message : "操作失败";
	notice = "";
}

function cloneValue<T extends JsonValue>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function fieldValue(field: ConfigField): JsonValue | undefined {
	if (field.editable && field.value !== undefined)
		return cloneValue(field.value);
	if (field.kind !== "object") return undefined;
	const value: Record<string, JsonValue> = {};
	for (const child of field.children || []) {
		const childValue = fieldValue(child);
		if (childValue !== undefined) value[child.key] = childValue;
	}
	return value;
}

function documentValue(document: ConfigDocument) {
	const root = document.sections[0]?.field;
	if (!root) throw new Error("配置字段为空");
	const value = fieldValue(root);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("配置字段结构无效");
	return value;
}

function collectFieldValues(document: ConfigDocument) {
	const values: Record<string, JsonValue> = {};
	function visit(field: ConfigField) {
		if (field.editable && field.value !== undefined)
			values[field.path] = cloneValue(field.value);
		for (const child of field.children || []) visit(child);
	}
	for (const item of document.sections) visit(item.field);
	return values;
}

function updateDocumentField(
	document: ConfigDocument,
	path: string,
	value: JsonValue,
) {
	function visit(field: ConfigField): boolean {
		if (field.path === path && field.editable) {
			field.value = cloneValue(value);
			return true;
		}
		return (field.children || []).some(visit);
	}
	if (!document.sections.some((item) => visit(item.field)))
		throw new Error("配置字段不存在或不可编辑");
}

function collectValueUpdates(
	field: ConfigField,
	nextValue: JsonValue | undefined,
	updates: ConfigUpdate[],
) {
	if (field.editable) {
		if (
			field.value !== undefined &&
			nextValue !== undefined &&
			JSON.stringify(field.value) !== JSON.stringify(nextValue)
		)
			updates.push({ path: field.path, value: cloneValue(nextValue) });
		return;
	}
	if (
		field.kind !== "object" ||
		!nextValue ||
		typeof nextValue !== "object" ||
		Array.isArray(nextValue)
	)
		return;
	for (const child of field.children || [])
		collectValueUpdates(child, nextValue[child.key], updates);
}

function updateSelectedField(path: string, value: JsonValue) {
	if (!selectedFile) return;
	const document = structuredClone(selectedFile.document);
	updateDocumentField(document, path, value);
	const updates = { ...fileUpdates, [path]: cloneValue(value) };
	if (JSON.stringify(fileOriginalValues[path]) === JSON.stringify(value))
		delete updates[path];
	fileUpdates = updates;
	selectedFile = { ...selectedFile, document };
}

async function loadFeatureConfig() {
	featureConfig = await api<AdminConfig>("/api/config");
	featureSnapshot = JSON.stringify(featureConfig);
}

async function loadCatalog() {
	catalog = (await api<{ files: ConfigFileSummary[] }>("/api/config/files"))
		.files;
}

async function getManagedFile(key: string) {
	return api<ManagedConfigFile>(
		`/api/config/file?key=${encodeURIComponent(key)}`,
	);
}

async function loadMusicSettings() {
	const file = await getManagedFile("music-settings");
	const parsed = documentValue(file.document) as unknown as MusicSettings;
	musicSettings = parsed;
	musicSha = file.sha;
	musicDocument = file.document;
	musicSnapshot = JSON.stringify(parsed);
}

async function loadWorkspace() {
	busy = true;
	try {
		await Promise.all([
			loadFeatureConfig(),
			loadCatalog(),
			loadMusicSettings(),
		]);
	} catch (error) {
		fail(error);
	} finally {
		busy = false;
	}
}

async function saveFeatureConfig() {
	if (!featureConfig || !featureDirty) return;
	startAction();
	try {
		featureConfig = await api<AdminConfig>("/api/config", {
			method: "PUT",
			body: JSON.stringify({
				...featureConfig,
				message: "chore: update site feature settings",
			}),
		});
		featureSnapshot = JSON.stringify(featureConfig);
		notice = "功能开关已提交，部署完成后生效。";
	} catch (error) {
		fail(error);
	} finally {
		busy = false;
	}
}

function musicUpdates() {
	if (!musicSettings || !musicDocument) throw new Error("音乐设置尚未加载");
	if (musicSettings.mode === "local") {
		for (const [index, track] of musicSettings.local.playlist.entries()) {
			if (!track.name.trim() || !track.artist.trim() || !track.url.trim())
				throw new Error(`第 ${index + 1} 首歌曲缺少名称、艺术家或音频地址`);
		}
	}
	const updates: ConfigUpdate[] = [];
	const root = musicDocument.sections[0]?.field;
	if (!root) throw new Error("音乐配置字段为空");
	collectValueUpdates(root, musicSettings as unknown as JsonValue, updates);
	return updates;
}

async function saveMusicSettings() {
	if (!musicSettings || !musicDirty) return;
	startAction();
	try {
		const updates = musicUpdates();
		if (!updates.length) return;
		const result = await api<SaveFileResponse>("/api/config/file", {
			method: "PUT",
			body: JSON.stringify({
				key: "music-settings",
				sha: musicSha,
				updates,
			}),
		});
		if (result.sha) musicSha = result.sha;
		musicDocument = result.document;
		musicSettings = documentValue(result.document) as unknown as MusicSettings;
		musicSnapshot = JSON.stringify(musicSettings);
		notice = "音乐设置已提交，部署完成后生效。";
		if (selectedFile?.key === "music-settings") {
			selectedFile = {
				...selectedFile,
				sha: musicSha,
				document: result.document,
			};
			fileOriginalValues = collectFieldValues(result.document);
			fileUpdates = {};
		}
	} catch (error) {
		fail(error);
	} finally {
		busy = false;
	}
}

function addFallbackApi() {
	if (!musicSettings) return;
	musicSettings = {
		...musicSettings,
		meting: {
			...musicSettings.meting,
			fallbackApis: [...musicSettings.meting.fallbackApis, "https://"],
		},
	};
}

function removeFallbackApi(index: number) {
	if (!musicSettings) return;
	musicSettings = {
		...musicSettings,
		meting: {
			...musicSettings.meting,
			fallbackApis: musicSettings.meting.fallbackApis.filter(
				(_, itemIndex) => itemIndex !== index,
			),
		},
	};
}

function addTrack() {
	if (!musicSettings) return;
	musicSettings = {
		...musicSettings,
		local: {
			playlist: [
				...musicSettings.local.playlist,
				{ name: "", artist: "", url: "", cover: "", lrc: "" },
			],
		},
	};
}

function removeTrack(index: number) {
	if (!musicSettings) return;
	musicSettings = {
		...musicSettings,
		local: {
			playlist: musicSettings.local.playlist.filter(
				(_, itemIndex) => itemIndex !== index,
			),
		},
	};
}

function moveTrack(index: number, direction: -1 | 1) {
	if (!musicSettings) return;
	const target = index + direction;
	if (target < 0 || target >= musicSettings.local.playlist.length) return;
	const playlist = [...musicSettings.local.playlist];
	[playlist[index], playlist[target]] = [playlist[target], playlist[index]];
	musicSettings = { ...musicSettings, local: { playlist } };
}

async function selectConfigFile(key: string) {
	if (selectedFile?.key === key) return;
	if (fileDirty && !confirm("当前文件有未保存修改，确定切换吗？")) return;
	loadingFile = true;
	notice = "";
	errorMessage = "";
	try {
		selectedFile = await getManagedFile(key);
		fileOriginalValues = collectFieldValues(selectedFile.document);
		fileUpdates = {};
	} catch (error) {
		fail(error);
	} finally {
		loadingFile = false;
	}
}

async function saveConfigFile() {
	if (!selectedFile || !fileDirty) return;
	startAction();
	try {
		const updates = Object.entries(fileUpdates).map(([path, value]) => ({
			path,
			value,
		}));
		const result = await api<SaveFileResponse>("/api/config/file", {
			method: "PUT",
			body: JSON.stringify({
				key: selectedFile.key,
				sha: selectedFile.sha,
				updates,
			}),
		});
		selectedFile = {
			...selectedFile,
			sha: result.sha || selectedFile.sha,
			document: result.document,
		};
		fileOriginalValues = collectFieldValues(result.document);
		fileUpdates = {};
		notice = `${selectedFile.name}已提交，部署完成后生效。`;
		if (selectedFile.key === "music-settings") {
			musicSha = selectedFile.sha;
			musicDocument = result.document;
			musicSettings = documentValue(
				result.document,
			) as unknown as MusicSettings;
			musicSnapshot = JSON.stringify(musicSettings);
		}
	} catch (error) {
		fail(error);
	} finally {
		busy = false;
	}
}

async function reloadSelectedFile() {
	if (!selectedFile) return;
	if (fileDirty && !confirm("确定放弃当前文件的修改吗？")) return;
	await selectConfigFileAfterReset(selectedFile.key);
}

async function selectConfigFileAfterReset(key: string) {
	fileUpdates = {};
	selectedFile = null;
	await selectConfigFile(key);
}

function switchSection(next: SettingsSection) {
	section = next;
	if (next === "files" && !selectedFile && catalog.length)
		selectConfigFile(catalog[0].key);
}

onMount(loadWorkspace);
</script>

<section class="config-workspace" aria-labelledby="config-title">
	<header class="config-header">
		<div>
			<p class="kicker">CONFIGURATION</p>
			<h2 id="config-title">站点配置中心</h2>
		</div>
		<div class="coverage" aria-label="配置覆盖状态">
			<strong>{catalog.length || 24}</strong>
			<span>配置源</span>
		</div>
	</header>

	<nav class="section-tabs" aria-label="配置模块">
		<button
			type="button"
			class:active={section === "features"}
			aria-current={section === "features" ? "page" : undefined}
			on:click={() => switchSection("features")}>功能开关</button
		>
		<button
			type="button"
			class:active={section === "music"}
			aria-current={section === "music" ? "page" : undefined}
			on:click={() => switchSection("music")}>音乐播放器</button
		>
		<button
			type="button"
			class:active={section === "files"}
			aria-current={section === "files" ? "page" : undefined}
			on:click={() => switchSection("files")}>全部配置</button
		>
	</nav>

	<div class="status-region" aria-live="polite" aria-atomic="true">
		{#if notice}<p class="status success">{notice}</p>{/if}
		{#if errorMessage}<p class="status failure" role="alert">{errorMessage}</p>{/if}
	</div>

	{#if section === "features"}
		<section class="config-section" aria-labelledby="features-title">
			<div class="section-title-row">
				<div><h3 id="features-title">功能开关</h3><span>adminOverrides.json</span></div>
				<button
					class="primary"
					type="button"
					on:click={saveFeatureConfig}
					disabled={busy || !featureDirty}>保存开关</button
				>
			</div>
			{#if featureConfig}
				<div class="setting-list">
					<label class="toggle-row">
						<span><strong>音乐播放器</strong><small>全站主开关</small></span>
						<input type="checkbox" bind:checked={featureConfig.music.enabled} />
					</label>
					<label class="toggle-row">
						<span><strong>侧栏</strong><small>全局布局开关</small></span>
						<input type="checkbox" bind:checked={featureConfig.sidebar.enabled} />
					</label>
				</div>
				<h4>页面</h4>
				<div class="toggle-grid">
					{#each Object.entries(featureConfig.pages) as [key]}
						<label class="toggle-row compact">
							<span><strong>{pageLabels[key] || key}</strong><small>{key}</small></span>
							<input type="checkbox" bind:checked={featureConfig.pages[key]} />
						</label>
					{/each}
				</div>
			{:else}
				<p class="empty-state">正在加载功能开关...</p>
			{/if}
		</section>
	{:else if section === "music"}
		<section class="config-section" aria-labelledby="music-title">
			<div class="section-title-row">
				<div><h3 id="music-title">音乐播放器</h3><span>musicSettings.json</span></div>
				<button
					class="primary"
					type="button"
					on:click={saveMusicSettings}
					disabled={busy || !musicDirty}>保存音乐设置</button
				>
			</div>
			{#if musicSettings}
				<div class="field-band">
					<div class="field-group span-2">
						<span class="field-label">音源模式</span>
						<div class="segmented" aria-label="音源模式">
							<button type="button" class:active={musicSettings.mode === "meting"} aria-pressed={musicSettings.mode === "meting"} on:click={() => (musicSettings.mode = "meting")}>Meting</button>
							<button type="button" class:active={musicSettings.mode === "local"} aria-pressed={musicSettings.mode === "local"} on:click={() => (musicSettings.mode = "local")}>本地列表</button>
						</div>
					</div>
					<label class="range-field" for="music-volume">
						<span>默认音量 <strong>{Math.round(musicSettings.volume * 100)}%</strong></span>
						<input id="music-volume" type="range" min="0" max="1" step="0.05" bind:value={musicSettings.volume} />
					</label>
					<div class="field-group span-2">
						<span class="field-label">播放模式</span>
						<div class="segmented" aria-label="播放模式">
							<button type="button" class:active={musicSettings.playMode === "list"} aria-pressed={musicSettings.playMode === "list"} on:click={() => (musicSettings.playMode = "list")}>列表循环</button>
							<button type="button" class:active={musicSettings.playMode === "one"} aria-pressed={musicSettings.playMode === "one"} on:click={() => (musicSettings.playMode = "one")}>单曲循环</button>
							<button type="button" class:active={musicSettings.playMode === "random"} aria-pressed={musicSettings.playMode === "random"} on:click={() => (musicSettings.playMode = "random")}>随机播放</button>
						</div>
					</div>
				</div>

				<div class="toggle-grid music-toggles">
					<label class="toggle-row compact"><span><strong>显示歌词</strong><small>歌词面板</small></span><input type="checkbox" bind:checked={musicSettings.showLyrics} /></label>
					<label class="toggle-row compact"><span><strong>导航栏入口</strong><small>桌面与移动导航</small></span><input type="checkbox" bind:checked={musicSettings.showInNavbar} /></label>
					<label class="toggle-row compact"><span><strong>侧栏播放器</strong><small>侧栏组件</small></span><input type="checkbox" bind:checked={musicSettings.showInSidebar} /></label>
				</div>

				{#if musicSettings.mode === "meting"}
					<div class="subsection-heading"><h4>Meting 音源</h4><span>{musicSettings.meting.server}</span></div>
					<div class="form-grid">
						<label class="span-2" for="meting-api">API 地址<input id="meting-api" type="url" bind:value={musicSettings.meting.api} /></label>
						<label for="meting-server">音乐平台<select id="meting-server" bind:value={musicSettings.meting.server}><option value="netease">网易云音乐</option><option value="tencent">QQ 音乐</option><option value="kugou">酷狗音乐</option><option value="xiami">虾米音乐</option><option value="baidu">百度音乐</option></select></label>
						<label for="meting-type">资源类型<select id="meting-type" bind:value={musicSettings.meting.type}><option value="song">单曲</option><option value="playlist">歌单</option><option value="album">专辑</option><option value="search">搜索</option><option value="artist">艺术家</option></select></label>
						<label for="meting-id">资源 ID / 关键词<input id="meting-id" bind:value={musicSettings.meting.id} /></label>
						<label for="meting-auth">公开认证参数<input id="meting-auth" bind:value={musicSettings.meting.auth} autocomplete="off" /></label>
					</div>
					<div class="subsection-heading"><h4>备用 API</h4><button class="small" type="button" on:click={addFallbackApi}>+ 添加</button></div>
					<div class="repeat-list">
						{#each musicSettings.meting.fallbackApis as _, index}
							<div class="inline-editor"><label for={`fallback-${index}`}>地址 {index + 1}</label><input id={`fallback-${index}`} type="url" bind:value={musicSettings.meting.fallbackApis[index]} /><button class="icon-button danger" type="button" title="删除备用 API" aria-label={`删除备用 API ${index + 1}`} on:click={() => removeFallbackApi(index)}>×</button></div>
						{/each}
					</div>
				{:else}
					<div class="subsection-heading"><h4>本地歌曲</h4><button class="small" type="button" on:click={addTrack}>+ 添加歌曲</button></div>
					<div class="track-list">
						{#each musicSettings.local.playlist as track, index}
							<section class="track-row" aria-labelledby={`track-title-${index}`}>
								<div class="track-index"><strong id={`track-title-${index}`}>{index + 1}</strong><div><button type="button" title="上移" aria-label={`上移第 ${index + 1} 首歌曲`} disabled={index === 0} on:click={() => moveTrack(index, -1)}>↑</button><button type="button" title="下移" aria-label={`下移第 ${index + 1} 首歌曲`} disabled={index === musicSettings.local.playlist.length - 1} on:click={() => moveTrack(index, 1)}>↓</button></div></div>
								<div class="form-grid track-fields">
									<label for={`track-name-${index}`}>歌曲名称<input id={`track-name-${index}`} bind:value={track.name} /></label>
									<label for={`track-artist-${index}`}>艺术家<input id={`track-artist-${index}`} bind:value={track.artist} /></label>
									<label class="span-2" for={`track-url-${index}`}>音频地址<input id={`track-url-${index}`} bind:value={track.url} /></label>
									<label for={`track-cover-${index}`}>封面地址<input id={`track-cover-${index}`} bind:value={track.cover} /></label>
									<label for={`track-lrc-${index}`}>歌词文件 / LRC<input id={`track-lrc-${index}`} bind:value={track.lrc} /></label>
								</div>
								<button class="icon-button danger" type="button" title="删除歌曲" aria-label={`删除第 ${index + 1} 首歌曲`} on:click={() => removeTrack(index)}>×</button>
							</section>
						{/each}
						{#if musicSettings.local.playlist.length === 0}<p class="empty-state">本地歌曲列表为空。</p>{/if}
					</div>
				{/if}
			{:else}
				<p class="empty-state">正在加载音乐设置...</p>
			{/if}
		</section>
	{:else}
		<section class="file-workspace" aria-labelledby="files-title">
			<aside class="file-sidebar">
				<div class="file-sidebar-heading"><h3 id="files-title">全部配置</h3><span>{filteredCatalog.length}/{catalog.length}</span></div>
				<label class="search-field" for="config-search"><span>筛选</span><input id="config-search" type="search" bind:value={fileFilter} placeholder="名称或路径" /></label>
				<div class="file-list">
					{#each catalogGroups as group}
						<section aria-labelledby={`group-${group.key}`}>
							<h4 id={`group-${group.key}`}>{group.label}</h4>
							{#each group.files as file}
								<button type="button" class:active={selectedFile?.key === file.key} on:click={() => selectConfigFile(file.key)}><strong>{file.name}</strong><span>{file.description}</span></button>
							{/each}
						</section>
					{/each}
				</div>
			</aside>
			<section class="file-editor">
				{#if selectedFile}
					<div class="section-title-row file-title-row">
						<div><h3>{selectedFile.name}</h3><p>{selectedFile.description}</p></div>
						<div class="file-actions"><button class="quiet" type="button" on:click={reloadSelectedFile} disabled={busy || loadingFile}>重新加载</button><button class="primary" type="button" on:click={saveConfigFile} disabled={busy || loadingFile || !fileDirty}>保存设置</button></div>
					</div>
					<div class="file-meta"><span>{selectedFile.document.editableFieldCount} 个可编辑字段</span>{#if fileDirty}<strong>{Object.keys(fileUpdates).length} 项未保存</strong>{/if}</div>
					<div class="document-form" aria-busy={busy || loadingFile}>
						{#each selectedFile.document.sections as configSection}
							<section class="document-section" aria-labelledby={selectedFile.document.sections.length > 1 ? `config-section-${configSection.key}` : undefined} aria-label={selectedFile.document.sections.length === 1 ? configSection.label : undefined}>
								{#if selectedFile.document.sections.length > 1}<h4 id={`config-section-${configSection.key}`}>{configSection.label}</h4>{/if}
								<ConfigFieldEditor field={configSection.field} disabled={busy || loadingFile} onChange={updateSelectedField} />
							</section>
						{/each}
						{#if selectedFile.document.editableFieldCount === 0}
							<p class="empty-state">当前配置由代码生成。</p>
						{/if}
					</div>
				{:else if loadingFile}
					<p class="empty-state">正在加载配置文件...</p>
				{:else}
					<p class="empty-state">选择一个配置文件。</p>
				{/if}
			</section>
		</section>
	{/if}
</section>

<style>
	:global(*) { box-sizing: border-box; }
	.config-workspace { min-width: 0; overflow: hidden; border: 1px solid #d8e1df; border-radius: 8px; background: #fff; box-shadow: 0 8px 28px #243b5310; }
	.config-header { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 22px 24px 18px; border-bottom: 1px solid #e2e8e6; background: #fbfcfc; }
	.config-header h2, .config-section h3, .file-sidebar h3, .file-editor h3 { margin: 0; color: #182522; letter-spacing: 0; }
	.config-header h2 { font-size: 21px; }
	.kicker { margin: 0 0 5px; color: #246b60; font-size: 11px; font-weight: 800; letter-spacing: 0; }
	.coverage { display: flex; align-items: baseline; gap: 7px; color: #5e6e6a; }
	.coverage strong { color: #176b5a; font-size: 25px; }
	.coverage span { font-size: 12px; }
	.section-tabs { display: flex; min-height: 46px; padding: 0 18px; overflow-x: auto; border-bottom: 1px solid #e2e8e6; background: #fff; }
	.section-tabs button { min-width: max-content; border: 0; border-bottom: 2px solid transparent; padding: 0 16px; background: transparent; color: #61706d; cursor: pointer; }
	.section-tabs button:hover { color: #174f45; }
	.section-tabs button.active { border-color: #16866f; color: #115b4e; font-weight: 750; }
	.section-tabs button:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #1976a3; outline-offset: 2px; }
	.status-region { padding: 0 24px; }
	.status { margin: 14px 0 0; padding: 10px 12px; border-radius: 6px; font-size: 13px; }
	.status.success { border: 1px solid #a9d9c7; background: #ebf8f2; color: #185f46; }
	.status.failure { border: 1px solid #edb6ae; background: #fff1ef; color: #9c3429; }
	.config-section { padding: 24px; }
	.section-title-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 20px; }
	.section-title-row h3, .file-sidebar h3, .file-editor h3 { font-size: 18px; }
	.section-title-row span, .file-sidebar-heading span { display: block; margin-top: 5px; color: #76827f; font-family: ui-monospace, monospace; font-size: 11px; }
	.primary, .small, .quiet, .icon-button, .track-index button { border: 0; border-radius: 6px; cursor: pointer; }
	.primary { padding: 10px 14px; background: #126f5c; color: #fff; font-weight: 700; }
	.primary:hover { background: #0b594a; }
	.small, .quiet { padding: 8px 11px; }
	.small { background: #e6f3ef; color: #176453; }
	.quiet { background: #eef1f3; color: #3c5260; }
	button:disabled { cursor: not-allowed; opacity: .48; }
	.setting-list { border-top: 1px solid #e3e8e7; }
	.toggle-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-top: 1px solid #e3e8e7; }
	.toggle-row { display: flex; min-height: 68px; justify-content: space-between; align-items: center; gap: 16px; padding: 13px 4px; border-bottom: 1px solid #e3e8e7; }
	.toggle-grid .toggle-row:nth-child(odd) { padding-right: 22px; border-right: 1px solid #e3e8e7; }
	.toggle-grid .toggle-row:nth-child(even) { padding-left: 22px; }
	.toggle-row strong, .toggle-row small { display: block; }
	.toggle-row strong { color: #263633; font-size: 14px; }
	.toggle-row small { margin-top: 4px; color: #7a8885; font-size: 11px; }
	.toggle-row input { width: 20px; height: 20px; flex: 0 0 auto; accent-color: #16866f; }
	h4 { margin: 24px 0 10px; color: #53635f; font-size: 12px; letter-spacing: 0; }
	.field-band { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(240px, .8fr); gap: 22px; padding: 18px; border: 1px solid #dce4e2; border-radius: 7px; background: #f8faf9; }
	.field-group, .range-field { min-width: 0; }
	.field-label, .range-field > span { display: flex; justify-content: space-between; margin-bottom: 8px; color: #43534f; font-size: 12px; font-weight: 700; }
	.range-field input { width: 100%; accent-color: #16866f; }
	.segmented { display: inline-flex; max-width: 100%; padding: 3px; border: 1px solid #ccd8d5; border-radius: 7px; background: #eef3f1; }
	.segmented button { min-height: 34px; border: 0; border-radius: 5px; padding: 6px 12px; background: transparent; color: #556662; cursor: pointer; white-space: nowrap; }
	.segmented button.active { background: #fff; color: #115b4e; box-shadow: 0 1px 4px #223b351a; font-weight: 700; }
	.music-toggles { margin-top: 22px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
	.music-toggles .toggle-row { padding-right: 16px; padding-left: 16px; border-right: 1px solid #e3e8e7; }
	.music-toggles .toggle-row:last-child { border-right: 0; }
	.subsection-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 26px; border-bottom: 1px solid #dce4e2; }
	.subsection-heading h4 { margin: 0; padding: 0 0 10px; color: #293a36; font-size: 14px; }
	.subsection-heading span { color: #687a75; font-family: ui-monospace, monospace; font-size: 11px; }
	.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px; margin-top: 16px; }
	.form-grid label, .search-field { display: grid; gap: 6px; color: #4a5d58; font-size: 12px; font-weight: 700; }
	.span-2 { grid-column: 1 / -1; }
	.form-grid input, .form-grid select, .inline-editor input, .search-field input { min-width: 0; width: 100%; height: 40px; border: 1px solid #cbd7d4; border-radius: 6px; padding: 8px 10px; background: #fff; color: #20322e; }
	.repeat-list, .track-list { display: grid; gap: 10px; margin-top: 14px; }
	.inline-editor { display: grid; grid-template-columns: 76px minmax(0, 1fr) 34px; align-items: center; gap: 10px; }
	.inline-editor label { color: #65736f; font-size: 11px; }
	.icon-button { width: 34px; height: 34px; padding: 0; font-size: 18px; }
	.icon-button.danger { background: #fbeae7; color: #a33d32; }
	.track-row { display: grid; grid-template-columns: 42px minmax(0, 1fr) 34px; align-items: start; gap: 13px; padding: 16px 0; border-bottom: 1px solid #e1e7e5; }
	.track-index { display: grid; justify-items: center; gap: 8px; color: #176b5a; }
	.track-index > div { display: flex; gap: 3px; }
	.track-index button { width: 19px; height: 24px; padding: 0; background: #edf2f1; color: #485c57; }
	.track-fields { margin-top: 0; }
	.empty-state { margin: 28px 0; color: #74837f; }
	.file-workspace { display: grid; grid-template-columns: 270px minmax(0, 1fr); min-height: 680px; }
	.file-sidebar { min-width: 0; padding: 20px 14px; border-right: 1px solid #dce4e2; background: #f7f9f9; }
	.file-sidebar-heading { display: flex; align-items: baseline; justify-content: space-between; padding: 0 6px; }
	.search-field { margin: 16px 6px; }
	.file-list { max-height: 610px; overflow-y: auto; padding-right: 2px; }
	.file-list h4 { margin: 18px 7px 7px; color: #77847f; font-size: 10px; }
	.file-list button { display: grid; width: 100%; gap: 3px; border: 1px solid transparent; border-radius: 6px; padding: 9px 10px; background: transparent; color: #2e403c; text-align: left; cursor: pointer; }
	.file-list button:hover { background: #edf3f1; }
	.file-list button.active { border-color: #9fc9be; background: #e5f3ef; color: #115b4e; }
	.file-list button strong { font-size: 13px; }
	.file-list button span { display: -webkit-box; overflow: hidden; color: #788681; font-size: 10px; line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
	.file-editor { min-width: 0; padding: 22px; }
	.file-title-row { align-items: center; }
	.file-title-row p { max-width: 620px; margin: 6px 0 0; color: #70807b; font-size: 12px; line-height: 1.5; }
	.file-actions { display: flex; gap: 8px; }
	.file-meta { display: flex; align-items: center; gap: 12px; margin-bottom: 9px; color: #72817d; font-size: 10px; }
	.file-meta strong { padding: 3px 6px; border-radius: 4px; background: #fff1d9; color: #8a5b0d; }
	.document-form { display: grid; gap: 24px; padding-top: 8px; }
	.document-section { min-width: 0; padding-bottom: 24px; border-bottom: 1px solid #dfe6e4; }
	.document-section:last-child { border-bottom: 0; }
	.document-section > h4 { margin: 0 0 16px; color: #263a35; font-size: 14px; }
	@media (max-width: 900px) {
		.file-workspace { grid-template-columns: 220px minmax(0, 1fr); }
		.music-toggles { grid-template-columns: 1fr; }
		.music-toggles .toggle-row { border-right: 0; }
	}
	@media (max-width: 700px) {
		.config-header, .config-section, .file-editor { padding-right: 16px; padding-left: 16px; }
		.section-tabs { padding: 0 6px; }
		.toggle-grid, .field-band, .form-grid, .file-workspace { grid-template-columns: 1fr; }
		.toggle-grid .toggle-row:nth-child(odd), .toggle-grid .toggle-row:nth-child(even) { padding-right: 4px; padding-left: 4px; border-right: 0; }
		.file-sidebar { border-right: 0; border-bottom: 1px solid #dce4e2; }
		.file-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 300px; gap: 8px; }
		.file-list section { min-width: 0; }
		.section-title-row { align-items: stretch; flex-direction: column; }
		.file-actions { width: 100%; }
		.file-actions button { flex: 1; }
		.track-row { grid-template-columns: 36px minmax(0, 1fr); }
		.track-row > .icon-button { grid-column: 2; justify-self: end; }
		.inline-editor { grid-template-columns: minmax(0, 1fr) 34px; }
		.inline-editor label { grid-column: 1 / -1; }
	}
</style>
