import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { GitHub, type ReviewRequest, parseReviewRequest } from "core";
import { Effect } from "effect";
import { runWithGitHub } from "./github-runtime.ts";
import { type ReviewOutcome, runReview } from "./run-review.ts";

export { ContainerProxy, Sandbox } from "./sandbox.ts";

/** The label a maintainer applies to request a Run. */
const REQUEST_LABEL = "agent:review";

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
  timeout: "20 minutes",
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

    await step.do("clear-request-label", STEP_RETRIES, async () => {
      await runWithGitHub(
        this.env,
        Effect.flatMap(GitHub, (github) => github.removeLabel(request, REQUEST_LABEL)),
      );
      return { label: REQUEST_LABEL };
    });
  }
}

// The Workflow is started through the Cloudflare REST API, so this Worker
// exposes no ingress of its own.
export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler<Env>;
