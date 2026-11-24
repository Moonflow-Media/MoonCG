/**
 * Whether one of the grants covers a permission. This is the server's own rule, taken from
 * the SDK, so the dashboard cannot disagree with the server about what a grant means. The
 * server still decides what is allowed; this only keeps the dashboard from offering what
 * would be refused.
 */
export { grantsCover as holds } from '@mooncg/sdk/client';
