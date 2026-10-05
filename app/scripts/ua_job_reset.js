function ddbConfirmResetJob() {
	if (!confirm('Delete every record this build created?'))
		return false;
	gsftSubmit(null, g_form.getFormElement(), 'x_ddb_reset_job');
}

if (typeof window == 'undefined')
	ddbResetJobServer();

function ddbResetJobServer() {
	try {
		const scenario = new GlideRecord('x_ddb_scenario');
		scenario.get(current.getValue('scenario'));
		const job = GenerationJob.start('reset', scenario, null, { onlyJob: current.getUniqueValue() });
		gs.addInfoMessage('Reset started in the background.');
		action.setRedirectURL(job);
	} catch (e) {
		gs.addErrorMessage(e.message);
		action.setRedirectURL(current);
	}
}
