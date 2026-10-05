function ddbConfirmResetScenario() {
	if (!confirm('Delete every user, group, location, department and other record Demo Data Builder created for this scenario?'))
		return false;
	gsftSubmit(null, g_form.getFormElement(), 'x_ddb_reset_scenario');
}

if (typeof window == 'undefined')
	ddbResetScenarioServer();

function ddbResetScenarioServer() {
	try {
		const job = GenerationJob.start('reset', current, null, {});
		gs.addInfoMessage('Reset started in the background.');
		action.setRedirectURL(job);
	} catch (e) {
		gs.addErrorMessage(e.message);
		action.setRedirectURL(current);
	}
}
