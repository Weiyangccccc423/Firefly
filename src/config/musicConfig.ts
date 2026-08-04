import type { MusicPlayerConfig } from "../types/musicConfig";
import adminOverrides from "./adminOverrides.json";
import musicSettings from "./musicSettings.json";

const musicEnabled = adminOverrides.music?.enabled ?? true;
const settings = musicSettings as MusicPlayerConfig;

// 音乐播放器配置
export const musicPlayerConfig: MusicPlayerConfig = {
	...settings,
	showInNavbar: musicEnabled && (settings.showInNavbar ?? true),
	showInSidebar: musicEnabled && (settings.showInSidebar ?? false),
};
