const MAX_SCORE = 99;

/**
 * Runs in its own thread next to the MoonCG server. Everything that reaches the server is
 * asynchronous.
 */
export default async function start(ctx) {
  const score = ctx.replicant('score');
  await score.ready;
  ctx.log.info(`Score is ${score.value.home}:${score.value.away}`);

  // Keeps the score within what the graphic can display.
  score.subscribe((value) => {
    if (value.home <= MAX_SCORE && value.away <= MAX_SCORE) return;
    score
      .update((draft) => {
        draft.home = Math.min(draft.home, MAX_SCORE);
        draft.away = Math.min(draft.away, MAX_SCORE);
      })
      .catch((error) => ctx.log.error(`Could not clamp the score: ${error.message}`));
  });

  // The panel's reset button asks for this with `mc.request('reset')`.
  await ctx.handle('reset', async (_data, { sender }) => {
    await score.set({ home: 0, away: 0 });
    // `sender.kind` tells a signed-in user from an API token or another bundle's extension.
    ctx.log.info(`Score reset by ${sender.kind} ${sender.principal}`);
    return score.value;
  });

  // GET /b/scoreboard/api/score, for a Stream Deck or a script.
  await ctx.http.get('/score', () => ({ body: score.value }));

  ctx.onDispose(() => ctx.log.info('Stopped'));
}
