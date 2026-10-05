'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedProvider, seedCredential, claudeResponse } = require('./harness');

function setup(providerOverrides) {
	const h = createHarness();
	seedProvider(h, providerOverrides);
	seedCredential(h, 'sk-ant-secret');
	return h;
}

const REQUEST = '({ purpose: "blueprint", jobId: "job1", template: "t v1", system: "SYS", ' +
	'messages: [{ role: "user", content: "hello" }], schema: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } } })';

test('structured request uses output_config.format, effort, fallbacks and caching', () => {
	const h = setup();
	h.respond(claudeResponse({ a: 'ok' }));
	const result = JSON.parse(JSON.stringify(h.eval('ProviderFactory.get("blueprint").generateStructured' + REQUEST)));
	assert.deepEqual(result.data, { a: 'ok' });

	const req = h.http.requests[0];
	assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
	assert.equal(req.method, 'post');
	assert.equal(req.headers['x-api-key'], 'sk-ant-secret');
	assert.equal(req.headers['anthropic-version'], '2023-06-01');
	assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
	assert.equal(req.timeout, 120000);

	const body = JSON.parse(req.body);
	assert.equal(body.model, 'claude-opus-5-5');
	assert.equal(body.max_tokens, 16000);
	assert.equal(body.fallbacks, 'default');
	assert.equal(body.output_config.effort, 'medium');
	assert.equal(body.output_config.format.type, 'json_schema');
	assert.deepEqual(body.output_config.format.schema.required, ['a']);
	assert.deepEqual(body.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
	assert.equal(body.tool_choice, undefined, 'forced tool use is rejected by current models');
	assert.equal(body.thinking, undefined, 'thinking cannot be disabled on Opus 5.5; leave it out');
	assert.equal(body.temperature, undefined);
});

test('fallbacks can be turned off', () => {
	const h = setup({ use_fallbacks: false, effort: 'low' });
	h.respond(claudeResponse({ a: 'ok' }));
	h.eval('ProviderFactory.get("blueprint").generateStructured' + REQUEST);
	const req = h.http.requests[0];
	const body = JSON.parse(req.body);
	assert.equal(body.fallbacks, undefined);
	assert.equal(req.headers['anthropic-beta'], undefined);
	assert.equal(body.output_config.effort, 'low');
});

test('every call is logged with usage and cost but never the key', () => {
	const h = setup();
	h.respond(claudeResponse({ a: 'ok' }, {}));
	h.eval('ProviderFactory.get("blueprint").generateStructured' + REQUEST);
	const calls = h.rows('x_ddb_llm_call');
	assert.equal(calls.length, 1);
	const c = calls[0];
	assert.equal(c.purpose, 'blueprint');
	assert.equal(c.job, 'job1');
	assert.equal(c.input_tokens, '1200');
	assert.equal(c.output_tokens, '800');
	assert.equal(c.cost, String((1200 * 4 + 800 * 20) / 1e6));
	assert.equal(c.stop_reason, 'end_turn');
	assert.match(c.prompt_hash, /^[0-9a-f]{64}$/);
	assert.ok(!JSON.stringify(c).includes('sk-ant-secret'));
});

test('text after a fallback switch is used and usage is summed across attempts', () => {
	const h = setup();
	h.respond({ status: 200, body: {
		model: 'claude-opus-5', stop_reason: 'end_turn',
		content: [
			{ type: 'text', text: '{"a":' },
			{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
			{ type: 'thinking', thinking: '' },
			{ type: 'text', text: '{"a":"from fallback"}' }
		],
		usage: { input_tokens: 10, output_tokens: 5, iterations: [
			{ type: 'message', input_tokens: 100, output_tokens: 3 },
			{ type: 'fallback_message', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 }
		] }
	} });
	const result = JSON.parse(JSON.stringify(h.eval('ProviderFactory.get("blueprint").generateStructured' + REQUEST)));
	assert.deepEqual(result.data, { a: 'from fallback' });
	assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 53, cacheReadTokens: 20, cacheWriteTokens: 0 });
	assert.equal(h.rows('x_ddb_llm_call')[0].served_model, 'claude-opus-5');
});

test('refusals and truncation fail with clear, non-retryable errors', () => {
	const h = setup();
	h.respond({ status: 200, body: { model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [], usage: {} } });
	const refusal = h.eval('(function () { try { ProviderFactory.get("blueprint").generateStructured' + REQUEST + '; } catch (e) { return { m: e.message, r: e.retryable }; } })()');
	assert.match(refusal.m, /declined the request \(category: cyber\)/);
	assert.equal(refusal.r, false);

	h.respond(claudeResponse({ a: 'x' }, { body: { model: 'm', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }], usage: {} } }));
	const cut = h.eval('(function () { try { ProviderFactory.get("blueprint").generateStructured' + REQUEST + '; } catch (e) { return { m: e.message, r: e.retryable }; } })()');
	assert.match(cut.m, /max_tokens \(16000\)/);
	assert.equal(cut.r, false);
	assert.deepEqual(h.rows('x_ddb_llm_call').map((c) => c.error), ['refusal (cyber)', 'max_tokens']);
});

test('rate limits and overload are retryable and carry retry-after', () => {
	const h = setup();
	h.respond({ status: 429, headers: { 'retry-after': '42' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } });
	const e429 = h.eval('(function () { try { ProviderFactory.get("blueprint").generateStructured' + REQUEST + '; } catch (e) { return { m: e.message, r: e.retryable, a: e.retryAfter, s: e.status }; } })()');
	assert.deepEqual(JSON.parse(JSON.stringify(e429)), { m: 'Anthropic API HTTP 429: rate_limit_error: slow down', r: true, a: 42, s: 429 });

	h.respond({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } });
	assert.equal(h.eval('(function () { try { ProviderFactory.get("blueprint").generateStructured' + REQUEST + '; } catch (e) { return e.retryable; } })()'), true);

	h.respond({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad schema' } } });
	const e400 = h.eval('(function () { try { ProviderFactory.get("blueprint").generateStructured' + REQUEST + '; } catch (e) { return { m: e.message, r: e.retryable }; } })()');
	assert.equal(e400.r, false);
	assert.match(e400.m, /bad schema/);
});

test('missing credentials and exhausted budgets stop before any request', () => {
	const h = createHarness();
	seedProvider(h, { credential_alias: '' });
	const noKey = h.eval('(function () { try { ProviderFactory.get("blueprint").generateStructured' + REQUEST + '; } catch (e) { return e.message; } })()');
	assert.match(noKey, /No API key/);

	const h2 = setup({ daily_token_budget: 1000 });
	h2.insert('x_ddb_llm_call', { provider_config: h2.rows('x_ddb_provider_config')[0].sys_id, input_tokens: 900, output_tokens: 200 });
	const budget = h2.eval('(function () { try { ProviderFactory.get("blueprint").generateStructured' + REQUEST + '; } catch (e) { return e.message; } })()');
	assert.match(budget, /Daily token budget/);
	assert.equal(h2.http.requests.length, 0);
});

test('API key falls back to the encrypted field when no alias is set', () => {
	const h = createHarness();
	seedProvider(h, { credential_alias: '', api_key: 'sk-field-key' });
	h.respond(claudeResponse({ a: 'ok' }));
	h.eval('ProviderFactory.get("blueprint").generateStructured' + REQUEST);
	assert.equal(h.http.requests[0].headers['x-api-key'], 'sk-field-key');
});

test('provider selection prefers the purpose, then "any", by order', () => {
	const h = createHarness();
	seedProvider(h, { name: 'General', purpose: 'any', order: 10 });
	seedProvider(h, { name: 'Blueprints', purpose: 'blueprint', order: 50 });
	seedProvider(h, { name: 'Inactive', purpose: 'blueprint', order: 1, active: false });
	assert.equal(h.eval('ProviderFactory.get("blueprint").config.name'), 'Blueprints');
	assert.equal(h.eval('ProviderFactory.get("repair").config.name'), 'General');
	const h2 = createHarness();
	assert.match(h2.eval('(function () { try { ProviderFactory.get("blueprint"); } catch (e) { return e.message; } })()'), /No active provider/);
	const h3 = createHarness();
	seedProvider(h3, { provider: 'bedrock' });
	assert.match(h3.eval('(function () { try { ProviderFactory.get("blueprint"); } catch (e) { return e.message; } })()'), /not implemented yet/);
});

test('health check calls the models endpoint without spending tokens', () => {
	const h = setup();
	h.respond({ status: 200, body: { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' } });
	const r = JSON.parse(JSON.stringify(h.eval('ProviderFactory.get("blueprint").healthCheck()')));
	assert.deepEqual(r, { ok: true, message: 'Connected. Model available: Claude Opus 5.5' });
	assert.equal(h.http.requests[0].method, 'get');
	assert.equal(h.http.requests[0].url, 'https://api.anthropic.com/v1/models/claude-opus-5-5');
	assert.equal(h.http.requests[0].body, null);

	h.respond({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
	const bad = h.eval('ProviderFactory.get("blueprint").healthCheck()');
	assert.equal(bad.ok, false);
	assert.match(bad.message, /HTTP 401: authentication_error/);
});
