(function () {
	GenerationJob.cancel(current);
	gs.addInfoMessage('Job cancelled. Records already written stay in place; use Reset to remove them.');
	action.setRedirectURL(current);
})();
