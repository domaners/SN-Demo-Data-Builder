(function () {
	try {
		const counts = GenerationJob.preview(current);
		const parts = Object.keys(counts).map(function (k) { return k.replace(/_/g, ' ') + ': ' + counts[k]; });
		gs.addInfoMessage('A build would create or update ' + parts.join(', ') + '.');
	} catch (e) {
		gs.addErrorMessage(e.message);
	}
	action.setRedirectURL(current);
})();
