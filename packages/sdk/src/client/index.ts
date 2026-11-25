export type {
  ClientErrorCode,
  ErrorCode,
  GraphicEndReason,
  ReplicantHandle,
  ReplicantMeta,
} from '@mooncg/core';
// `grantsCover` is the rule the server checks permissions by, for pages that decide what to show.
export { grantsCover, MoonCGError, PROTOCOL_VERSION } from '@mooncg/core';
export {
  bundleFromPath,
  type ClientOptions,
  type ConnectionStatus,
  createClient,
  graphicFromPath,
  type MessageListener,
  type MessageMeta,
  type Messaging,
  type MoonCGClient,
  type ReplicantMap,
  type RequestOptions,
  type SocketLike,
} from './client.js';
export {
  createDialogs,
  DIALOG_CHANNEL,
  DIALOG_HOST_PARAMETER,
  type DialogMessage,
  type DialogOptions,
  type Dialogs,
  type DialogWindow,
  dialogHostOrigin,
  type OpenDialog,
  readDialogMessage,
} from './dialogs.js';
