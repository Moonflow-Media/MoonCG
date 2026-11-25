/**
 * The server side of the bundle. It runs in its own thread next to the MoonCG server, and
 * everything that reaches the server is asynchronous. `mooncg dev` starts it again whenever a
 * file in `extension/` or `shared/` changes.
 */
export default async function start(ctx) {
  const message = ctx.replicant('message');
  await message.ready;
  ctx.log.info(`Started. The message is "${message.value.text}"`);

  // Runs on every change, whoever made it: the panel, another extension or an API call.
  message.subscribe((value) => {
    ctx.log.info(`The message is now ${value.visible ? 'shown' : 'hidden'}: "${value.text}"`);
  });

  ctx.onDispose(() => ctx.log.info('Stopped'));
}
