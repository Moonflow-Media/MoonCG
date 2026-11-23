// Never finishes its cleanup, so the host has to end it.
export default function start(ctx) {
  ctx.onDispose(() => new Promise(() => {}));
  setInterval(() => {}, 1000);
}
