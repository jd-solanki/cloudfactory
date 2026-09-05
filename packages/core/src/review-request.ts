import { Data, Effect } from "effect";

/**
 * Contract version of the payload GitHub Actions sends to the review Workflow.
 * Bump it when a field changes meaning, so a Workflow never acts on a payload
 * shape it does not understand.
 */
export const REVIEW_REQUEST_VERSION = 1;

/** The repository coordinates a Run needs. It carries no repository content. */
export type ReviewRequest = {
  readonly version: typeof REVIEW_REQUEST_VERSION;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly headSha: string;
};

export class InvalidReviewRequest extends Data.TaggedError("InvalidReviewRequest")<{
  readonly reason: string;
}> {}

const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

const fail = (reason: string) => Effect.fail(new InvalidReviewRequest({ reason }));

/**
 * Validate an untrusted Workflow payload. Routing must never depend on a field
 * that has not been checked, so every field is proven here or the Run stops.
 */
export const parseReviewRequest = (
  input: unknown,
): Effect.Effect<ReviewRequest, InvalidReviewRequest> => {
  if (typeof input !== "object" || input === null) return fail("payload is not an object");

  const { version, owner, repo, pullNumber, headSha } = input as Record<string, unknown>;

  if (version !== REVIEW_REQUEST_VERSION) return fail(`unsupported version ${String(version)}`);
  if (typeof owner !== "string" || owner === "") return fail("owner is missing");
  if (typeof repo !== "string" || repo === "") return fail("repo is missing");
  if (typeof pullNumber !== "number" || !Number.isInteger(pullNumber) || pullNumber < 1) {
    return fail("pullNumber is not a positive integer");
  }
  if (typeof headSha !== "string" || !HEAD_SHA_PATTERN.test(headSha)) {
    return fail("headSha is not a full 40-character commit SHA");
  }

  return Effect.succeed({ version: REVIEW_REQUEST_VERSION, owner, repo, pullNumber, headSha });
};
