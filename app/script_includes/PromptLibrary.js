/**
 * Prompt templates. Admins can override a template by creating an active
 * x_ddb_prompt_template record with the same name and a higher version; otherwise the
 * defaults bundled from app/prompts/*.md are used.
 *
 * Templates use {{variable}} placeholders.
 *
 * @access package_private
 */
var PromptLibrary = Class.create();

PromptLibrary.TABLE = 'x_ddb_prompt_template';
PromptLibrary.DEFAULTS = /*@@PROMPTS@@*/ null;

/** @returns {{name, version, system, user}} */
PromptLibrary.get = function (name) {
	const gr = new GlideRecord(PromptLibrary.TABLE);
	gr.addQuery('name', name);
	gr.addQuery('active', true);
	gr.orderByDesc('version');
	gr.setLimit(1);
	gr.query();
	const fallback = PromptLibrary.DEFAULTS ? PromptLibrary.DEFAULTS[name] : null;
	if (gr.next()) {
		const version = parseInt(gr.getValue('version'), 10) || 0;
		if (!fallback || version >= fallback.version) {
			return {
				name: name,
				version: version,
				system: gr.getValue('system_text') || '',
				user: gr.getValue('user_text') || ''
			};
		}
	}
	if (!fallback)
		throw new Error('Prompt template "' + name + '" not found');
	return { name: name, version: fallback.version, system: fallback.system, user: fallback.user };
};

PromptLibrary.render = function (text, vars) {
	return String(text).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, function (match, key) {
		return vars.hasOwnProperty(key) && vars[key] !== null && vars[key] !== undefined ? String(vars[key]) : '';
	});
};

PromptLibrary.prototype = {
	initialize: function () {},
	type: 'PromptLibrary'
};
