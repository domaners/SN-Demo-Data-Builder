(function () {
	try {
		GenerationJob.retry(current);
		gs.addInfoMessage('Job re-queued from where it stopped.');
	} catch (e) {
		gs.addErrorMessage(e.message);
	}
	action.setRedirectURL(current);
})();
