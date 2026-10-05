(function () {
	current.update();
	const result = new BlueprintService().validate(current);
	if (result.valid)
		gs.addInfoMessage('Blueprint is valid' + (result.warnings.length ? ' with ' + result.warnings.length + ' warning(s).' : '.'));
	else
		gs.addErrorMessage('Blueprint has ' + result.errors.length + ' error(s). See Validation errors, edit the JSON, or click Repair with Claude.');
	action.setRedirectURL(current);
})();
