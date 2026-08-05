import ts from "typescript";

const MAX_UPDATES = 500;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_VALUE_DEPTH = 16;
const MAX_VALUE_BYTES = 250_000;

const FIELD_OPTIONS = {
	mode: ["banner", "fullscreen", "overlay", "none", "meting", "local"],
	playMode: ["list", "one", "random"],
	playerMode: ["order", "random"],
	provider: ["fontsource", "local"],
	server: ["netease", "tencent", "kugou", "xiami", "baidu"],
	theme: ["light", "dark", "auto"],
	type: ["song", "playlist", "album", "search", "artist"],
};

const FIELD_LABELS = {
	enabled: "启用",
	title: "标题",
	subtitle: "副标题",
	description: "描述",
	name: "名称",
	url: "地址",
	icon: "图标",
	avatar: "头像",
	cover: "封面",
	position: "位置",
	order: "顺序",
	mode: "模式",
	theme: "主题",
	color: "颜色",
	opacity: "透明度",
	width: "宽度",
	height: "高度",
	fontSize: "字号",
	fontFamily: "字体",
	show: "显示",
	showTitle: "显示标题",
	showDescription: "显示描述",
	showInNavbar: "导航栏显示",
	showInSidebar: "侧栏显示",
	showLyrics: "显示歌词",
	server: "服务平台",
	type: "类型",
	id: "标识",
	api: "API 地址",
	provider: "服务商",
	language: "语言",
	items: "项目",
	links: "链接",
	playlist: "播放列表",
	fallbackApis: "备用 API",
	content: "内容",
	text: "文本",
	path: "路径",
	src: "资源地址",
	alt: "替代文本",
	tags: "标签",
	categories: "分类",
	layout: "布局",
	style: "样式",
	defaultMode: "默认模式",
	themeColor: "主题色",
	hue: "色相",
	volume: "音量",
	playMode: "播放模式",
	artist: "艺术家",
	lrc: "歌词",
	comment: "评论",
	license: "许可协议",
};

const SECTION_LABELS = {
	fontsList: "字体列表",
	fontConfig: "区域字体",
	friendsPageConfig: "友链页面",
	friendsConfig: "友链列表",
	getEnabledFriends: "友链排序",
	navBarSearchConfig: "导航搜索",
	LinkPresets: "链接预设",
	navBarConfig: "导航结构",
	spineModelConfig: "Spine 模型",
	live2dWidgetConfig: "Live2D 模型",
};

function pointerSegment(value) {
	return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointer(parent, key) {
	return `${parent}/${pointerSegment(key)}`;
}

function pointerTokens(value) {
	if (typeof value !== "string" || !value.startsWith("/"))
		throw new Error("Configuration update path is invalid");
	return value
		.slice(1)
		.split("/")
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function formatLabel(key) {
	if (Object.hasOwn(FIELD_LABELS, key)) return FIELD_LABELS[key];
	return key
		.replace(/Config$/, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replaceAll("_", " ");
}

function cleanComment(value) {
	return value
		.replace(/^\/\*+|\*+\/$/g, "")
		.split("\n")
		.map((line) => line.replace(/^\s*(?:\/\/|\*)?\s?/, "").trim())
		.filter((line) => line && !line.startsWith("@"))
		.join(" ")
		.slice(0, MAX_DESCRIPTION_LENGTH);
}

function nodeDescription(source, node, sourceFile) {
	const trivia = source.slice(node.getFullStart(), node.getStart(sourceFile));
	const comments = trivia.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) || [];
	return comments.length ? cleanComment(comments.at(-1)) : "";
}

function fieldHints(key, value, description) {
	const hints = {};
	const options = FIELD_OPTIONS[key]?.filter((option) =>
		new RegExp(`(?:^|["'：:,\\s])${option}(?:$|["'，,、\\s])`, "i").test(
			description,
		),
	);
	if (options?.length > 1 && options.includes(value)) hints.options = options;
	if (
		typeof value === "string" &&
		(/(?:url|uri|href|src|link|avatar|cover|api)$/i.test(key) ||
			/地址|链接|图片|头像|封面/.test(description))
	)
		hints.input = "url";
	if (
		typeof value === "string" &&
		(value.includes("\n") || /内容|消息|简介|描述/.test(description))
	)
		hints.input = "multiline";
	if (
		typeof value === "number" &&
		/(?:0\s*[~-]\s*1|0到1|0~1|0-1)/.test(description)
	) {
		hints.min = 0;
		hints.max = 1;
		hints.step = 0.05;
	}
	return hints;
}

function propertyName(node, sourceFile) {
	if (
		ts.isIdentifier(node) ||
		ts.isStringLiteral(node) ||
		ts.isNumericLiteral(node)
	)
		return node.text;
	if (ts.isComputedPropertyName(node)) return null;
	return node.getText(sourceFile);
}

function unwrapExpression(node) {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression?.(current)
	)
		current = current.expression;
	return current;
}

function expressionToJson(node, sourceFile) {
	const current = unwrapExpression(node);
	if (
		ts.isStringLiteral(current) ||
		ts.isNoSubstitutionTemplateLiteral(current)
	)
		return { ok: true, value: current.text };
	if (ts.isNumericLiteral(current))
		return { ok: true, value: Number(current.text) };
	if (current.kind === ts.SyntaxKind.TrueKeyword)
		return { ok: true, value: true };
	if (current.kind === ts.SyntaxKind.FalseKeyword)
		return { ok: true, value: false };
	if (current.kind === ts.SyntaxKind.NullKeyword)
		return { ok: true, value: null };
	if (
		ts.isPrefixUnaryExpression(current) &&
		(current.operator === ts.SyntaxKind.MinusToken ||
			current.operator === ts.SyntaxKind.PlusToken) &&
		ts.isNumericLiteral(current.operand)
	) {
		const value = Number(current.operand.text);
		return {
			ok: true,
			value: current.operator === ts.SyntaxKind.MinusToken ? -value : value,
		};
	}
	if (ts.isArrayLiteralExpression(current)) {
		const result = [];
		for (const element of current.elements) {
			if (ts.isSpreadElement(element)) return { ok: false };
			const parsed = expressionToJson(element, sourceFile);
			if (!parsed.ok) return { ok: false };
			result.push(parsed.value);
		}
		return { ok: true, value: result };
	}
	if (ts.isObjectLiteralExpression(current)) {
		const result = {};
		for (const property of current.properties) {
			if (!ts.isPropertyAssignment(property)) return { ok: false };
			const key = propertyName(property.name, sourceFile);
			if (key === null || Object.hasOwn(result, key)) return { ok: false };
			const parsed = expressionToJson(property.initializer, sourceFile);
			if (!parsed.ok) return { ok: false };
			result[key] = parsed.value;
		}
		return { ok: true, value: result };
	}
	return { ok: false };
}

function blankTemplate(value) {
	if (Array.isArray(value)) return [];
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, blankTemplate(child)]),
		);
	if (typeof value === "string") return "";
	if (typeof value === "number") return 0;
	if (typeof value === "boolean") return false;
	return null;
}

function editableField(kind, path, key, value, description) {
	return {
		kind,
		path,
		key,
		label: formatLabel(key),
		value,
		editable: true,
		...(kind === "array"
			? { itemTemplate: value.length ? blankTemplate(value[0]) : "" }
			: {}),
		...fieldHints(key, value, description),
		...(description ? { description } : {}),
	};
}

function fieldFromExpression(
	node,
	path,
	key,
	source,
	sourceFile,
	editableNodes,
	commentNode = node,
) {
	const current = unwrapExpression(node);
	const description = nodeDescription(source, commentNode, sourceFile);
	if (
		ts.isStringLiteral(current) ||
		ts.isNoSubstitutionTemplateLiteral(current)
	) {
		const field = editableField("string", path, key, current.text, description);
		editableNodes.set(path, {
			node: current,
			kind: field.kind,
			value: field.value,
		});
		return field;
	}
	if (ts.isNumericLiteral(current)) {
		const field = editableField(
			"number",
			path,
			key,
			Number(current.text),
			description,
		);
		editableNodes.set(path, {
			node: current,
			kind: field.kind,
			value: field.value,
		});
		return field;
	}
	if (
		ts.isPrefixUnaryExpression(current) &&
		(current.operator === ts.SyntaxKind.MinusToken ||
			current.operator === ts.SyntaxKind.PlusToken) &&
		ts.isNumericLiteral(current.operand)
	) {
		const number = Number(current.operand.text);
		const value =
			current.operator === ts.SyntaxKind.MinusToken ? -number : number;
		const field = editableField("number", path, key, value, description);
		editableNodes.set(path, {
			node: current,
			kind: field.kind,
			value: field.value,
		});
		return field;
	}
	if (
		current.kind === ts.SyntaxKind.TrueKeyword ||
		current.kind === ts.SyntaxKind.FalseKeyword
	) {
		const field = editableField(
			"boolean",
			path,
			key,
			current.kind === ts.SyntaxKind.TrueKeyword,
			description,
		);
		editableNodes.set(path, {
			node: current,
			kind: field.kind,
			value: field.value,
		});
		return field;
	}
	if (current.kind === ts.SyntaxKind.NullKeyword) {
		const field = editableField("null", path, key, null, description);
		editableNodes.set(path, {
			node: current,
			kind: field.kind,
			value: field.value,
		});
		return field;
	}
	if (ts.isArrayLiteralExpression(current)) {
		const parsed = expressionToJson(current, sourceFile);
		if (parsed.ok) {
			const field = editableField(
				"array",
				path,
				key,
				parsed.value,
				description,
			);
			editableNodes.set(path, {
				node: current,
				kind: field.kind,
				value: field.value,
			});
			return field;
		}
		return {
			kind: "collection",
			path,
			key,
			label: formatLabel(key),
			editable: false,
			children: current.elements.map((element, index) =>
				fieldFromExpression(
					element,
					pointer(path, index),
					String(index + 1),
					source,
					sourceFile,
					editableNodes,
				),
			),
			...(description ? { description } : {}),
		};
	}
	if (ts.isObjectLiteralExpression(current)) {
		const children = [];
		for (const property of current.properties) {
			if (ts.isPropertyAssignment(property)) {
				const propertyKey = propertyName(property.name, sourceFile);
				if (propertyKey === null) continue;
				children.push(
					fieldFromExpression(
						property.initializer,
						pointer(path, propertyKey),
						propertyKey,
						source,
						sourceFile,
						editableNodes,
						property,
					),
				);
			} else if (ts.isShorthandPropertyAssignment(property)) {
				const propertyKey = property.name.text;
				children.push({
					kind: "readonly",
					path: pointer(path, propertyKey),
					key: propertyKey,
					label: formatLabel(propertyKey),
					editable: false,
				});
			} else if (ts.isSpreadAssignment(property)) {
				children.push({
					kind: "readonly",
					path: pointer(path, `spread-${children.length}`),
					key: "inherited",
					label: "继承配置",
					editable: false,
				});
			}
		}
		return {
			kind: "object",
			path,
			key,
			label: formatLabel(key),
			editable: false,
			children,
			...(description ? { description } : {}),
		};
	}
	return {
		kind: "readonly",
		path,
		key,
		label: formatLabel(key),
		editable: false,
		...(description ? { description } : {}),
	};
}

function parseTypeScript(source) {
	const sourceFile = ts.createSourceFile(
		"config.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	if (sourceFile.parseDiagnostics?.length) {
		const diagnostic = sourceFile.parseDiagnostics[0];
		const message = ts.flattenDiagnosticMessageText(
			diagnostic.messageText,
			" ",
		);
		throw new Error(`Configuration TypeScript is invalid: ${message}`);
	}
	return sourceFile;
}

function exportedDeclarations(sourceFile) {
	const declarations = [];
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if (
			!statement.modifiers?.some(
				(item) => item.kind === ts.SyntaxKind.ExportKeyword,
			)
		)
			continue;
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.initializer)
				declarations.push(declaration);
		}
	}
	return declarations;
}

function fieldFromJson(value, path, key) {
	if (Array.isArray(value)) return editableField("array", path, key, value, "");
	if (value && typeof value === "object")
		return {
			kind: "object",
			path,
			key,
			label: formatLabel(key),
			editable: false,
			children: Object.entries(value).map(([childKey, childValue]) =>
				fieldFromJson(childValue, pointer(path, childKey), childKey),
			),
		};
	if (typeof value === "string")
		return editableField("string", path, key, value, "");
	if (typeof value === "number")
		return editableField("number", path, key, value, "");
	if (typeof value === "boolean")
		return editableField("boolean", path, key, value, "");
	return editableField("null", path, key, null, "");
}

function countEditableFields(field) {
	if (field.editable) return 1;
	return (field.children || []).reduce(
		(total, child) => total + countEditableFields(child),
		0,
	);
}

export function parseConfigDocument(definition, source) {
	if (definition.language === "json") {
		let value;
		try {
			value = JSON.parse(source);
		} catch {
			throw new Error("Configuration JSON is invalid");
		}
		const field = fieldFromJson(value, "/root", "root");
		return {
			sections: [{ key: "root", label: definition.name, field }],
			editableFieldCount: countEditableFields(field),
		};
	}
	if (definition.language === "html") {
		const field = editableField("string", "/content", "content", source, "");
		return {
			sections: [{ key: "content", label: definition.name, field }],
			editableFieldCount: 1,
		};
	}

	const sourceFile = parseTypeScript(source);
	const editableNodes = new Map();
	const declarations = exportedDeclarations(sourceFile);
	const sections = declarations.map((declaration) => {
		const name = declaration.name.text;
		return {
			key: name,
			label:
				declarations.length === 1
					? definition.name
					: SECTION_LABELS[name] || formatLabel(name),
			field: fieldFromExpression(
				declaration.initializer,
				pointer("", name),
				name,
				source,
				sourceFile,
				editableNodes,
				declaration,
			),
		};
	});
	return {
		sections,
		editableFieldCount: sections.reduce(
			(total, section) => total + countEditableFields(section.field),
			0,
		),
	};
}

function assertSafeJsonValue(value, depth = 0) {
	if (depth > MAX_VALUE_DEPTH)
		throw new Error("Configuration value is nested too deeply");
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("Configuration field must be a finite number");
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_ARRAY_ITEMS)
			throw new Error("Configuration array has too many items");
		for (const item of value) assertSafeJsonValue(item, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (["__proto__", "constructor", "prototype"].includes(key))
				throw new Error("Configuration object contains an unsafe key");
			assertSafeJsonValue(child, depth + 1);
		}
		return;
	}
	throw new Error("Configuration field contains an unsupported value");
}

function valuesHaveCompatibleShape(value, template) {
	if (template === null) return value === null;
	if (Array.isArray(template)) {
		if (!Array.isArray(value)) return false;
		if (template.length === 0) return true;
		return value.every((item) =>
			template.some((candidate) => valuesHaveCompatibleShape(item, candidate)),
		);
	}
	if (typeof template === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return false;
		const templateKeys = Object.keys(template);
		const valueKeys = Object.keys(value);
		return (
			templateKeys.length === valueKeys.length &&
			templateKeys.every(
				(key) =>
					Object.hasOwn(value, key) &&
					valuesHaveCompatibleShape(value[key], template[key]),
			)
		);
	}
	return typeof value === typeof template;
}

function validateUpdateValue(kind, value, originalValue) {
	assertSafeJsonValue(value);
	let serialized;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error("Configuration field cannot be serialized");
	}
	if (Buffer.byteLength(serialized || "") > MAX_VALUE_BYTES)
		throw new Error("Configuration field is too large");
	if (kind === "string" && typeof value !== "string")
		throw new Error("Configuration field must be a string");
	if (
		kind === "number" &&
		(typeof value !== "number" || !Number.isFinite(value))
	)
		throw new Error("Configuration field must be a finite number");
	if (kind === "boolean" && typeof value !== "boolean")
		throw new Error("Configuration field must be a boolean");
	if (kind === "null" && value !== null)
		throw new Error("Configuration field must remain null");
	if (kind === "array" && !Array.isArray(value))
		throw new Error("Configuration field must be an array");
	if (
		kind === "array" &&
		Array.isArray(originalValue) &&
		originalValue.length > 0 &&
		!valuesHaveCompatibleShape(value, originalValue)
	)
		throw new Error(
			"Configuration array items must keep their original structure",
		);
}

function serializeValue(value, kind, originalValue, source, node) {
	validateUpdateValue(kind, value, originalValue);
	const serialized =
		kind === "string"
			? JSON.stringify(value)
			: kind === "number" || kind === "boolean" || kind === "null"
				? String(value)
				: JSON.stringify(value, null, "\t");
	if (serialized === undefined)
		throw new Error("Configuration field cannot be serialized");
	const lineStart = source.lastIndexOf("\n", node.getStart()) + 1;
	const indentation =
		source.slice(lineStart, node.getStart()).match(/^\s*/)?.[0] || "";
	return serialized.replaceAll("\n", `\n${indentation}`);
}

function editableFields(document) {
	const fields = new Map();
	function visit(field) {
		if (field.editable) fields.set(field.path, field);
		for (const child of field.children || []) visit(child);
	}
	for (const section of document.sections) visit(section.field);
	return fields;
}

function editableTypeScriptNodes(source) {
	const sourceFile = parseTypeScript(source);
	const editableNodes = new Map();
	for (const declaration of exportedDeclarations(sourceFile)) {
		const name = declaration.name.text;
		fieldFromExpression(
			declaration.initializer,
			pointer("", name),
			name,
			source,
			sourceFile,
			editableNodes,
		);
	}
	return editableNodes;
}

function setJsonPointer(root, path, value) {
	const tokens = pointerTokens(path);
	if (tokens[0] !== "root")
		throw new Error("Configuration update path is invalid");
	if (tokens.length === 1) return value;
	let current = root;
	for (const token of tokens.slice(1, -1)) {
		if (
			!current ||
			typeof current !== "object" ||
			!Object.hasOwn(current, token)
		)
			throw new Error("Configuration update path does not exist");
		current = current[token];
	}
	const finalToken = tokens.at(-1);
	if (
		!current ||
		typeof current !== "object" ||
		!Object.hasOwn(current, finalToken)
	)
		throw new Error("Configuration update path does not exist");
	current[finalToken] = value;
	return root;
}

function validateUpdates(updates) {
	if (
		!Array.isArray(updates) ||
		updates.length === 0 ||
		updates.length > MAX_UPDATES
	)
		throw new Error("Configuration updates are invalid");
	const paths = new Set();
	for (const update of updates) {
		if (
			!update ||
			typeof update !== "object" ||
			typeof update.path !== "string"
		)
			throw new Error("Configuration update is invalid");
		if (paths.has(update.path))
			throw new Error("Configuration update path is duplicated");
		paths.add(update.path);
	}
	return updates;
}

export function applyConfigUpdates(definition, source, inputUpdates) {
	const updates = validateUpdates(inputUpdates);
	if (definition.language === "html") {
		if (updates.length !== 1 || updates[0].path !== "/content")
			throw new Error("Footer update path is invalid");
		validateUpdateValue("string", updates[0].value, source);
		return updates[0].value;
	}
	if (definition.language === "json") {
		let value;
		try {
			value = JSON.parse(source);
		} catch {
			throw new Error("Configuration JSON is invalid");
		}
		const fields = editableFields(parseConfigDocument(definition, source));
		for (const update of updates) {
			const target = fields.get(update.path);
			if (!target)
				throw new Error("Configuration field is read-only or does not exist");
			validateUpdateValue(target.kind, update.value, target.value);
			value = setJsonPointer(value, update.path, update.value);
		}
		return `${JSON.stringify(value, null, "\t")}\n`;
	}

	const editableNodes = editableTypeScriptNodes(source);
	const replacements = updates.map((update) => {
		const target = editableNodes.get(update.path);
		if (!target)
			throw new Error("Configuration field is read-only or does not exist");
		return {
			start: target.node.getStart(),
			end: target.node.getEnd(),
			content: serializeValue(
				update.value,
				target.kind,
				target.value,
				source,
				target.node,
			),
		};
	});
	replacements.sort((left, right) => right.start - left.start);
	for (let index = 1; index < replacements.length; index += 1) {
		if (replacements[index - 1].start < replacements[index].end)
			throw new Error("Configuration updates overlap");
	}
	let output = source;
	for (const replacement of replacements)
		output = `${output.slice(0, replacement.start)}${replacement.content}${output.slice(replacement.end)}`;
	parseTypeScript(output);
	return output;
}
