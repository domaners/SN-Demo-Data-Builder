/**
 * Claude via the Anthropic Messages API (POST /v1/messages).
 *
 * - Structured output uses output_config.format (json_schema); the reply's text is
 *   guaranteed to parse and match the schema. Forced tool_choice is not used because
 *   current models reject it.
 * - Thinking is always on for current Opus models; output_config.effort is the
 *   cost/latency control.
 * - fallbacks: "default" (beta server-side-fallback-2026-07-01) lets the API retry a
 *   request declined by a safety classifier on a fallback model inside the same call.
 * - The system prompt carries cache_control so repeated calls in one scenario reuse it.
 *
 * @access package_private
 */
var AnthropicProvider = Class.create();

AnthropicProvider.DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
AnthropicProvider.API_VERSION = '2023-06-01';
AnthropicProvider.FALLBACK_BETA = 'server-side-fallback-2026-07-01';
AnthropicProvider.RETRYABLE_STATUS = [0, 408, 409, 429, 500, 502, 503, 504, 529];

AnthropicProvider.prototype = Object.extendsObject(LLMProvider, {

	generateStructured: function (request) {
		const result = this._send(request, request.schema);
		let data;
		try {
			data = JSON.parse(result.text);
		} catch (e) {
			throw LLMProvider.error('Claude returned text that is not valid JSON: ' + String(result.text).substring(0, 300));
		}
		result.data = data;
		return result;
	},

	generateText: function (request) {
		return this._send(request, null);
	},

	/** Cheap credential and model check: GET /v1/models/{model}. Uses no tokens. */
	healthCheck: function () {
		const key = this.apiKeyFn();
		if (!key)
			return { ok: false, message: 'No API key found. Set the credential alias or the API key on the provider config.' };
		const url = this._baseUrl() + '/v1/models/' + encodeURIComponent(this.config.model);
		const resp = this._http('get', url, null, key);
		if (resp.status === 200) {
			let name = this.config.model;
			try {
				name = JSON.parse(resp.body).display_name || name;
			} catch (e) { /* keep model id */ }
			return { ok: true, message: 'Connected. Model available: ' + name };
		}
		return { ok: false, message: 'HTTP ' + resp.status + ': ' + this._errorMessage(resp) };
	},

	buildBody: function (request, schema) {
		const cfg = this.config;
		const outputConfig = { effort: request.effort || cfg.effort || 'medium' };
		if (schema)
			outputConfig.format = { type: 'json_schema', schema: schema };
		const body = {
			model: cfg.model,
			max_tokens: request.maxTokens || cfg.maxTokens || 16000,
			system: [{
				type: 'text',
				text: request.system || '',
				cache_control: { type: 'ephemeral' }
			}],
			messages: request.messages,
			output_config: outputConfig
		};
		if (cfg.useFallbacks)
			body.fallbacks = 'default';
		return body;
	},

	/** Concatenate the text blocks served by the final model (after any fallback switch). */
	extractText: function (content) {
		content = content || [];
		let start = 0;
		for (let i = 0; i < content.length; i++) {
			if (content[i].type === 'fallback')
				start = i + 1;
		}
		const parts = [];
		for (let j = start; j < content.length; j++) {
			if (content[j].type === 'text')
				parts.push(content[j].text);
		}
		return parts.join('');
	},

	/** Sum usage across fallback attempts when usage.iterations is present. */
	extractUsage: function (usage) {
		usage = usage || {};
		const sources = (usage.iterations && usage.iterations.length) ? usage.iterations : [usage];
		const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
		for (let i = 0; i < sources.length; i++) {
			const u = sources[i] || {};
			total.inputTokens += u.input_tokens || 0;
			total.outputTokens += u.output_tokens || 0;
			total.cacheReadTokens += u.cache_read_input_tokens || 0;
			total.cacheWriteTokens += u.cache_creation_input_tokens || 0;
		}
		return total;
	},

	_send: function (request, schema) {
		this.assertWithinBudget();
		const key = this.apiKeyFn();
		if (!key)
			throw LLMProvider.error('No API key found for provider "' + this.config.name + '".');

		const body = this.buildBody(request, schema);
		const bodyText = JSON.stringify(body);
		const log = {
			jobId: request.jobId,
			purpose: request.purpose,
			template: request.template,
			model: this.config.model,
			promptHash: this.hashPrompt(bodyText)
		};
		const started = new Date().getTime();
		const resp = this._http('post', this.config.endpoint || AnthropicProvider.DEFAULT_ENDPOINT, bodyText, key);
		log.latencyMs = new Date().getTime() - started;
		log.status = resp.status;

		if (resp.status !== 200) {
			const retryable = AnthropicProvider.RETRYABLE_STATUS.indexOf(resp.status) >= 0;
			log.error = this._errorMessage(resp);
			log.responseExcerpt = resp.body;
			this.logCall(log);
			throw LLMProvider.error('Anthropic API HTTP ' + resp.status + ': ' + log.error, {
				retryable: retryable,
				retryAfter: parseInt(resp.retryAfter, 10) || 0,
				status: resp.status
			});
		}

		let msg;
		try {
			msg = JSON.parse(resp.body);
		} catch (e) {
			log.error = 'Unparseable response body';
			log.responseExcerpt = resp.body;
			this.logCall(log);
			throw LLMProvider.error('Anthropic API returned an unparseable body', { retryable: true });
		}

		const usage = this.extractUsage(msg.usage);
		const text = this.extractText(msg.content);
		log.usage = usage;
		log.cost = this.estimateCost(usage);
		log.stopReason = msg.stop_reason;
		log.servedModel = msg.model;
		log.responseExcerpt = text;

		if (msg.stop_reason === 'refusal') {
			const details = msg.stop_details || {};
			log.error = 'refusal' + (details.category ? ' (' + details.category + ')' : '');
			this.logCall(log);
			throw LLMProvider.error('Claude declined the request' +
				(details.category ? ' (category: ' + details.category + ')' : '') +
				'. Adjust the scenario wording and try again.');
		}
		if (msg.stop_reason === 'max_tokens') {
			log.error = 'max_tokens';
			this.logCall(log);
			throw LLMProvider.error('Claude hit max_tokens (' + body.max_tokens +
				') before finishing. Raise max_tokens on the provider config or reduce the scenario size.');
		}

		this.logCall(log);
		return {
			text: text,
			usage: usage,
			stopReason: msg.stop_reason,
			model: msg.model,
			cost: log.cost
		};
	},

	_http: function (method, url, bodyText, key) {
		const rm = new sn_ws.RESTMessageV2();
		rm.setEndpoint(url);
		rm.setHttpMethod(method);
		rm.setRequestHeader('x-api-key', key);
		rm.setRequestHeader('anthropic-version', AnthropicProvider.API_VERSION);
		rm.setRequestHeader('content-type', 'application/json');
		if (this.config.useFallbacks && method === 'post')
			rm.setRequestHeader('anthropic-beta', AnthropicProvider.FALLBACK_BETA);
		rm.setHttpTimeout(this.config.timeoutMs || 120000);
		if (bodyText !== null)
			rm.setRequestBody(bodyText);
		try {
			const resp = rm.execute();
			return {
				status: resp.getStatusCode(),
				body: resp.getBody() || '',
				retryAfter: resp.getHeader('retry-after') || '',
				transportError: resp.haveError() ? resp.getErrorMessage() : ''
			};
		} catch (e) {
			return { status: 0, body: '', retryAfter: '', transportError: String(e.message || e) };
		}
	},

	_errorMessage: function (resp) {
		try {
			const parsed = JSON.parse(resp.body);
			if (parsed && parsed.error && parsed.error.message)
				return parsed.error.type + ': ' + parsed.error.message;
		} catch (e) { /* fall through */ }
		return resp.transportError || String(resp.body || '').substring(0, 300) || 'no response body';
	},

	_baseUrl: function () {
		const endpoint = this.config.endpoint || AnthropicProvider.DEFAULT_ENDPOINT;
		return endpoint.replace(/\/v1\/messages\/?$/, '');
	},

	type: 'AnthropicProvider'
});
