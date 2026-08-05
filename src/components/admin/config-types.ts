export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export type ConfigFieldKind =
	| "string"
	| "number"
	| "boolean"
	| "null"
	| "array"
	| "object"
	| "collection"
	| "readonly";

export type ConfigField = {
	kind: ConfigFieldKind;
	path: string;
	key: string;
	label: string;
	editable: boolean;
	value?: JsonValue;
	itemTemplate?: JsonValue;
	children?: ConfigField[];
	description?: string;
	input?: "url" | "multiline";
	options?: string[];
	min?: number;
	max?: number;
	step?: number;
};

export type ConfigDocument = {
	sections: Array<{
		key: string;
		label: string;
		field: ConfigField;
	}>;
	editableFieldCount: number;
};

export type ConfigFileSummary = {
	key: string;
	path: string;
	name: string;
	group: string;
	language: string;
	description: string;
};

export type ManagedConfigFile = ConfigFileSummary & {
	sha: string;
	document: ConfigDocument;
};

export type ConfigUpdate = { path: string; value: JsonValue };

export type SaveFileResponse = {
	ok: boolean;
	sha: string | null;
	document: ConfigDocument;
};
