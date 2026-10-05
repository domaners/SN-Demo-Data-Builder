/**
 * Returns the configured LLM provider for a purpose (blueprint, narrative, repair).
 *
 * Picks the active x_ddb_provider_config whose purpose matches, falling back to one
 * with purpose "any". Lowest order wins.
 *
 * The API key is read lazily, only when a request is sent:
 *   1. Connection & Credential alias named in credential_alias (sys_alias id such as
 *      "x_ddb.anthropic", or its sys_id), API Key credential attribute "api_key".
 *   2. Otherwise the encrypted api_key field on the provider config.
 *
 * @access package_private
 */
var ProviderFactory = Class.create();

ProviderFactory.TABLE = 'x_ddb_provider_config';

ProviderFactory.IMPLEMENTATIONS = {
	anthropic: function (config, keyFn) { return new AnthropicProvider(config, keyFn); }
};

ProviderFactory.findConfig = function (purpose) {
	const wanted = [purpose, 'any'];
	for (let i = 0; i < wanted.length; i++) {
		const gr = new GlideRecord(ProviderFactory.TABLE);
		gr.addQuery('active', true);
		gr.addQuery('purpose', wanted[i]);
		gr.orderBy('order');
		gr.setLimit(1);
		gr.query();
		if (gr.next())
			return gr;
	}
	return null;
};

ProviderFactory.get = function (purpose) {
	const gr = ProviderFactory.findConfig(purpose || 'any');
	if (!gr)
		throw LLMProvider.error('No active provider configuration for purpose "' + purpose +
			'". Create one under Demo Data Builder > Providers.');
	return ProviderFactory.fromRecord(gr);
};

ProviderFactory.fromRecord = function (gr) {
	const config = LLMProvider.configFrom(gr);
	const make = ProviderFactory.IMPLEMENTATIONS[config.provider];
	if (!make)
		throw LLMProvider.error('Provider "' + config.provider + '" is not implemented yet. Use "anthropic".');
	const sysId = gr.getUniqueValue();
	const keyFn = function () { return ProviderFactory.resolveApiKey(sysId); };
	return make(config, keyFn);
};

ProviderFactory.resolveApiKey = function (configSysId) {
	const gr = new GlideRecord(ProviderFactory.TABLE);
	if (!gr.get(configSysId))
		return '';
	const alias = gr.getValue('credential_alias');
	if (alias) {
		const key = ProviderFactory._keyFromAlias(alias);
		if (key)
			return key;
	}
	const element = gr.getElement('api_key');
	return element ? (element.getDecryptedValue() || '') : '';
};

ProviderFactory._keyFromAlias = function (alias) {
	try {
		let aliasId = alias;
		if (!/^[0-9a-f]{32}$/.test(alias)) {
			const a = new GlideRecord('sys_alias');
			a.addQuery('id', alias);
			a.setLimit(1);
			a.query();
			if (!a.next())
				return '';
			aliasId = a.getUniqueValue();
		}
		const cred = new sn_cc.StandardCredentialsProvider().getCredentialByAliasID(aliasId);
		return cred ? (cred.getAttribute('api_key') || '') : '';
	} catch (e) {
		gs.warn('[x_ddb] Could not read credential alias ' + alias + ': ' + e.message);
		return '';
	}
};

ProviderFactory.prototype = {
	initialize: function () {},
	type: 'ProviderFactory'
};
