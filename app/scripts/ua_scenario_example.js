(function () {
	try {
		Guard.assertNonProduction();
		current.update();
		const blueprint = new BlueprintService().loadExample(current, 'halden');
		current.setValue('state', 'blueprint_ready');
		current.update();
		if (blueprint.getValue('state') === 'valid')
			gs.addInfoMessage('Example blueprint loaded and valid. Review it, then click Approve.');
		else
			gs.addErrorMessage('Example blueprint loaded but has validation errors on this instance. See Validation errors.');
		action.setRedirectURL(blueprint);
	} catch (e) {
		gs.addErrorMessage(e.message);
		action.setRedirectURL(current);
	}
})();
