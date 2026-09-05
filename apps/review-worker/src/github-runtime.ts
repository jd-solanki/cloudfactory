import { GitHub, gitHubConfigLayer } from "core";
import { Effect } from "effect";

const USER_AGENT = "cloudfactory-review-worker";

/**
 * Run a GitHub program with the credential the Worker holds.
 *
 * The secret is read from the store per call, so it never becomes module-level
 * state shared between Runs.
 */
export const runWithGitHub = async <A, E>(
  env: Env,
  effect: Effect.Effect<A, E, GitHub>,
): Promise<A> => {
  const token = await env.GITHUB_TOKEN.get();

  return Effect.runPromise(
    effect.pipe(
      Effect.provide(GitHub.Default),
      Effect.provide(gitHubConfigLayer({ token, userAgent: USER_AGENT })),
    ),
  );
};
