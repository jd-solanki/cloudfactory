import { Effect } from "effect";
import { type GitHubError, GitHub, type PullRequestRef } from "./github.ts";

/** Applied by a maintainer to ask for a review. A Run consumes it. */
export const REQUEST_LABEL = "agent:review";

/** The states a Run projects onto the pull request while it works. */
export const STATE_LABELS = {
  reviewing: "agent:reviewing",
  failed: "agent:failed",
} as const;

export type ReviewState = keyof typeof STATE_LABELS;

/**
 * Move the pull request to one review state, or to none.
 *
 * A pull request carries at most one `agent:*` state label, and every label
 * this capability does not own is left alone. The wanted label is added before
 * the others are removed, so the pull request never briefly shows no state.
 */
export const setReviewState = (
  target: PullRequestRef,
  state: ReviewState | null,
): Effect.Effect<void, GitHubError, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const wanted = state === null ? null : STATE_LABELS[state];

    if (wanted !== null) {
      yield* github.addLabel(target, wanted);
    }

    yield* github.removeLabel(target, REQUEST_LABEL);

    for (const label of Object.values(STATE_LABELS)) {
      if (label !== wanted) {
        yield* github.removeLabel(target, label);
      }
    }
  });
