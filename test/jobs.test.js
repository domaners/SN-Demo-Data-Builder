'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedPlatform, seedProvider, seedCredential, claudeResponse, example } = require('./harness');

const SECTIONS = {
	org: ['schema_version', 'company', 'locations', 'departments'],
	people: ['people', 'groups'],
	apps: ['applications'],
	infra: ['infrastructure', 'catalog', 'themes']
};

function sectionOf(bp, key) {
	const out = {};
	SECTIONS[key].forEach((p) => { out[p] = bp[p]; });
	return out;
}

function setup(scenarioOverrides) {
	const h = createHarness();
	seedPlatform(h);
	seedProvider(h);
	seedCredential(h);
	const scenarioId = h.insert('x_ddb_scenario', Object.assign({
		name: 'Halden', industry: 'Logistics', size_tier: 'small', regions: 'UK, NL', state: 'draft', seed: 'fixed-seed'
	}, scenarioOverrides || {}));
	return { h, scenarioId };
}

function runUiAction(h, script, table, sysId) {
	const action = h.action();
	h.runScript(script, { current: h.gr(table, sysId), action: action });
	return action;
}

function job(h) {
	const jobs = h.rows('x_ddb_generation_job');
	return jobs[jobs.length - 1];
}

test('generate blueprint: one Claude call per section, then validation', () => {
	const { h, scenarioId } = setup();
	const bp = example();
	['org', 'people', 'apps', 'infra'].forEach((k) => h.respond(claudeResponse(sectionOf(bp, k))));

	const action = runUiAction(h, 'scripts/ua_scenario_generate.js', 'x_ddb_scenario', scenarioId);
	assert.deepEqual(h.messages.error, []);
	assert.equal(action.redirect.getTableName(), 'x_ddb_generation_job');
	h.drain();

	const j = job(h);
	assert.equal(j.state, 'complete', j.log);
	assert.equal(j.progress, '100');
	assert.equal(j.tokens_in, String(4 * 1200));
	assert.equal(j.tokens_out, String(4 * 800));
	assert.equal(h.http.requests.length, 4);

	const second = JSON.parse(h.http.requests[1].body);
	assert.match(second.messages[0].content, /"people" section/);
	assert.match(second.messages[0].content, /Halden Freight Logistics/, 'earlier sections are passed as context');
	assert.deepEqual(Object.keys(second.output_config.format.schema.properties), ['people', 'groups']);
	assert.equal(JSON.parse(h.http.requests[0].body).system[0].text, second.system[0].text, 'system prompt is stable for caching');

	const blueprint = h.rows('x_ddb_blueprint')[0];
	assert.equal(blueprint.state, 'valid', blueprint.validation_errors);
	assert.deepEqual(JSON.parse(blueprint.blueprint_json), bp);
	assert.match(blueprint.summary, /^Halden Freight Logistics \(HFL\)/);
	assert.equal(h.gr('x_ddb_scenario', scenarioId).getValue('state'), 'blueprint_ready');
	assert.equal(h.rows('x_ddb_llm_call').length, 4);
});

test('temporary API errors put the job in waiting; the watchdog retries it', () => {
	const { h, scenarioId } = setup();
	const bp = example();
	h.respond(claudeResponse(sectionOf(bp, 'org')));
	h.respond({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
	runUiAction(h, 'scripts/ua_scenario_generate.js', 'x_ddb_scenario', scenarioId);
	h.drain();

	let j = job(h);
	assert.equal(j.state, 'waiting');
	assert.equal(j.phase, 'people');
	assert.equal(j.attempt, '1');
	assert.match(j.log, /retrying in 30s/);

	h.runScript('scripts/watchdog.js', {});
	assert.equal(h.events.length, 0, 'not due yet');
	h.advance(31);
	['people', 'apps', 'infra'].forEach((k) => h.respond(claudeResponse(sectionOf(bp, k))));
	h.runScript('scripts/watchdog.js', {});
	h.drain();
	j = job(h);
	assert.equal(j.state, 'complete', j.log);
	assert.equal(h.rows('x_ddb_blueprint')[0].state, 'valid');
});

test('a refusal fails the job and the scenario, and Retry resumes it', () => {
	const { h, scenarioId } = setup();
	h.respond({ status: 200, body: { model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { category: null }, content: [], usage: {} } });
	runUiAction(h, 'scripts/ua_scenario_generate.js', 'x_ddb_scenario', scenarioId);
	h.drain();
	let j = job(h);
	assert.equal(j.state, 'failed');
	assert.match(j.error, /declined/);
	assert.equal(h.gr('x_ddb_scenario', scenarioId).getValue('state'), 'failed');

	const bp = example();
	['org', 'people', 'apps', 'infra'].forEach((k) => h.respond(claudeResponse(sectionOf(bp, k))));
	runUiAction(h, 'scripts/ua_job_retry.js', 'x_ddb_generation_job', j.sys_id);
	h.drain();
	j = job(h);
	assert.equal(j.state, 'complete', j.log);
});

test('only one active job per scenario', () => {
	const { h, scenarioId } = setup();
	runUiAction(h, 'scripts/ua_scenario_generate.js', 'x_ddb_scenario', scenarioId);
	runUiAction(h, 'scripts/ua_scenario_generate.js', 'x_ddb_scenario', scenarioId);
	assert.match(h.messages.error[0], /still in progress/);
	assert.equal(h.rows('x_ddb_generation_job').length, 1);
});

test('repair regenerates only the sections named in the errors', () => {
	const { h, scenarioId } = setup();
	const broken = example();
	broken.themes[0].application_keys = ['ghost'];
	h.ctx.__bp = broken;
	h.eval('var __svc = new BlueprintService(); var __s = new GlideRecord("x_ddb_scenario"); __s.query(); __s.next();' +
		'var __b = __svc.createDraft(__s, "manual", __bp); __svc.validate(__b);');
	let blueprint = h.rows('x_ddb_blueprint')[0];
	assert.equal(blueprint.state, 'invalid');

	h.respond(claudeResponse(sectionOf(example(), 'infra')));
	runUiAction(h, 'scripts/ua_blueprint_repair.js', 'x_ddb_blueprint', blueprint.sys_id);
	h.drain();
	assert.equal(h.http.requests.length, 1);
	const body = JSON.parse(h.http.requests[0].body);
	assert.match(body.messages[0].content, /theme "db-connections": unknown application "ghost"/);
	assert.deepEqual(Object.keys(body.output_config.format.schema.properties), ['infrastructure', 'catalog', 'themes']);
	blueprint = h.rows('x_ddb_blueprint')[0];
	assert.equal(blueprint.state, 'valid', blueprint.validation_errors);
	assert.equal(job(h).state, 'complete');
	assert.ok(scenarioId);
});

function loadApprovedExample(h, scenarioId) {
	runUiAction(h, 'scripts/ua_scenario_example.js', 'x_ddb_scenario', scenarioId);
	const blueprint = h.rows('x_ddb_blueprint')[0];
	assert.equal(blueprint.state, 'valid', blueprint.validation_errors);
	runUiAction(h, 'scripts/ua_blueprint_approve.js', 'x_ddb_blueprint', blueprint.sys_id);
	assert.equal(h.gr('x_ddb_blueprint', blueprint.sys_id).getValue('state'), 'approved');
	return blueprint.sys_id;
}

test('build writes foundation data with LDAP provenance, in steps, and is idempotent', () => {
	const { h, scenarioId } = setup({ size_tier: 'custom', headcount: 150 });
	h.props['x_ddb.max_records_per_step'] = '100';
	const blueprintId = loadApprovedExample(h, scenarioId);
	assert.equal(h.http.requests.length, 0, 'example blueprints need no LLM call');

	runUiAction(h, 'scripts/ua_blueprint_preview.js', 'x_ddb_blueprint', blueprintId);
	assert.match(h.messages.info.join('\n'), /users: 150/);

	runUiAction(h, 'scripts/ua_blueprint_build.js', 'x_ddb_blueprint', blueprintId);
	const steps = h.drain();
	const j = job(h);
	assert.equal(j.state, 'complete', j.log);
	assert.ok(steps > 3, 'work is split into several steps (' + steps + ')');
	assert.equal(h.gr('x_ddb_scenario', scenarioId).getValue('state'), 'built');

	const users = h.rows('sys_user');
	assert.equal(users.length, 150);
	users.forEach((u) => {
		assert.match(u.source, /^ldap:CN=.*,DC=corp,DC=haldenfreight,DC=example$/);
		assert.equal(u.notification, '1');
		assert.ok(u.department && u.location && u.company && u.cost_center);
	});
	assert.equal(users.filter((u) => !u.manager).length, 1);
	const priya = users.find((u) => u.user_name === 'priya.raman');
	assert.equal(priya.title, 'Chief Information Officer');

	assert.equal(h.rows('x_ddb_dir_user').length, 150);
	assert.equal(h.rows('x_ddb_dir_group').length, 4);
	assert.equal(h.rows('core_company').length, 1);
	assert.equal(h.rows('cmn_location').length, 5);
	assert.equal(h.rows('cmn_department').length, 5);
	const groups = h.rows('sys_user_group');
	assert.equal(groups.length, 4);
	const itilType = h.rows('sys_user_group_type').find((t) => t.name === 'itil').sys_id;
	assert.equal(groups.find((g) => g.name === 'HFL Service Desk').type, itilType);
	assert.ok(h.rows('sys_user_grmember').length > 4);
	assert.equal(h.rows('sys_group_has_role').length, 4, 'every example group carries itil');
	assert.equal(h.rows('sys_user_has_role').length, 3, 'sd-lead itil + itil_admin, wms-owner itil');

	const london = h.rows('cmn_location').find((l) => l.name === 'Manchester HQ');
	const emea = h.rows('cmn_location').find((l) => l.name === 'EMEA');
	assert.equal(london.parent, emea.sys_id);
	const it = h.rows('cmn_department').find((d) => d.name === 'Information Technology');
	assert.equal(it.dept_head, users.find((u) => u.user_name === 'tom.whitaker').sys_id);

	const ledgerCount = h.rows('x_ddb_record_ledger').length;
	const total = Object.values(JSON.parse(j.counts)).reduce((n, c) => n + c.insert, 0);
	assert.equal(ledgerCount, total);
	assert.equal(ledgerCount, parseInt(j.total, 10));

	// Second build of the same blueprint and seed updates in place.
	runUiAction(h, 'scripts/ua_blueprint_build.js', 'x_ddb_blueprint', blueprintId);
	h.drain();
	const j2 = job(h);
	assert.equal(j2.state, 'complete', j2.log);
	assert.equal(h.rows('sys_user').length, 150);
	assert.equal(h.rows('x_ddb_record_ledger').length, ledgerCount);
	const counts2 = JSON.parse(j2.counts);
	assert.equal(Object.values(counts2).reduce((n, c) => n + (c.insert || 0), 0), 0);
});

test('fields missing on the instance are skipped and reported', () => {
	const { h, scenarioId } = setup({ size_tier: 'custom', headcount: 20 });
	h.schemas.cmn_location = ['name', 'parent', 'city', 'state', 'country', 'company'];
	const blueprintId = loadApprovedExample(h, scenarioId);
	runUiAction(h, 'scripts/ua_blueprint_build.js', 'x_ddb_blueprint', blueprintId);
	h.drain();
	const j = job(h);
	assert.equal(j.state, 'complete', j.log);
	assert.match(j.log, /Fields not present on this instance were skipped: cmn_location\.time_zone, cmn_location\.cmn_location_type/);
});

test('missing roles are skipped with a warning instead of failing the build', () => {
	const { h, scenarioId } = setup({ size_tier: 'custom', headcount: 20 });
	const blueprintId = loadApprovedExample(h, scenarioId);
	h.table('sys_user_role').forEach((r, id) => { if (r.name === 'itil_admin') h.table('sys_user_role').delete(id); });
	runUiAction(h, 'scripts/ua_blueprint_build.js', 'x_ddb_blueprint', blueprintId);
	h.drain();
	const j = job(h);
	assert.equal(j.state, 'complete');
	assert.match(j.log, /no sys_user_role named "itil_admin"/);
	assert.equal(h.rows('sys_user_has_role').length, 2);
});

test('building requires an approved blueprint', () => {
	const { h, scenarioId } = setup();
	runUiAction(h, 'scripts/ua_scenario_example.js', 'x_ddb_scenario', scenarioId);
	const blueprint = h.rows('x_ddb_blueprint')[0];
	assert.equal(blueprint.state, 'valid');
	h.ctx.__s = h.gr('x_ddb_scenario', scenarioId);
	h.ctx.__b = h.gr('x_ddb_blueprint', blueprint.sys_id);
	h.eval('GenerationJob.start("build", __s, __b, {})');
	h.drain();
	assert.equal(job(h).state, 'failed');
	assert.match(job(h).error, /must be approved/);
	assert.equal(h.rows('sys_user').length, 0);
});

test('reset deletes everything the scenario created and empties the ledger', () => {
	const { h, scenarioId } = setup({ size_tier: 'custom', headcount: 60 });
	h.props['x_ddb.max_records_per_step'] = '50';
	const blueprintId = loadApprovedExample(h, scenarioId);
	const otherUser = h.insert('sys_user', { user_name: 'existing.person' });
	runUiAction(h, 'scripts/ua_blueprint_build.js', 'x_ddb_blueprint', blueprintId);
	h.drain();
	assert.equal(h.rows('sys_user').length, 61);

	const reset = h.action();
	h.runScript('scripts/ua_scenario_reset.js', { current: h.gr('x_ddb_scenario', scenarioId), action: reset });
	const steps = h.drain();
	const j = job(h);
	assert.equal(j.type, 'reset');
	assert.equal(j.state, 'complete', j.log);
	assert.ok(steps > 2);
	['sys_user_has_role', 'sys_group_has_role', 'sys_user_grmember', 'sys_user_group', 'x_ddb_dir_user', 'x_ddb_dir_group',
		'cmn_department', 'cmn_cost_center', 'cmn_location', 'core_company', 'x_ddb_record_ledger'].forEach((t) => {
		assert.equal(h.rows(t).length, 0, t + ' should be empty');
	});
	assert.deepEqual(h.rows('sys_user').map((u) => u.sys_id), [otherUser], 'records DDB did not create are untouched');
	assert.equal(h.gr('x_ddb_scenario', scenarioId).getValue('state'), 'reset');
});

test('jobs refuse to run on production instances', () => {
	const { h, scenarioId } = setup();
	h.props['glide.installation.production'] = 'true';
	runUiAction(h, 'scripts/ua_scenario_example.js', 'x_ddb_scenario', scenarioId);
	assert.match(h.messages.error[0], /production/);
	assert.equal(h.rows('x_ddb_blueprint').length, 0);
});

test('setup check reports configuration state', () => {
	const { h } = setup();
	h.insert('sysevent_register', { event_name: 'x_ddb.job.step' });
	h.insert('sysevent_script_action', { event_name: 'x_ddb.job.step', active: true });
	h.insert('sysauto_script', { name: 'DDB Job Watchdog', active: true });
	h.respond({ status: 200, body: { display_name: 'Claude Opus 5.5' } });
	const results = JSON.parse(JSON.stringify(h.eval('new SetupCheck().run(true)')));
	const byName = {};
	results.forEach((r) => { byName[r.name] = r; });
	['Instance guard', 'Your role', 'Provider configuration', 'API credential', 'Outbound HTTP timeout',
		'Provider connection', 'Background processing', 'Table access'].forEach((n) => {
		assert.equal(byName[n].status, 'ok', n + ': ' + byName[n].message);
	});
	assert.ok(!JSON.stringify(results).includes('sk-ant'), 'never shows the key');
	const html = h.eval('new SetupCheck().renderHtml(' + JSON.stringify(results) + ', true)');
	assert.match(html, /Ready to use/);

	const bare = createHarness();
	const bareResults = JSON.parse(JSON.stringify(bare.eval('new SetupCheck().run(false)')));
	assert.equal(bareResults.find((r) => r.name === 'Provider configuration').status, 'fail');
	assert.equal(bareResults.find((r) => r.name === 'Background processing').status, 'fail');
});
