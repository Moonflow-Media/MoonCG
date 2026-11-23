// Does what the "do" message says: flood the log, send an oversized frame, or block.
export default async function start(ctx) {
  await ctx.on('do', (what) => {
    if (what === 'flood') {
      for (let line = 0; line < 5000; line++) ctx.log.info(`line ${line}`);
      setTimeout(() => ctx.log.info('after the flood'), 1200);
    }
    if (what === 'flood-many') {
      for (let line = 0; line < 200_000; line++) ctx.log.info(`line ${line}`);
    }
    if (what === 'frames') {
      for (let frame = 0; frame < 50_000; frame++) ctx.send('ping', frame).catch(() => {});
    }
    if (what === 'big') ctx.send('do', 'x'.repeat(2 * 1024 * 1024)).catch(() => {});
    if (typeof what === 'number') {
      const end = Date.now() + what;
      while (Date.now() < end);
      ctx.log.info(`blocked for ${what} ms`);
    }
  });
}
