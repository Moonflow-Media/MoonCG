// Starts fine, then does what the test tells it to through the "do" message.
export default async function start(ctx) {
  await ctx.http.get('/alive', () => ({ body: 'yes' }));
  await ctx.on('do', (what) => {
    if (what === 'throw')
      setTimeout(() => {
        throw new Error('late crash');
      }, 0);
    if (what === 'reject') Promise.reject(new Error('late rejection'));
    if (what === 'exit') process.exit(3);
    if (what === 'spin') for (;;) {}
    if (what === 'hog') {
      const hoard = [];
      for (;;) hoard.push(new Array(100_000).fill(hoard.length));
    }
  });
}
