/**
 * The blueprint JSON Schema and how it is split into sections for generation.
 *
 * SCHEMA is injected at build time from docs/schemas/blueprint.schema.json, so the
 * document and the app never drift apart. Do not edit the placeholder by hand.
 *
 * @access package_private
 */
var BlueprintSchema = Class.create();

BlueprintSchema.SCHEMA = /*@@BLUEPRINT_SCHEMA@@*/ null;

/**
 * Generation order. Each section is one Claude call; later sections are given the
 * earlier ones as context so cross-references (keys) line up.
 */
BlueprintSchema.SECTIONS = [
	{ key: 'org', label: 'Company, locations and departments', properties: ['schema_version', 'company', 'locations', 'departments'] },
	{ key: 'people', label: 'People and groups', properties: ['people', 'groups'] },
	{ key: 'apps', label: 'Application portfolio', properties: ['applications'] },
	{ key: 'infra', label: 'Infrastructure, catalog and operational themes', properties: ['infrastructure', 'catalog', 'themes'] }
];

BlueprintSchema.section = function (key) {
	for (let i = 0; i < BlueprintSchema.SECTIONS.length; i++) {
		if (BlueprintSchema.SECTIONS[i].key === key)
			return BlueprintSchema.SECTIONS[i];
	}
	return null;
};

/** Root schema without the meta keywords the structured-output API does not need. */
BlueprintSchema.full = function () {
	const s = JSON.parse(JSON.stringify(BlueprintSchema.SCHEMA));
	delete s.$schema;
	delete s.$id;
	return s;
};

/** Object schema containing only the given section's top-level properties. */
BlueprintSchema.sectionSchema = function (key) {
	const section = BlueprintSchema.section(key);
	if (!section)
		throw new Error('Unknown blueprint section: ' + key);
	const root = BlueprintSchema.full();
	const properties = {};
	for (let i = 0; i < section.properties.length; i++)
		properties[section.properties[i]] = root.properties[section.properties[i]];
	return {
		type: 'object',
		additionalProperties: false,
		required: section.properties.slice(),
		properties: properties
	};
};

BlueprintSchema.prototype = {
	initialize: function () {},
	type: 'BlueprintSchema'
};
