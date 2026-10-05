'use strict';
// Reads the app/ source tree and injects generated content into Script Includes.
// Shared by the build and the test harness so both see exactly the same scripts.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Parse app/prompts/*.md: front matter, then "=== system ===" and "=== user ===" blocks. */
function parsePrompt(text, file) {
	const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
	if (!m)
		throw new Error(file + ': missing front matter');
	const meta = {};
	m[1].split('\n').forEach((line) => {
		const i = line.indexOf(':');
		if (i > 0)
			meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	});
	const body = m[2];
	const sys = /=== system ===\n([\s\S]*?)\n=== user ===\n([\s\S]*)$/.exec(body);
	if (!sys)
		throw new Error(file + ': needs "=== system ===" and "=== user ===" sections');
	if (!meta.name || !meta.version)
		throw new Error(file + ': front matter needs name and version');
	return {
		name: meta.name,
		purpose: meta.purpose || '',
		version: parseInt(meta.version, 10),
		description: meta.description || '',
		system: sys[1].trim() + '\n',
		user: sys[2].trim() + '\n'
	};
}

function loadPrompts() {
	const dir = path.join(APP, 'prompts');
	const prompts = {};
	fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().forEach((f) => {
		const p = parsePrompt(fs.readFileSync(path.join(dir, f), 'utf8'), f);
		prompts[p.name] = p;
	});
	return prompts;
}

function loadGenerated() {
	return {
		schema: readJson(path.join(ROOT, 'docs', 'schemas', 'blueprint.schema.json')),
		example: readJson(path.join(ROOT, 'docs', 'examples', 'blueprint.example.json')),
		prompts: loadPrompts()
	};
}

const PLACEHOLDERS = {
	'/*@@BLUEPRINT_SCHEMA@@*/ null': (g) => JSON.stringify(g.schema),
	'/*@@EXAMPLE_BLUEPRINT@@*/ null': (g) => JSON.stringify(g.example),
	'/*@@PROMPTS@@*/ null': (g) => JSON.stringify(g.prompts)
};

function inject(source, generated) {
	let out = source;
	Object.keys(PLACEHOLDERS).forEach((token) => {
		if (out.indexOf(token) >= 0)
			out = out.split(token).join(PLACEHOLDERS[token](generated));
	});
	return out;
}

/** Script Includes in load order (base classes first), with metadata from the header comment. */
const SCRIPT_INCLUDE_ORDER = [
	'Prng', 'Guard', 'Ledger', 'LLMProvider', 'AnthropicProvider', 'ProviderFactory', 'BlueprintSchema',
	'ExampleBlueprints', 'JsonSchemaValidator', 'NameGenerator', 'BlueprintValidator', 'PromptLibrary',
	'BlueprintService', 'FoundationPlanner', 'FoundationSimulator', 'ResetService', 'GenerationJob', 'SetupCheck'
];

function loadScriptIncludes(generated) {
	const dir = path.join(APP, 'script_includes');
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
	const unknown = files.filter((n) => SCRIPT_INCLUDE_ORDER.indexOf(n) < 0);
	if (unknown.length)
		throw new Error('Add these Script Includes to SCRIPT_INCLUDE_ORDER in build/lib/source.js: ' + unknown.join(', '));
	return SCRIPT_INCLUDE_ORDER.filter((n) => files.indexOf(n) >= 0).map((name) => {
		const raw = fs.readFileSync(path.join(dir, name + '.js'), 'utf8');
		const header = /^\/\*\*([\s\S]*?)\*\//.exec(raw);
		const doc = header ? header[1] : '';
		const access = (/@access\s+(\w+)/.exec(doc) || [])[1] || 'package_private';
		const description = doc.split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).filter((l) => l && l.indexOf('@') !== 0)
			.join(' ').trim().slice(0, 1000);
		return { name: name, access: access, description: description, script: inject(raw, generated) };
	});
}

function loadApp() {
	const generated = loadGenerated();
	const tablesDir = path.join(APP, 'tables');
	const recordsDir = path.join(APP, 'records');
	const tables = fs.readdirSync(tablesDir).filter((f) => f.endsWith('.json')).sort()
		.map((f) => readJson(path.join(tablesDir, f)));
	const records = [];
	fs.readdirSync(recordsDir).filter((f) => f.endsWith('.json')).sort().forEach((f) => {
		readJson(path.join(recordsDir, f)).forEach((r) => {
			const fields = Object.assign({}, r.fields);
			Object.keys(r.scripts || {}).forEach((field) => {
				fields[field] = fs.readFileSync(path.join(APP, r.scripts[field]), 'utf8');
			});
			records.push({ table: r.table, key: r.key, fields: fields, file: f });
		});
	});
	return {
		app: readJson(path.join(APP, 'app.json')),
		tables: tables,
		scriptIncludes: loadScriptIncludes(generated),
		records: records,
		prompts: generated.prompts,
		generated: generated
	};
}

module.exports = { ROOT, APP, loadApp, loadGenerated, loadScriptIncludes, inject, parsePrompt, SCRIPT_INCLUDE_ORDER };
