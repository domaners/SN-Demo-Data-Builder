'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedPlatform, example, generated } = require('./harness');

const plain = (x) => JSON.parse(JSON.stringify(x));

test('Prng is deterministic and forks independently', () => {
	const h = createHarness();
	const a = h.eval('var p = new Prng("seed-1"); [p.next(), p.int(1, 6), p.uuid()]');
	const b = h.eval('var q = new Prng("seed-1"); [q.next(), q.int(1, 6), q.uuid()]');
	assert.deepEqual(plain(a), plain(b));
	const c = h.eval('new Prng("seed-2").next()');
	assert.notEqual(a[0], c);
	assert.match(a[2], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	const forks = h.eval('var r = new Prng("s"); [r.fork("x").next(), new Prng("s").fork("x").next(), r.fork("y").next()]');
	assert.equal(forks[0], forks[1]);
	assert.notEqual(forks[0], forks[2]);
});

test('Prng values stay in range', () => {
	const h = createHarness();
	const stats = plain(h.eval(`(function () {
		var p = new Prng("range"), min = 1, max = 0, ints = {};
		for (var i = 0; i < 5000; i++) {
			var v = p.next(); if (v < min) min = v; if (v > max) max = v;
			ints[p.int(3, 5)] = true;
		}
		return { min: min, max: max, ints: Object.keys(ints).sort() };
	})()`));
	assert.ok(stats.min >= 0 && stats.max < 1);
	assert.deepEqual(stats.ints, ['3', '4', '5']);
});

test('apportion distributes exactly with largest remainders', () => {
	const h = createHarness();
	assert.deepEqual(plain(h.eval('FoundationPlanner.apportion(10, [0.5, 0.3, 0.2])')), [5, 3, 2]);
	assert.deepEqual(plain(h.eval('FoundationPlanner.apportion(7, [1, 1, 1])')), [3, 2, 2]);
	assert.deepEqual(plain(h.eval('FoundationPlanner.apportion(5, [0, 0])')), [0, 0]);
	const sum = h.eval('FoundationPlanner.apportion(997, [0.13, 0.27, 0.31, 0.29]).reduce(function (a, b) { return a + b; }, 0)');
	assert.equal(sum, 997);
});

test('NameGenerator slugs and patterns', () => {
	const h = createHarness();
	assert.equal(h.eval('NameGenerator.slug("de Vries")'), 'devries');
	assert.equal(h.eval('NameGenerator.slug("Müller-Lüdenscheidt")'), 'mullerludenscheidt');
	assert.equal(h.eval('NameGenerator.slug("Łukasz")'), 'lukasz');
	assert.equal(h.eval('NameGenerator.slug("D\'Angelo")'), 'dangelo');
	assert.equal(h.eval('NameGenerator.applyPattern("{first}.{last}", {first: "Femke", last: "de Vries"}, 0)'), 'femke.devries');
	assert.equal(h.eval('NameGenerator.applyPattern("{f}{last}{n}", {first: "Tom", last: "Whitaker"}, 2)'), 'twhitaker2');
	assert.equal(h.eval('NameGenerator.applyPattern("{first}.{last}@{domain}", {first: "A", last: "B"}, 0, "x.example")'), 'a.b@x.example');
	assert.equal(h.eval('NameGenerator.resolve("en-AU")'), 'en-GB');
	assert.equal(h.eval('NameGenerator.resolve("de-LU")'), 'de-DE');
	assert.equal(h.eval('NameGenerator.supports("xx-YY")'), false);
});

test('blueprint schema stays within the structured-output subset', () => {
	const bad = [];
	const walk = (node, p) => {
		if (Array.isArray(node))
			return node.forEach((v, i) => walk(v, p + '/' + i));
		if (!node || typeof node !== 'object')
			return;
		if (node.type === 'object') {
			if (node.additionalProperties !== false)
				bad.push(p + ': additionalProperties must be false');
			const req = (node.required || []).slice().sort().join(',');
			const props = Object.keys(node.properties || {}).sort().join(',');
			if (req !== props)
				bad.push(p + ': every property must be required');
		}
		['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'].forEach((k) => {
			if (k in node)
				bad.push(p + ': unsupported keyword ' + k);
		});
		Object.keys(node).forEach((k) => walk(node[k], p + '/' + k));
	};
	walk(generated.schema, '#');
	assert.deepEqual(bad, []);
});

test('section schemas cover every top-level property exactly once', () => {
	const h = createHarness();
	const sections = plain(h.eval('BlueprintSchema.SECTIONS'));
	const covered = sections.flatMap((s) => s.properties).sort();
	assert.deepEqual(covered, Object.keys(generated.schema.properties).sort());
	const org = plain(h.eval('BlueprintSchema.sectionSchema("org")'));
	assert.equal(org.additionalProperties, false);
	assert.deepEqual(org.required, ['schema_version', 'company', 'locations', 'departments']);
	assert.equal(org.$schema, undefined);
});

test('JsonSchemaValidator reports type, enum, required and extra properties', () => {
	const h = createHarness();
	const errors = plain(h.eval(`new JsonSchemaValidator().validate(
		{ a: "x", b: 5, extra: 1 },
		{ type: "object", additionalProperties: false, required: ["a", "b", "c"],
		  properties: { a: { type: "integer" }, b: { enum: [1, 2] }, c: { type: "string" } } })`));
	const messages = errors.map((e) => e.path + ' ' + e.message).join('\n');
	assert.match(messages, /\$\.a expected integer, got string/);
	assert.match(messages, /\$\.b must be one of 1, 2/);
	assert.match(messages, /missing required property "c"/);
	assert.match(messages, /unexpected property "extra"/);
	assert.equal(h.eval('new JsonSchemaValidator().validate(null, { anyOf: [{ type: "string" }, { type: "null" }] }).length'), 0);
	assert.equal(h.eval('new JsonSchemaValidator().validate("bad host!", { type: "string", format: "hostname" }).length'), 1);
});

test('the bundled example blueprint is valid, including platform checks', () => {
	const h = createHarness();
	seedPlatform(h);
	const result = plain(h.eval('new BlueprintValidator(BlueprintValidator.instancePlatform()).validate(ExampleBlueprints.get("halden"))'));
	assert.deepEqual(result.errors, []);
	assert.equal(result.valid, true);
});

test('validator catches broken references, cycles and bad values', () => {
	const h = createHarness();
	const bp = example();
	bp.groups[0].manager_key = 'nobody';
	bp.departments[0].parent_key = 'it';
	bp.applications[0].depends_on_keys = ['wms'];
	bp.applications[1].depends_on_keys = ['track'];
	bp.themes[0].application_keys.push('ghost');
	bp.company.short_code = 'hfl';
	bp.locations.push(Object.assign({}, bp.locations[1]));
	h.ctx.__bp = bp;
	const result = plain(h.eval('new BlueprintValidator(null).validate(__bp)'));
	const text = result.errors.join('\n');
	assert.equal(result.valid, false);
	assert.match(text, /group "sd": unknown manager \(named user\) "nobody"/);
	assert.match(text, /departments: cycle/);
	assert.match(text, /application dependencies: cycle/);
	assert.match(text, /theme "db-connections": unknown application "ghost"/);
	assert.match(text, /short_code/);
	assert.match(text, /locations: duplicate key "man-hq"/);
});

test('validator reports schema errors with paths and stops there', () => {
	const h = createHarness();
	const bp = example();
	delete bp.catalog;
	bp.locations[0].type = 'moon_base';
	h.ctx.__bp = bp;
	const result = plain(h.eval('new BlueprintValidator(null).validate(__bp)'));
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => /^Schema: \$ missing required property "catalog"/.test(e)));
	assert.ok(result.errors.some((e) => /^Schema: \$\.locations\[0\]\.type must be one of/.test(e)));
});

test('validator platform checks flag unknown CI classes and roles', () => {
	const h = createHarness();
	seedPlatform(h);
	const bp = example();
	bp.applications[0].tiers[0].ci_class = 'cmdb_ci_made_up';
	bp.groups[0].roles = ['not_a_role'];
	h.ctx.__bp = bp;
	const result = plain(h.eval('new BlueprintValidator(BlueprintValidator.instancePlatform()).validate(__bp)'));
	assert.ok(result.errors.some((e) => /"cmdb_ci_made_up" is not a CMDB class/.test(e)));
	assert.ok(result.warnings.some((w) => /role "not_a_role" does not exist/.test(w)));
});

test('errors map to the sections that should be repaired', () => {
	const h = createHarness();
	const map = (errors) => plain(h.eval('BlueprintService.sectionsForErrors(' + JSON.stringify(errors) + ')'));
	assert.deepEqual(map(['theme "x": unknown application "y"']), ['infra']);
	assert.deepEqual(map(['application "a" tier web: unknown hosting location "z"']), ['apps']);
	assert.deepEqual(map(['group "g": unknown member department "d"', 'named user "u": unknown department "d"']), ['people']);
	assert.deepEqual(map(['location "l": unknown parent location "p"', 'company.short_code must be']), ['org']);
	assert.deepEqual(map(['Schema: $.applications[0].tiers expected array', 'Schema: $.catalog[1] missing']), ['apps', 'infra']);
	assert.deepEqual(map(['something unrecognised']), []);
});

test('prompt templates render and have both parts', () => {
	const h = createHarness();
	assert.equal(h.eval('PromptLibrary.render("Hi {{ name }}, {{missing}}!", { name: "Ann" })'), 'Hi Ann, !');
	const names = Object.keys(generated.prompts).sort();
	assert.deepEqual(names, ['blueprint.repair', 'blueprint.section']);
	names.forEach((n) => {
		assert.ok(generated.prompts[n].system.length > 200, n + ' system');
		assert.match(generated.prompts[n].user, /\{\{/);
	});
	const p = plain(h.eval('PromptLibrary.get("blueprint.section")'));
	assert.equal(p.version, 1);
	assert.match(p.user, /\{\{section_key\}\}/);
});

test('Guard blocks production and instances outside the allow list', () => {
	const prod = createHarness({ props: { 'glide.installation.production': 'true' } });
	assert.match(prod.eval('Guard.whyBlocked()'), /production/);
	const listed = createHarness({ props: { 'x_ddb.allowed_instances': 'dev1, DEV12345' } });
	assert.equal(listed.eval('Guard.whyBlocked()'), null);
	const unlisted = createHarness({ props: { 'x_ddb.allowed_instances': 'dev1' } });
	assert.match(unlisted.eval('Guard.whyBlocked()'), /not listed/);
});
