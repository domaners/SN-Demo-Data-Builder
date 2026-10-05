'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, example } = require('./harness');

function plan(headcount, seed, bp) {
	const h = createHarness();
	h.ctx.__bp = bp || example();
	return JSON.parse(JSON.stringify(h.eval('new FoundationPlanner(__bp, { seed: "' + (seed || 'abc') + '", headcount: ' + headcount + ' }).plan()')));
}

test('plan has exactly the requested headcount, named personas first', () => {
	const p = plan(250);
	assert.equal(p.users.length, 250);
	assert.equal(p.counts.users, 250);
	const named = p.users.filter((u) => u.namedKey);
	assert.deepEqual(named.map((u) => u.username), ['priya.raman', 'tom.whitaker', 'femke.devries']);
	assert.equal(named[0].title, 'Chief Information Officer');
});

test('staff are spread by department and location weights, never in datacenters', () => {
	const p = plan(1000);
	const byLoc = {};
	const byDept = {};
	p.users.forEach((u) => {
		byLoc[u.locationKey] = (byLoc[u.locationKey] || 0) + 1;
		byDept[u.departmentKey] = (byDept[u.departmentKey] || 0) + 1;
	});
	assert.equal(byLoc['lds-dc1'], undefined);
	assert.equal(byLoc['aws-euw2'], undefined);
	assert.ok(Math.abs(byLoc['man-hq'] - 550) <= 3, 'Manchester ~55%: ' + byLoc['man-hq']);
	assert.ok(Math.abs(byDept.ops - 600) <= 3, 'Ops ~60%: ' + byDept.ops);
});

test('usernames, emails, employee ids and GUIDs are unique', () => {
	const p = plan(1000);
	['username', 'email', 'employeeId', 'objectGuid', 'dn'].forEach((field) => {
		const values = p.users.map((u) => u[field]);
		assert.equal(new Set(values).size, values.length, field + ' must be unique');
	});
	p.users.forEach((u) => {
		assert.match(u.username, /^[a-z0-9.]+$/);
		assert.match(u.email, /@haldenfreight\.example$/);
		assert.match(u.dn, /,DC=corp,DC=haldenfreight,DC=example$/);
	});
});

test('everyone except the top executive has a manager, with no cycles', () => {
	const p = plan(600);
	const byKey = {};
	p.users.forEach((u) => { byKey[u.key] = u; });
	const roots = p.users.filter((u) => !u.managerKey);
	assert.deepEqual(roots.map((u) => u.namedKey), ['cio']);
	p.users.forEach((u) => {
		const seen = new Set();
		let cur = u;
		while (cur.managerKey) {
			assert.ok(byKey[cur.managerKey], 'manager exists');
			assert.ok(!seen.has(cur.key), 'no cycle at ' + u.username);
			seen.add(cur.key);
			cur = byKey[cur.managerKey];
		}
		assert.equal(cur.namedKey, 'cio');
	});
});

test('named managers and department heads are respected', () => {
	const p = plan(400);
	const named = {};
	p.users.forEach((u) => { if (u.namedKey) named[u.namedKey] = u; });
	assert.equal(named['sd-lead'].managerKey, named.cio.key);
	const it = p.departments.find((d) => d.key === 'it');
	assert.equal(it.headKey, named['sd-lead'].key);
	const ops = p.departments.find((d) => d.key === 'ops');
	assert.equal(ops.headKey, named['wms-owner'].key);
	assert.equal(named['wms-owner'].managerKey, named.cio.key, 'head of a child department reports to the root head');
	const fin = p.departments.find((d) => d.key === 'fin');
	const finHead = p.users.find((u) => u.key === fin.headKey);
	assert.equal(finHead.title, 'Head of Finance');
	assert.ok(p.users.some((u) => /^Depot Operations Manager, /.test(u.title)), 'large cells get line managers');
});

test('groups draw members from their departments and include their manager', () => {
	const p = plan(800);
	const byKey = {};
	p.users.forEach((u) => { byKey[u.key] = u; });
	const sd = p.groups.find((g) => g.key === 'sd');
	const itCount = p.users.filter((u) => u.departmentKey === 'it').length;
	assert.ok(Math.abs(sd.memberKeys.length - Math.round(0.4 * itCount)) <= 1);
	sd.memberKeys.forEach((k) => assert.equal(byKey[k].departmentKey, 'it'));
	assert.equal(byKey[sd.managerKey].namedKey, 'sd-lead');
	assert.ok(sd.memberKeys.indexOf(sd.managerKey) >= 0);
	assert.equal(new Set(sd.memberKeys).size, sd.memberKeys.length);
	const cab = p.groups.find((g) => g.key === 'cab');
	cab.memberKeys.forEach((k) => assert.ok(['it', 'exec'].indexOf(byKey[k].departmentKey) >= 0));
	assert.match(sd.dn, /^CN=HFL Service Desk,OU=Groups,DC=corp/);
});

test('plans are reproducible and growing headcount keeps existing people', () => {
	const a = plan(300, 'seed-x');
	const b = plan(300, 'seed-x');
	assert.deepEqual(a, b);
	const c = plan(300, 'seed-y');
	assert.notDeepEqual(a.users.map((u) => u.username), c.users.map((u) => u.username));
	const bigger = plan(330, 'seed-x');
	const keys = new Set(bigger.users.map((u) => u.key));
	const kept = a.users.filter((u) => keys.has(u.key)).length;
	assert.ok(kept / a.users.length > 0.95, 'kept ' + kept + ' of ' + a.users.length);
});

test('locations and departments are ordered parents first', () => {
	const bp = example();
	bp.locations.reverse();
	bp.departments.reverse();
	const p = plan(100, 'x', bp);
	const seen = new Set();
	p.locations.concat(p.departments).forEach((x) => {
		if (x.parentKey)
			assert.ok(seen.has(x.parentKey), x.key + ' after its parent');
		seen.add(x.key);
	});
});

test('collisions get numbered usernames', () => {
	const bp = example();
	bp.people.name_locales = [{ locale: 'zh-CN', weight: 1 }];
	bp.people.username_pattern = '{f}{last}';
	const p = plan(800, 's', bp);
	const usernames = p.users.map((u) => u.username);
	assert.equal(new Set(usernames).size, usernames.length);
	assert.ok(usernames.some((u) => /\d$/.test(u)), 'some usernames needed a number');
});
