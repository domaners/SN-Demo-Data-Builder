'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadApp, ROOT } = require('../build/lib/source');
const { buildApp } = require('../build/lib/updateset');
const { checkWellFormed } = require('../build/lib/xmlcheck');
const { outputs, SC_DIR } = require('../build/build');

const src = loadApp();
const built = buildApp(src);

test('update set and every payload are well-formed XML', () => {
	checkWellFormed(built.xml);
	built.updates.forEach((u) => checkWellFormed(u.payload, u.name));
});

test('committed generated files match the source (run npm run build)', () => {
	const files = outputs(src, built);
	const stale = Object.keys(files).filter((f) => {
		const abs = path.join(ROOT, f);
		return !fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== files[f];
	});
	assert.deepEqual(stale, [], 'stale generated files; run npm run build');
});

test('build output is deterministic', () => {
	assert.equal(buildApp(loadApp()).xml, built.xml);
});

test('update set contains the app, every table, column, Script Include and record', () => {
	const names = built.updates.map((u) => u.name);
	assert.ok(names.indexOf('sys_app_' + built.appId) === 0, 'the application comes first');
	src.tables.forEach((t) => {
		assert.ok(names.indexOf('sys_dictionary_' + t.name + '_null') >= 0, t.name);
		t.columns.forEach((c) => assert.ok(names.indexOf('sys_dictionary_' + t.name + '_' + c.name) >= 0, t.name + '.' + c.name));
	});
	assert.equal(built.updates.filter((u) => u.type === 'Script Include').length, src.scriptIncludes.length);
	assert.equal(built.updates.filter((u) => u.name.indexOf('x_ddb_prompt_template_') === 0).length, Object.keys(src.prompts).length);
	const sorted = built.updates.map((u) => u.created);
	assert.deepEqual(sorted, sorted.slice().sort(), 'updates are timestamped in dependency order');
});

test('generated Script Includes contain the injected schema, example and prompts', () => {
	const byName = {};
	src.scriptIncludes.forEach((si) => { byName[si.name] = si.script; });
	assert.ok(!/@@[A-Z_]+@@/.test(Object.values(byName).join('\n')), 'no placeholders left');
	assert.match(byName.BlueprintSchema, /"applications"/);
	assert.match(byName.ExampleBlueprints, /Halden Freight Logistics/);
	assert.match(byName.PromptLibrary, /blueprint\.section/);
});

test('records reference tables and scripts that exist', () => {
	const appTables = new Set(src.tables.map((t) => t.name));
	src.records.forEach((r) => {
		if (r.table === 'sys_ui_action')
			assert.ok(appTables.has(r.fields.table), r.key + ' table');
		if (r.table === 'sys_app_module' && r.fields.link_type === 'LIST')
			assert.ok(appTables.has(r.fields.name) || r.fields.name === 'sys_properties', r.key + ' module table');
		if (r.table === 'sys_script')
			assert.ok(appTables.has(r.fields.collection), r.key + ' business rule table');
		Object.keys(r.fields).forEach((f) => {
			const v = r.fields[f];
			if (typeof v === 'string' && v.indexOf('@ref:') === 0) {
				const [, table, key] = v.split(':');
				assert.ok(src.records.some((x) => x.table === table && x.key === key), r.key + '.' + f + ' -> ' + v);
			}
		});
	});
	const actionNames = src.records.filter((r) => r.table === 'sys_ui_action').map((r) => r.fields.action_name);
	assert.equal(new Set(actionNames).size, actionNames.length);
	src.records.filter((r) => r.table === 'sys_ui_action' && r.fields.client === 'true').forEach((r) => {
		const fn = r.fields.onclick.replace('()', '');
		assert.match(r.fields.script, new RegExp('function ' + fn + '\\('), r.key + ' defines its onclick function');
		assert.match(r.fields.script, new RegExp("gsftSubmit\\(null, g_form.getFormElement\\(\\), '" + r.fields.action_name + "'\\)"), r.key);
	});
});

test('table definitions are sane', () => {
	const reserved = ['cursor', 'json', 'order by', 'select', 'group', 'number'];
	src.tables.forEach((t) => {
		assert.match(t.name, /^x_ddb_[a-z_]+$/);
		assert.ok(t.name.length <= 40, t.name + ' too long');
		const cols = t.columns.map((c) => c.name);
		assert.equal(new Set(cols).size, cols.length, t.name + ' duplicate columns');
		assert.ok(cols.indexOf(t.display) >= 0, t.name + ' display column');
		t.columns.forEach((c) => {
			assert.ok(reserved.indexOf(c.name) < 0, t.name + '.' + c.name + ' is a reserved word');
			assert.ok(!/^sys_/.test(c.name), t.name + '.' + c.name);
			if (c.type === 'reference')
				assert.ok(c.reference, t.name + '.' + c.name + ' needs a reference table');
			if (c.choices)
				c.choices.forEach((ch) => assert.ok(ch[0].length <= (c.max_length || 40), t.name + '.' + c.name + ' choice too long'));
		});
	});
});

test('Studio source-control layout has what Import From Source Control looks for', () => {
	const props = fs.readFileSync(path.join(ROOT, 'sn_source_control.properties'), 'utf8');
	assert.match(props, new RegExp('^path=/' + SC_DIR + '$', 'm'));
	const sc = built.sourceControl;
	assert.ok(sc['sys_app_' + built.appId + '.xml'], 'application file at the app path root');
	assert.match(sc['sys_app_' + built.appId + '.xml'], /<record_update table="sys_app"><sys_app action="INSERT_OR_UPDATE">.*<scope>x_ddb<\/scope>/);
	assert.ok(sc['checksum.txt']);
	built.updates.filter((u) => u.table !== 'sys_app').forEach((u) => {
		assert.equal(sc['update/' + u.name + '.xml'], u.payload + '\n', u.name);
	});
	src.tables.forEach((t) => {
		const db = sc['dictionary/' + t.name + '.xml'];
		checkWellFormed(db, t.name);
		assert.match(db, new RegExp('<element label="[^"]+" max_length="40" name="' + t.name + '" type="collection">'));
		t.columns.forEach((c) => assert.match(db, new RegExp(' name="' + c.name + '" '), t.name + '.' + c.name));
	});
	const allowed = /^(sys_app_[0-9a-f]{32}\.xml|checksum\.txt|update\/[a-z0-9_]+\.xml|dictionary\/x_ddb_[a-z_]+\.xml)$/;
	Object.keys(sc).forEach((f) => assert.match(f, allowed));
});

test('payloads use the shapes Studio exports', () => {
	const byName = {};
	built.updates.forEach((u) => { byName[u.name] = u.payload; });
	assert.match(byName.sys_dictionary_x_ddb_scenario_null, /^<\?xml[^>]*\?><record_update><sys_dictionary action="INSERT_OR_UPDATE" element="" table="x_ddb_scenario">/);
	assert.match(byName.sys_dictionary_x_ddb_scenario_name, /<record_update><sys_dictionary action="INSERT_OR_UPDATE" element="name" table="x_ddb_scenario">/);
	assert.match(byName.sys_documentation_x_ddb_scenario_name_en,
		/<record_update><sys_documentation element="name" label="Name" language="en" table="x_ddb_scenario"><sys_documentation action="INSERT_OR_UPDATE">/);
	assert.match(byName.sys_documentation_x_ddb_scenario__en, /<sys_documentation element="" label="Scenario"/);
	const choices = byName.sys_choice_x_ddb_scenario_size_tier;
	assert.match(choices, /<record_update><sys_choice action="INSERT_OR_UPDATE" field="size_tier" table="x_ddb_scenario" version="1">/);
	assert.equal((choices.match(/<sys_choice action="INSERT_OR_UPDATE">/g) || []).length, 4);
	const acl = built.updates.find((u) => u.table === 'sys_security_acl').payload;
	assert.match(acl, /<operation display_value="read">read<\/operation>/);
	assert.match(acl, /<type display_value="record">record<\/type>/);
	const app = byName['sys_app_' + built.appId];
	assert.ok(!/<sys_scope/.test(app), 'the application record does not reference a scope');
});
