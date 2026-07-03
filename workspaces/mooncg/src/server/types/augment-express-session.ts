/**
 * This is the idiomatic, intended way of adding fields to the session
 */
declare module "express-session" {
	interface SessionData {
		returnTo?: string;

		/**
		 * Metadata about the client that created this session,
		 * used to present "active sessions" in the management API.
		 */
		meta?: {
			createdAt: number;
			ip?: string;
			userAgent?: string;
		};

		/**
		 * Written by Passport (serializeUser stores the user id here).
		 * Declared so that the database session store can associate
		 * sessions with users without unsafe casts.
		 */
		passport?: {
			user?: string;
		};
	}
}

// This export needs to be here to make this file be a module. It serves no other purpose. It can be anything.
export {};
