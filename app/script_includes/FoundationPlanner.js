/**
 * Expands the foundation part of a blueprint (company, locations, departments, people,
 * groups) into a concrete, deterministic plan. Pure computation: no database access.
 *
 * Each person is generated from a PRNG stream keyed by department, location and index,
 * so raising the headcount adds people without renaming the existing ones.
 *
 * @access package_private
 */
var FoundationPlanner = Class.create();

FoundationPlanner.COUNTRY_CODES = {
	'united kingdom': '44', 'uk': '44', 'netherlands': '31', 'united states': '1', 'usa': '1', 'canada': '1',
	'germany': '49', 'france': '33', 'spain': '34', 'italy': '39', 'brazil': '55', 'india': '91',
	'japan': '81', 'sweden': '46', 'poland': '48', 'china': '86', 'australia': '61', 'ireland': '353',
	'belgium': '32', 'switzerland': '41', 'austria': '43', 'mexico': '52', 'singapore': '65', 'portugal': '351'
};

FoundationPlanner.LOCATION_TYPES = {
	region: 'region', country: 'country', site: 'site', building: 'building',
	datacenter: 'site', cloud_region: 'region'
};

/** Distribute total across weights with the largest-remainder method. */
FoundationPlanner.apportion = function (total, weights) {
	let sum = 0;
	for (let i = 0; i < weights.length; i++)
		sum += weights[i];
	if (sum <= 0 || total <= 0)
		return weights.map(function () { return 0; });
	const exact = weights.map(function (w) { return total * w / sum; });
	const counts = exact.map(Math.floor);
	let assigned = counts.reduce(function (a, b) { return a + b; }, 0);
	const order = exact.map(function (x, idx) { return { idx: idx, rem: x - Math.floor(x) }; })
		.sort(function (a, b) { return b.rem - a.rem || a.idx - b.idx; });
	for (let k = 0; assigned < total; k++, assigned++)
		counts[order[k % order.length].idx]++;
	return counts;
};

/** Escape a value for use in an LDAP DN component. */
FoundationPlanner.dnEscape = function (value) {
	return String(value).replace(/([,+"\\<>;=])/g, '\\$1');
};

/** Order items so parents come before children. */
FoundationPlanner.parentsFirst = function (items) {
	const byKey = {};
	items.forEach(function (i) { byKey[i.key] = i; });
	const out = [];
	const done = {};
	const visit = function (item, depth) {
		if (done[item.key] || depth > items.length)
			return;
		if (item.parent_key && byKey[item.parent_key])
			visit(byKey[item.parent_key], depth + 1);
		done[item.key] = true;
		out.push(item);
	};
	items.forEach(function (i) { visit(i, 0); });
	return out;
};

FoundationPlanner.prototype = {
	/**
	 * @param {Object} blueprint  validated blueprint
	 * @param {Object} opts { seed: string, headcount: number }
	 */
	initialize: function (blueprint, opts) {
		this.bp = blueprint;
		this.seed = String(opts.seed);
		this.headcount = Math.max(parseInt(opts.headcount, 10) || 0, blueprint.people.named_users.length);
		this.prng = new Prng(this.seed + '/foundation');
	},

	plan: function () {
		const bp = this.bp;
		const company = bp.company;
		const dc = company.ad_domain.split('.').map(function (p) { return 'DC=' + p; }).join(',');
		const plan = {
			baseDn: dc,
			company: {
				key: 'company',
				name: company.name,
				shortCode: company.short_code,
				industry: company.industry,
				description: company.description,
				country: company.headquarters_country,
				website: 'https://www.' + company.email_domain,
				emailDomain: company.email_domain
			},
			locations: [],
			departments: [],
			costCenters: [],
			users: [],
			groups: [],
			roleAssignments: []
		};

		this.locByKey = {};
		FoundationPlanner.parentsFirst(bp.locations).forEach(function (l) {
			const loc = {
				key: l.key,
				name: l.name,
				parentKey: l.parent_key || '',
				type: FoundationPlanner.LOCATION_TYPES[l.type] || 'site',
				blueprintType: l.type,
				city: l.city,
				state: l.state,
				country: l.country,
				timezone: l.timezone,
				isDatacenter: l.is_datacenter,
				weight: l.is_datacenter ? 0 : Math.max(0, l.headcount_weight)
			};
			plan.locations.push(loc);
			this.locByKey[l.key] = loc;
		}, this);

		this.deptByKey = {};
		FoundationPlanner.parentsFirst(bp.departments).forEach(function (d) {
			const dept = {
				key: d.key,
				name: d.name,
				parentKey: d.parent_key || '',
				costCenterKey: d.key,
				costCenterCode: d.cost_center_code,
				titles: d.job_titles.length ? d.job_titles : ['Employee'],
				weight: Math.max(0, d.headcount_weight),
				headKey: ''
			};
			plan.departments.push(dept);
			plan.costCenters.push({ key: d.key, name: d.cost_center_code + ' ' + d.name, code: d.cost_center_code });
			this.deptByKey[d.key] = dept;
		}, this);

		this._people(plan);
		this._hierarchy(plan);
		this._groups(plan);
		plan.counts = {
			locations: plan.locations.length,
			departments: plan.departments.length,
			cost_centers: plan.costCenters.length,
			users: plan.users.length,
			groups: plan.groups.length,
			memberships: plan.groups.reduce(function (n, g) { return n + g.memberKeys.length; }, 0),
			role_assignments: plan.roleAssignments.length
		};
		return plan;
	},

	_people: function (plan) {
		const bp = this.bp;
		this.usernames = {};
		this.userByKey = {};
		this.byCell = {};

		// Named personas first, so they keep their exact names and usernames.
		bp.people.named_users.forEach(function (n) {
			const user = this._makeUser(this.prng.fork('named/' + n.key), {
				first: n.first_name, last: n.last_name, locale: ''
			}, n.department_key, n.location_key, n.title);
			user.namedKey = n.key;
			user.namedManagerKey = n.manager_key || '';
			plan.users.push(user);
			n.roles.forEach(function (role) {
				plan.roleAssignments.push({ userKey: user.key, role: role });
			});
		}, this);

		const offices = plan.locations.filter(function (l) { return l.weight > 0; });
		const depts = plan.departments.filter(function (d) { return d.weight > 0; });
		const cells = [];
		const weights = [];
		depts.forEach(function (d) {
			offices.forEach(function (l) {
				cells.push({ dept: d, loc: l });
				weights.push(d.weight * l.weight);
			});
		});
		const others = this.headcount - bp.people.named_users.length;
		const counts = FoundationPlanner.apportion(others, weights);

		cells.forEach(function (cell, idx) {
			for (let i = 0; i < counts[idx]; i++) {
				const stream = this.prng.fork('user/' + cell.dept.key + '/' + cell.loc.key + '/' + i);
				const names = new NameGenerator(stream, bp.people.name_locales).next();
				plan.users.push(this._makeUser(stream, names, cell.dept.key, cell.loc.key, stream.pick(cell.dept.titles)));
			}
		}, this);
	},

	_makeUser: function (stream, names, deptKey, locKey, title) {
		const bp = this.bp;
		const dept = this.deptByKey[deptKey];
		const loc = this.locByKey[locKey];
		const base = { first: names.first, last: names.last };

		const pattern = bp.people.username_pattern;
		const patternHasN = pattern.indexOf('{n}') >= 0;
		let n = 0;
		let username = NameGenerator.applyPattern(pattern, base, 0);
		while (!username || this.usernames[username]) {
			n = n ? n + 1 : 2;
			username = patternHasN ? NameGenerator.applyPattern(pattern, base, n) :
				NameGenerator.applyPattern(pattern, base, 0) + n;
		}
		this.usernames[username] = true;
		let email = NameGenerator.applyPattern(bp.people.email_pattern, base, n, bp.company.email_domain);
		if (n && bp.people.email_pattern.indexOf('{n}') < 0)
			email = email.replace('@', n + '@');

		const ou = String(bp.people.ou_path)
			.replace(/\{department\}/g, FoundationPlanner.dnEscape(dept.name))
			.replace(/\{site\}/g, FoundationPlanner.dnEscape(loc.name))
			.replace(/\{location\}/g, FoundationPlanner.dnEscape(loc.name));
		// Same name twice needs a distinct CN, as a directory administrator would do.
		const cn = FoundationPlanner.dnEscape(names.first + ' ' + names.last + (n ? ' (' + username + ')' : ''));
		const guid = stream.uuid();
		const cc = FoundationPlanner.COUNTRY_CODES[String(loc.country).toLowerCase()] || '1';

		const user = {
			key: guid,
			objectGuid: guid,
			username: username,
			first: names.first,
			last: names.last,
			email: email,
			title: title,
			departmentKey: deptKey,
			locationKey: locKey,
			timezone: loc.timezone,
			managerKey: '',
			employeeId: bp.company.short_code + String(100000 + this._seq()).substring(1),
			phone: '+' + cc + ' 555 ' + stream.int(100, 999) + ' ' + stream.int(1000, 9999),
			mobile: '+' + cc + ' 7' + stream.int(100, 999) + ' ' + stream.int(100000, 999999),
			dn: 'CN=' + cn + ',' + ou + ',' + this._baseDn(),
			active: true
		};
		this.userByKey[user.key] = user;
		const cellKey = deptKey + '|' + locKey;
		(this.byCell[cellKey] = this.byCell[cellKey] || []).push(user);
		return user;
	},

	_seq: function () {
		this._counter = (this._counter || 0) + 1;
		return this._counter;
	},

	_baseDn: function () {
		return this.bp.company.ad_domain.split('.').map(function (p) { return 'DC=' + p; }).join(',');
	},

	/** Department heads, line managers and manager chains. */
	_hierarchy: function (plan) {
		const self = this;
		const named = {};
		plan.users.forEach(function (u) {
			if (u.namedKey)
				named[u.namedKey] = u;
		});

		// Department heads: a named user who does not report into their own department,
		// otherwise the first person in the department's largest cell.
		plan.departments.forEach(function (d) {
			const candidates = plan.users.filter(function (u) {
				if (!u.namedKey || u.departmentKey !== d.key)
					return false;
				const mgr = named[u.namedManagerKey];
				return !mgr || mgr.departmentKey !== d.key;
			});
			let head = candidates[0];
			if (!head) {
				let largest = [];
				Object.keys(self.byCell).sort().forEach(function (cellKey) {
					if (cellKey.split('|')[0] === d.key && self.byCell[cellKey].length > largest.length)
						largest = self.byCell[cellKey];
				});
				head = largest[0];
				if (head)
					head.title = 'Head of ' + d.name;
			}
			d.headKey = head ? head.key : '';
		});

		const headOf = function (deptKey) {
			const d = self.deptByKey[deptKey];
			return d && d.headKey ? self.userByKey[d.headKey] : null;
		};
		const roots = plan.departments.filter(function (d) { return !d.parentKey; });
		const top = roots.length ? headOf(roots[0].key) : null;

		// Line managers for larger cells.
		const lineManagerOf = {};
		Object.keys(this.byCell).sort().forEach(function (cellKey) {
			const members = self.byCell[cellKey];
			const deptKey = cellKey.split('|')[0];
			const head = headOf(deptKey);
			const staff = members.filter(function (u) { return !u.namedKey && (!head || u.key !== head.key); });
			if (staff.length >= 6) {
				const lead = staff[0];
				lead.title = self.deptByKey[deptKey].name + ' Manager, ' + self.locByKey[lead.locationKey].name;
				lineManagerOf[cellKey] = lead;
			}
		});

		plan.users.forEach(function (u) {
			const dept = self.deptByKey[u.departmentKey];
			const head = headOf(u.departmentKey);
			if (u.namedKey && u.namedManagerKey && named[u.namedManagerKey]) {
				u.managerKey = named[u.namedManagerKey].key;
				return;
			}
			if (head && u.key === head.key) {
				const parentHead = dept.parentKey ? headOf(dept.parentKey) : top;
				u.managerKey = parentHead && parentHead.key !== u.key ? parentHead.key : '';
				return;
			}
			const lead = lineManagerOf[u.departmentKey + '|' + u.locationKey];
			if (lead && lead.key !== u.key) {
				u.managerKey = lead.key;
				return;
			}
			u.managerKey = head ? head.key : (top && top.key !== u.key ? top.key : '');
		});
	},

	_groups: function (plan) {
		const bp = this.bp;
		const self = this;
		const named = {};
		plan.users.forEach(function (u) {
			if (u.namedKey)
				named[u.namedKey] = u;
		});

		bp.groups.forEach(function (g) {
			const stream = self.prng.fork('group/' + g.key);
			const pool = plan.users.filter(function (u) {
				return g.member_department_keys.indexOf(u.departmentKey) >= 0;
			});
			let size = Math.round(Math.max(0, g.size_weight) * pool.length);
			size = Math.min(pool.length, Math.max(Math.min(3, pool.length), size));
			const members = stream.shuffle(pool).slice(0, size);
			const manager = g.manager_key && named[g.manager_key] ? named[g.manager_key] : members[0];
			if (manager && members.indexOf(manager) < 0)
				members.unshift(manager);
			plan.groups.push({
				key: g.key,
				name: g.name,
				description: g.description,
				type: g.type,
				managerKey: manager ? manager.key : '',
				memberKeys: members.map(function (m) { return m.key; }),
				roles: g.roles.slice(),
				objectGuid: stream.uuid(),
				dn: 'CN=' + FoundationPlanner.dnEscape(g.name) + ',OU=Groups,' + self._baseDn()
			});
		});
	},

	type: 'FoundationPlanner'
};
