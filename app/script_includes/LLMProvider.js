/**
 * Base class and shared helpers for LLM providers.
 *
 * Contract (see docs/DESIGN.md section 4.1):
 *   generateStructured(request) -> { data, text, usage, stopReason, model, cost }
 *   generateText(request)       -> { text, usage, stopReason, model, cost }
 *   healthCheck()               -> { ok, message }
 *   estimateCost(usage)         -> Number
 *
 * request = { purpose, system, messages: [{role, content}], schema, maxTokens, effort,
 *             jobId, template }
 *
 * Errors thrown by providers carry .retryable (Boolean), .retryAfter (seconds) and .status.
 *
 * @access package_private
 */
var LLMProvider = Class.create();

LLMProvider.CALL_TABLE = 'x_ddb_llm_call';

LLMProvider.error = function (message, opts) {
	opts = opts || {};
	const err = new Error(message);
	err.retryable = !!opts.retryable;
	err.retryAfter = opts.retryAfter || 0;
	err.status = opts.status || 0;
	return err;
};

/** Plain-object view of an x_ddb_provider_config record. */
LLMProvider.configFrom = function (gr) {
	const num = function (name, dflt) {
		const v = parseFloat(gr.getValue(name));
		return isNaN(v) ? dflt : v;
	};
	return {
		sysId: gr.getUniqueValue(),
		name: gr.getValue('name'),
		provider: gr.getValue('provider'),
		purpose: gr.getValue('purpose'),
		model: gr.getValue('model'),
		effort: gr.getValue('effort') || 'medium',
		maxTokens: num('max_tokens', 16000),
		endpoint: gr.getValue('endpoint') || '',
		credentialAlias: gr.getValue('credential_alias') || '',
		timeoutMs: num('timeout_ms', 120000),
		useFallbacks: gr.getValue('use_fallbacks') !== '0' && gr.getValue('use_fallbacks') !== 'false',
		dailyTokenBudget: num('daily_token_budget', 0),
		prices: {
			input: num('input_price', 0),
			output: num('output_price', 0),
			cacheRead: num('cache_read_price', 0),
			cacheWrite: num('cache_write_price', 0)
		}
	};
};

LLMProvider.prototype = {
	/**
	 * @param {Object} config  from LLMProvider.configFrom
	 * @param {Function} apiKeyFn  returns the secret; called only when a request is sent
	 */
	initialize: function (config, apiKeyFn) {
		this.config = config || {};
		this.apiKeyFn = apiKeyFn || function () { return ''; };
	},

	generateStructured: function (request) {
		throw LLMProvider.error(this.type + ' does not implement generateStructured');
	},

	generateText: function (request) {
		throw LLMProvider.error(this.type + ' does not implement generateText');
	},

	healthCheck: function () {
		return { ok: false, message: this.type + ' is not implemented yet' };
	},

	/** usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } */
	estimateCost: function (usage) {
		const p = this.config.prices || {};
		const cost = ((usage.inputTokens || 0) * (p.input || 0) +
			(usage.outputTokens || 0) * (p.output || 0) +
			(usage.cacheReadTokens || 0) * (p.cacheRead || 0) +
			(usage.cacheWriteTokens || 0) * (p.cacheWrite || 0)) / 1000000;
		return Math.round(cost * 10000) / 10000;
	},

	/** Tokens (input + output) logged today against this provider config. */
	tokensUsedToday: function () {
		let total = 0;
		const gr = new GlideRecord(LLMProvider.CALL_TABLE);
		gr.addQuery('provider_config', this.config.sysId);
		gr.addQuery('sys_created_on', '>=', gs.beginningOfToday());
		gr.query();
		while (gr.next())
			total += (parseInt(gr.getValue('input_tokens'), 10) || 0) + (parseInt(gr.getValue('output_tokens'), 10) || 0);
		return total;
	},

	assertWithinBudget: function () {
		const budget = this.config.dailyTokenBudget;
		if (!budget)
			return;
		const used = this.tokensUsedToday();
		if (used >= budget)
			throw LLMProvider.error('Daily token budget for provider "' + this.config.name + '" is used up (' +
				used + ' of ' + budget + ' tokens). Raise daily_token_budget or try again tomorrow.');
	},

	/** Write one x_ddb_llm_call row. Never stores credentials or headers. */
	logCall: function (entry) {
		const gr = new GlideRecord(LLMProvider.CALL_TABLE);
		gr.initialize();
		gr.setValue('job', entry.jobId || '');
		gr.setValue('provider_config', this.config.sysId || '');
		gr.setValue('provider', this.config.provider || '');
		gr.setValue('model', entry.model || this.config.model || '');
		gr.setValue('served_model', entry.servedModel || '');
		gr.setValue('purpose', entry.purpose || '');
		gr.setValue('template', entry.template || '');
		gr.setValue('prompt_hash', entry.promptHash || '');
		const u = entry.usage || {};
		gr.setValue('input_tokens', u.inputTokens || 0);
		gr.setValue('output_tokens', u.outputTokens || 0);
		gr.setValue('cache_read_tokens', u.cacheReadTokens || 0);
		gr.setValue('cache_write_tokens', u.cacheWriteTokens || 0);
		gr.setValue('cost', entry.cost || 0);
		gr.setValue('latency_ms', entry.latencyMs || 0);
		gr.setValue('http_status', entry.status || 0);
		gr.setValue('stop_reason', entry.stopReason || '');
		gr.setValue('error', String(entry.error || '').substring(0, 4000));
		gr.setValue('response_excerpt', String(entry.responseExcerpt || '').substring(0, 4000));
		gr.insert();
	},

	hashPrompt: function (text) {
		return String(new GlideDigest().getSHA256Hex(String(text))).toLowerCase();
	},

	type: 'LLMProvider'
};
