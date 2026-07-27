import type { GalleryConfig } from "@/types/galleryConfig";

export const galleryConfig: GalleryConfig = {
	albums: [
		{
			id: "china-high-speed-rail",
			name: "中国高速铁路线路图",
			description: "2025 年 11 月版中国高速铁路线路示意图",
			date: "2025-11",
			tags: ["铁路", "地图", "中国"],
			cover: "/gallery/china-high-speed-rail/preview.webp",
			photos: [
				{
					src: "/gallery/china-high-speed-rail/map.webp",
					thumbnail: "/gallery/china-high-speed-rail/preview.webp",
					alt: "中国高速铁路线路示意图（2025 年 11 月）",
				},
			],
		},
	],
	columnWidth: 240,
};
