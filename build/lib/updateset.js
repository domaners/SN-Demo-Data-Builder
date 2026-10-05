'use strict';
// Generates a ServiceNow update set (unload XML) containing the scoped application.
//
// Every record gets a deterministic sys_id (md5 of a stable key) so rebuilding gives the
// same file and re-importing updates records in place. Updates are timestamped in
// dependency order (app, tables, columns, then everything else).

const crypto = require('crypto');

function md5(s) {
	return crypto.createHash('md5').update(s).digest('hex');
}

function esc(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const TYPE_MAP = {
	string: 'string', choice: 'string', integer: 'integer', boolean: 'boolean', reference: 'reference',
	glide_date_time: 'glide_date_time', decimal: 'decimal', password2: 'password2'
};

const UPDATE_TYPES = {
	sys_app: 'Application', sys_db_object: 'Table', sys_dictionary: 'Dictionary', sys_documentation: 'Field Label',
	sys_choice: 'Choice', sys_script_include: 'Script Include', sys_ui_action: 'UI Action', sys_ui_page: 'UI Page',
	sys_script: 'Business Rule', sysevent_register: 'Event Registration', sysevent_script_action: 'Script Action',
	sysauto_script: 'Scheduled Script Execution', sys_properties: 'System Property', sys_user_role: 'Role',
	sys_user_role_contains: 'Contains Role', sys_app_application: 'Application Menu', sys_app_module: 'Module',
	sys_scope_privilege: 'Cross scope privilege', sys_security_acl: 'Access Control', sys_security_acl_role: 'Access Role'
};

class UpdateSetBuilder {
	constructor(app) {
		this.app = app;
		this.scope = app.scope;
		this.appId = this.id('sys_app', app.scope);
		this.remoteId = this.id('sys_remote_update_set', app.scope + '@' + app.version);
		this.updates = [];
		this.seq = 0;
		this.baseTime = Date.parse(app.build_timestamp.replace(' ', 'T') + 'Z');
	}

	id(kind, key) {
		return md5(this.scope + ':' + kind + ':' + key);
	}

	timestamp(offsetSeconds) {
		return new Date(this.baseTime + offsetSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
	}

	/** Resolve "@ref:table:key" values to deterministic sys_ids, "@app" to the app sys_id. */
	resolve(value) {
		if (typeof value !== 'string')
			return value;
		if (value === '@app')
			return this.appId;
		const m = /^@ref:([a-z0-9_]+):(.+)$/.exec(value);
		return m ? this.id('rec', m[1] + ':' + m[2]) : value;
	}

	/**
	 * Add one record.
	 * @param {string} table
	 * @param {string} sysId
	 * @param {Object} fields  field -> value (strings, numbers, booleans)
	 * @param {Object} opts { updateName, targetName, attrs }
	 */
	add(table, sysId, fields, opts) {
		opts = opts || {};
		const created = this.timestamp(this.seq++);
		const updateName = opts.updateName || table + '_' + sysId;
		const appLabel = esc(this.app.name);
		const sysFields = {
			sys_class_name: table,
			sys_id: sysId,
			sys_created_by: 'admin',
			sys_created_on: created,
			sys_updated_by: 'admin',
			sys_updated_on: created,
			sys_mod_count: '0',
			sys_update_name: updateName,
			sys_name: opts.targetName || fields.name || fields.title || sysId,
			sys_policy: ''
		};
		const body = [];
		const all = Object.assign({}, fields, sysFields);
		Object.keys(all).sort().forEach((name) => {
			let value = this.resolve(all[name]);
			if (value === true)
				value = 'true';
			if (value === false)
				value = 'false';
			if (value === null || value === undefined || value === '')
				body.push('<' + name + '/>');
			else
				body.push('<' + name + '>' + esc(value) + '</' + name + '>');
		});
		if (table !== 'sys_app') {
			body.push('<sys_package display_value="' + appLabel + '" source="' + esc(this.scope) + '">' + this.appId + '</sys_package>');
			body.push('<sys_scope display_value="' + appLabel + '">' + this.appId + '</sys_scope>');
		}
		const attrs = Object.keys(opts.attrs || {}).map((a) => ' ' + a + '="' + esc(opts.attrs[a]) + '"').join('');
		const payload = '<?xml version="1.0" encoding="UTF-8"?><record_update table="' + esc(opts.recordTable || table) + '">' +
			'<' + table + ' action="INSERT_OR_UPDATE"' + attrs + '>' + body.join('') + '</' + table + '></record_update>';

		this.updates.push({
			name: updateName,
			type: UPDATE_TYPES[table] || table,
			targetName: opts.targetName || sysFields.sys_name,
			table: opts.recordTable || table,
			created: created,
			payload: payload
		});
		return sysId;
	}

	addApp() {
		const a = this.app;
		this.add('sys_app', this.appId, {
			name: a.name,
			scope: a.scope,
			version: a.version,
			short_description: a.short_description,
			vendor: a.vendor,
			active: true,
			js_level: a.js_level || 'es_latest',
			licensable: false,
			private: false,
			runtime_access_tracking: 'tracking',
			sys_scope: this.appId,
			sys_package: this.appId,
			source: a.scope
		}, { targetName: a.name });
	}

	addTable(t) {
		const tableId = this.id('sys_db_object', t.name);
		this.add('sys_db_object', tableId, {
			name: t.name,
			label: t.label,
			is_extendable: false,
			access: 'public',
			read_access: true,
			create_access: true,
			update_access: true,
			delete_access: true,
			ws_access: true,
			alter_access: false,
			create_access_controls: false,
			user_role: '',
			super_class: ''
		}, { targetName: t.label });

		this.add('sys_dictionary', this.id('sys_dictionary', t.name + '.'), {
			name: t.name,
			element: '',
			column_label: t.label,
			internal_type: 'collection',
			active: true,
			comments: t.description || ''
		}, { updateName: 'sys_dictionary_' + t.name + '_null', targetName: t.label, recordTable: t.name,
			attrs: { element: 'NULL', table: t.name } });
		this.add('sys_documentation', this.id('sys_documentation', t.name + '.'), {
			name: t.name, element: '', label: t.label, plural: t.plural || t.label, language: 'en', hint: '', help: ''
		}, { updateName: 'sys_documentation_' + t.name + '__en', targetName: t.label, recordTable: t.name });

		t.columns.forEach((c) => this.addColumn(t, c));
	}

	addColumn(t, c) {
		const type = TYPE_MAP[c.type];
		if (!type)
			throw new Error(t.name + '.' + c.name + ': unknown column type ' + c.type);
		const maxLength = c.max_length || { string: 255, choice: 40, reference: 32, integer: 40, boolean: 40,
			decimal: 15, glide_date_time: 40, password2: 255 }[c.type];
		this.add('sys_dictionary', this.id('sys_dictionary', t.name + '.' + c.name), {
			name: t.name,
			element: c.name,
			column_label: c.label,
			internal_type: type,
			max_length: String(maxLength),
			reference: c.reference || '',
			mandatory: !!c.mandatory,
			read_only: !!c.read_only,
			active: true,
			display: t.display === c.name,
			default_value: c.default === undefined ? '' : c.default,
			choice: c.choices ? '1' : '',
			comments: c.hint || ''
		}, { updateName: 'sys_dictionary_' + t.name + '_' + c.name, targetName: c.label, recordTable: t.name,
			attrs: { element: c.name, table: t.name } });
		this.add('sys_documentation', this.id('sys_documentation', t.name + '.' + c.name), {
			name: t.name, element: c.name, label: c.label, plural: c.label, language: 'en', hint: c.hint || '', help: ''
		}, { updateName: 'sys_documentation_' + t.name + '_' + c.name + '_en', targetName: c.label, recordTable: t.name });

		(c.choices || []).forEach((choice, i) => {
			const sysId = this.id('sys_choice', t.name + '.' + c.name + '.' + choice[0]);
			this.add('sys_choice', sysId, {
				name: t.name, element: c.name, value: choice[0], label: choice[1], sequence: String((i + 1) * 10),
				language: 'en', inactive: false
			}, { targetName: choice[1] });
		});
	}

	/**
	 * Record ACLs: read for x_ddb.user (or x_ddb.admin when read_role is "admin"),
	 * create/write/delete for x_ddb.admin. admin_overrides keeps platform admins in.
	 */
	addAcls(t) {
		const roles = { read: t.read_role || 'user', create: 'admin', write: 'admin', delete: 'admin' };
		Object.keys(roles).forEach((op) => {
			const aclId = this.id('sys_security_acl', t.name + ':' + op);
			this.add('sys_security_acl', aclId, {
				name: t.name,
				operation: op,
				type: 'record',
				decision_type: 'allow',
				active: true,
				admin_overrides: true,
				advanced: false,
				description: 'Demo Data Builder: ' + op + ' requires x_ddb.' + roles[op]
			}, { targetName: t.name + ' ' + op });
			this.add('sys_security_acl_role', this.id('sys_security_acl_role', t.name + ':' + op), {
				sys_security_acl: aclId,
				sys_user_role: '@ref:sys_user_role:' + roles[op]
			}, { targetName: t.name + ' ' + op + ' x_ddb.' + roles[op] });
		});
	}

	addScriptInclude(si) {
		this.add('sys_script_include', this.id('sys_script_include', si.name), {
			name: si.name,
			api_name: this.scope + '.' + si.name,
			access: si.access,
			active: true,
			client_callable: false,
			caller_access: '',
			description: si.description,
			script: si.script
		}, { targetName: si.name });
	}

	addRecord(r) {
		this.add(r.table, this.id('rec', r.table + ':' + r.key), r.fields, { targetName: r.fields.name || r.fields.title || r.key });
	}

	addPromptTemplate(p) {
		this.add('x_ddb_prompt_template', this.id('rec', 'x_ddb_prompt_template:' + p.name + '@' + p.version), {
			name: p.name,
			version: String(p.version),
			active: true,
			purpose: p.purpose,
			description: p.description,
			system_text: p.system,
			user_text: p.user
		}, { targetName: p.name + ' v' + p.version });
	}

	addScopePrivileges(groups) {
		groups.forEach((g) => {
			g.tables.forEach((table) => {
				g.operations.forEach((op) => {
					this.add('sys_scope_privilege', this.id('sys_scope_privilege', table + ':' + op), {
						source_scope: this.appId,
						target_scope: 'global',
						target_name: table,
						target_type: 'sys_db_object',
						operation: op,
						status: 'allowed'
					}, { targetName: table + ' ' + op });
				});
			});
		});
	}

	toXml() {
		const a = this.app;
		const ts = this.timestamp(0);
		const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<unload unload_date="' + ts + '">'];
		const field = (name, value, attrs) => {
			const at = attrs ? Object.keys(attrs).map((k) => ' ' + k + '="' + esc(attrs[k]) + '"').join('') : '';
			return value === '' || value === null || value === undefined ? '<' + name + at + '/>' : '<' + name + at + '>' + esc(value) + '</' + name + '>';
		};
		const setName = a.name + ' ' + a.version;
		out.push('<sys_remote_update_set action="INSERT_OR_UPDATE">' + [
			field('application', this.appId, { display_value: a.name }),
			field('application_name', a.name),
			field('application_scope', a.scope),
			field('application_version', a.version),
			field('collisions', ''),
			field('commit_date', ''),
			field('deleted', ''),
			field('description', a.short_description),
			field('inserted', ''),
			field('name', setName),
			field('origin_sys_id', ''),
			field('parent', '', { display_value: '' }),
			field('release_date', ''),
			field('remote_base_update_set', '', { display_value: '' }),
			field('remote_parent_id', ''),
			field('remote_sys_id', this.remoteId),
			field('state', 'loaded'),
			field('summary', ''),
			field('sys_class_name', 'sys_remote_update_set'),
			field('sys_created_by', 'admin'),
			field('sys_created_on', ts),
			field('sys_id', this.remoteId),
			field('sys_mod_count', '0'),
			field('sys_updated_by', 'admin'),
			field('sys_updated_on', ts),
			field('update_set', '', { display_value: '' }),
			field('update_source', '', { display_value: '' }),
			field('updated', '')
		].join('') + '</sys_remote_update_set>');

		this.updates.forEach((u) => {
			out.push('<sys_update_xml action="INSERT_OR_UPDATE">' + [
				field('action', 'INSERT_OR_UPDATE'),
				field('application', this.appId, { display_value: a.name }),
				field('category', 'customer'),
				field('comments', ''),
				field('name', u.name),
				field('payload', u.payload),
				field('payload_hash', ''),
				field('remote_update_set', this.remoteId, { display_value: setName }),
				field('replace_on_upgrade', 'false'),
				field('sys_created_by', 'admin'),
				field('sys_created_on', u.created),
				field('sys_id', md5('sys_update_xml:' + u.name)),
				field('sys_mod_count', '0'),
				field('sys_recorded_at', u.created),
				field('sys_updated_by', 'admin'),
				field('sys_updated_on', u.created),
				field('table', u.table),
				field('target_name', u.targetName),
				field('type', u.type),
				field('update_domain', 'global'),
				field('update_guid', ''),
				field('update_guid_history', ''),
				field('update_set', '', { display_value: '' }),
				field('view', '')
			].join('') + '</sys_update_xml>');
		});
		out.push('</unload>');
		return out.join('\n') + '\n';
	}
}

/** Build the full update set XML from loadApp() output. */
function buildUpdateSet(src) {
	const b = new UpdateSetBuilder(src.app);
	b.addApp();
	src.tables.forEach((t) => b.addTable(t));
	src.scriptIncludes.forEach((si) => b.addScriptInclude(si));
	src.records.forEach((r) => b.addRecord(r));
	src.tables.forEach((t) => b.addAcls(t));
	Object.keys(src.prompts).sort().forEach((name) => b.addPromptTemplate(src.prompts[name]));
	b.addScopePrivileges(src.app.scope_privileges || []);
	const names = {};
	b.updates.forEach((u) => {
		if (names[u.name])
			throw new Error('Duplicate update name ' + u.name);
		names[u.name] = true;
	});
	return { xml: b.toXml(), updates: b.updates, appId: b.appId };
}

module.exports = { buildUpdateSet, UpdateSetBuilder, esc, md5 };
