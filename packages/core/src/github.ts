import { Context, Data, Effect, Layer } from "effect";

const API_ORIGIN = "https://api.github.com";

/**
 * Hidden anchor that identifies the comment this capability owns. Finding the
 * previous comment by marker, not by author, keeps the write idempotent when
 * the token identity changes.
 */
export const REVIEW_COMMENT_MARKER = "<!-- cloudfactory:pr-review -->";

const COMMENTS_PAGE_SIZE = 100;

const JSON_MEDIA_TYPE = "application/vnd.github+json";
const DIFF_MEDIA_TYPE = "application/vnd.github.v3.diff";

export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly status: number;
  readonly path: string;
  readonly detail: string;
}> {}

export type PullRequestRef = {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
};

export class GitHubConfig extends Context.Tag("cloudfactory/GitHubConfig")<
  GitHubConfig,
  { readonly token: string; readonly userAgent: string }
>() {}

export const gitHubConfigLayer = (config: Context.Tag.Service<GitHubConfig>) =>
  Layer.succeed(GitHubConfig, config);

type IssueComment = { readonly id: number; readonly body?: string };

export class GitHub extends Effect.Service<GitHub>()("cloudfactory/GitHub", {
  effect: Effect.gen(function* () {
    const config = yield* GitHubConfig;

    const send = (path: string, init: RequestInit = {}, accept = JSON_MEDIA_TYPE) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${API_ORIGIN}${path}`, {
              ...init,
              headers: {
                authorization: `Bearer ${config.token}`,
                accept,
                "content-type": "application/json",
                "x-github-api-version": "2022-11-28",
                "user-agent": config.userAgent,
              },
            }),
          catch: (cause) => new GitHubError({ status: 0, path, detail: String(cause) }),
        });

        if (!response.ok) {
          const detail = yield* Effect.promise(() => response.text());
          return yield* new GitHubError({ status: response.status, path, detail });
        }

        return response;
      });

    const issuePath = (target: PullRequestRef) =>
      `/repos/${target.owner}/${target.repo}/issues/${target.pullNumber}`;

    /** Walk every page, because a busy pull request holds more than one. */
    const findOwnComment = (
      target: PullRequestRef,
      page: number,
    ): Effect.Effect<number | undefined, GitHubError> =>
      Effect.gen(function* () {
        const response = yield* send(
          `${issuePath(target)}/comments?per_page=${COMMENTS_PAGE_SIZE}&page=${page}`,
        );
        const comments = yield* Effect.promise(
          () => response.json() as Promise<ReadonlyArray<IssueComment>>,
        );
        const own = comments.find((comment) => comment.body?.includes(REVIEW_COMMENT_MARKER));

        if (own !== undefined) return own.id;
        if (comments.length < COMMENTS_PAGE_SIZE) return undefined;
        return yield* findOwnComment(target, page + 1);
      });

    return {
      /**
       * The unified diff of the pull request, as GitHub itself computes it.
       * Reviewing this instead of a locally derived diff removes any chance of
       * reviewing a different change set than the one under discussion.
       */
      getPullRequestDiff: (target: PullRequestRef) =>
        send(
          `/repos/${target.owner}/${target.repo}/pulls/${target.pullNumber}`,
          {},
          DIFF_MEDIA_TYPE,
        ).pipe(Effect.flatMap((response) => Effect.promise(() => response.text()))),

      /**
       * A gzipped tar of the repository at one commit, as an unread stream.
       *
       * GitHub answers with a redirect to a signed archive URL. That URL needs
       * no credential, so the token stops at the first request and never
       * travels with the bytes.
       */
      downloadArchive: (
        target: Pick<PullRequestRef, "owner" | "repo">,
        ref: string,
      ): Effect.Effect<ReadableStream<Uint8Array>, GitHubError> =>
        Effect.gen(function* () {
          const path = `/repos/${target.owner}/${target.repo}/tarball/${ref}`;

          const redirect = yield* Effect.tryPromise({
            try: () =>
              fetch(`${API_ORIGIN}${path}`, {
                redirect: "manual",
                headers: {
                  authorization: `Bearer ${config.token}`,
                  accept: JSON_MEDIA_TYPE,
                  "x-github-api-version": "2022-11-28",
                  "user-agent": config.userAgent,
                },
              }),
            catch: (cause) => new GitHubError({ status: 0, path, detail: String(cause) }),
          });

          const location = redirect.headers.get("location");
          if (location === null) {
            return yield* new GitHubError({
              status: redirect.status,
              path,
              detail: "archive response carried no redirect location",
            });
          }

          const archive = yield* Effect.tryPromise({
            try: () => fetch(location),
            catch: (cause) => new GitHubError({ status: 0, path, detail: String(cause) }),
          });

          if (!archive.ok || archive.body === null) {
            return yield* new GitHubError({
              status: archive.status,
              path,
              detail: "archive download returned no body",
            });
          }

          return archive.body;
        }),

      /** Publish the review as a single comment that later Runs update in place. */
      upsertReviewComment: (target: PullRequestRef, body: string) =>
        Effect.gen(function* () {
          const withMarker = `${body}\n\n${REVIEW_COMMENT_MARKER}`;
          const existing = yield* findOwnComment(target, 1);

          yield* existing === undefined
            ? send(`${issuePath(target)}/comments`, {
                method: "POST",
                body: JSON.stringify({ body: withMarker }),
              })
            : send(`/repos/${target.owner}/${target.repo}/issues/comments/${existing}`, {
                method: "PATCH",
                body: JSON.stringify({ body: withMarker }),
              });
        }),

      /** Add one label, leaving every other label alone. */
      addLabel: (target: PullRequestRef, label: string) =>
        send(`${issuePath(target)}/labels`, {
          method: "POST",
          body: JSON.stringify({ labels: [label] }),
        }).pipe(Effect.asVoid),

      /** Remove one label. An absent label is already the wanted end state. */
      removeLabel: (target: PullRequestRef, label: string) =>
        send(`${issuePath(target)}/labels/${encodeURIComponent(label)}`, {
          method: "DELETE",
        }).pipe(
          Effect.catchTag("GitHubError", (error) =>
            error.status === 404 ? Effect.void : Effect.fail(error),
          ),
          Effect.asVoid,
        ),
    };
  }),
}) {}
