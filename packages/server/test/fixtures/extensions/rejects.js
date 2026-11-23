export default async function start(ctx) {
  await ctx.http.get('/left-behind', () => ({}));
  throw new Error('async failure');
}
