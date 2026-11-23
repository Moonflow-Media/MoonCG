// Takes requests and never answers them.
export default async function start(ctx) {
  await ctx.handle('double', () => new Promise(() => {}));
  await ctx.http.get('/never', () => new Promise(() => {}));
}
