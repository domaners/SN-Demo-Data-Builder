(function () {
	try {
		const errors = (current.getValue('validation_errors') || '').split('\n').filter(function (l) { return l; });
		const sections = BlueprintService.sectionsForErrors(errors);
		if (!sections.length) {
			gs.addErrorMessage('Could not tell which sections the errors belong to. Edit the JSON by hand.');
			action.setRedirectURL(current);
			return;
		}
		const scenario = new GlideRecord('x_ddb_scenario');
		scenario.get(current.getValue('scenario'));
		const job = GenerationJob.start('repair', scenario, current, { sections: sections });
		gs.addInfoMessage('Repairing section(s): ' + sections.join(', '));
		action.setRedirectURL(job);
	} catch (e) {
		gs.addErrorMessage(e.message);
		action.setRedirectURL(current);
	}
})();
