import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { CONFIG_FILES } from "./config-files.mjs";
import { applyConfigUpdates, parseConfigDocument } from "./config-model.mjs";

const typescriptDefinition = {
	key: "site",
	name: "站点基础",
	language: "typescript",
};

const source = `import banner from "./banner.png";

export const siteConfig: SiteConfig = {
	// 站点标题
	title: "Firefly",
	enabled: true,
	count: 2,
	offset: -4,
	nested: {
		description: "Blog",
	},
	links: [
		{ name: "Home", url: "/" },
	],
	banner,
};
`;

test("TypeScript configs become structured fields without source expressions", () => {
	const document = parseConfigDocument(typescriptDefinition, source);
	assert.equal(document.sections.length, 1);
	assert.equal(document.editableFieldCount, 6);
	const serialized = JSON.stringify(document);
	assert.match(serialized, /站点标题/);
	assert.match(serialized, /Firefly/);
	assert.doesNotMatch(serialized, /banner\.png/);
	assert.doesNotMatch(serialized, /import banner/);
	assert.doesNotMatch(serialized, /"banner"\s*:/);
});

test("literal updates preserve surrounding TypeScript and computed values", () => {
	const output = applyConfigUpdates(typescriptDefinition, source, [
		{ path: "/siteConfig/title", value: "Updated" },
		{ path: "/siteConfig/enabled", value: false },
		{
			path: "/siteConfig/links",
			value: [
				{ name: "Home", url: "/" },
				{ name: "About", url: "/about/" },
			],
		},
	]);
	assert.match(output, /title: "Updated"/);
	assert.match(output, /enabled: false/);
	assert.match(output, /About/);
	assert.match(output, /import banner/);
	assert.match(output, /\tbanner,/);
	assert.equal(
		parseConfigDocument(typescriptDefinition, output).sections.length,
		1,
	);
});

test("computed expressions and invalid value types cannot be updated", () => {
	assert.throws(
		() =>
			applyConfigUpdates(typescriptDefinition, source, [
				{ path: "/siteConfig/banner", value: "other.png" },
			]),
		/read-only/,
	);
	assert.throws(
		() =>
			applyConfigUpdates(typescriptDefinition, source, [
				{ path: "/siteConfig/count", value: "3" },
			]),
		/finite number/,
	);
	assert.throws(
		() =>
			applyConfigUpdates(typescriptDefinition, source, [
				{ path: "/siteConfig/links", value: [{ name: "Home" }] },
			]),
		/original structure/,
	);
});

test("JSON and HTML configs use the same field update protocol", () => {
	const jsonDefinition = { key: "data", name: "Data", language: "json" };
	const jsonDocument = parseConfigDocument(jsonDefinition, '{"enabled":true}');
	assert.equal(jsonDocument.editableFieldCount, 1);
	assert.equal(
		applyConfigUpdates(jsonDefinition, '{"enabled":true}', [
			{ path: "/root/enabled", value: false },
		]),
		'{\n\t"enabled": false\n}\n',
	);
	assert.throws(
		() =>
			applyConfigUpdates(jsonDefinition, '{"enabled":true}', [
				{ path: "/root/missing", value: false },
			]),
		/read-only or does not exist/,
	);

	const htmlDefinition = { key: "footer", name: "Footer", language: "html" };
	assert.equal(
		applyConfigUpdates(htmlDefinition, "old", [
			{ path: "/content", value: "new" },
		]),
		"new",
	);
});

test("every registered configuration renders as a source-free document", () => {
	for (const definition of CONFIG_FILES) {
		const source = fs.readFileSync(definition.path, "utf8");
		const document = parseConfigDocument(definition, source);
		assert.ok(document.sections.length > 0, definition.key);
		assert.ok(Number.isInteger(document.editableFieldCount), definition.key);
		assert.equal(Object.hasOwn(document, "content"), false, definition.key);
		assert.equal(Object.hasOwn(document, "source"), false, definition.key);
	}
});
