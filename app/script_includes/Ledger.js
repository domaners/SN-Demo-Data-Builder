/**
 * Writes records on behalf of a job and remembers every one of them in
 * x_ddb_record_ledger, so they can be reported on and removed later.
 *
 * Records created directly (not through IRE) get deterministic sys_ids derived from the
 * scenario seed, the table and a stable key. Re-running a build therefore updates the
 * same records instead of duplicating them.
 *
 * @access package_private
 */
var Ledger = Class.create();

Ledger.TABLE = 'x_ddb_record_ledger';

/** Deterministic sys_id for (seed, table, key). */
Ledger.guid = function (seed, table, key) {
	const digest = new GlideDigest();
	return String(digest.getMD5Hex('x_ddb|' + seed + '|' + table + '|' + key)).toLowerCase();
};

Ledger.prototype = {
	/**
	 * @param {Object} opts { scenarioId, jobId, seed, domain }
	 */
	initialize: function (opts) {
		opts = opts || {};
		this.scenarioId = opts.scenarioId || '';
		this.jobId = opts.jobId || '';
		this.seed = opts.seed || '';
		this.domain = opts.domain || '';
		this.counts = {};
		this.skippedFields = {};
		this._validFields = {};
	},

	guidFor: function (table, key) {
		return Ledger.guid(this.seed, table, key);
	},

	/**
	 * Insert or update the record identified by (table, key).
	 * Field values may be strings, numbers or booleans. Fields the table does not have
	 * are skipped and reported once in skippedFields.
	 * @returns {{sysId: string, action: string}}
	 */
	upsert: function (table, key, fields, domain) {
		const sysId = this.guidFor(table, key);
		const gr = new GlideRecord(table);
		let action;
		if (gr.get(sysId)) {
			this._apply(gr, table, fields);
			gr.update();
			action = 'update';
		} else {
			gr.initialize();
			gr.setNewGuidValue(sysId);
			this._apply(gr, table, fields);
			gr.insert();
			action = 'insert';
		}
		this._count(table, action);
		this.track(table, sysId, action, key, domain);
		return { sysId: sysId, action: action };
	},

	/** Record (or refresh) a ledger entry for a document DDB touched. */
	track: function (table, sysId, action, key, domain) {
		const led = new GlideRecord(Ledger.TABLE);
		led.addQuery('table_name', table);
		led.addQuery('document_id', sysId);
		led.setLimit(1);
		led.query();
		if (led.next()) {
			led.setValue('last_job', this.jobId);
			led.update();
			return;
		}
		led.initialize();
		led.setValue('scenario', this.scenarioId);
		led.setValue('job', this.jobId);
		led.setValue('last_job', this.jobId);
		led.setValue('table_name', table);
		led.setValue('document_id', sysId);
		led.setValue('domain', domain || this.domain);
		led.setValue('action', action);
		led.setValue('blueprint_key', String(key || '').substring(0, 255));
		led.insert();
	},

	_apply: function (gr, table, fields) {
		const names = Object.keys(fields);
		for (let i = 0; i < names.length; i++) {
			const name = names[i];
			if (!this._isValidField(gr, table, name)) {
				this.skippedFields[table + '.' + name] = true;
				continue;
			}
			const value = fields[name];
			gr.setValue(name, value === null || value === undefined ? '' : value);
		}
	},

	_isValidField: function (gr, table, name) {
		const cacheKey = table + '.' + name;
		if (!(cacheKey in this._validFields))
			this._validFields[cacheKey] = gr.isValidField(name);
		return this._validFields[cacheKey];
	},

	_count: function (table, action) {
		if (!this.counts[table])
			this.counts[table] = { insert: 0, update: 0 };
		this.counts[table][action]++;
	},

	type: 'Ledger'
};
