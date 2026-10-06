'use strict';
// Generates the scoped application in two forms from the same records:
//   - an update set (unload XML) for System Update Sets > Import Update Set from XML
//   - a Studio source-control layout (sys_app_<id>.xml, update/, dictionary/) for
//     Studio > Import From Source Control
//
// Payload shapes follow files exported by ServiceNow Studio: plain records use
// <record_update table="T"><T action="INSERT_OR_UPDATE">; dictionary entries use
// <record_update><sys_dictionary element="E" table="T">; field labels and choice lists
// use the grouped sys_documentation and sys_choice wrappers.
//
// Every record gets a deterministic sys_id (md5 of a stable key) so rebuilding gives the
// same output and re-importing updates records in place. Updates are timestamped in
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

function attrs(map) {
	return Object.keys(map).map((k) => ' ' + k + '="' + esc(map[k]) + '"').join('');
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

const TYPE_MAP = {
	string: 'string', choice: 'string', integer: 'integer', boolean: 'boolean', reference: 'reference',
	glide_date_time: 'glide_date_time', decimal: 'decimal', password2: 'password2'
};

const DEFAULT_LENGTH = {
	string: 255, choice: 40, reference: 32, integer: 40, boolean: 40, decimal: 15, glide_date_time: 40, password2: 255
};

const UPDATE_TYPES = {
	sys_app: 'Application', sys_db_object: 'Table', sys_dictionary: 'Dictionary', sys_documentation: 'Field Label',
	sys_choice: 'Choice List', sys_script_include: 'Script Include', sys_ui_action: 'UI Action', sys_ui_page: 'UI Page',
	sys_script: 'Business Rule', sysevent_register: 'Event Registration', sysevent_script_action: 'Script Action',
	sysauto_script: 'Scheduled Script Execution', sys_properties: 'System Property', sys_user_role: 'Role',
	sys_user_role_contains: 'Contains Role', sys_app_application: 'Application Menu', sys_app_module: 'Module',
	sys_scope_privilege: 'Cross scope privilege', sys_security_acl: 'Access Control', sys_security_acl_role: 'Access Role'
};

class AppBuilder {
	constructor(app) {
		this.app = app;
		this.scope = app.scope;
		this.appId = this.id('sys_app', app.scope);
		this.remoteId = this.id('sys_remote_update_set', app.scope + '@' + app.version);
		this.updates = [];
		this.tables = [];
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
	 * XML for one record's fields plus system fields, sorted by name.
	 * @param {Object} opts { scoped: add sys_scope/sys_package, updateName, sysName, created }
	 */
	recordBody(table, sysId, fields, opts) {
		const sys = {
			sys_class_name: table,
			sys_id: sysId,
			sys_created_by: 'admin',
			sys_created_on: opts.created,
			sys_updated_by: 'admin',
			sys_updated_on: opts.created,
			sys_mod_count: '0'
		};
		if (opts.scoped !== false) {
			sys.sys_update_name = opts.updateName;
			sys.sys_name = opts.sysName;
			sys.sys_policy = '';
		}
		const all = Object.assign({}, fields, sys);
		if (opts.scoped !== false) {
			all.sys_package = { attrs: { display_value: this.app.name, source: this.scope }, value: this.appId };
			all.sys_scope = { attrs: { display_value: this.app.name }, value: this.appId };
		}
		return Object.keys(all).sort().map((name) => {
			let value = all[name];
			let at = '';
			if (value && typeof value === 'object') {
				at = attrs(value.attrs);
				value = value.value;
			}
			value = this.resolve(value);
			if (value === true)
				value = 'true';
			if (value === false)
				value = 'false';
			if (value === null || value === undefined || value === '')
				return '<' + name + at + '/>';
			return '<' + name + at + '>' + esc(value) + '</' + name + '>';
		}).join('');
	}

	push(u) {
		this.updates.push(u);
	}

	nextTime() {
		return this.timestamp(this.seq++);
	}

	/** A plain record: <record_update table="T"><T action="INSERT_OR_UPDATE">. */
	add(table, sysId, fields, opts) {
		opts = opts || {};
		const created = this.nextTime();
		const updateName = opts.updateName || table + '_' + sysId;
		const sysName = opts.targetName || fields.name || fields.title || sysId;
		const body = this.recordBody(table, sysId, fields, { created: created, updateName: updateName, sysName: sysName });
		this.push({
			name: updateName,
			type: UPDATE_TYPES[table] || table,
			targetName: sysName,
			table: table,
			created: created,
			payload: XML_DECL + '<record_update table="' + esc(table) + '"><' + table + ' action="INSERT_OR_UPDATE">' +
				body + '</' + table + '></record_update>'
		});
		return sysId;
	}

	addApp() {
		const a = this.app;
		const created = this.nextTime();
		const body = this.recordBody('sys_app', this.appId, {
			active: true,
			enforce_license: 'log',
			js_level: a.js_level || 'es_latest',
			licensable: false,
			license_model: 'none',
			logo: '',
			menu: '',
			name: a.name,
			private: false,
			restrict_table_access: false,
			runtime_access_tracking: 'permissive',
			scope: a.scope,
			scoped_administration: false,
			short_description: a.short_description,
			source: a.scope,
			sys_code: '',
			template: '',
			trackable: true,
			user_role: '',
			vendor: a.vendor,
			vendor_prefix: '',
			version: a.version
		}, { created: created, scoped: false });
		this.push({
			name: 'sys_app_' + this.appId,
			type: UPDATE_TYPES.sys_app,
			targetName: a.name,
			table: 'sys_app',
			created: created,
			payload: XML_DECL + '<record_update table="sys_app"><sys_app action="INSERT_OR_UPDATE">' + body + '</sys_app></record_update>'
		});
	}

	addTable(t) {
		this.tables.push(t);
		this.add('sys_db_object', this.id('sys_db_object', t.name), {
			access: 'public',
			actions_access: false,
			alter_access: false,
			client_scripts_access: false,
			configuration_access: false,
			create_access: false,
			create_access_controls: false,
			delete_access: false,
			is_extendable: false,
			label: t.label,
			live_feed_enabled: false,
			name: t.name,
			number_ref: '',
			read_access: true,
			super_class: '',
			update_access: false,
			user_role: '',
			ws_access: true
		}, { targetName: t.label });

		this.addDictionary(t, null);
		this.addDocumentation(t, null);
		t.columns.forEach((c) => {
			this.addDictionary(t, c);
			this.addDocumentation(t, c);
			if (c.choices)
				this.addChoices(t, c);
		});
	}

	/** Dictionary entry; c = null for the table's collection entry. */
	addDictionary(t, c) {
		const element = c ? c.name : '';
		const sysId = this.id('sys_dictionary', t.name + '.' + element);
		const updateName = 'sys_dictionary_' + t.name + '_' + (c ? c.name : 'null');
		const created = this.nextTime();
		let fields;
		if (!c) {
			fields = {
				active: true, array: false, attributes: '', audit: false, choice: '', column_label: '', comments: t.description || '',
				default_value: '', display: false, element: '', internal_type: 'collection', mandatory: false, max_length: '40',
				name: t.name, primary: false, read_only: false, reference: '', spell_check: false, text_index: false, unique: false,
				virtual: false, xml_view: false
			};
		} else {
			const type = TYPE_MAP[c.type];
			if (!type)
				throw new Error(t.name + '.' + c.name + ': unknown column type ' + c.type);
			fields = {
				active: true, array: false, attributes: '', audit: false,
				choice: c.choices ? '1' : '',
				column_label: c.label,
				comments: c.hint || '',
				default_value: c.default === undefined ? '' : c.default,
				display: t.display === c.name,
				element: c.name,
				internal_type: type,
				mandatory: !!c.mandatory,
				max_length: String(c.max_length || DEFAULT_LENGTH[c.type]),
				name: t.name,
				primary: false,
				read_only: !!c.read_only,
				reference: c.reference || '',
				spell_check: false, text_index: false, unique: false, virtual: false, xml_view: false
			};
		}
		const sysName = c ? c.label : t.name;
		const body = this.recordBody('sys_dictionary', sysId, fields, { created: created, updateName: updateName, sysName: sysName });
		this.push({
			name: updateName,
			type: UPDATE_TYPES.sys_dictionary,
			targetName: sysName,
			table: t.name,
			created: created,
			payload: XML_DECL + '<record_update><sys_dictionary action="INSERT_OR_UPDATE"' + attrs({ element: element, table: t.name }) + '>' +
				body + '</sys_dictionary></record_update>'
		});
	}

	addDocumentation(t, c) {
		const element = c ? c.name : '';
		const label = c ? c.label : t.label;
		const updateName = 'sys_documentation_' + t.name + '_' + element + '_en';
		const created = this.nextTime();
		const body = this.recordBody('sys_documentation', this.id('sys_documentation', t.name + '.' + element), {
			element: element, help: '', hint: c ? (c.hint || '') : '', label: label, language: 'en', name: t.name,
			plural: c ? label : (t.plural || label), url: '', url_target: ''
		}, { created: created, updateName: updateName, sysName: label });
		this.push({
			name: updateName,
			type: UPDATE_TYPES.sys_documentation,
			targetName: label,
			table: t.name,
			created: created,
			payload: XML_DECL + '<record_update><sys_documentation' + attrs({ element: element, label: label, language: 'en', table: t.name }) + '>' +
				'<sys_documentation action="INSERT_OR_UPDATE">' + body + '</sys_documentation></sys_documentation></record_update>'
		});
	}

	/** One choice list per field, as Studio stores it. */
	addChoices(t, c) {
		const updateName = 'sys_choice_' + t.name + '_' + c.name;
		const created = this.nextTime();
		const inner = c.choices.map((choice, i) => '<sys_choice action="INSERT_OR_UPDATE">' +
			this.recordBody('sys_choice', this.id('sys_choice', t.name + '.' + c.name + '.' + choice[0]), {
				dependent_value: '', element: c.name, hint: '', inactive: false, label: choice[1], language: 'en',
				name: t.name, sequence: String((i + 1) * 10), sys_domain: 'global', sys_domain_path: '/', value: choice[0]
			}, { created: created, scoped: false }) + '</sys_choice>').join('');
		this.push({
			name: updateName,
			type: UPDATE_TYPES.sys_choice,
			targetName: c.label,
			table: t.name,
			created: created,
			payload: XML_DECL + '<record_update><sys_choice action="INSERT_OR_UPDATE"' + attrs({ field: c.name, table: t.name, version: '1' }) + '>' +
				inner + '</sys_choice></record_update>'
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
			const roleName = this.scope + '.' + roles[op];
			this.add('sys_security_acl', aclId, {
				active: true,
				admin_overrides: true,
				advanced: false,
				condition: '',
				description: 'Demo Data Builder: ' + op + ' requires ' + roleName,
				name: t.name,
				operation: { attrs: { display_value: op }, value: op },
				script: '',
				type: { attrs: { display_value: 'record' }, value: 'record' }
			}, { targetName: t.name });
			this.add('sys_security_acl_role', this.id('sys_security_acl_role', t.name + ':' + op), {
				sys_security_acl: { attrs: { display_value: t.name }, value: aclId },
				sys_user_role: { attrs: { display_value: roleName, name: roleName }, value: '@ref:sys_user_role:' + roles[op] }
			}, { targetName: t.name + '.' + roleName });
		});
	}

	addScriptInclude(si) {
		this.add('sys_script_include', this.id('sys_script_include', si.name), {
			access: si.access,
			active: true,
			api_name: this.scope + '.' + si.name,
			caller_access: '',
			client_callable: false,
			description: si.description,
			name: si.name,
			script: si.script
		}, { targetName: si.name });
	}

	addRecord(r) {
		this.add(r.table, this.id('rec', r.table + ':' + r.key), r.fields, { targetName: r.fields.name || r.fields.title || r.key });
	}

	addPromptTemplate(p) {
		this.add('x_ddb_prompt_template', this.id('rec', 'x_ddb_prompt_template:' + p.name + '@' + p.version), {
			active: true,
			description: p.description,
			name: p.name,
			purpose: p.purpose,
			system_text: p.system,
			user_text: p.user,
			version: String(p.version)
		}, { targetName: p.name + ' v' + p.version });
	}

	addScopePrivileges(groups) {
		groups.forEach((g) => {
			g.tables.forEach((table) => {
				g.operations.forEach((op) => {
					this.add('sys_scope_privilege', this.id('sys_scope_privilege', table + ':' + op), {
						operation: op,
						source_scope: { attrs: { display_value: this.app.name }, value: this.appId },
						status: 'allowed',
						target_name: table,
						target_scope: { attrs: { display_value: 'Global' }, value: 'global' },
						target_type: 'sys_db_object'
					}, { targetName: table });
				});
			});
		});
	}

	/** <database> table definition, as Studio writes to dictionary/<table>.xml. */
	databaseXml(t) {
		const cols = t.columns.map((c) => {
			const a = { label: c.label, max_length: String(c.max_length || DEFAULT_LENGTH[c.type]), name: c.name, type: TYPE_MAP[c.type] };
			if (t.display === c.name)
				a.display = 'true';
			if (c.mandatory)
				a.mandatory = 'true';
			if (c.read_only)
				a.read_only = 'true';
			if (c.reference)
				a.reference = c.reference;
			if (c.choices)
				a.choice = '1';
			if (c.default !== undefined)
				a.default = c.default;
			const ordered = {};
			Object.keys(a).sort().forEach((k) => { ordered[k] = a[k]; });
			return '        <element' + attrs(ordered) + '/>';
		});
		return XML_DECL + '\n<database>\n    <element' + attrs({ label: t.label, max_length: '40', name: t.name, type: 'collection' }) + '>\n' +
			cols.join('\n') + '\n    </element>\n</database>\n';
	}

	toUpdateSetXml() {
		const a = this.app;
		const ts = this.timestamp(0);
		const out = [XML_DECL, '<unload unload_date="' + ts + '">'];
		const field = (name, value, at) => {
			const x = at ? attrs(at) : '';
			return value === '' || value === null || value === undefined ? '<' + name + x + '/>' : '<' + name + x + '>' + esc(value) + '</' + name + '>';
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

	/**
	 * Files for a Studio source-control repository, relative to the app path:
	 * sys_app_<id>.xml, update/<update name>.xml, dictionary/<table>.xml, checksum.txt.
	 */
	toSourceControlFiles() {
		const files = {};
		this.updates.forEach((u) => {
			const file = u.table === 'sys_app' ? u.name + '.xml' : 'update/' + u.name + '.xml';
			files[file] = u.payload + '\n';
		});
		this.tables.forEach((t) => {
			files['dictionary/' + t.name + '.xml'] = this.databaseXml(t);
		});
		// Studio compares this against its own checksum; a mismatch makes it validate the files.
		const hash = crypto.createHash('sha256');
		Object.keys(files).sort().forEach((f) => hash.update(f + '\n' + files[f]));
		files['checksum.txt'] = hash.digest('hex') + '\n';
		return files;
	}
}

/** Build both outputs from loadApp() output. */
function buildApp(src) {
	const b = new AppBuilder(src.app);
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
	return {
		xml: b.toUpdateSetXml(),
		sourceControl: b.toSourceControlFiles(),
		updates: b.updates,
		appId: b.appId,
		tables: b.tables
	};
}

module.exports = { buildApp, buildUpdateSet: buildApp, AppBuilder, esc, md5 };
