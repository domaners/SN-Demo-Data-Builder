(function executeRule(current, previous) {
	if (current.getValue('state') === 'superseded')
		return;
	current.setValue('state', 'draft');
	current.setValue('validation_errors', '');
	current.setValue('validation_warnings', '');
	try {
		current.setValue('summary', BlueprintService.summarize(JSON.parse(current.getValue('blueprint_json'))));
	} catch (e) {
		current.setValue('summary', 'Blueprint JSON is not valid JSON: ' + e.message);
	}
	if (current.getValue('source') !== 'manual')
		current.setValue('source', 'manual');
	gs.addInfoMessage('Blueprint changed. Validate it, then approve it again before building.');
})(current, previous);
