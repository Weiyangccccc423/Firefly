<script lang="ts">
import type { JsonValue } from "./config-types";

export let value: JsonValue;
export let template: JsonValue | undefined = undefined;
export let label = "";
export let disabled = false;
export let depth = 0;
export let onChange: (value: JsonValue) => void;

const valueLabels: Record<string, string> = {
	action: "操作",
	alt: "替代文本",
	amount: "金额",
	artist: "艺术家",
	avatar: "头像",
	cover: "封面",
	cssVariable: "CSS 变量",
	date: "日期",
	deepZoom: "深度缩放",
	desc: "描述",
	description: "描述",
	enable: "启用",
	enabled: "启用",
	fallbacks: "回退字体",
	icon: "图标",
	id: "标识",
	imgurl: "图片地址",
	label: "标签",
	link: "链接",
	lrc: "歌词",
	name: "名称",
	path: "路径",
	provider: "服务商",
	qrCode: "二维码",
	scale: "缩放",
	showOnPostPage: "文章页显示",
	siteurl: "站点地址",
	src: "资源地址",
	thumbnail: "缩略图",
	title: "标题",
	type: "类型",
	url: "地址",
	volume: "音量",
	weight: "权重",
	width: "宽度",
	height: "高度",
};

$: arrayValue = Array.isArray(value) ? value : [];
$: objectValue =
	value && typeof value === "object" && !Array.isArray(value) ? value : null;
$: objectEntries = objectValue ? Object.entries(objectValue) : [];

function valueLabel(key: string) {
	return (
		valueLabels[key] ||
		key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ")
	);
}

function blankFrom(valueTemplate: JsonValue | undefined): JsonValue {
	if (Array.isArray(valueTemplate)) return [];
	if (valueTemplate && typeof valueTemplate === "object")
		return Object.fromEntries(
			Object.entries(valueTemplate).map(([key, child]) => [
				key,
				blankFrom(child),
			]),
		);
	if (typeof valueTemplate === "number") return 0;
	if (typeof valueTemplate === "boolean") return false;
	if (valueTemplate === null) return null;
	return "";
}

function updateArray(index: number, nextValue: JsonValue) {
	const next = [...arrayValue];
	next[index] = nextValue;
	onChange(next);
}

function addArrayItem() {
	const valueTemplate =
		template ?? (arrayValue.length ? arrayValue[0] : undefined);
	onChange([...arrayValue, blankFrom(valueTemplate)]);
}

function removeArrayItem(index: number) {
	onChange(arrayValue.filter((_, itemIndex) => itemIndex !== index));
}

function moveArrayItem(index: number, direction: -1 | 1) {
	const target = index + direction;
	if (target < 0 || target >= arrayValue.length) return;
	const next = [...arrayValue];
	[next[index], next[target]] = [next[target], next[index]];
	onChange(next);
}

function updateObject(key: string, nextValue: JsonValue) {
	if (!objectValue) return;
	onChange({ ...objectValue, [key]: nextValue });
}

function stringInput(event: Event) {
	onChange(
		(event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value,
	);
}

function numberInput(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	onChange(input.value === "" ? 0 : input.valueAsNumber);
}
</script>

{#if Array.isArray(value)}
	<div class="array-editor" class:nested={depth > 0}>
		<div class="array-heading">
			{#if label}<strong>{label}</strong>{/if}
			<span>{arrayValue.length} 项</span>
			<button type="button" class="add-button" on:click={addArrayItem} {disabled}>
				+ 添加
			</button>
		</div>
		<div class="array-items">
			{#each arrayValue as item, index}
				<section class="array-item" aria-label={`${label || "列表"}第 ${index + 1} 项`}>
					<header>
						<strong>项目 {index + 1}</strong>
						<div class="item-actions">
							<button type="button" title="上移" aria-label={`上移第 ${index + 1} 项`} on:click={() => moveArrayItem(index, -1)} disabled={disabled || index === 0}>↑</button>
							<button type="button" title="下移" aria-label={`下移第 ${index + 1} 项`} on:click={() => moveArrayItem(index, 1)} disabled={disabled || index === arrayValue.length - 1}>↓</button>
							<button type="button" class="remove" title="删除" aria-label={`删除第 ${index + 1} 项`} on:click={() => removeArrayItem(index)} {disabled}>×</button>
						</div>
					</header>
					<svelte:self value={item} template={template} label="" {disabled} depth={depth + 1} onChange={(next) => updateArray(index, next)} />
				</section>
			{/each}
			{#if arrayValue.length === 0}
				<p class="empty">列表为空。</p>
			{/if}
		</div>
	</div>
{:else if objectValue}
	<div class="object-editor" class:nested={depth > 0}>
		{#if label}<strong class="object-label">{label}</strong>{/if}
		<div class="object-fields">
			{#each objectEntries as [key, child]}
				<svelte:self value={child} label={valueLabel(key)} {disabled} depth={depth + 1} onChange={(next) => updateObject(key, next)} />
			{/each}
		</div>
	</div>
{:else if typeof value === "boolean"}
	<label class="toggle-value">
		<span>{label}</span>
		<input type="checkbox" checked={value} on:change={(event) => onChange((event.currentTarget as HTMLInputElement).checked)} {disabled} />
	</label>
{:else if typeof value === "number"}
	<label class="value-field">
		<span>{label}</span>
		<input type="number" value={value} on:input={numberInput} {disabled} />
	</label>
{:else if typeof value === "string"}
	<label class="value-field">
		<span>{label}</span>
		<input type={/(地址|链接|头像|封面|资源)/.test(label) ? "url" : "text"} value={value} on:input={stringInput} {disabled} />
	</label>
{:else}
	<div class="null-value"><span>{label}</span><strong>空值</strong></div>
{/if}

<style>
	.array-editor { min-width: 0; }
	.array-editor.nested { padding-left: 12px; border-left: 2px solid #dbe5e2; }
	.array-heading { display: flex; min-height: 38px; align-items: center; gap: 10px; }
	.array-heading > strong { color: #344a44; font-size: 13px; }
	.array-heading > span { color: #75847f; font-size: 11px; }
	.add-button { margin-left: auto; border: 0; border-radius: 5px; padding: 7px 10px; background: #e5f3ef; color: #176453; cursor: pointer; font-weight: 700; }
	.array-items { display: grid; gap: 12px; margin-top: 8px; }
	.array-item { min-width: 0; padding: 12px 0 14px; border-top: 1px solid #dfe7e5; }
	.array-item > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 11px; }
	.array-item > header > strong { color: #60716c; font-size: 11px; }
	.item-actions { display: flex; gap: 4px; }
	.item-actions button { width: 30px; height: 30px; border: 0; border-radius: 5px; background: #edf2f1; color: #40534e; cursor: pointer; }
	.item-actions .remove { background: #fbeae7; color: #99382e; }
	button:disabled { cursor: not-allowed; opacity: .45; }
	.object-editor { min-width: 0; }
	.object-editor.nested { padding: 12px; border: 1px solid #dfe7e5; border-radius: 6px; background: #fafcfb; }
	.object-label { display: block; margin-bottom: 10px; color: #40534e; font-size: 12px; }
	.object-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
	.value-field { display: grid; min-width: 0; gap: 5px; color: #576862; font-size: 11px; font-weight: 700; }
	.value-field input { min-width: 0; width: 100%; height: 38px; border: 1px solid #c9d6d2; border-radius: 5px; padding: 7px 9px; background: #fff; color: #20322e; }
	.toggle-value, .null-value { display: flex; min-height: 38px; align-items: center; justify-content: space-between; gap: 12px; color: #52645e; font-size: 12px; }
	.toggle-value input { width: 19px; height: 19px; accent-color: #16866f; }
	.null-value strong { color: #86918e; font-size: 11px; }
	.empty { margin: 8px 0; color: #7b8985; font-size: 12px; }
	input:focus-visible, button:focus-visible { outline: 2px solid #1976a3; outline-offset: 2px; }
	@media (max-width: 700px) {
		.object-fields { grid-template-columns: 1fr; }
		.object-editor.nested { padding: 10px; }
		.array-editor.nested { padding-left: 8px; }
	}
</style>
