// Uses every part of the extension context. The tests watch it through the server side.
export default async function start(ctx) {
  const out = ctx.replicant('out');
  await out.ready;
  await out.update((draft) => {
    draft.bundle = ctx.bundle;
    draft.config = ctx.config;
  });

  await ctx.on('ping', (data, meta) => {
    out.update((draft) => {
      draft.pings.push({ data, by: meta.sender.principal });
    });
  });
  await ctx.handle('double', async (value) => value * 2);
  await ctx.http.get('/hello/:name', (request) => ({ body: { hello: request.params.name } }));

  ctx.onDispose(() => ctx.log.info('disposed'));
  ctx.log.info('started');
}
