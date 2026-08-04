import assert from "node:assert/strict";
import test from "node:test";
import {
	configFileCatalog,
	configFileDefinition,
	validateConfigFileContent,
	validateMusicSettings,
} from "./config-files.mjs";

const validMusicSettings = {
	mode: "meting",
	volume: 0.7,
	playMode: "list",
	showLyrics: true,
	showInNavbar: true,
	showInSidebar: false,
	meting: {
		api: "https://example.com/:id",
		server: "netease",
		type: "playlist",
		id: "123",
		auth: "",
		fallbackApis: [],
	},
	local: { playlist: [] },
};

test("catalog exposes every managed config without internal validators", () => {
	const catalog = configFileCatalog();
	assert.equal(catalog.length, 24);
	assert.equal(new Set(catalog.map((item) => item.key)).size, catalog.length);
	assert.ok(catalog.every((item) => !Object.hasOwn(item, "expectedToken")));
});

test("unknown config keys are rejected", () => {
	assert.throws(() => configFileDefinition("../../package"), /Unknown/);
});

test("music settings enforce enums and numeric bounds", () => {
	assert.equal(validateMusicSettings(validMusicSettings), validMusicSettings);
	assert.throws(
		() => validateMusicSettings({ ...validMusicSettings, volume: 2 }),
		/volume/,
	);
	assert.throws(
		() => validateMusicSettings({ ...validMusicSettings, mode: "remote" }),
		/mode/,
	);
});

test("config validation checks JSON schema and required exports", () => {
	const music = configFileDefinition("music-settings");
	assert.equal(
		validateConfigFileContent(music, JSON.stringify(validMusicSettings)),
		JSON.stringify(validMusicSettings),
	);
	assert.throws(() => validateConfigFileContent(music, "{}"), /music setting/);

	const site = configFileDefinition("site");
	assert.throws(
		() => validateConfigFileContent(site, "export const wrong = {};"),
		/siteConfig/,
	);
});

test("footer editor rejects active content", () => {
	const footer = configFileDefinition("footer-html");
	assert.throws(
		() => validateConfigFileContent(footer, '<script src="/bad.js"></script>'),
		/unsafe/,
	);
});
