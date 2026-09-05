import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { GitHub, type ReviewRequest, parseReviewRequest, setReviewState } from "core";
import { Effect } from "effect";
import { runWithGitHub } from "./github-runtime.ts";
import { log } from "./logging.ts";
import { type ReviewOutcome, runReview } from "./run-review.ts";

export { ContainerProxy, Sandbox } from "./sandbox.ts";

/**
 * Cloudflare Workflows owns durable recovery, so a step retries only the
 * short-lived failures that a second immediate attempt can clear.
 */
const STEP_RETRIES = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const;

/** A checkout and a full agent session need far longer than an API call. */
const REVIEW_RETRIES = {
  retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

const renderReview = (outcome: ReviewOutcome) =>
  [
    outcome.body,
    "",
    "---",
    "",
    `Reviewed \`${outcome.headSha}\` across ${outcome.fileCount} files.`,
  ].join("\n");

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewRequest> {
  override async run(event: WorkflowEvent<ReviewRequest>, step: WorkflowStep): Promise<void> {
    // A type parameter does not validate an incoming payload, so prove it here.
    const parsed = await Effect.runPromise(Effect.either(parseReviewRequest(event.payload)));
    if (parsed._tag === "Left") {
      throw new NonRetryableError(`invalid review request: ${parsed.left.reason}`);
    }
    const request = parsed.right;
    log("run.started", {
      instanceId: event.instanceId,
      repo: `${request.owner}/${request.repo}`,
      pullNumber: request.pullNumber,
      headSha: request.headSha,
    });

    // Claim the request before any slow work, so the pull request shows that a
    // Run owns it rather than looking untouched for the length of a review.
    await step.do("claim-request", STEP_RETRIES, async () => {
      await runWithGitHub(this.env, setReviewState(request, "reviewing"));
      return { state: "reviewing" };
    });

    try {
      const outcome = await step.do("review-head-revision", REVIEW_RETRIES, (context) =>
        runReview(this.env, request, context.attempt),
      );

      await step.do("publish-review-comment", STEP_RETRIES, async () => {
        await runWithGitHub(
          this.env,
          Effect.flatMap(GitHub, (github) =>
            github.upsertReviewComment(request, renderReview(outcome)),
          ),
        );
        return { headSha: request.headSha };
      });

      await step.do("clear-review-state", STEP_RETRIES, async () => {
        await runWithGitHub(this.env, setReviewState(request, null));
        return { state: "none" };
      });
      log("run.finished", { instanceId: event.instanceId, headSha: request.headSha });
    } catch (error) {
      log("run.failed", {
        instanceId: event.instanceId,
        reason: error instanceof Error ? error.message : String(error),
      });
      // Retries are already exhausted here, so the pull request must not be
      // left claiming that a review is still running.
      await step.do("mark-run-failed", STEP_RETRIES, async () => {
        await runWithGitHub(this.env, setReviewState(request, "failed"));
        return { state: "failed" };
      });
      throw error;
    }
  }
}

// The Workflow is started through the Cloudflare REST API, so this Worker
// exposes no ingress of its own.
export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler<Env>;
