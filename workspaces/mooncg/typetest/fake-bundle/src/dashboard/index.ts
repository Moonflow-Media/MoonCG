/// <reference path="./augment-window-with-bundleconfig.d.ts" />
import type MoonCGTypes from "../../../../types";
import { assertTypeOrUndefined } from "../shared/utils";

console.log(mooncg);
console.log(MoonCG);

const logger = new mooncg.Logger("foo");
logger.error("shaking my smh");
mooncg.log.trace("some verbose logs here");

mooncg.sendMessage("hello!").then(() => {
	console.log("done");
});

const sound = mooncg.playSound("playRocknRoll");
console.log(sound.duration);

export const config: MoonCGTypes.FilteredConfig = mooncg.config;

// Even though a generic type is specified, the value could still be
// undefined because no default was provided and there is no assertion
// that a default value will come from the schema.
// Also, it's a client replicant, so it can always be undefined anyway...
const explicitlyTypedRep: MoonCGTypes.ClientReplicant<string> =
	mooncg.Replicant("explicitlyTypedRep");
assertTypeOrUndefined<string>(explicitlyTypedRep.value);

// This is the same thing as the above test.
const genericallyTypedRep = mooncg.Replicant<string>("genericallyTypedRep");
assertTypeOrUndefined<string>(genericallyTypedRep.value);

// Even if a defaultValue is provided, a client-side rep can still be undefined.
const defaultValueRep = mooncg.Replicant("defaultValueRep", {
	defaultValue: "foo",
});
assertTypeOrUndefined<string>(defaultValueRep.value);

// This tests the default case that a replicant's value should be unknown.
const unknownRep = mooncg.Replicant("unknownRep");
// @ts-expect-error
const fail = 4 + unknownRep.value;

// @ts-expect-error
mooncg.Replicant("unsupportedOptions", { madeUp: true });

const replicants: {
	mappedReplicant: MoonCGTypes.ClientReplicant<string>;
	[k: string]: MoonCGTypes.ClientReplicant<unknown>;
} = {
	mappedReplicant: mooncg.Replicant("mappedReplicant"),
};
const what: MoonCGTypes.ClientReplicant<unknown> =
	mooncg.Replicant<string>("haha");
console.log(what.value);
assertTypeOrUndefined<string>(replicants.mappedReplicant.value);

// This tests that bundleConfig is deep read only
// @ts-expect-error
mooncg.bundleConfig.foo.bar = "bar";

// This tests that bundleConfig only specifies known properties
// @ts-expect-error
mooncg.bundleConfig.nope;

// This tests that the generic for readReplicant works
mooncg.readReplicant<string>("readTest", (value) => {
	assertTypeOrUndefined<string>(value);
});

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
