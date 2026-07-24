import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MarkdownHeading } from "astro";
import type { Loader } from "astro/loaders";
import { glob } from "glob";
import type { DefaultTreeAdapterTypes as HtmlTree } from "parse5";
import { parse, parseFragment, serialize } from "parse5";
import sanitizeHtml from "sanitize-html";

type HtmlMetadata = Record<string, unknown>;
type HtmlElement = HtmlTree.Element | HtmlTree.Template;
type HtmlNode = HtmlTree.Node;

const HTML_POST_PATTERN = "**/*.html";
const METADATA_SUFFIX = ".meta.json";
const READING_WORDS_PER_MINUTE = 200;

const allowedTags = Array.from(
	new Set(
		sanitizeHtml.defaults.allowedTags.concat([
			"article",
			"audio",
			"details",
			"figcaption",
			"figure",
			"img",
			"mark",
			"picture",
			"source",
			"summary",
			"table",
			"tbody",
			"td",
			"tfoot",
			"th",
			"thead",
			"tr",
			"video",
		]),
	),
);

function isElement(node: HtmlNode): node is HtmlElement {
	return "tagName" in node;
}

function isTextNode(node: HtmlNode): node is HtmlTree.TextNode {
	return node.nodeName === "#text";
}

function getAttribute(node: HtmlElement, name: string): string | undefined {
	return node.attrs.find((attribute) => attribute.name === name)?.value;
}

function setAttribute(node: HtmlElement, name: string, value: string) {
	const existing = node.attrs.find((attribute) => attribute.name === name);
	if (existing) {
		existing.value = value;
		return;
	}
	node.attrs.push({ name, value });
}

function visitNodes(node: HtmlNode, callback: (node: HtmlNode) => void) {
	callback(node);
	if (!("childNodes" in node)) return;
	for (const child of node.childNodes) {
		visitNodes(child, callback);
	}
}

function findFirstElement(
	node: HtmlNode,
	tagName: string,
): HtmlElement | undefined {
	let result: HtmlElement | undefined;
	visitNodes(node, (currentNode) => {
		if (!result && isElement(currentNode) && currentNode.tagName === tagName) {
			result = currentNode;
		}
	});
	return result;
}

function getTextContent(node: HtmlNode): string {
	if (isTextNode(node)) return node.value;
	if (!("childNodes" in node)) return "";
	return node.childNodes.map((child) => getTextContent(child)).join("");
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength).trimEnd()}...`;
}

function slugifyHeading(value: string): string {
	const slug = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "section";
}

function createHeadings(
	fragment: HtmlTree.DocumentFragment,
): MarkdownHeading[] {
	const headings: MarkdownHeading[] = [];
	const slugCounts = new Map<string, number>();

	visitNodes(fragment, (node) => {
		if (!isElement(node) || !/^h[1-6]$/.test(node.tagName)) return;

		const text = normalizeText(getTextContent(node));
		if (!text) return;

		const baseSlug = slugifyHeading(text);
		const count = slugCounts.get(baseSlug) ?? 0;
		slugCounts.set(baseSlug, count + 1);
		const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;
		setAttribute(node, "id", slug);
		headings.push({
			depth: Number(node.tagName.slice(1)),
			slug,
			text,
		});
	});

	return headings;
}

function countWords(text: string): number {
	const words = text.match(
		/[\p{Script=Han}]|[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu,
	);
	return words?.length ?? 0;
}

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	if (value.toLowerCase() === "true") return true;
	if (value.toLowerCase() === "false") return false;
	return undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return undefined;
}

function parseDate(
	value: unknown,
	field: string,
	filePath: string,
): Date | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	if (typeof value !== "string" && typeof value !== "number") {
		throw new Error(`HTML post ${filePath} has an invalid ${field} value.`);
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(
			`HTML post ${filePath} has an invalid ${field} date: ${value}`,
		);
	}
	return date;
}

function readHtmlMetadata(document: HtmlTree.Document): HtmlMetadata {
	const metadata: HtmlMetadata = {};

	visitNodes(document, (node) => {
		if (!isElement(node)) return;

		if (node.tagName === "title" && typeof metadata.title !== "string") {
			metadata.title = normalizeText(getTextContent(node));
			return;
		}

		if (node.tagName !== "meta") return;
		const key = getAttribute(node, "name") ?? getAttribute(node, "property");
		const content = getAttribute(node, "content");
		if (!key || content === undefined) return;
		metadata[key.toLowerCase()] = content;
	});

	return metadata;
}

async function readSidecarMetadata(
	htmlFilePath: string,
): Promise<HtmlMetadata> {
	const metadataFilePath = htmlFilePath.replace(/\.html$/i, METADATA_SUFFIX);
	try {
		const contents = await readFile(metadataFilePath, "utf-8");
		const metadata = JSON.parse(contents) as unknown;
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
			throw new Error("metadata must be a JSON object");
		}
		return metadata as HtmlMetadata;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(
			`Unable to read HTML post metadata for ${htmlFilePath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function getMetadataValue(
	sidecar: HtmlMetadata,
	documentMetadata: HtmlMetadata,
	...keys: string[]
): unknown {
	for (const key of keys) {
		if (sidecar[key] !== undefined) return sidecar[key];
	}
	for (const key of keys) {
		if (documentMetadata[key] !== undefined) return documentMetadata[key];
	}
	return undefined;
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildPostData({
	sidecar,
	documentMetadata,
	bodyText,
	filePath,
}: {
	sidecar: HtmlMetadata;
	documentMetadata: HtmlMetadata;
	bodyText: string;
	filePath: string;
}): HtmlMetadata {
	const title =
		getString(
			getMetadataValue(sidecar, documentMetadata, "title", "og:title"),
		) ??
		filePath
			.replace(/\.html$/i, "")
			.split("/")
			.at(-1)
			?.replace(/[-_]/g, " ") ??
		"Untitled HTML post";
	const published = parseDate(
		getMetadataValue(
			sidecar,
			documentMetadata,
			"published",
			"article:published_time",
			"date",
		),
		"published",
		filePath,
	);

	if (!published) {
		throw new Error(
			`HTML post ${filePath} must define a published date in ${METADATA_SUFFIX} or a <meta name="published"> tag.`,
		);
	}

	const description =
		getString(
			getMetadataValue(
				sidecar,
				documentMetadata,
				"description",
				"og:description",
			),
		) ?? truncate(bodyText, 180);
	const tags = parseStringArray(
		getMetadataValue(sidecar, documentMetadata, "tags"),
	);
	const category = getString(
		getMetadataValue(sidecar, documentMetadata, "category"),
	);
	const updated = parseDate(
		getMetadataValue(
			sidecar,
			documentMetadata,
			"updated",
			"article:modified_time",
		),
		"updated",
		filePath,
	);

	return {
		...sidecar,
		title,
		published,
		updated,
		description,
		tags,
		category,
		draft: parseBoolean(getMetadataValue(sidecar, documentMetadata, "draft")),
		pinned: parseBoolean(getMetadataValue(sidecar, documentMetadata, "pinned")),
		comment: parseBoolean(
			getMetadataValue(sidecar, documentMetadata, "comment"),
		),
		contentType: "html",
	};
}

function sanitizePostHtml(html: string): string {
	return sanitizeHtml(html, {
		allowedTags,
		allowedAttributes: {
			"*": ["aria-*", "class", "data-*", "id", "role", "style", "title"],
			a: ["href", "name", "rel", "target"],
			audio: ["autoplay", "controls", "loop", "muted", "preload", "src"],
			img: [
				"alt",
				"decoding",
				"height",
				"loading",
				"sizes",
				"src",
				"srcset",
				"width",
			],
			li: ["value"],
			ol: ["reversed", "start", "type"],
			source: ["media", "sizes", "src", "srcset", "type"],
			td: ["colspan", "rowspan"],
			th: ["colspan", "rowspan", "scope"],
			video: [
				"autoplay",
				"controls",
				"height",
				"loop",
				"muted",
				"playsinline",
				"poster",
				"preload",
				"src",
				"width",
			],
		},
		allowedSchemes: ["http", "https", "mailto", "tel"],
		allowedSchemesByTag: {
			img: ["http", "https", "data"],
		},
		disallowedTagsMode: "discard",
	});
}

async function loadHtmlPosts(context: Parameters<Loader["load"]>[0]) {
	const postsDirectory = fileURLToPath(
		new URL("content/posts/", context.config.srcDir),
	);
	const projectRoot = fileURLToPath(context.config.root);
	const files = await glob(HTML_POST_PATTERN, {
		cwd: postsDirectory,
		nodir: true,
	});

	context.store.clear();

	for (const relativeFilePath of files) {
		const absoluteFilePath = new URL(
			relativeFilePath,
			new URL(`file://${postsDirectory}/`),
		);
		const htmlFilePath = fileURLToPath(absoluteFilePath);
		const sourceHtml = await readFile(htmlFilePath, "utf-8");
		const document = parse(sourceHtml);
		const body = findFirstElement(document, "body");
		const bodyHtml = sanitizePostHtml(serialize(body ?? document));
		const fragment = parseFragment(bodyHtml);
		const headings = createHeadings(fragment);
		const renderedHtml = serialize(fragment);
		const bodyText = normalizeText(getTextContent(fragment));
		const sidecar = await readSidecarMetadata(htmlFilePath);
		const documentMetadata = readHtmlMetadata(document);
		const id = relativeFilePath.replace(/\.html$/i, "");
		const data = buildPostData({
			sidecar,
			documentMetadata,
			bodyText,
			filePath: relativeFilePath,
		});
		const parsedData = await context.parseData({
			id,
			data,
			filePath: htmlFilePath,
		});
		const words = countWords(bodyText);
		const minutes =
			words === 0
				? 0
				: Math.max(1, Math.ceil(words / READING_WORDS_PER_MINUTE));
		const metadataFilePath = htmlFilePath.replace(/\.html$/i, METADATA_SUFFIX);
		let metadataContents = "";
		try {
			metadataContents = await readFile(metadataFilePath, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		context.store.set({
			id,
			data: parsedData,
			body: sourceHtml,
			filePath: relative(projectRoot, htmlFilePath).replaceAll("\\", "/"),
			digest: context.generateDigest(`${sourceHtml}\0${metadataContents}`),
			rendered: {
				html: renderedHtml,
				metadata: {
					headings,
					frontmatter: {
						excerpt: truncate(bodyText, 180),
						minutes,
						words,
					},
				},
			},
		});
	}
}

export const htmlPostsLoader: Loader = {
	name: "firefly-html-posts-loader",
	load: async (context) => {
		await loadHtmlPosts(context);

		if (!context.watcher) return;
		const postsDirectory = fileURLToPath(
			new URL("content/posts/", context.config.srcDir),
		);
		context.watcher.add(postsDirectory);
		const shouldReload = (filePath: string) =>
			filePath.startsWith(postsDirectory) &&
			(filePath.endsWith(".html") || filePath.endsWith(METADATA_SUFFIX));
		const reload = async (filePath: string) => {
			if (!shouldReload(filePath)) return;
			await loadHtmlPosts(context);
			context.logger.info(`Reloaded HTML posts after ${filePath}`);
		};

		context.watcher.on("add", reload);
		context.watcher.on("change", reload);
		context.watcher.on("unlink", reload);
	},
};
