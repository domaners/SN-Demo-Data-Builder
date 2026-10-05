(function () {
	try {
		const scenario = new GlideRecord('x_ddb_scenario');
		scenario.get(current.getValue('scenario'));
		const job = GenerationJob.start('build', scenario, current, {});
		gs.addInfoMessage('Build started in the background.');
		action.setRedirectURL(job);
	} catch (e) {
		gs.addErrorMessage(e.message);
		action.setRedirectURL(current);
	}
})();
