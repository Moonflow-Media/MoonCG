/* eslint-disable @typescript-eslint/no-namespace */
declare namespace NodeJS {
	interface ProcessEnv {
		/**
		 * This is set by our test suite.
		 */
		MOONCG_TEST?: string;

		/**
		 * This is set by the server core when under test.
		 */
		MOONCG_TEST_PORT?: string;
	}
}
