# Codex CLI authentication in a headless container

Source code claims cite `openai/codex` at tag `rust-v0.153.2`, published 2026-09-03, which was the latest release when this note was written. Documentation claims cite `learn.chatgpt.com`, which is where `developers.openai.com/codex/*` and the `docs/*.md` stubs in the `openai/codex` repository now redirect.

## Summary

A ChatGPT subscription can pay for Codex CLI usage on a headless machine. OpenAI documents two first-party ways to do it: device-code login, and copying `~/.codex/auth.json` from a machine that completed a browser login. Neither fits a Cloudflare Sandbox container well. Device-code login needs a human at a browser for every fresh container. The `auth.json` path requires the container to write the file back, because Codex rewrites `auth.json` on every token refresh and the refresh token rotates on each use. An ephemeral, read-only, or concurrently-run container breaks that contract, and OpenAI's own guide says one `auth.json` copy per serialized job stream.

OpenAI states directly that API keys are the right default for automation. For the described architecture the recommendation is a platform API key held in Cloudflare Secrets Store and injected by a Sandbox `outboundByHost` handler, with Codex configured as a custom model provider that sends no credential of its own.

## 1. Authentication modes

The `codex login` command surface is defined in `codex-rs/cli/src/main.rs:491-532` and dispatched in `codex-rs/cli/src/main.rs:1530-1555` ([source](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/cli/src/main.rs#L491-L532)).

| Mode                            | Exact invocation                                                        | Browser needed on that machine        |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| ChatGPT browser OAuth           | `codex login`                                                           | Yes, or a forwarded port to one       |
| ChatGPT device code             | `codex login --device-auth`                                             | No, but a browser elsewhere is needed |
| API key, persisted              | `printenv OPENAI_API_KEY \| codex login --with-api-key`                 | No                                    |
| Codex access token, persisted   | `printenv CODEX_ACCESS_TOKEN \| codex login --with-access-token`        | No                                    |
| API key, environment only       | `CODEX_API_KEY=<key> codex exec ...`                                    | No                                    |
| Access token, environment only  | `CODEX_ACCESS_TOKEN=<token> codex exec ...`                             | No                                    |
| Workload identity federation    | `OPENAI_FEDERATION_RULE_ID` + `OPENAI_IDENTITY_TOKEN_FILE`              | No                                    |
| Amazon Bedrock                  | `account/login/start` with `amazonBedrock` or `amazonBedrockAccessKeys` | No                                    |
| Custom provider, `env_key`      | `[model_providers.<id>] env_key = "<VAR>"`                              | No                                    |
| Custom provider, command-backed | `[model_providers.<id>.auth]`                                           | No                                    |

Details and corrections to the shapes named in the question:

- **`codex login`** starts a local HTTP callback server on `localhost:1455` and opens a browser. On failure it prints `On a remote or headless machine? Use 'codex login --device-auth' instead.` (`codex-rs/cli/src/login.rs:116-120`).
- **`codex login --device-auth`** exists and is a real OAuth device-code flow. It POSTs to `{issuer}/api/accounts/deviceauth/usercode`, prints a verification URL of `{issuer}/codex/device` plus a one-time code, and polls `{issuer}/api/accounts/deviceauth/token` until the code is approved or 15 minutes elapse (`codex-rs/login/src/device_code_auth.rs:63-179`). The docs mark it beta and say it must be enabled first in ChatGPT security settings or workspace permissions ([Authentication](https://learn.chatgpt.com/docs/auth)).
- **`codex login --api-key <key>`** no longer works. The flag is hidden and exits with `The --api-key flag is no longer supported. Pipe the key instead` (`codex-rs/cli/src/main.rs:507-516`, `codex-rs/cli/src/main.rs:1542-1546`). The replacement reads the key from stdin and refuses to run on a TTY (`codex-rs/cli/src/login.rs:277-316`).
- **`codex login --with-chatgpt` and `--headless` do not exist.** No such flags appear anywhere in the CLI argument definitions at this tag.
- **`CODEX_API_KEY`** is the environment variable that authenticates a non-interactive Codex process. `OPENAI_API_KEY` is _not_ read as an ambient credential by the built-in OpenAI provider; it appears only in the documented `printenv OPENAI_API_KEY | codex login --with-api-key` idiom, where the shell reads it, and as a conventional value for a custom provider's `env_key`. The three public constants are `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` (`codex-rs/login/src/auth/manager.rs:910-912`), but the auth loader consults only `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` (`codex-rs/login/src/auth/manager.rs:1456-1514`). The environment variable reference lists `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` under "Authentication and network" and does not list `OPENAI_API_KEY` at all ([Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)).
- **`codex exec-server --remote`** is a separate transport, not an auth mode. It registers a local exec-server with an environment registry over a Noise relay. Registration itself needs auth, supplied either as an Agent Identity JWT in `CODEX_ACCESS_TOKEN` with `--use-agent-identity-auth`, or as `CODEX_API_KEY` sent as a bearer token ([`codex-rs/exec-server/README.md`](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/exec-server/README.md)). It does not let a subscription pay for a container that has no credential.

## 2. Subscription auth without a browser

Yes, two first-party paths exist. Both are documented on the [Authentication](https://learn.chatgpt.com/docs/auth) page under "Login on headless devices".

**Device code (preferred, beta).** A person enables device code login in ChatGPT security settings or workspace permissions, runs `codex login --device-auth` in the container, opens the printed link on any device, signs in, and types the one-time code. The code expires in 15 minutes (`codex-rs/login/src/device_code_auth.rs:108`, `codex-rs/login/src/device_code_auth.rs:149-158`). This is interactive by definition. It cannot bootstrap an unattended container.

**Copy the auth cache.** The docs give exact commands, including a Docker variant:

```shell
ssh user@remote 'mkdir -p ~/.codex && cat > ~/.codex/auth.json' < ~/.codex/auth.json
```

```shell
CONTAINER_HOME=$(docker exec MY_CONTAINER printenv HOME)
docker exec MY_CONTAINER mkdir -p "$CONTAINER_HOME/.codex"
docker cp ~/.codex/auth.json MY_CONTAINER:"$CONTAINER_HOME/.codex/auth.json"
```

**Port forwarding.** The docs describe tunnelling the callback server: `ssh -L 1455:localhost:1455 user@remote`, then `codex login` inside that session ([Authentication](https://learn.chatgpt.com/docs/auth)).

**Paste flow for subscription tokens.** There is a paste flow, but it is not for consumer subscriptions. `printenv CODEX_ACCESS_TOKEN | codex login --with-access-token` accepts a Codex access token, and those "are currently supported for ChatGPT Business and Enterprise workspaces" ([Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)). Plus and Pro accounts cannot mint one. No primary source I checked documents a paste flow that turns a Plus or Pro subscription into a non-interactive credential.

## 3. The credential file

**Location.** `$CODEX_HOME/auth.json`, where `CODEX_HOME` defaults to `~/.codex` (`codex-rs/login/src/auth/storage.rs:154-156`; [Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)). If `CODEX_HOME` is set, the directory must already exist. The `cli_auth_credentials_store` config option selects `file`, `keyring`, or `auto`; only `file` produces a portable `auth.json` ([Authentication](https://learn.chatgpt.com/docs/auth)).

**Fields.** `AuthDotJson` is defined at `codex-rs/login/src/auth/storage.rs:39-64`:

| Field                                    | Meaning                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `auth_mode`                              | `chatgpt`, `apikey`, `chatgptAuthTokens`, `agentIdentity`, `personalAccessToken`, `bedrockApiKey`, or `bedrockAccessKeys` |
| `OPENAI_API_KEY`                         | The API key, when `auth_mode` is `apikey`                                                                                 |
| `tokens`                                 | The OAuth bundle, when `auth_mode` is `chatgpt`                                                                           |
| `last_refresh`                           | UTC timestamp of the last successful refresh                                                                              |
| `agent_identity`                         | Agent identity JWT or key record                                                                                          |
| `personal_access_token`                  | Personal access token string                                                                                              |
| `bedrock_api_key`, `bedrock_access_keys` | Amazon Bedrock credentials                                                                                                |

`tokens` is a `TokenData` with `id_token`, `access_token`, `refresh_token`, and `account_id` (`codex-rs/login/src/token_data.rs:10-25`). So a ChatGPT-backed `auth.json` holds **both** an access token and a refresh token, plus an ID token whose claims carry `chatgpt_plan_type`, `chatgpt_user_id`, and `chatgpt_account_id` (`codex-rs/login/src/token_data.rs:28-42`).

**Access-token lifetime.** Not documented in any primary source I checked. The client does not hard-code a lifetime; it reads the `exp` claim out of the access token JWT and refreshes when expiry is within 5 minutes, or when `last_refresh` is more than 8 days old (`codex-rs/login/src/auth/manager.rs:188-189`, `codex-rs/login/src/auth/manager.rs:2924-2946`). OpenAI's CI/CD guide restates the 8-day figure as the reason a weekly maintenance job is enough ([Maintain Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth)).

**Automatic refresh and rewrite.** Yes, and this is the decisive point. `refresh_and_persist_chatgpt_token` POSTs the refresh token to `https://auth.openai.com/oauth/token` and then calls `persist_tokens`, which loads the stored blob, overwrites `id_token`, `access_token`, and `refresh_token`, sets `last_refresh` to now, and saves (`codex-rs/login/src/auth/manager.rs:197`, `codex-rs/login/src/auth/manager.rs:1556-1578`, `codex-rs/login/src/auth/manager.rs:3012-3028`). The file backend opens the path with `truncate(true).write(true).create(true)` and mode `0o600`, so the whole file is rewritten in place (`codex-rs/login/src/auth/storage.rs:206-224`). The docs say the same: "after a successful refresh, Codex writes the new tokens and a new `last_refresh` back to `auth.json`" ([Maintain Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth)).

**Does a read-only or ephemeral container break?** Yes, on both counts.

- Read-only: `persist_tokens` propagates the write error, and the caller converts it into a `RefreshTokenError` rather than continuing (`codex-rs/login/src/auth/manager.rs:1577`, `codex-rs/login/src/auth/manager.rs:3019-3024`). A refresh that cannot write is a failed refresh.
- Ephemeral: the refresh token rotates. The response carries a new `refresh_token` that replaces the old one, and reusing a spent one is a named permanent failure — "Your access token could not be refreshed because your refresh token was already used." (`codex-rs/login/src/auth/manager.rs:192`). A container that starts from a baked image, refreshes, and then discards its disk burns the seed credential. Two containers running the same `auth.json` concurrently invalidate each other. OpenAI states this operational rule directly: "Use one `auth.json` per runner or per serialized workflow stream. Do not share the same file across concurrent jobs or multiple machines." ([Maintain Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth)).

The documented ephemeral-runner pattern is restore, run, and write the refreshed file back to secure storage after every job. That is a serialized read-modify-write on a shared secret, which conflicts with running review jobs in parallel.

## 4. Portability and legitimacy

**Supported, with conditions.** Copying `auth.json` is not merely tolerated; OpenAI documents it, ships shell and `docker cp` recipes for it, and maintains a dedicated advanced guide for keeping it alive in CI/CD ([Authentication](https://learn.chatgpt.com/docs/auth); [Maintain Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth)). The conditions are explicit: use it only when you specifically need to run as your Codex account, only on trusted private infrastructure, never for public or open-source repositories, and one copy per serialized job stream. The same guide opens with "The right way to authenticate automation is with an API key."

**Account sharing.** The consumer Terms of Use, effective January 1, 2026, say under Registration: "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account." ([Terms of Use](https://openai.com/policies/terms-of-use/), retrieved via the [2026-08-30 Internet Archive capture](https://web.archive.org/web/20260830042413/https://openai.com/policies/terms-of-use/); openai.com returns HTTP 403 to non-browser clients). Moving your own `auth.json` onto your own container is not sharing with anyone else. Letting other people's work run under it is.

**Programmatic use.** The same "What you cannot do" list includes "Automatically or programmatically extract data or Output" and "Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations we put on our Services." Read strictly, a CI job that drives a subscription session programmatically sits close to the first clause. Read in the light of OpenAI's own CI/CD guide, running Codex non-interactively under your account is contemplated and supported. These two documents are in tension and I did not find a primary source that reconciles them. Treat the CI/CD guide as the narrower, more specific permission and stay inside its stated conditions.

**Business and Enterprise.** The Business Terms are stricter and unambiguous: "Customer will not share Account access credentials or individual login credentials between multiple users. Customer may not resell or lease access to its Account or any End User Account." ([Business Terms](https://openai.com/policies/business-terms/), via the [2026-08-21 capture](https://web.archive.org/web/20260821142157/https://openai.com/policies/business-terms/)). For a workspace plan the sanctioned non-interactive credential is a Codex access token or a service account, not a copied `auth.json` ([Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens); [Service accounts](https://learn.chatgpt.com/docs/enterprise/service-accounts)).

**Device binding.** No. `auth.json` contains no machine identifier, and nothing in the file is derived from hardware. The only host-derived value in the storage layer is `compute_store_key`, a SHA-256 of the canonical `CODEX_HOME` path used as a keyring entry name; it is never written into `auth.json` and never sent to the server (`codex-rs/login/src/auth/storage.rs:237-249`). Requests carry a `User-Agent` and an `originator` header, neither of which is a device id (`codex-rs/login/src/auth/default_client.rs`). The practical binding is the single-use refresh token, not the machine.

## 5. Rate limits and CI

Subscription usage is capped and the caps are published as ranges, not fixed numbers. The [Pricing](https://learn.chatgpt.com/docs/pricing) page gives "local messages per five-hour period":

| Model         | Plus      | Pro 5x       | Pro 20x      | Standard Business | API key     |
| ------------- | --------- | ------------ | ------------ | ----------------- | ----------- |
| GPT-5.6 Sol   | 10-100    | 50-500       | 200-2,000    | 10-100            | Usage-based |
| GPT-5.6 Terra | 25-200    | 125-1,000    | 500-4,000    | 25-200            | Usage-based |
| GPT-5.6 Luna  | 250-2,000 | 1,250-10,000 | 5,000-40,000 | 250-2,000         | Usage-based |

The page adds three qualifiers that matter here: "Local messages and cloud chats share your plan's usage allowance. Weekly limits may also apply."; "Business ($100) uses the Pro 5x estimates."; and "Enterprise and Edu plans without flexible pricing have the same per-seat usage limits as Plus for most features." Exact weekly limits are not published. "These estimates are not fixed message limits."

For a PR-review capability the relevant number is not messages but reviews. A single review run is a long agent session that holds a lot of context, and the page warns that "larger projects, long-running tasks, or extended sessions that require the agent to hold more context will use significantly more per message." On Plus, the low end of the Sol range is 10 messages per five hours. That is not a CI budget.

**First-party statement about CI.** Yes, several, and they all point the same way. "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs." ([Authentication](https://learn.chatgpt.com/docs/auth)). "API keys are the right default for automation because they are simpler to provision and rotate. Use this path only if you specifically need to run as your Codex account." ([Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)). OpenAI does acknowledge the motivation — the CI/CD toggle is addressed to "users who need ChatGPT/Codex rate limits instead of API key usage" — but frames it as the exception.

## 6. The API-key path

**Environment variable.** `CODEX_API_KEY` is the one to set. It is checked first, ahead of every persisted credential: "API key via env var takes precedence over any other auth method" (`codex-rs/login/src/auth/manager.rs:1456-1462`). `codex exec` opts into that lookup by passing `enable_codex_api_key_env: true` (`codex-rs/exec/src/lib.rs:554`). The docs confirm the surface: "You can use `CODEX_API_KEY` with `codex exec`, `codex review`, the TypeScript SDK, and `codex exec-server --remote`." ([Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)).

**Precedence, in order** (`codex-rs/login/src/auth/manager.rs:1445-1550`):

1. `CODEX_API_KEY`, when the caller enabled env-key auth and API-key login is allowed.
2. The in-memory ephemeral store, used by external ChatGPT auth-token hosts.
3. `CODEX_ACCESS_TOKEN`, classified as a personal access token when it starts with `at-`, otherwise as an agent identity JWT.
4. The configured persistent store: `auth.json` or the OS keyring.

**No file on disk.** Yes, a key can be supplied purely by environment. `CODEX_API_KEY` is read before storage is touched, and a missing `auth.json` is a normal `Ok(None)` rather than an error (`codex-rs/login/src/auth/storage.rs:195-200`). `CODEX_HOME` itself must exist as a directory if you set it, and Codex will still want to write session state there unless you pass `--ephemeral`; `--ignore-user-config` skips `config.toml` but, per its own help text, "auth still uses `CODEX_HOME`" (`codex-rs/exec/src/cli.rs:32-45`). So: no credential file needed, but give the process a writable `CODEX_HOME` anyway.

**Custom model providers.** `[model_providers.<id>]` takes `base_url`, `env_key`, `env_key_instructions`, `wire_api`, `http_headers`, `env_http_headers`, `query_params`, `requires_openai_auth`, and an `[.auth]` block for a command-backed bearer token (`codex-rs/model-provider-info/src/lib.rs:96-152`). The three authentication shapes are documented as:

> - **OpenAI authentication**: Set `requires_openai_auth = true` [...] When `requires_openai_auth = true`, Codex ignores `env_key`.
> - **Environment variable authentication**: Set `env_key = "<ENV_VARIABLE_NAME>"` [...]
> - **No authentication**: If you don't set `requires_openai_auth` (or set it to `false`) and you don't set `env_key`, Codex assumes the provider doesn't require authentication.

([Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)). `env_key` is read straight from the process environment at request time and errors if empty (`codex-rs/model-provider-info/src/lib.rs:336-355`). You cannot redefine the built-in `openai` provider id; to move its base URL, set top-level `openai_base_url` instead.

**Other pieces.** `config.toml` lives at `$CODEX_HOME/config.toml`. `codex exec` refuses to run outside a Git repository unless given `--skip-git-repo-check`. `CODEX_CA_CERTIFICATE` points Codex's HTTPS, login, and WebSocket clients at a PEM bundle, falling back to `SSL_CERT_FILE` ([Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)).

## 7. Recommended setup

The three candidates, judged against cost, legality, reliability, and secret exposure.

**(a) Platform API key injected by the outbound handler.** Cloudflare Sandbox outbound handlers "run in the Workers runtime — outside the container sandbox", and the docs state the security property plainly: "No token is exposed to the sandbox. The secret lives in the Worker's environment and is never passed into the sandbox." ([Handle outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)). Cost is metered API pricing. Legality is clean: this is the path OpenAI names for CI. Reliability is high, because there is nothing to refresh, rotate, or write back. Secret exposure is the lowest of the three — repository-controlled code running in the sandbox never sees the key, which is exactly the risk the Codex docs warn about: "Do not set `OPENAI_API_KEY` or `CODEX_API_KEY` as a job-level environment variable in workflows that check out or run repository-controlled code."

Configure Codex as a custom provider that carries no credential of its own, so the handler owns the `Authorization` header:

```toml
model_provider = "cf-proxy"

[model_providers.cf-proxy]
name = "cf-proxy"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
```

With no `env_key` and `requires_openai_auth` unset, Codex sends no credential and the handler attaches one. Two operational notes. First, HTTPS interception writes an ephemeral CA to `/etc/cloudflare/certs/cloudflare-containers-ca.crt`; set `CODEX_CA_CERTIFICATE` to that path so Codex's Rust HTTP client trusts it rather than relying on distro-level trust wiring. Second, outbound handlers only see ports 80 and 443, and `allowedHosts`, if set, is deny-by-default.

**(b) API key as a container environment variable.** Same cost and same legality as (a). Reliability is equally good and the setup is simpler — `CODEX_API_KEY=<key> codex exec ...`, no custom provider, no CA plumbing. The difference is exposure: the key is inside the container, where checked-out repository code, build scripts, test hooks, and dependency lifecycle scripts run. For a PR-review product that executes untrusted branches, that is the whole threat model. Keep it as the fallback if TLS interception causes trouble, and if you use it, set the variable inline on the Codex invocation rather than job-wide, as the docs instruct.

**(c) Subscription `auth.json` baked or mounted in.** Cost looks free, and that is the only advantage. Legality is the weakest: defensible for a personal Plus or Pro account on trusted private infrastructure under OpenAI's CI/CD guide, in clear breach of the Business Terms if the account is a Business or Enterprise seat, and outside the guide's stated conditions the moment reviews run for a public repository — which the guide forbids outright. Reliability is the real killer. The file is rewritten on refresh, the refresh token is single-use, and the container is ephemeral, so every run must round-trip the file back to durable storage and no two reviews may run concurrently against the same copy. Secret exposure is the worst of the three: a long-lived credential to a human ChatGPT account, sitting on disk inside a container that runs untrusted code. And the five-hour message ranges in §5 make a review queue unpredictable in a way a metered key is not.

**Recommendation: (a).** Put the platform API key in Cloudflare Secrets Store, bind it to the Worker, and attach it from an `outboundByHost` handler scoped to `api.openai.com`. Point Codex at a custom provider with no credential, set `CODEX_CA_CERTIFICATE` to the injected CA path, give the container a writable `CODEX_HOME`, and run `codex exec --json`. Keep (b) documented as the fallback for debugging. Do not ship (c): it trades a predictable, cheap, legally clean dependency for a rotating secret that your architecture is structurally unable to persist.

## Sources

Primary source code, `openai/codex` at tag `rust-v0.153.2`:

- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/cli/src/main.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/cli/src/login.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/login/src/lib.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/login/src/device_code_auth.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/login/src/token_data.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/login/src/auth/storage.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/login/src/auth/manager.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/login/src/auth/default_client.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/exec/src/lib.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/exec/src/cli.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/model-provider-info/src/lib.rs
- https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/exec-server/README.md
- https://github.com/openai/codex/blob/rust-v0.153.2/docs/authentication.md

OpenAI documentation:

- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/auth/ci-cd-auth
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/config-file/environment-variables
- https://learn.chatgpt.com/docs/config-file/config-advanced
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/pricing
- https://learn.chatgpt.com/docs/enterprise/access-tokens
- https://learn.chatgpt.com/docs/enterprise/service-accounts
- https://learn.chatgpt.com/docs/enterprise/workload-identity
- https://learn.chatgpt.com/docs/enterprise/usage-limits
- https://learn.chatgpt.com/llms.txt

OpenAI policies. The canonical URLs return HTTP 403 to non-browser clients, so text was read from Internet Archive captures of those pages:

- https://openai.com/policies/terms-of-use/ — capture https://web.archive.org/web/20260830042413/https://openai.com/policies/terms-of-use/
- https://openai.com/policies/business-terms/ — capture https://web.archive.org/web/20260821142157/https://openai.com/policies/business-terms/
- https://openai.com/policies/usage-policies/ — capture https://web.archive.org/web/20260830204612/https://openai.com/policies/usage-policies/
- https://openai.com/policies/service-terms/ — capture https://web.archive.org/web/20260830085413/https://openai.com/policies/service-terms

Cloudflare documentation:

- https://developers.cloudflare.com/sandbox/guides/outbound-traffic/
