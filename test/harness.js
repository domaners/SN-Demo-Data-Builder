'use strict';
// Runs the app's Script Includes in a Node vm with in-memory mocks of the Glide APIs
// they use (GlideRecord, gs, GlideDigest, GlideDateTime, GlideTableHierarchy,
// sn_ws.RESTMessageV2, sn_cc.StandardCredentialsProvider).
//
// The mocks implement only what the app calls. They are not a ServiceNow emulator:
// business rules, ACLs and reference integrity are not simulated.

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadGenerated, loadScriptIncludes, APP } = require('../build/lib/source');

const generated = loadGenerated();
const scriptIncludes = loadScriptIncludes(generated);

function pad(n) {
	return String(n).padStart(2, '0');
}

function fmt(ms) {
	const d = new Date(ms);
	return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
		pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}

function normalize(value) {
	if (value === true)
		return '1';
	if (value === false)
		return '0';
	if (value === null || value === undefined)
		return '';
	return String(value);
}

function createHarness(opts) {
	opts = opts || {};
	const h = {
		now: Date.parse('2026-10-05T09:00:00Z'),
		tables: {},
		schemas: opts.schemas || {},
		invalidTables: new Set(opts.invalidTables || []),
		hierarchy: opts.hierarchy || {},
		props: Object.assign({ 'glide.installation.production': 'false', instance_name: 'dev12345' }, opts.props || {}),
		roles: new Set(opts.roles || ['x_ddb.admin']),
		events: [],
		messages: { info: [], error: [] },
		logs: [],
		http: { queue: [], requests: [] },
		credentials: opts.credentials || {},
		guidCounter: 0
	};

	h.table = function (name) {
		if (!h.tables[name])
			h.tables[name] = new Map();
		return h.tables[name];
	};
	h.rows = function (name) {
		return Array.from(h.table(name).values());
	};
	h.insert = function (table, fields) {
		const id = fields.sys_id || crypto.randomBytes(16).toString('hex');
		const rec = { sys_id: id, sys_created_on: fmt(h.now), sys_updated_on: fmt(h.now) };
		Object.keys(fields).forEach((k) => { rec[k] = normalize(fields[k]); });
		h.table(table).set(id, rec);
		return id;
	};
	h.advance = function (seconds) {
		h.now += seconds * 1000;
	};
	/** Queue an HTTP response: { status, body (object or string), headers } or a function(request). */
	h.respond = function (resp) {
		h.http.queue.push(resp);
	};

	class GlideRecord {
		constructor(table) {
			this._table = table;
			this._conds = [];
			this._order = [];
			this._limit = 0;
			this._rows = null;
			this._idx = -1;
			this._rec = null;
			this._newId = null;
		}
		getTableName() { return this._table; }
		isValid() { return !h.invalidTables.has(this._table); }
		isValidField(f) {
			const s = h.schemas[this._table];
			return !s || s.indexOf(f) >= 0 || f.indexOf('sys_') === 0;
		}
		canCreate() { return true; }
		canWrite() { return true; }
		canDelete() { return true; }
		canRead() { return true; }
		setWorkflow() {}
		autoSysFields() {}
		initialize() { this._rec = {}; this._newId = null; }
		newRecord() { this.initialize(); }
		setNewGuidValue(id) { this._newId = id; }
		setValue(f, v) { if (!this._rec) this._rec = {}; this._rec[f] = normalize(v); }
		getValue(f) {
			if (!this._rec)
				return null;
			const v = this._rec[f];
			return v === undefined || v === '' ? null : v;
		}
		getDisplayValue(f) { return this.getValue(f); }
		getUniqueValue() { return this._rec ? this._rec.sys_id : null; }
		getElement(f) {
			const self = this;
			return { getDecryptedValue: () => self.getValue(f), toString: () => self.getValue(f) };
		}
		addQuery(field, op, value) {
			if (arguments.length === 2) {
				value = op;
				op = '=';
			}
			this._conds.push({ field: field, op: String(op).toUpperCase(), value: value });
			return this;
		}
		addEncodedQuery() { throw new Error('addEncodedQuery is not mocked'); }
		orderBy(f) { this._order.push({ f: f, desc: false }); }
		orderByDesc(f) { this._order.push({ f: f, desc: true }); }
		setLimit(n) { this._limit = n; }
		_match(rec) {
			return this._conds.every((c) => {
				const actual = rec[c.field] === undefined ? '' : rec[c.field];
				switch (c.op) {
				case '=': return actual === normalize(c.value);
				case '!=': return actual !== normalize(c.value);
				case 'IN': return String(c.value).split(',').indexOf(actual) >= 0;
				case 'STARTSWITH': return actual.indexOf(String(c.value)) === 0;
				case '>=': return actual >= normalize(c.value);
				case '<=': return actual <= normalize(c.value);
				case '>': return actual > normalize(c.value);
				case '<': return actual < normalize(c.value);
				default: throw new Error('Operator ' + c.op + ' not mocked');
				}
			});
		}
		query() {
			let rows = h.rows(this._table).filter((r) => this._match(r));
			this._order.slice().reverse().forEach((o) => {
				rows.sort((a, b) => {
					const x = a[o.f] || '';
					const y = b[o.f] || '';
					const nx = parseFloat(x);
					const ny = parseFloat(y);
					const cmp = !isNaN(nx) && !isNaN(ny) ? nx - ny : (x < y ? -1 : x > y ? 1 : 0);
					return o.desc ? -cmp : cmp;
				});
			});
			if (this._limit)
				rows = rows.slice(0, this._limit);
			this._rows = rows.map((r) => r.sys_id);
			this._idx = -1;
		}
		hasNext() { return this._rows !== null && this._idx + 1 < this._rows.length; }
		next() {
			while (this.hasNext()) {
				this._idx++;
				const rec = h.table(this._table).get(this._rows[this._idx]);
				if (rec) {
					this._rec = Object.assign({}, rec);
					return true;
				}
			}
			return false;
		}
		getRowCount() { return this._rows ? this._rows.length : 0; }
		get(a, b) {
			let rec;
			if (b === undefined)
				rec = h.table(this._table).get(a);
			else
				rec = h.rows(this._table).find((r) => r[a] === normalize(b));
			if (!rec)
				return false;
			this._rec = Object.assign({}, rec);
			return true;
		}
		insert() {
			const id = this._newId || crypto.randomBytes(16).toString('hex');
			const rec = Object.assign({}, this._rec, { sys_id: id, sys_created_on: fmt(h.now), sys_updated_on: fmt(h.now) });
			h.table(this._table).set(id, rec);
			this._rec = Object.assign({}, rec);
			return id;
		}
		update() {
			const id = this._rec.sys_id;
			this._rec.sys_updated_on = fmt(h.now);
			h.table(this._table).set(id, Object.assign({}, this._rec));
			return id;
		}
		deleteRecord() {
			return h.table(this._table).delete(this._rec.sys_id);
		}
	}

	class GlideDateTime {
		constructor() { this._ms = h.now; }
		addSeconds(n) { this._ms += n * 1000; }
		getValue() { return fmt(this._ms); }
		getNumericValue() { return this._ms; }
	}

	class GlideDigest {
		getMD5Hex(s) { return crypto.createHash('md5').update(String(s)).digest('hex').toUpperCase(); }
		getSHA256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').toUpperCase(); }
	}

	class GlideTableHierarchy {
		constructor(name) { this._name = name; }
		getTables() { return h.hierarchy[this._name] || [this._name]; }
	}

	class RESTMessageV2 {
		constructor() { this.req = { headers: {}, method: '', url: '', body: null, timeout: 0 }; }
		setEndpoint(u) { this.req.url = u; }
		setHttpMethod(m) { this.req.method = m; }
		setRequestHeader(k, v) { this.req.headers[k.toLowerCase()] = v; }
		setRequestBody(b) { this.req.body = b; }
		setHttpTimeout(t) { this.req.timeout = t; }
		execute() {
			h.http.requests.push(this.req);
			let resp = h.http.queue.shift();
			if (!resp)
				throw new Error('No mocked HTTP response for ' + this.req.method + ' ' + this.req.url);
			if (typeof resp === 'function')
				resp = resp(this.req);
			const body = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body || {});
			const headers = resp.headers || {};
			return {
				getStatusCode: () => resp.status,
				getBody: () => body,
				getHeader: (k) => headers[k.toLowerCase()] || null,
				haveError: () => resp.status !== 200,
				getErrorMessage: () => resp.error || ''
			};
		}
	}

	const gs = {
		getProperty: (name, dflt) => (name in h.props ? h.props[name] : (dflt === undefined ? null : dflt)),
		hasRole: (role) => h.roles.has('admin') || h.roles.has(role),
		getUserName: () => 'admin',
		generateGUID: () => crypto.randomBytes(16).toString('hex'),
		beginningOfToday: () => fmt(h.now).slice(0, 10) + ' 00:00:00',
		eventQueue: (name, gr, parm1, parm2) => { h.events.push({ name: name, parm1: parm1, parm2: parm2 }); },
		addInfoMessage: (m) => { h.messages.info.push(m); },
		addErrorMessage: (m) => { h.messages.error.push(m); },
		info: (m) => { h.logs.push(['info', m]); },
		warn: (m) => { h.logs.push(['warn', m]); },
		error: (m) => { h.logs.push(['error', m]); }
	};

	const Class = {
		create: function () {
			return function () {
				this.initialize.apply(this, arguments);
			};
		}
	};

	const context = {
		console: console,
		gs: gs,
		GlideRecord: GlideRecord,
		GlideDateTime: GlideDateTime,
		GlideDigest: GlideDigest,
		GlideTableHierarchy: GlideTableHierarchy,
		sn_ws: { RESTMessageV2: RESTMessageV2 },
		sn_cc: {
			StandardCredentialsProvider: class {
				getCredentialByAliasID(id) {
					const c = h.credentials[id];
					return c ? { getAttribute: (k) => c[k] } : null;
				}
			}
		},
		Class: Class
	};
	vm.createContext(context);
	vm.runInContext('Object.extendsObject = function (base, props) {' +
		' var proto = Object.create(base.prototype);' +
		' Object.keys(props).forEach(function (k) { proto[k] = props[k]; });' +
		' return proto; };', context);
	scriptIncludes.forEach((si) => {
		vm.runInContext(si.script, context, { filename: 'app/script_includes/' + si.name + '.js' });
	});
	vm.runInContext('var x_ddb = {' + scriptIncludes.map((si) => si.name + ': ' + si.name).join(', ') + '};', context);

	h.ctx = context;
	h.gs = gs;
	h.GlideRecord = GlideRecord;

	/** Evaluate an expression in the app context. */
	h.eval = function (code) {
		return vm.runInContext(code, context);
	};

	/** Run a server-side record script (UI action, script action) with the given globals. */
	h.runScript = function (relPath, globals) {
		const code = fs.readFileSync(path.join(APP, relPath), 'utf8');
		const names = Object.keys(globals || {});
		const fn = vm.runInContext('(function (' + names.join(', ') + ') {\n' + code + '\n})', context, { filename: relPath });
		return fn.apply(null, names.map((n) => globals[n]));
	};

	/** Load a record into a fresh GlideRecord. */
	h.gr = function (table, sysId) {
		const gr = new GlideRecord(table);
		if (!gr.get(sysId))
			throw new Error('No ' + table + ' ' + sysId);
		return gr;
	};

	/** UI action "action" object. */
	h.action = function () {
		return { redirect: null, setRedirectURL: function (x) { this.redirect = x; } };
	};

	/** Process queued x_ddb.job.step events until none remain (or maxSteps). */
	h.drain = function (maxSteps) {
		let steps = 0;
		while (h.events.length && steps < (maxSteps || 500)) {
			const ev = h.events.shift();
			if (ev.name === 'x_ddb.job.step')
				h.runScript('scripts/job_step.js', { event: ev });
			steps++;
		}
		return steps;
	};

	return h;
}

/** Standard platform data most tests need. */
function seedPlatform(h) {
	['itil', 'itil_admin', 'approver_user', 'catalog_admin', 'asset'].forEach((r) => h.insert('sys_user_role', { name: r }));
	['itil', 'approval', 'catalog'].forEach((t) => h.insert('sys_user_group_type', { name: t }));
	['Europe/London', 'Europe/Amsterdam', 'America/New_York', 'GMT'].forEach((tz) =>
		h.insert('sys_choice', { name: 'sys_user', element: 'time_zone', value: tz }));
	const ci = (cls, parent) => { h.hierarchy[cls] = [cls].concat(parent ? [parent] : []).concat(['cmdb_ci']); };
	ci('cmdb_ci_linux_server', 'cmdb_ci_server');
	ci('cmdb_ci_win_server', 'cmdb_ci_server');
	ci('cmdb_ci_app_server_tomcat', 'cmdb_ci_app_server');
	ci('cmdb_ci_db_postgresql_instance', 'cmdb_ci_db_instance');
	ci('cmdb_ci_db_mssql_instance', 'cmdb_ci_db_instance');
	ci('cmdb_ci_lb_bigip', 'cmdb_ci_lb');
	ci('cmdb_ci_ip_switch', 'cmdb_ci_netgear');
	ci('cmdb_ci_ip_router', 'cmdb_ci_netgear');
}

function seedProvider(h, overrides) {
	return h.insert('x_ddb_provider_config', Object.assign({
		name: 'Claude', active: true, order: 100, provider: 'anthropic', purpose: 'any', model: 'claude-opus-5-5',
		effort: 'medium', max_tokens: 16000, endpoint: 'https://api.anthropic.com/v1/messages',
		credential_alias: 'x_ddb.anthropic', use_fallbacks: true, timeout_ms: 120000, daily_token_budget: 2000000,
		input_price: 4, output_price: 20, cache_read_price: 0.2, cache_write_price: 5
	}, overrides || {}));
}

function seedCredential(h, key) {
	const aliasId = h.insert('sys_alias', { id: 'x_ddb.anthropic', name: 'anthropic' });
	h.credentials[aliasId] = { api_key: key || 'sk-ant-test-key' };
	return aliasId;
}

/** A Messages API response whose text block is the given JSON. */
function claudeResponse(json, extra) {
	return Object.assign({
		status: 200,
		body: {
			id: 'msg_test',
			type: 'message',
			model: 'claude-opus-5-5',
			stop_reason: 'end_turn',
			content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(json) }],
			usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
		}
	}, extra || {});
}

function example() {
	return JSON.parse(JSON.stringify(generated.example));
}

module.exports = { createHarness, seedPlatform, seedProvider, seedCredential, claudeResponse, example, generated, fmt };
