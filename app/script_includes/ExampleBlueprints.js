/**
 * Bundled example blueprints, so a scenario can be built without calling an LLM
 * (offline instances, demos of the app itself, tests).
 *
 * HALDEN is injected at build time from docs/examples/blueprint.example.json.
 *
 * @access package_private
 */
var ExampleBlueprints = Class.create();

ExampleBlueprints.HALDEN = /*@@EXAMPLE_BLUEPRINT@@*/ null;

ExampleBlueprints.list = function () {
	return [{ key: 'halden', name: 'Halden Freight Logistics (UK/NL logistics, sample)' }];
};

ExampleBlueprints.get = function (key) {
	if (key === 'halden')
		return JSON.parse(JSON.stringify(ExampleBlueprints.HALDEN));
	return null;
};

ExampleBlueprints.prototype = {
	initialize: function () {},
	type: 'ExampleBlueprints'
};
