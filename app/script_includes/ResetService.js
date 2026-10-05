/**
 * Deletes records DDB created, using the ledger, in dependency order (dependants first).
 * Ledger rows are removed as their records are deleted, so a reset can be resumed.
 *
 * @access package_private
 */
var ResetService = Class.create();

/** Later phases (CMDB, ITSM) add their tables in front of the foundation tables. */
ResetService.ORDER = FoundationSimulator.RESET_ORDER;

ResetService.prototype = {
	/**
	 * @param {Object} opts { scenarioId, jobId } - jobId limits the reset to records a job created
	 */
	initialize: function (opts) {
		this.scenarioId = opts.scenarioId;
		this.jobId = opts.jobId || '';
	},

	_ledger: function (table) {
		const gr = new GlideRecord(Ledger.TABLE);
		gr.addQuery('scenario', this.scenarioId);
		if (this.jobId)
			gr.addQuery('job', this.jobId);
		if (table)
			gr.addQuery('table_name', table);
		return gr;
	},

	remaining: function () {
		const gr = this._ledger();
		gr.query();
		return gr.getRowCount();
	},

	/** Tables present in the ledger, in delete order. */
	tables: function () {
		const seen = {};
		const gr = this._ledger();
		gr.query();
		while (gr.next())
			seen[gr.getValue('table_name')] = true;
		const ordered = ResetService.ORDER.filter(function (t) { return seen[t]; });
		Object.keys(seen).sort().forEach(function (t) {
			if (ordered.indexOf(t) < 0)
				ordered.push(t);
		});
		return ordered;
	},

	/** @returns {{deleted: number, counts: Object, remaining: number}} */
	deleteChunk: function (limit) {
		let deleted = 0;
		const counts = {};
		const tables = this.tables();
		for (let i = 0; i < tables.length && deleted < limit; i++) {
			const table = tables[i];
			const led = this._ledger(table);
			led.setLimit(limit - deleted);
			led.query();
			while (led.next()) {
				const target = new GlideRecord(table);
				if (target.isValid() && target.get(led.getValue('document_id')))
					target.deleteRecord();
				led.deleteRecord();
				deleted++;
				counts[table] = (counts[table] || 0) + 1;
			}
		}
		return { deleted: deleted, counts: counts, remaining: this.remaining() };
	},

	type: 'ResetService'
};
