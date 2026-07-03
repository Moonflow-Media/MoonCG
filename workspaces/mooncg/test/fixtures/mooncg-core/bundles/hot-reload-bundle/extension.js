"use strict";

const RESPONSE = "original";

module.exports = function (mooncg) {
	const pingCount = mooncg.Replicant("pingCount", {
		defaultValue: 0,
		persistent: false,
	});
	const unloadCount = mooncg.Replicant("unloadCount", {
		defaultValue: 0,
		persistent: false,
	});

	mooncg.listenFor("hr-getValue", (_data, ack) => {
		if (ack && !ack.handled) {
			ack(null, RESPONSE);
		}
	});

	mooncg.listenFor("hr-ping", (_data, ack) => {
		pingCount.value = (pingCount.value ?? 0) + 1;
		if (ack && !ack.handled) {
			ack(null, RESPONSE);
		}
	});

	mooncg.on("bundleUnloading", () => {
		unloadCount.value = (unloadCount.value ?? 0) + 1;
	});

	return { response: RESPONSE };
};
