/**
 * Runs in its own thread next to the MoonCG server. Everything that reaches the server is
 * asynchronous.
 */
export default async function start(ctx) {
  // The settings from the dashboard's settings page, with the defaults of
  // schemas/config.json filled in. Saving them restarts this extension.
  const { title, maxScore, resultsApiKey } = ctx.config;

  const score = ctx.replicant('score');
  await score.ready;
  ctx.log.info(`Score is ${score.value.home}:${score.value.away}`);
  // A secret is for the extension to use. It is never logged or put into a replicant.
  ctx.log.info(`The results service key is ${resultsApiKey ? 'set' : 'not set'}`);

  // Pages cannot read the configuration, so what the overlay shows of it goes in a replicant.
  const shownTitle = ctx.replicant('title');
  await shownTitle.ready;
  await shownTitle.set(title);

  // Keeps the score within what the settings allow.
  score.subscribe((value) => {
    if (value.home <= maxScore && value.away <= maxScore) return;
    score
      .update((draft) => {
        draft.home = Math.min(draft.home, maxScore);
        draft.away = Math.min(draft.away, maxScore);
      })
      .catch((error) => ctx.log.error(`Could not clamp the score: ${error.message}`));
  });

  // The panel asks for this with `mc.request('reset')` once its dialog was confirmed.
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
