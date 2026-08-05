<script lang="ts">
import ConfigValueEditor from "./ConfigValueEditor.svelte";
import type { ConfigField, JsonValue } from "./config-types";

export let field: ConfigField;
export let disabled = false;
export let depth = 0;
export let onChange: (path: string, value: JsonValue) => void;

$: fieldId = `config-${field.path.replace(/[^a-z0-9]+/gi, "-")}`;
$: children = field.children || [];

function stringInput(event: Event) {
	onChange(
		field.path,
		(event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value,
	);
}

function numberInput(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	if (input.value !== "" && Number.isFinite(input.valueAsNumber))
		onChange(field.path, input.valueAsNumber);
}
</script>

{#if field.kind === "object" || field.kind === "collection"}
	<fieldset class="field-group" class:root={depth === 0} data-config-path={field.path}>
		<legend>{field.label}</legend>
		{#if field.description}<p class="description">{field.description}</p>{/if}
		{#if field.kind === "collection"}
			<p class="generated-note">固定列表结构</p>
		{/if}
		<div class="field-children">
			{#each children as child}
				<svelte:self field={child} {disabled} depth={depth + 1} {onChange} />
			{/each}
		</div>
	</fieldset>
{:else if field.kind === "readonly" || field.kind === "null"}
	<div class="readonly-field" data-config-path={field.path}>
		<span><strong>{field.label}</strong>{#if field.description}<small>{field.description}</small>{/if}</span>
		<em>代码生成值</em>
	</div>
{:else if field.kind === "boolean"}
	<label class="toggle-field" for={fieldId} data-config-path={field.path}>
		<span><strong>{field.label}</strong>{#if field.description}<small>{field.description}</small>{/if}</span>
		<input id={fieldId} type="checkbox" checked={Boolean(field.value)} on:change={(event) => onChange(field.path, (event.currentTarget as HTMLInputElement).checked)} {disabled} />
	</label>
{:else if field.kind === "array" && Array.isArray(field.value)}
	<div class="array-field" data-config-path={field.path}>
		<div class="field-copy"><strong>{field.label}</strong>{#if field.description}<small>{field.description}</small>{/if}</div>
		<ConfigValueEditor value={field.value} template={field.itemTemplate} {disabled} depth={depth + 1} onChange={(value) => onChange(field.path, value)} />
	</div>
{:else if field.kind === "string"}
	<label class="input-field" for={fieldId} data-config-path={field.path}>
		<span><strong>{field.label}</strong>{#if field.description}<small>{field.description}</small>{/if}</span>
		{#if field.options?.length}
			<select id={fieldId} value={String(field.value ?? "")} on:change={stringInput} {disabled}>
				{#each field.options as option}<option value={option}>{option}</option>{/each}
			</select>
		{:else if field.input === "multiline"}
			<textarea id={fieldId} rows="4" value={String(field.value ?? "")} on:input={stringInput} {disabled}></textarea>
		{:else}
			<input id={fieldId} type={field.input === "url" ? "url" : "text"} value={String(field.value ?? "")} on:input={stringInput} {disabled} />
		{/if}
	</label>
{:else if field.kind === "number"}
	<label class="input-field" for={fieldId} data-config-path={field.path}>
		<span><strong>{field.label}</strong>{#if field.description}<small>{field.description}</small>{/if}</span>
		<input id={fieldId} type="number" value={Number(field.value)} min={field.min} max={field.max} step={field.step ?? "any"} on:input={numberInput} {disabled} />
	</label>
{/if}

<style>
	.field-group { min-width: 0; margin: 0; border: 0; border-left: 2px solid #dbe5e2; padding: 10px 0 10px 16px; }
	.field-group.root { border-left: 0; padding: 0; }
	.field-group legend { max-width: 100%; padding: 0 7px 0 0; color: #344943; font-size: 13px; font-weight: 750; overflow-wrap: anywhere; }
	.field-group.root > legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; clip-path: inset(50%); }
	.description, .generated-note { margin: 3px 0 10px; color: #697975; font-size: 11px; line-height: 1.55; }
	.generated-note { padding: 8px 10px; border-left: 3px solid #9dafaa; background: #f5f7f7; }
	.field-children { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 18px; }
	.field-group .field-group, .array-field { grid-column: 1 / -1; }
	.input-field { display: grid; min-width: 0; align-content: start; gap: 7px; }
	.input-field > span, .toggle-field > span, .readonly-field > span, .field-copy { min-width: 0; }
	.input-field strong, .input-field small, .toggle-field strong, .toggle-field small, .readonly-field strong, .readonly-field small, .field-copy strong, .field-copy small { display: block; overflow-wrap: anywhere; }
	.input-field strong, .toggle-field strong, .readonly-field strong, .field-copy strong { color: #344943; font-size: 12px; }
	.input-field small, .toggle-field small, .readonly-field small, .field-copy small { margin-top: 4px; color: #74827e; font-size: 10px; font-weight: 400; line-height: 1.45; }
	.input-field input, .input-field select, .input-field textarea { min-width: 0; width: 100%; border: 1px solid #c8d5d1; border-radius: 6px; padding: 8px 10px; background: #fff; color: #20322e; }
	.input-field input, .input-field select { height: 40px; }
	.input-field textarea { resize: vertical; line-height: 1.55; }
	.toggle-field, .readonly-field { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid #e2e8e6; padding: 8px 0; }
	.toggle-field input { width: 20px; height: 20px; flex: 0 0 auto; accent-color: #16866f; }
	.readonly-field em { flex: 0 0 auto; border-radius: 4px; padding: 4px 6px; background: #edf1f0; color: #6f7e7a; font-size: 10px; font-style: normal; }
	.array-field { min-width: 0; padding: 12px 0; border-top: 1px solid #dfe7e5; }
	.field-copy { margin-bottom: 8px; }
	input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #1976a3; outline-offset: 2px; }
	@media (max-width: 700px) {
		.field-children { grid-template-columns: 1fr; }
		.field-group { padding-left: 10px; }
	}
</style>
