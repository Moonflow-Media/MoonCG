import type MoonCG from "../../../../types";
import { assertNever, assertTypeOrUndefined } from "../shared/utils";

type BundleConfig = { foo: { bar: "bar" } };

export = (mooncg: MoonCG.ServerAPI<BundleConfig>) => {
	new mooncg.Logger("foo");
	mooncg.Replicant<string>("stringRep").value;
	mooncg.listenFor("execSomethin", (_) => {
		console.log("doin somethin");
	});
	console.log(mooncg.bundleConfig.foo.bar);

	mooncg.mount((req, _res, _next) => {
		if (req.user) {
			const ident = req.user.identities[0];
			switch (ident.provider_type) {
				case "discord":
				case "twitch":
					console.log(
						ident.provider_access_token,
						ident.provider_refresh_token,
					);
			}
		}
	});

	mooncg.on("login", (user) => {
		console.log(user?.id, user?.name);
	});

	mooncg.on("logout", (user) => {
		console.log(user?.id, user?.name);
	});

	// Even though a generic type is specified, the value could still be
	// undefined because no default was provided and there is no assertion
	// that a default value will come from the schema.
	const explicitlyTypedRep: MoonCG.ServerReplicant<string> =
		mooncg.Replicant("explicitlyTypedRep");
	assertTypeOrUndefined<string>(explicitlyTypedRep.value);

	// This is the same thing as the above test.
	const genericallyTypedRep = mooncg.Replicant<string>("genericallyTypedRep");
	assertTypeOrUndefined<string>(genericallyTypedRep.value);

	// Because a default value is provided, this server-side replicant can never be unexpectedly undefined.
	const defaultValueRep = mooncg.Replicant("defaultValueRep", {
		defaultValue: "foo",
	});
	if (typeof defaultValueRep.value !== "string") {
		assertNever(defaultValueRep.value);
	}

	// This tests the type that asserts that a default value will be provided by the schema.
	const schemaDefaultRep = mooncg.Replicant(
		"schemaDefaultRep",
	) as unknown as MoonCG.ServerReplicantWithSchemaDefault<string>;
	if (typeof schemaDefaultRep.value !== "string") {
		assertNever(schemaDefaultRep.value);
	}

	// This tests the default case that a replicant's value should be unknown.
	const unknownRep = mooncg.Replicant("unknownRep");
	// @ts-expect-error
	const fail = 4 + unknownRep.value;

	// @ts-expect-error
	mooncg.Replicant("unsupportedOptions", { madeUp: true });

	const replicants: {
		mappedReplicant: MoonCG.ServerReplicant<string>;
		[k: string]: MoonCG.ServerReplicant<unknown>;
	} = {
		mappedReplicant: mooncg.Replicant("mappedReplicant"),
	};
	assertTypeOrUndefined<string>(replicants.mappedReplicant.value);

	// This tests that bundleConfig is deep read only
	// @ts-expect-error
	mooncg.bundleConfig.foo.bar = "bar";

	// This tests that bundleConfig only specifies known properties
	// @ts-expect-error
	mooncg.bundleConfig.nope;

	// This tests that the generic for readReplicant works
	const readResult = mooncg.readReplicant<string>("readTest");
	assertTypeOrUndefined<string>(readResult);

	// This tests some conditions for having "undefined" be a possible value of a Replicant.
	const withGenericButNoOptions = mooncg.Replicant<{ param: string }>(
		"withGenericButNoOptions",
	);
	// @ts-expect-error
	withGenericButNoOptions.value.param = "thing";
	const withGenericAndEmptyOptions = mooncg.Replicant<{ param: string }>(
		"withGenericAndEmptyOptions",
		{},
	);
	// @ts-expect-error
	withGenericAndEmptyOptions.value.param = "thing";
};
