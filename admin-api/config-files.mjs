const STRING_LIMIT = 4_000;
const CONFIG_FILE_LIMIT = 300_000;

export const CONFIG_FILES = [
	{
		key: "site",
		path: "src/config/siteConfig.ts",
		name: "站点基础",
		group: "core",
		language: "typescript",
		description: "标题、主题、布局、文章页与 SEO 基础设置",
		expectedToken: "export const siteConfig",
	},
	{
		key: "profile",
		path: "src/config/profileConfig.ts",
		name: "个人资料",
		group: "core",
		language: "typescript",
		description: "头像、名称、简介与社交链接",
		expectedToken: "export const profileConfig",
	},
	{
		key: "navbar",
		path: "src/config/navBarConfig.ts",
		name: "导航栏",
		group: "core",
		language: "typescript",
		description: "导航链接、搜索与链接预设",
		expectedToken: "export const navBarConfig",
	},
	{
		key: "sidebar",
		path: "src/config/sidebarConfig.ts",
		name: "侧栏布局",
		group: "core",
		language: "typescript",
		description: "侧栏组件、顺序和页面布局",
		expectedToken: "export const sidebarLayoutConfig",
	},
	{
		key: "footer",
		path: "src/config/footerConfig.ts",
		name: "页脚",
		group: "core",
		language: "typescript",
		description: "页脚行为与自定义内容开关",
		expectedToken: "export const footerConfig",
	},
	{
		key: "footer-html",
		path: "src/config/FooterConfig.html",
		name: "页脚 HTML",
		group: "core",
		language: "html",
		description: "备案号等页脚自定义标记",
	},
	{
		key: "music-settings",
		path: "src/config/musicSettings.json",
		name: "音乐播放器数据",
		group: "media",
		language: "json",
		description: "播放来源、音量、循环模式和本地歌曲",
		validator: "music",
	},
	{
		key: "music-adapter",
		path: "src/config/musicConfig.ts",
		name: "音乐播放器适配器",
		group: "media",
		language: "typescript",
		description: "音乐数据与站点总开关的代码接线",
		expectedToken: "export const musicPlayerConfig",
	},
	{
		key: "background",
		path: "src/config/backgroundWallpaper.ts",
		name: "背景壁纸",
		group: "appearance",
		language: "typescript",
		description: "壁纸、横幅文字与水波纹效果",
		expectedToken: "export const backgroundWallpaper",
	},
	{
		key: "cover",
		path: "src/config/coverImageConfig.ts",
		name: "封面图片",
		group: "appearance",
		language: "typescript",
		description: "文章封面图来源与显示规则",
		expectedToken: "export const coverImageConfig",
	},
	{
		key: "fonts",
		path: "src/config/fontConfig.ts",
		name: "字体",
		group: "appearance",
		language: "typescript",
		description: "字体列表与各区域字体选择",
		expectedToken: "export const fontConfig",
	},
	{
		key: "effects",
		path: "src/config/effectsConfig.ts",
		name: "页面特效",
		group: "appearance",
		language: "typescript",
		description: "樱花等全局视觉效果",
		expectedToken: "export const sakuraConfig",
	},
	{
		key: "announcement",
		path: "src/config/announcementConfig.ts",
		name: "公告",
		group: "content",
		language: "typescript",
		description: "公告内容、样式和展示行为",
		expectedToken: "export const announcementConfig",
	},
	{
		key: "friends",
		path: "src/config/friendsConfig.ts",
		name: "友链",
		group: "content",
		language: "typescript",
		description: "友链页面设置和站点列表",
		expectedToken: "export const friendsConfig",
	},
	{
		key: "gallery",
		path: "src/config/galleryConfig.ts",
		name: "相册",
		group: "content",
		language: "typescript",
		description: "相册页面与图片源配置",
		expectedToken: "export const galleryConfig",
	},
	{
		key: "sponsor",
		path: "src/config/sponsorConfig.ts",
		name: "赞助",
		group: "content",
		language: "typescript",
		description: "赞助页面、方式和展示内容",
		expectedToken: "export const sponsorConfig",
	},
	{
		key: "dynamic",
		path: "src/config/dynamicConfig.ts",
		name: "动态",
		group: "content",
		language: "typescript",
		description: "动态页面数据源设置",
		expectedToken: "export const dynamicConfig",
	},
	{
		key: "license",
		path: "src/config/licenseConfig.ts",
		name: "文章许可",
		group: "content",
		language: "typescript",
		description: "文章版权和许可协议",
		expectedToken: "export const licenseConfig",
	},
	{
		key: "analytics",
		path: "src/config/analyticsConfig.ts",
		name: "站点统计",
		group: "integrations",
		language: "typescript",
		description: "前台统计供应商与公开站点标识",
		expectedToken: "export const analyticsConfig",
	},
	{
		key: "comments",
		path: "src/config/commentConfig.ts",
		name: "评论系统",
		group: "integrations",
		language: "typescript",
		description: "评论供应商与公开客户端参数",
		expectedToken: "export const commentConfig",
	},
	{
		key: "expressive-code",
		path: "src/config/expressiveCodeConfig.ts",
		name: "代码块",
		group: "integrations",
		language: "typescript",
		description: "Expressive Code 渲染选项",
		expectedToken: "export const expressiveCodeConfig",
	},
	{
		key: "mermaid",
		path: "src/config/mermaidConfig.ts",
		name: "Mermaid",
		group: "integrations",
		language: "typescript",
		description: "Mermaid 图表渲染设置",
		expectedToken: "export const mermaidConfig",
	},
	{
		key: "plantuml",
		path: "src/config/plantumlConfig.ts",
		name: "PlantUML",
		group: "integrations",
		language: "typescript",
		description: "PlantUML 服务与渲染设置",
		expectedToken: "export const plantumlConfig",
	},
	{
		key: "pio",
		path: "src/config/pioConfig.ts",
		name: "看板角色",
		group: "integrations",
		language: "typescript",
		description: "Live2D 与 Spine 模型设置",
		expectedToken: "export const live2dWidgetConfig",
	},
];

export function configFileCatalog() {
	return CONFIG_FILES.map(
		({ key, path, name, group, language, description }) => ({
			key,
			path,
			name,
			group,
			language,
			description,
		}),
	);
}

export function configFileDefinition(key) {
	const definition = CONFIG_FILES.find((item) => item.key === key);
	if (!definition) throw new Error("Unknown configuration file");
	return definition;
}

function assertString(
	value,
	field,
	{ allowEmpty = true, limit = STRING_LIMIT } = {},
) {
	if (
		typeof value !== "string" ||
		(!allowEmpty && !value.trim()) ||
		value.length > limit
	)
		throw new Error(`Invalid music setting: ${field}`);
}

export function validateMusicSettings(value) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Music settings must be an object");
	if (!new Set(["meting", "local"]).has(value.mode))
		throw new Error("Invalid music setting: mode");
	if (
		typeof value.volume !== "number" ||
		!Number.isFinite(value.volume) ||
		value.volume < 0 ||
		value.volume > 1
	)
		throw new Error("Invalid music setting: volume");
	if (!new Set(["list", "one", "random"]).has(value.playMode))
		throw new Error("Invalid music setting: playMode");
	for (const field of ["showLyrics", "showInNavbar", "showInSidebar"])
		if (typeof value[field] !== "boolean")
			throw new Error(`Invalid music setting: ${field}`);

	if (!value.meting || typeof value.meting !== "object")
		throw new Error("Invalid music setting: meting");
	assertString(value.meting.api, "meting.api", { allowEmpty: false });
	if (
		!new Set(["netease", "tencent", "kugou", "xiami", "baidu"]).has(
			value.meting.server,
		)
	)
		throw new Error("Invalid music setting: meting.server");
	if (
		!new Set(["song", "playlist", "album", "search", "artist"]).has(
			value.meting.type,
		)
	)
		throw new Error("Invalid music setting: meting.type");
	assertString(value.meting.id, "meting.id", { allowEmpty: false });
	assertString(value.meting.auth, "meting.auth");
	if (
		!Array.isArray(value.meting.fallbackApis) ||
		value.meting.fallbackApis.length > 12
	)
		throw new Error("Invalid music setting: meting.fallbackApis");
	for (const [index, api] of value.meting.fallbackApis.entries())
		assertString(api, `meting.fallbackApis.${index}`, { allowEmpty: false });

	const playlist = value.local?.playlist;
	if (!Array.isArray(playlist) || playlist.length > 200)
		throw new Error("Invalid music setting: local.playlist");
	for (const [index, track] of playlist.entries()) {
		if (!track || typeof track !== "object")
			throw new Error(`Invalid music setting: local.playlist.${index}`);
		assertString(track.name, `local.playlist.${index}.name`, {
			allowEmpty: false,
		});
		assertString(track.artist, `local.playlist.${index}.artist`, {
			allowEmpty: false,
		});
		assertString(track.url, `local.playlist.${index}.url`, {
			allowEmpty: false,
		});
		assertString(track.cover ?? "", `local.playlist.${index}.cover`);
		assertString(track.lrc ?? "", `local.playlist.${index}.lrc`, {
			limit: 80_000,
		});
	}
	return value;
}

export function validateConfigFileContent(definition, content) {
	if (
		typeof content !== "string" ||
		!content.trim() ||
		content.length > CONFIG_FILE_LIMIT ||
		content.includes("\0")
	)
		throw new Error("Configuration content is invalid or too large");
	if (definition.expectedToken && !content.includes(definition.expectedToken))
		throw new Error(`Configuration must keep ${definition.expectedToken}`);
	if (definition.language === "json") {
		let parsed;
		try {
			parsed = JSON.parse(content);
		} catch {
			throw new Error("Configuration JSON is invalid");
		}
		if (definition.validator === "music") validateMusicSettings(parsed);
	}
	if (
		definition.language === "html" &&
		/<\/?(?:script|iframe|object|embed|form|style|link|meta|base)\b|javascript\s*:|\bon[a-z]+\s*=/i.test(
			content,
		)
	)
		throw new Error("Footer HTML contains unsafe markup");
	return content;
}
