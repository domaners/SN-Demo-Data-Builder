/**
 * Checks a blueprint before anything is written to the instance:
 *   1. JSON Schema conformance
 *   2. Referential integrity (every *_key points at something that exists, no cycles)
 *   3. Platform fit (CI classes, roles and time zones exist on this instance)
 *   4. Sanity (weights, counts, naming)
 *
 * Errors block a build; warnings are shown but do not.
 *
 * @access package_private
 */
var BlueprintValidator = Class.create();

/** Platform checks backed by the instance. Tests pass their own. */
BlueprintValidator.instancePlatform = function () {
	return {
		isCmdbClass: function (name) {
			if (!new GlideRecord(name).isValid())
				return false;
			const tables = new GlideTableHierarchy(name).getTables();
			for (let i = 0; i < tables.length; i++) {
				if (String(tables[i]) === 'cmdb_ci')
					return true;
			}
			return false;
		},
		roleExists: function (name) {
			const gr = new GlideRecord('sys_user_role');
			gr.addQuery('name', name);
			gr.setLimit(1);
			gr.query();
			return gr.hasNext();
		},
		timezoneValid: function (tz) {
			const gr = new GlideRecord('sys_choice');
			gr.addQuery('name', 'sys_user');
			gr.addQuery('element', 'time_zone');
			gr.addQuery('value', tz);
			gr.setLimit(1);
			gr.query();
			return gr.hasNext();
		}
	};
};

BlueprintValidator.prototype = {
	/**
	 * @param {Object} platform optional { isCmdbClass(name), roleExists(name), timezoneValid(tz) }
	 */
	initialize: function (platform) {
		this.platform = platform || null;
	},

	/** @returns {{valid: boolean, errors: string[], warnings: string[]}} */
	validate: function (bp) {
		const errors = [];
		const warnings = [];

		const schemaErrors = new JsonSchemaValidator(50).validate(bp, BlueprintSchema.SCHEMA);
		for (let i = 0; i < schemaErrors.length; i++)
			errors.push('Schema: ' + schemaErrors[i].path + ' ' + schemaErrors[i].message);
		if (schemaErrors.length)
			return { valid: false, errors: errors, warnings: warnings };

		this._references(bp, errors, warnings);
		this._sanity(bp, errors, warnings);
		if (this.platform)
			this._platform(bp, errors, warnings);

		return { valid: errors.length === 0, errors: errors, warnings: warnings };
	},

	_index: function (list, label, errors) {
		const idx = {};
		for (let i = 0; i < list.length; i++) {
			const key = list[i].key;
			if (idx[key])
				errors.push(label + ': duplicate key "' + key + '"');
			idx[key] = list[i];
		}
		return idx;
	},

	_ref: function (idx, key, where, target, errors, nullable) {
		if (key === null || key === undefined || key === '') {
			if (!nullable)
				errors.push(where + ': missing ' + target + ' reference');
			return;
		}
		if (!idx[key])
			errors.push(where + ': unknown ' + target + ' "' + key + '"');
	},

	/** Detect cycles in a parent-pointer graph. getParents(item) -> array of keys. */
	_cycles: function (idx, getParents, label, errors) {
		const state = {};
		const self = this;
		const visit = function (key, trail) {
			if (state[key] === 2 || !idx[key])
				return;
			if (state[key] === 1) {
				errors.push(label + ': cycle ' + trail.concat(key).join(' -> '));
				return;
			}
			state[key] = 1;
			const parents = getParents(idx[key]) || [];
			for (let i = 0; i < parents.length; i++)
				visit(parents[i], trail.concat(key));
			state[key] = 2;
		};
		const keys = Object.keys(idx);
		for (let k = 0; k < keys.length; k++)
			visit(keys[k], []);
		return self;
	},

	_references: function (bp, errors, warnings) {
		const loc = this._index(bp.locations, 'locations', errors);
		const dept = this._index(bp.departments, 'departments', errors);
		const users = this._index(bp.people.named_users, 'people.named_users', errors);
		const groups = this._index(bp.groups, 'groups', errors);
		const apps = this._index(bp.applications, 'applications', errors);
		this._index(bp.catalog, 'catalog', errors);
		this._index(bp.themes, 'themes', errors);
		this._index(bp.infrastructure.shared_services, 'infrastructure.shared_services', errors);

		bp.locations.forEach(function (l) {
			this._ref(loc, l.parent_key, 'location "' + l.key + '"', 'parent location', errors, true);
		}, this);
		this._cycles(loc, function (l) { return l.parent_key ? [l.parent_key] : []; }, 'locations', errors);

		bp.departments.forEach(function (d) {
			this._ref(dept, d.parent_key, 'department "' + d.key + '"', 'parent department', errors, true);
		}, this);
		this._cycles(dept, function (d) { return d.parent_key ? [d.parent_key] : []; }, 'departments', errors);

		bp.people.named_users.forEach(function (u) {
			const where = 'named user "' + u.key + '"';
			this._ref(dept, u.department_key, where, 'department', errors);
			this._ref(loc, u.location_key, where, 'location', errors);
			this._ref(users, u.manager_key, where, 'manager', errors, true);
			if (loc[u.location_key] && loc[u.location_key].is_datacenter)
				warnings.push(where + ' is based in datacenter "' + u.location_key + '"');
		}, this);
		this._cycles(users, function (u) { return u.manager_key ? [u.manager_key] : []; }, 'named user managers', errors);

		bp.groups.forEach(function (g) {
			const where = 'group "' + g.key + '"';
			this._ref(users, g.manager_key, where, 'manager (named user)', errors, true);
			g.member_department_keys.forEach(function (k) {
				this._ref(dept, k, where, 'member department', errors);
			}, this);
		}, this);

		bp.applications.forEach(function (a) {
			const where = 'application "' + a.key + '"';
			this._ref(users, a.business_owner_key, where, 'business owner', errors);
			this._ref(users, a.it_owner_key, where, 'IT owner', errors);
			this._ref(groups, a.support_group_key, where, 'support group', errors);
			a.tiers.forEach(function (t) {
				this._ref(loc, t.hosting_location_key, where + ' tier ' + t.role, 'hosting location', errors);
			}, this);
			a.depends_on_keys.forEach(function (k) {
				this._ref(apps, k, where, 'dependency', errors);
			}, this);
		}, this);
		this._cycles(apps, function (a) { return a.depends_on_keys; }, 'application dependencies', errors);

		const infra = bp.infrastructure;
		infra.ip_ranges.forEach(function (r) {
			this._ref(loc, r.location_key, 'ip range ' + r.cidr, 'location', errors);
		}, this);
		infra.virtualization.forEach(function (v) {
			this._ref(loc, v.location_key, 'virtualization ' + v.platform, 'location', errors);
		}, this);
		infra.network_devices.forEach(function (n) {
			this._ref(loc, n.location_key, 'network device ' + n.model, 'location', errors);
		}, this);
		infra.shared_services.forEach(function (s) {
			this._ref(groups, s.support_group_key, 'shared service "' + s.key + '"', 'support group', errors);
		}, this);
		bp.catalog.forEach(function (c) {
			this._ref(groups, c.fulfillment_group_key, 'catalog item "' + c.key + '"', 'fulfillment group', errors);
		}, this);
		bp.themes.forEach(function (t) {
			t.application_keys.forEach(function (k) {
				this._ref(apps, k, 'theme "' + t.key + '"', 'application', errors);
			}, this);
		}, this);
	},

	_sanity: function (bp, errors, warnings) {
		if (!/^[A-Z]{2,6}$/.test(bp.company.short_code))
			errors.push('company.short_code must be 2-6 upper-case letters (got "' + bp.company.short_code + '")');

		const offices = bp.locations.filter(function (l) { return !l.is_datacenter && l.headcount_weight > 0; });
		if (!offices.length)
			errors.push('locations: at least one non-datacenter location needs headcount_weight > 0');

		const staffed = bp.departments.filter(function (d) { return d.headcount_weight > 0; });
		if (!staffed.length)
			errors.push('departments: at least one department needs headcount_weight > 0');
		bp.departments.forEach(function (d) {
			if (d.headcount_weight > 0 && !d.job_titles.length)
				errors.push('department "' + d.key + '" has staff but no job_titles');
		});

		[['locations', bp.locations], ['departments', bp.departments]].forEach(function (pair) {
			let sum = 0;
			pair[1].forEach(function (x) {
				if (x.headcount_weight < 0)
					errors.push(pair[0] + ': negative headcount_weight on "' + x.key + '"');
				sum += x.headcount_weight;
			});
			if (sum > 0 && Math.abs(sum - 1) > 0.05)
				warnings.push(pair[0] + ': headcount weights sum to ' + sum.toFixed(2) + ' (they will be normalised)');
		});

		if (!bp.people.name_locales.length)
			errors.push('people.name_locales must not be empty');
		bp.people.name_locales.forEach(function (l) {
			if (!NameGenerator.supports(l.locale))
				warnings.push('name locale "' + l.locale + '" is not bundled; ' + NameGenerator.DEFAULT_LOCALE + ' names will be used instead');
		});
		if (!/\{(first|f)\}/.test(bp.people.username_pattern) || !/\{(last|l)\}/.test(bp.people.username_pattern))
			errors.push('people.username_pattern must contain a first-name token and a last-name token');
		if (bp.people.email_pattern.indexOf('{domain}') < 0)
			errors.push('people.email_pattern must contain {domain}');

		bp.groups.forEach(function (g) {
			if (!g.member_department_keys.length)
				warnings.push('group "' + g.key + '" has no member departments and will only contain its manager');
		});

		bp.applications.forEach(function (a) {
			a.tiers.forEach(function (t) {
				if (t.instance_count < 1 || t.instance_count > 50)
					errors.push('application "' + a.key + '" tier ' + t.role + ': instance_count must be 1-50');
			});
		});
	},

	_platform: function (bp, errors, warnings) {
		const p = this.platform;
		const seenTz = {};
		bp.locations.forEach(function (l) {
			if (l.timezone && !seenTz[l.timezone]) {
				seenTz[l.timezone] = true;
				if (!p.timezoneValid(l.timezone))
					warnings.push('time zone "' + l.timezone + '" (location "' + l.key + '") is not a sys_user time zone choice on this instance');
			}
		});

		const seenRole = {};
		const checkRole = function (role, where) {
			if (seenRole[role] === undefined)
				seenRole[role] = p.roleExists(role);
			if (!seenRole[role])
				warnings.push(where + ': role "' + role + '" does not exist on this instance and will be skipped');
		};
		bp.people.named_users.forEach(function (u) {
			u.roles.forEach(function (r) { checkRole(r, 'named user "' + u.key + '"'); });
		});
		bp.groups.forEach(function (g) {
			g.roles.forEach(function (r) { checkRole(r, 'group "' + g.key + '"'); });
		});

		const seenClass = {};
		const checkClass = function (cls, where) {
			if (seenClass[cls] === undefined)
				seenClass[cls] = p.isCmdbClass(cls);
			if (!seenClass[cls])
				errors.push(where + ': "' + cls + '" is not a CMDB class on this instance');
		};
		bp.applications.forEach(function (a) {
			a.tiers.forEach(function (t) { checkClass(t.ci_class, 'application "' + a.key + '" tier ' + t.role); });
		});
		bp.infrastructure.network_devices.forEach(function (n) {
			checkClass(n.ci_class, 'network device ' + n.model);
		});
	},

	type: 'BlueprintValidator'
};
