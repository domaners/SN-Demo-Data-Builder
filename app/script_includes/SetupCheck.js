/**
 * Installation and configuration checks shown on the Setup Check page
 * (x_ddb_setup_check.do). Pass live = true to also call the provider's health check.
 *
 * @access package_private
 */
var SetupCheck = Class.create();

SetupCheck.FOUNDATION_TABLES = [
	'core_company', 'cmn_cost_center', 'cmn_location', 'cmn_department', 'sys_user', 'sys_user_group',
	'sys_user_grmember', 'sys_user_has_role', 'sys_group_has_role'
];

/** Tables later phases use; reported for information only. */
SetupCheck.OPTIONAL_TABLES = [
	{ table: 'cmdb_ci_service_auto', label: 'Application services (CSDM)' },
	{ table: 'cmdb_ci_service_discovered', label: 'Service Mapping' },
	{ table: 'em_event', label: 'Event Management' },
	{ table: 'sc_cat_item', label: 'Service Catalog' },
	{ table: 'chg_model', label: 'Change models' }
];

SetupCheck.escape = function (s) {
	return String(s === null || s === undefined ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

SetupCheck.prototype = {
	initialize: function () {},

	/** @returns {Array<{name: string, status: string, message: string}>} */
	run: function (live) {
		const out = [];
		const add = function (name, status, message) { out.push({ name: name, status: status, message: message }); };
		const safely = function (name, fn) {
			try {
				fn();
			} catch (e) {
				add(name, 'fail', 'Check failed: ' + e.message);
			}
		};

		safely('Instance guard', function () {
			const reason = Guard.whyBlocked();
			add('Instance guard', reason ? 'fail' : 'ok', reason || 'Not a production instance; DDB may run here.');
		});

		safely('Your role', function () {
			add('Your role', Guard.isAdmin() ? 'ok' : 'fail',
				Guard.isAdmin() ? 'You have ' + Guard.ADMIN_ROLE + '.' : 'You need ' + Guard.ADMIN_ROLE + ' (or admin) to run DDB.');
		});

		let config = null;
		safely('Provider configuration', function () {
			config = ProviderFactory.findConfig('blueprint');
			if (!config) {
				add('Provider configuration', 'fail', 'No active provider config for blueprints. Create one under Demo Data Builder > Providers.');
				return;
			}
			add('Provider configuration', 'ok', config.getValue('name') + ': ' + config.getValue('provider') + ', model ' +
				config.getValue('model') + ', effort ' + config.getValue('effort'));
		});

		if (config) {
			safely('API credential', function () {
				const key = ProviderFactory.resolveApiKey(config.getUniqueValue());
				add('API credential', key ? 'ok' : 'fail', key ?
					'An API key is configured (' + (config.getValue('credential_alias') ? 'credential alias ' + config.getValue('credential_alias') : 'encrypted field on the provider config') + ').' :
					'No API key found. Set credential_alias to a Connection & Credential alias with an API Key credential, or fill in the API key field.');
			});

			safely('Outbound HTTP timeout', function () {
				const max = gs.getProperty('glide.http.outbound.max_timeout', '');
				const wanted = Math.round((parseInt(config.getValue('timeout_ms'), 10) || 120000) / 1000);
				const maxSeconds = parseInt(max, 10);
				if (max && maxSeconds < wanted)
					add('Outbound HTTP timeout', 'warn', 'glide.http.outbound.max_timeout is ' + max + 's but the provider config asks for ' + wanted +
						's. Long blueprint sections may time out; raise the property or lower the effort.');
				else
					add('Outbound HTTP timeout', 'ok', 'Provider timeout ' + wanted + 's' + (max ? ' (instance maximum ' + max + 's)' : ''));
			});

			if (live) {
				safely('Provider connection', function () {
					const result = ProviderFactory.fromRecord(config).healthCheck();
					add('Provider connection', result.ok ? 'ok' : 'fail', result.message);
				});
			} else {
				add('Provider connection', 'info', 'Not tested. Use "Test connection" to call the provider (uses no tokens).');
			}
		}

		safely('Background processing', function () {
			const ev = new GlideRecord('sysevent_register');
			ev.addQuery('event_name', GenerationJob.EVENT);
			ev.query();
			const action = new GlideRecord('sysevent_script_action');
			action.addQuery('event_name', GenerationJob.EVENT);
			action.addQuery('active', true);
			action.query();
			const job = new GlideRecord('sysauto_script');
			job.addQuery('name', 'DDB Job Watchdog');
			job.addQuery('active', true);
			job.query();
			const missing = [];
			if (!ev.hasNext())
				missing.push('event ' + GenerationJob.EVENT);
			if (!action.hasNext())
				missing.push('script action "DDB Job Step"');
			if (!job.hasNext())
				missing.push('scheduled job "DDB Job Watchdog"');
			add('Background processing', missing.length ? 'fail' : 'ok', missing.length ?
				'Missing or inactive: ' + missing.join(', ') + '.' : 'Job event, script action and watchdog are active.');
		});

		safely('Table access', function () {
			const blocked = [];
			SetupCheck.FOUNDATION_TABLES.forEach(function (t) {
				const gr = new GlideRecord(t);
				if (!gr.isValid() || !gr.canCreate() || !gr.canWrite() || !gr.canDelete())
					blocked.push(t);
			});
			add('Table access', blocked.length ? 'warn' : 'ok', blocked.length ?
				'Cannot create, update or delete: ' + blocked.join(', ') + '. Check Application Access on these tables and the cross-scope privileges.' :
				'Foundation tables can be written.');
		});

		safely('Optional features', function () {
			const present = [];
			const absent = [];
			SetupCheck.OPTIONAL_TABLES.forEach(function (o) {
				(new GlideRecord(o.table).isValid() ? present : absent).push(o.label);
			});
			add('Optional features', 'info', 'Available: ' + (present.join(', ') || 'none') +
				'. Not installed: ' + (absent.join(', ') || 'none') + '. (Used from Phase 2 onwards.)');
		});

		return out;
	},

	renderHtml: function (results, live) {
		const colours = { ok: '#2e7d32', warn: '#b26a00', fail: '#c62828', info: '#455a64' };
		const labels = { ok: 'OK', warn: 'Warning', fail: 'Problem', info: 'Info' };
		const rows = results.map(function (r) {
			return '<tr><td style="padding:6px 12px;font-weight:600">' + SetupCheck.escape(r.name) + '</td>' +
				'<td style="padding:6px 12px;color:' + colours[r.status] + ';font-weight:600">' + labels[r.status] + '</td>' +
				'<td style="padding:6px 12px">' + SetupCheck.escape(r.message) + '</td></tr>';
		}).join('');
		const problems = results.filter(function (r) { return r.status === 'fail'; }).length;
		return '<div style="font-family:sans-serif;max-width:1100px;padding:16px">' +
			'<h2 style="margin:0 0 4px">Demo Data Builder setup check</h2>' +
			'<p style="margin:0 0 16px">' + (problems ? problems + ' problem(s) need attention.' : 'Ready to use.') + '</p>' +
			'<table style="border-collapse:collapse;width:100%" border="1" cellspacing="0">' +
			'<tr style="background:#eceff1"><th style="padding:6px 12px;text-align:left">Check</th><th style="padding:6px 12px;text-align:left">Result</th><th style="padding:6px 12px;text-align:left">Details</th></tr>' +
			rows + '</table>' +
			'<p style="margin-top:16px"><a href="x_ddb_setup_check.do?live=true">Test connection</a>' +
			(live ? ' &middot; <a href="x_ddb_setup_check.do">Run without connection test</a>' : '') + '</p></div>';
	},

	type: 'SetupCheck'
};
