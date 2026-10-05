/**
 * Creates, generates, repairs, validates and approves blueprints (x_ddb_blueprint).
 *
 * @access package_private
 */
var BlueprintService = Class.create();

BlueprintService.TABLE = 'x_ddb_blueprint';
BlueprintService.SCENARIO_TABLE = 'x_ddb_scenario';

BlueprintService.HEADCOUNT = { small: 200, medium: 1000, large: 5000 };

/** Map a validation message to the section that should be repaired. Order matters. */
BlueprintService.ERROR_SECTIONS = [
	{ re: /^Schema: \$\.(schema_version|company|locations|departments)\b/, section: 'org' },
	{ re: /^Schema: \$\.(people|groups)\b/, section: 'people' },
	{ re: /^Schema: \$\.applications\b/, section: 'apps' },
	{ re: /^Schema: \$\.(infrastructure|catalog|themes)\b/, section: 'infra' },
	{ re: /^(theme|catalog item|ip range|virtualization|network device|shared service|infrastructure)/, section: 'infra' },
	{ re: /^(application|applications)\b/, section: 'apps' },
	{ re: /^(named user|group|people|name locale)/, section: 'people' },
	{ re: /^(company|location|locations|department|departments)\b/, section: 'org' }
];

BlueprintService.headcountFor = function (scenarioGr) {
	const tier = scenarioGr.getValue('size_tier') || 'medium';
	const custom = parseInt(scenarioGr.getValue('headcount'), 10);
	if (tier === 'custom' && custom > 0)
		return custom;
	return BlueprintService.HEADCOUNT[tier] || BlueprintService.HEADCOUNT.medium;
};

/** Sections that the given errors point at, in generation order. */
BlueprintService.sectionsForErrors = function (errors) {
	const found = {};
	errors.forEach(function (e) {
		for (let i = 0; i < BlueprintService.ERROR_SECTIONS.length; i++) {
			if (BlueprintService.ERROR_SECTIONS[i].re.test(e)) {
				found[BlueprintService.ERROR_SECTIONS[i].section] = true;
				return;
			}
		}
	});
	return BlueprintSchema.SECTIONS
		.map(function (s) { return s.key; })
		.filter(function (k) { return found[k]; });
};

/** Plain-text overview shown on the blueprint form. */
BlueprintService.summarize = function (bp) {
	if (!bp || !bp.company)
		return '';
	const lines = [];
	lines.push(bp.company.name + ' (' + bp.company.short_code + ') - ' + bp.company.industry);
	lines.push(bp.company.description);
	lines.push('');
	if (bp.locations)
		lines.push('Locations (' + bp.locations.length + '): ' + bp.locations.map(function (l) {
			return l.name + (l.is_datacenter ? ' [DC]' : '');
		}).join(', '));
	if (bp.departments)
		lines.push('Departments (' + bp.departments.length + '): ' + bp.departments.map(function (d) { return d.name; }).join(', '));
	if (bp.people)
		lines.push('Named personas (' + bp.people.named_users.length + '): ' + bp.people.named_users.map(function (u) {
			return u.first_name + ' ' + u.last_name + ' (' + u.title + ')';
		}).join('; '));
	if (bp.groups)
		lines.push('Groups (' + bp.groups.length + '): ' + bp.groups.map(function (g) { return g.name; }).join(', '));
	if (bp.applications)
		lines.push('Applications (' + bp.applications.length + '): ' + bp.applications.map(function (a) {
			return a.name + ' [' + a.tiers.map(function (t) { return t.role; }).join('/') + ']';
		}).join('; '));
	if (bp.catalog)
		lines.push('Catalog items (' + bp.catalog.length + '): ' + bp.catalog.map(function (c) { return c.name; }).join(', '));
	if (bp.themes)
		lines.push('Operational themes (' + bp.themes.length + '): ' + bp.themes.map(function (t) { return t.title; }).join('; '));
	return lines.join('\n').substring(0, 8000);
};

BlueprintService.prototype = {
	initialize: function (opts) {
		opts = opts || {};
		this.providerFn = opts.providerFn || function (purpose) { return ProviderFactory.get(purpose); };
		this.platform = opts.platform === undefined ? BlueprintValidator.instancePlatform() : opts.platform;
	},

	/** New draft blueprint for a scenario, version = previous max + 1. */
	createDraft: function (scenarioGr, source, json) {
		const prev = new GlideRecord(BlueprintService.TABLE);
		prev.addQuery('scenario', scenarioGr.getUniqueValue());
		prev.orderByDesc('version');
		prev.setLimit(1);
		prev.query();
		const version = prev.next() ? (parseInt(prev.getValue('version'), 10) || 0) + 1 : 1;

		const gr = new GlideRecord(BlueprintService.TABLE);
		gr.initialize();
		gr.setValue('scenario', scenarioGr.getUniqueValue());
		gr.setValue('name', scenarioGr.getValue('name') + ' v' + version);
		gr.setValue('version', version);
		gr.setValue('source', source || 'claude');
		gr.setValue('state', 'draft');
		gr.setValue('blueprint_json', json ? JSON.stringify(json, null, 2) : '{}');
		gr.setValue('summary', json ? BlueprintService.summarize(json) : '');
		gr.insert();
		return gr;
	},

	/** Draft a blueprint from a bundled example and validate it. */
	loadExample: function (scenarioGr, exampleKey) {
		const json = ExampleBlueprints.get(exampleKey);
		if (!json)
			throw new Error('Unknown example blueprint "' + exampleKey + '"');
		const gr = this.createDraft(scenarioGr, 'example', json);
		this.validate(gr);
		return gr;
	},

	read: function (blueprintGr) {
		try {
			return JSON.parse(blueprintGr.getValue('blueprint_json') || '{}');
		} catch (e) {
			throw new Error('Blueprint JSON is not valid JSON: ' + e.message);
		}
	},

	write: function (blueprintGr, bp) {
		blueprintGr.setValue('blueprint_json', JSON.stringify(bp, null, 2));
		blueprintGr.setValue('summary', BlueprintService.summarize(bp));
		// Skip the "blueprint edited by hand" business rule; this is a generated change.
		blueprintGr.setWorkflow(false);
		blueprintGr.update();
		blueprintGr.setWorkflow(true);
	},

	scenarioVars: function (scenarioGr) {
		return {
			industry: scenarioGr.getValue('industry') || 'General business',
			company_name: scenarioGr.getValue('company_name') || 'Invent a plausible fictional name',
			size_tier: scenarioGr.getValue('size_tier') || 'medium',
			headcount: BlueprintService.headcountFor(scenarioGr),
			regions: scenarioGr.getValue('regions') || 'Choose two or three regions that suit the industry',
			instructions: scenarioGr.getValue('instructions') || 'None'
		};
	},

	/** One Claude call: generate a section and merge it into the blueprint. */
	generateSection: function (blueprintGr, scenarioGr, sectionKey, jobId) {
		const section = BlueprintSchema.section(sectionKey);
		const bp = this.read(blueprintGr);
		const template = PromptLibrary.get('blueprint.section');
		const vars = this.scenarioVars(scenarioGr);
		vars.section_key = section.key;
		vars.section_label = section.label;
		vars.previous_sections = Object.keys(bp).length ? JSON.stringify(bp) : '(none yet)';

		const result = this.providerFn('blueprint').generateStructured({
			purpose: 'blueprint',
			template: template.name + ' v' + template.version,
			jobId: jobId,
			system: PromptLibrary.render(template.system, vars),
			messages: [{ role: 'user', content: PromptLibrary.render(template.user, vars) }],
			schema: BlueprintSchema.sectionSchema(sectionKey)
		});

		section.properties.forEach(function (p) { bp[p] = result.data[p]; });
		blueprintGr.setValue('model', result.model || '');
		this.write(blueprintGr, bp);
		return result;
	},

	/** One Claude call: repair a section using the stored validation errors. */
	repairSection: function (blueprintGr, sectionKey, jobId) {
		const section = BlueprintSchema.section(sectionKey);
		const bp = this.read(blueprintGr);
		const template = PromptLibrary.get('blueprint.repair');
		const vars = {
			section_key: section.key,
			section_label: section.label,
			errors: blueprintGr.getValue('validation_errors') || '(none recorded)',
			blueprint: JSON.stringify(bp)
		};
		const result = this.providerFn('repair').generateStructured({
			purpose: 'repair',
			template: template.name + ' v' + template.version,
			jobId: jobId,
			system: PromptLibrary.render(template.system, vars),
			messages: [{ role: 'user', content: PromptLibrary.render(template.user, vars) }],
			schema: BlueprintSchema.sectionSchema(sectionKey)
		});
		section.properties.forEach(function (p) { bp[p] = result.data[p]; });
		this.write(blueprintGr, bp);
		return result;
	},

	/** Validate, store results, set state to valid or invalid. */
	validate: function (blueprintGr) {
		let result;
		try {
			result = new BlueprintValidator(this.platform).validate(this.read(blueprintGr));
		} catch (e) {
			result = { valid: false, errors: [e.message], warnings: [] };
		}
		blueprintGr.setValue('validation_errors', result.errors.join('\n').substring(0, 65000));
		blueprintGr.setValue('validation_warnings', result.warnings.join('\n').substring(0, 65000));
		if (blueprintGr.getValue('state') !== 'approved' || !result.valid)
			blueprintGr.setValue('state', result.valid ? 'valid' : 'invalid');
		blueprintGr.update();
		return result;
	},

	/** Approve a valid blueprint; supersede earlier approved versions of the scenario. */
	approve: function (blueprintGr) {
		const result = this.validate(blueprintGr);
		if (!result.valid)
			throw new Error('Blueprint has ' + result.errors.length + ' validation error(s); fix or repair it first.');
		const scenarioId = blueprintGr.getValue('scenario');
		const others = new GlideRecord(BlueprintService.TABLE);
		others.addQuery('scenario', scenarioId);
		others.addQuery('state', 'approved');
		others.addQuery('sys_id', '!=', blueprintGr.getUniqueValue());
		others.query();
		while (others.next()) {
			others.setValue('state', 'superseded');
			others.update();
		}
		blueprintGr.setValue('state', 'approved');
		blueprintGr.update();

		const scenario = new GlideRecord(BlueprintService.SCENARIO_TABLE);
		if (scenario.get(scenarioId)) {
			scenario.setValue('active_blueprint', blueprintGr.getUniqueValue());
			scenario.setValue('state', 'blueprint_approved');
			scenario.update();
		}
		return result;
	},

	type: 'BlueprintService'
};
