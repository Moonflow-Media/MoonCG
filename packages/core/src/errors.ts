/** Error codes the server puts on the wire. */
export const ERROR_CODES = [
  'conflict',
  'forbidden',
  'not_found',
  'bad_request',
  'invalid',
  /** A request was not answered in time. */
  'timeout',
  /** Whoever was to answer went away, for example because its bundle stopped. */
  'unavailable',
  /** Something failed on the answering side; details stay in its log. */
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** `disconnected` never travels on the wire: a client raises it when its socket drops. */
export type ClientErrorCode = ErrorCode | 'disconnected';

/** The error every rejected operation carries. */
export class MoonCGError extends Error {
  override readonly name = 'MoonCGError';
  readonly code: ClientErrorCode;

  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Timers as the host provides them. Core has none of its own, so they are passed in. */
export interface Timers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
