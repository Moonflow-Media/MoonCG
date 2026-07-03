import type {
	DatabaseAdapter,
	User as DatabaseUser,
} from "@mooncg/database-adapter-types";

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		export interface Locals {
			databaseAdapter: DatabaseAdapter;

			/**
			 * The user that `authCheck` resolved for this request
			 * (from the Passport session or from an API key / socket token).
			 * Only present after `authCheck` has passed.
			 */
			authenticatedUser?: DatabaseUser;
		}

		export interface Request {
			/**
			 * The raw request body as a Buffer.
			 *
			 * This property is populated by MoonCG's body-parser middleware and contains
			 * the original, unparsed request body. This is particularly useful for verifying
			 * webhook signatures, where the exact bytes of the request body are needed to
			 * compute a hash that matches the signature provided by the webhook service.
			 */
			rawBody?: Buffer;
		}
	}
}
