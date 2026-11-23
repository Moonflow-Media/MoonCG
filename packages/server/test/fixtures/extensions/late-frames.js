// Keeps registering things while its start fails, and afterwards for as long as it lives.
export default async function start(ctx) {
  let n = 0;
  setInterval(() => {
    ctx.on('do', () => {}).catch(() => {});
    ctx.http.get(`/late/${n++}`, () => ({})).catch(() => {});
    ctx.replicant('out').subscribe(() => {});
  }, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  throw new Error('failed after registering');
}
