export default async function start(ctx) {
  await ctx.replicant('greeting').set('hello from the extension');
  ctx.log.info('ready');
}
