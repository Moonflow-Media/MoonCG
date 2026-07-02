/* istanbul ignore next */
"use strict";

const express = require("express");

module.exports = function (mooncg) {
	const app = express();
	app.get("/test-bundle/test-route", (req, res) => {
		res.sendStatus(200);
	});

	mooncg.mount(app);

	return mooncg;
};
