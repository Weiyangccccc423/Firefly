import type { CollectionEntry } from "astro:content";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const filterExistingDynamics = (
	entries: CollectionEntry<"dynamic">[],
): CollectionEntry<"dynamic">[] =>
	// Astro's persisted content store can retain deleted entries during an
	// incremental build. Only publish entries backed by a current source file.
	entries.filter(
		(entry) => !!entry.filePath && existsSync(resolve(entry.filePath)),
	);

export const sortDynamics = (
	entries: CollectionEntry<"dynamic">[],
): CollectionEntry<"dynamic">[] =>
	entries.sort(
		(a, b) => b.data.published.getTime() - a.data.published.getTime(),
	);

export const dynamicSlug = (id: string): string =>
	id.replace(/\.(md|mdx)$/i, "");

export const dynamicAnchor = (id: string): string =>
	`dynamic-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

export const dynamicPlainText = (entry: CollectionEntry<"dynamic">): string =>
	(entry.body || "")
		.replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/[#>*_`~[\]()-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

export const dynamicSearchText = (entry: CollectionEntry<"dynamic">): string =>
	dynamicPlainText(entry).toLocaleLowerCase();
