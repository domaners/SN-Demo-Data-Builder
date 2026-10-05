(function () {
	try {
		new BlueprintService().approve(current);
		gs.addInfoMessage('Blueprint approved. Click Build Foundation Data to create the records.');
	} catch (e) {
		gs.addErrorMessage(e.message);
	}
	action.setRedirectURL(current);
})();
