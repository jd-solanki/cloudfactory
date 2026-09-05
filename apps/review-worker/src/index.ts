import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { GitHub, type ReviewRequest, parseReviewRequest, sandboxRunId, setReviewState } from "core";
import { Effect } from "effect";
import { runWithGitHub } from "./github-runtime.ts";
import { log } from "./logging.ts";
import {
  type ReviewOutcome,
  abandonSandbox,
  checkReview,
  collectReview,
  prepareReview,
} from "./run-review.ts";

export { ContainerProxy, Sandbox } from "./sandbox.ts";

/**
 * A Workflow step cannot hold a container connection open for minutes, so no
 * step here waits for the agent. Each one is a short exchange with the sandbox,
 * and the Workflow sleeps between them.
 */
const STEP_RETRIES = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/** Checking a revision out moves a repository archive, which takes longer. */
const PREPARE_RETRIES = {
  retries: { limit: 1, delay: "15 seconds", backoff: "constant" },
  timeout: "4 minutes",
} as const;

const POLL_INTERVAL = "20 seconds";

/** 45 polls of 20 seconds bounds a review at roughly fifteen minutes. */
const MAX_POLLS = 45;

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
    const sandboxId = sandboxRunId(event.instanceId);

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
      const { fileCount } = await step.do("prepare-review", PREPARE_RETRIES, () =>
        prepareReview(this.env, request, sandboxId),
      );

      let finished = false;
      for (let poll = 0; poll < MAX_POLLS && !finished; poll += 1) {
        await step.sleep(`wait-for-review-${poll}`, POLL_INTERVAL);
        const progress = await step.do(`check-review-${poll}`, STEP_RETRIES, () =>
          checkReview(this.env, sandboxId),
        );
        finished = progress.finished;
      }

      if (!finished) {
        await step.do("abandon-sandbox", STEP_RETRIES, async () => {
          await abandonSandbox(this.env, sandboxId);
          return { sandboxId };
        });
        throw new Error("the reviewing agent did not finish within the time allowed");
      }

      const outcome = await step.do("collect-review", STEP_RETRIES, () =>
        collectReview(this.env, request, sandboxId, fileCount),
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
