(function () {
	try {
		current.update();
		const blueprint = new BlueprintService().createDraft(current, 'claude');
		const job = GenerationJob.start('blueprint', current, blueprint, {});
		gs.addInfoMessage('Generating blueprint ' + blueprint.getValue('name') + ' in the background. This page shows progress.');
		action.setRedirectURL(job);
	} catch (e) {
		gs.addErrorMessage(e.message);
		action.setRedirectURL(current);
	}
})();
