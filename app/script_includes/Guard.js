/**
 * Safety checks that every DDB entry point calls before writing data.
 *
 * @access package_private
 */
var Guard = Class.create();

Guard.ADMIN_ROLE = 'x_ddb.admin';

/** Returns null when it is safe to run, otherwise a reason string. */
Guard.whyBlocked = function () {
	if (gs.getProperty('glide.installation.production', 'false') === 'true')
		return 'This instance is marked as production (glide.installation.production = true). Demo Data Builder will not run here.';
	const allowed = (gs.getProperty('x_ddb.allowed_instances', '') || '').trim();
	if (allowed) {
		const instance = gs.getProperty('instance_name', '');
		const list = allowed.split(',').map(function (s) { return s.trim().toLowerCase(); });
		if (list.indexOf(String(instance).toLowerCase()) < 0)
			return 'Instance "' + instance + '" is not listed in x_ddb.allowed_instances.';
	}
	return null;
};

Guard.assertNonProduction = function () {
	const reason = Guard.whyBlocked();
	if (reason)
		throw new Error(reason);
};

Guard.isAdmin = function () {
	return gs.hasRole(Guard.ADMIN_ROLE);
};

Guard.assertAdmin = function () {
	if (!Guard.isAdmin())
		throw new Error('The ' + Guard.ADMIN_ROLE + ' role is required.');
};

Guard.prototype = {
	initialize: function () {},
	type: 'Guard'
};
