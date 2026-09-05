# Cloudflare AI Gateway for Codex CLI in a Sandbox container

Documentation claims cite `developers.cloudflare.com`. Each page carries a "Last updated" date; where a claim depends on a recent change, that date is given. Pages were read as Markdown, which Cloudflare serves at the `index.md` suffix of every docs URL.

## Summary

AI Gateway cannot accept a ChatGPT subscription credential. It proxies `api.openai.com` and the other platform APIs; nothing in the documentation describes proxying `chatgpt.com` or `auth.openai.com`, and every coding-agent integration Cloudflare publishes authenticates with a platform key or with Cloudflare's own credits. The conclusion in `codex-cli-authentication.md` is unchanged: a subscription is not available to us.

Everything else asked about does exist, and more directly than expected. Cloudflare publishes a first-party Codex CLI integration page. It configures Codex as a custom model provider with `wire_api = "responses"` pointed at the gateway's OpenAI endpoint, so the Responses API question is answered by Cloudflare's own instructions. Stored provider keys are called **BYOK (Store Keys)**; the client then sends only a Cloudflare API token. There is an `env.AI` binding, but it runs models from a catalog rather than proxying an arbitrary Responses request, so a Sandbox outbound handler must reach the gateway by plain HTTPS `fetch`.

The decisive downside is that AI Gateway logs prompts and responses by default. For a product that reviews private repositories, that means our users' source code lands in Cloudflare's log store unless we turn logging off explicitly. Zero Data Retention does not cover this; it governs the upstream provider, not Cloudflare's own logs.

The recommendation is to ship option (a) now and treat option (c) as the next layer on top of it, not as a replacement. The container-side Codex configuration is identical in both, so nothing built today is discarded.

## 1. Subscription credentials

**No, and it is not close.**

AI Gateway's OpenAI provider is defined entirely in terms of the platform API. The endpoint page instructs: "When making requests to OpenAI, replace `https://api.openai.com/v1` in the URL you are currently using with `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai`" ([OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)). The provider index lists 25 or so providers, all of them platform inference APIs ([Using AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/)). Neither `chatgpt.com`, `auth.openai.com`, nor any ChatGPT backend appears as a provider.

Cloudflare's own credential model has three slots and none of them is an OAuth token. The precedence rule reads: a provider key on the request, then a BYOK stored key, then Unified Billing ([Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/#credential-precedence)). All three are API-key-shaped bearer credentials.

The clearest signal is the integration pages. Cloudflare wrote one page per coding agent, and each one routes the agent onto a platform API. The Codex page says: "AI Gateway authenticates the model provider for you through Unified Billing, so you pass a Cloudflare API token instead of an OpenAI API key" ([OpenAI Codex](https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/openai-codex/)). The Claude Code page offers "Either Unified Billing credits loaded on your Cloudflare account [...] or your own Anthropic API key" ([Claude Code](https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/)). Cloudflare had the obvious opportunity to document a subscription path for two different agents and documented a key path both times.

Whether AI Gateway would refuse an OAuth access token pasted into the `Authorization` header is not documented in any primary source I checked. It does not matter. The token would be forwarded to `api.openai.com`, which is not the host that accepts it, and the refresh and rotation problems described in `codex-cli-authentication.md` §3 would still apply unchanged.

Custom Providers accept "any AI provider that has an HTTPS API endpoint" and take an arbitrary `https://` `base_url` ([Custom Providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)), so a custom provider could in principle be pointed at a ChatGPT host. That is not a documented path, it does not solve token refresh, and it would not change the terms analysis. Treat it as unavailable.

## 2. BYOK and stored keys

**The current name is BYOK (Store Keys).** The separate feature that removes the provider key entirely is **Unified Billing**. They are different things and the docs keep them apart.

BYOK stores your own OpenAI key in the gateway: "Bring your own keys (BYOK) is a feature in Cloudflare AI Gateway that allows you to securely store your AI provider API keys directly in the Cloudflare dashboard." The keys are held in [Secrets Store](https://developers.cloudflare.com/secrets-store/) ([BYOK (Store Keys)](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)). Unified Billing instead uses Cloudflare's own provider credentials and bills prepaid credits, with "A 5% fee [...] applied to all credits purchased" and provider token rates passed through unmarked ([Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)).

BYOK requires an authenticated gateway ([BYOK, Prerequisites](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/#prerequisites)).

### Endpoint shapes

There are two families, and the header differs between them ([Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).

Provider-native endpoint, which is the one Codex uses:

```
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai/responses
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai/chat/completions
```

REST API endpoint, which Cloudflare now recommends for new integrations:

```
https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/responses
https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions
```

### Headers

| Endpoint family                    | Header carrying the Cloudflare token      | Provider key                                             |
| ---------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| `gateway.ai.cloudflare.com/v1/...` | `cf-aig-authorization: Bearer {CF_TOKEN}` | `Authorization: Bearer {OPENAI_KEY}`, omitted under BYOK |
| `api.cloudflare.com/client/v4/...` | `Authorization: Bearer {CF_TOKEN}`        | Not sent                                                 |

The BYOK page gives the before-and-after directly. With BYOK the request keeps `cf-aig-authorization` and drops the provider header ([BYOK, Example](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/#example)):

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai/chat/completions \
  -H 'cf-aig-authorization: Bearer {CF_AIG_TOKEN}' \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [...]}'
```

There is a second accepted shape that matters for Codex. The OpenAI provider page's "With Stored Keys (BYOK) / Unified Billing" example puts the Cloudflare token in the SDK's `apiKey` field against the provider-native base URL, which sends it as `Authorization: Bearer {cf_api_token}` with no `cf-aig-authorization` header at all ([OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)). The Codex integration page relies on exactly this, since Codex's `env_key` mechanism can only populate `Authorization`. How AI Gateway distinguishes a Cloudflare token in that header from a provider key it should forward unchanged is not documented in any primary source I checked. The precedence page states only the general rule that a request carrying provider authentication is forwarded to the provider and BYOK is not consulted ([Unified Billing, Credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/#credential-precedence)).

### Maturity

Not labelled beta. BYOK, Unified Billing, and authenticated gateways are documented as ordinary features with no beta or preview marker, and the pricing page states "AI Gateway is available to use on all plans" ([Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)). Cloudflare does not publish an explicit "GA" badge for them, so read this as "documented and generally available", not as a formal GA declaration.

### The token scope problem

This is the finding that changes the recommendation. Cloudflare states it plainly ([Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)):

> The `AI Gateway Read`, `Run`, and `Edit` permissions cannot be restricted to a single gateway — unlike R2, which supports per-bucket scoping. Any token with `AI Gateway Run` can send requests through every gateway in the account, including any configured with stored provider keys through Bring Your Own Keys (BYOK), consuming those credentials.

The same page's recommendation: "For isolation between gateways or tenants, use separate Cloudflare accounts or a Worker-side AI Gateway binding rather than relying on token scope."

A gateway token handed to the container is therefore not a narrower credential than an OpenAI key. It is an account-wide credential for every gateway we own.

## 3. Codex compatibility

**Confirmed, by Cloudflare's own integration page**, last updated 5 August 2026: [OpenAI Codex](https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/openai-codex/). Cloudflare's published configuration is:

```toml
model_provider = "cloudflare-ai-gateway"
model = "gpt-5.5"
model_reasoning_effort = "medium"

[model_providers.cloudflare-ai-gateway]
name = "Cloudflare AI Gateway"
base_url = "https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/<GATEWAY_ID>/openai"
env_key = "CLOUDFLARE_API_KEY"
wire_api = "responses"
```

`wire_api = "responses"` is in Cloudflare's own snippet, and the provider page lists the Responses endpoint explicitly: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai/responses` ([OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)). The REST API surface lists `POST /ai/v1/responses` — "OpenAI Responses API [...] Agentic workflows — OpenAI SDK compatible" ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).

Three constraints come with it.

**Models.** Cloudflare's own note: "Codex custom providers only support the OpenAI Responses API (`wire_api = "responses"`). This means you can only use OpenAI models that support the Responses API, such as `gpt-5.5`. Models from other providers (for example, Anthropic or Google) do not use the OpenAI Responses request format, so they do not work with Codex through this configuration." The gateway does not buy us cross-provider fallback for Codex.

**No variable expansion in `base_url`.** "Codex does not expand environment variables inside `base_url`, so the account ID and gateway slug must be literal values. Only `CLOUDFLARE_API_KEY` is read from the environment." The account ID and gateway slug must be baked into the container's `config.toml` or written at start-up.

**Streaming.** Streaming works and is the default path. The DLP page describes the non-DLP behaviour as the baseline: "This differs from requests without DLP, where streamed chunks are forwarded to the client as they arrive" ([Data Loss Prevention](https://developers.cloudflare.com/ai-gateway/features/dlp/#streaming-behavior)). The request-handling page assumes it too: "The timeout is based on when the first part of the response comes back. As long as the first part of the response returns within the specified timeframe — such as when streaming a response — your gateway will wait" ([Request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)). Two optional features break it, covered in §6.

There is also an Access-based variant on the same page, in which the provider points at a custom domain and a `[model_providers.<id>.auth]` block shells out to `cloudflared access login` for a short-lived token instead of holding a static one. Worth knowing about; it needs a browser login on first use, so it does not fit an unattended container.

## 4. Workers binding

**A binding exists, but it does not do what we need. Use a plain HTTPS `fetch`.**

The `env.AI` binding is declared as `{"ai": {"binding": "AI"}}` and exposes `env.AI.run(model, inputs, { gateway })`, `env.AI.aiGatewayLogId`, and `env.AI.gateway(id)` with `patchLog()`, `getLog()`, and `getUrl()` ([Workers Bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)). Requests made through a binding are pre-authenticated: "When an AI Gateway is accessed from a Cloudflare Worker using a binding, the `cf-aig-authorization` header does not need to be manually included" ([Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).

The mismatch is the shape of the call. `env.AI.run()` takes a model id from the [model catalog](https://developers.cloudflare.com/ai/models/) plus an inputs object. It is not a request proxy, and nothing in the binding reference accepts a raw Responses-API request body or returns a raw provider response. Codex speaks the Responses wire format end to end, so the outbound handler has to pass the body through unmodified.

There is no AI Gateway WebSocket binding. The WebSockets API is an HTTP-level surface at `gateway.ai.cloudflare.com`, not a binding ([WebSockets API](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/)).

What the binding is still good for is `getUrl()`, which builds the gateway URL from the binding rather than from hardcoded ids:

```ts
const url = await env.AI.gateway("my-gateway").getUrl("openai");
// https://gateway.ai.cloudflare.com/v1/my-account-id/my-gateway/openai
```

So the handler shape is: call `getUrl()` if you want, then `fetch` the gateway with `cf-aig-authorization` attached. Whether a `fetch` from an outbound handler to `gateway.ai.cloudflare.com` counts as pre-authenticated the way a binding call does is not documented in any primary source I checked. Assume it does not, and send the header.

Rewriting the destination inside the handler is supported. The Sandbox outbound guide names "Transparently reroute traffic" as one of the things outbound handlers are for, and the handler receives a `Request` it is free to reconstruct before forwarding ([Handle outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)).

## 5. What AI Gateway adds

Everything below is measured against the plain outbound handler, which gives us none of it.

**Analytics and cost.** Per-request token counts, cost, duration, model, provider, status, and cache status, in the dashboard and over GraphQL ([Analytics](https://developers.cloudflare.com/ai-gateway/observability/analytics/), [Costs](https://developers.cloudflare.com/ai-gateway/observability/costs/)). Free.

**Logging.** Full request and response bodies alongside the metadata, retained until deleted ([Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)). Free within the storage limits: 100,000 logs total across all gateways on Workers Free, 10,000,000 per gateway on Workers Paid ([Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)). Logs over 10 MB are not stored, and log writes are capped at 500 per second per gateway ([Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)). This is a liability for us before it is a feature; see §6.

**Custom metadata.** Up to 5 flat entries per request via `cf-aig-metadata`, so a review run could be tagged with its PR or installation id and filtered later ([Custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/), [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)). Free.

**Retries.** Up to 5 attempts, delay up to 5 seconds, with constant, linear, or exponential backoff, set per request with `cf-aig-max-attempts`, `cf-aig-retry-delay`, and `cf-aig-backoff`, or at the gateway level ([Request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)). Free.

**Timeouts.** `cf-aig-request-timeout`, in milliseconds, measured to the first byte of the response (same page). Free.

**Fallbacks and dynamic routing.** Fallback to another model or provider on error or timeout, with `cf-aig-step` in the response naming which step succeeded ([Fallbacks](https://developers.cloudflare.com/ai-gateway/configuration/fallbacks/)); conditional routing, per-model quotas, and budget limits through Dynamic Routing ([Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)). Free. Of limited use to us: §3 rules out non-OpenAI fallbacks for Codex.

**Rate limiting.** Fixed or sliding window, returning `429` past the limit ([Rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)). Free.

**Spend limits.** Cost budgets scoped by model, provider, or a custom metadata dimension such as user or team ([Spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)). Free. This is the one control here with no plain-handler equivalent short of writing it ourselves.

**Caching.** Disabled by default, TTL from 60 seconds to 1 month, cacheable requests up to 25 MB ([Caching](https://developers.cloudflare.com/ai-gateway/features/caching/), [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)). Free, and close to worthless for us: "caching is based on **exact match** of the entire request", with the key hashed from provider, endpoint, model, the provider auth header, and the full request body. Two reviews of two diffs share no request bodies. Cloudflare says semantic caching is planned, not shipped.

**Guardrails.** Llama Guard 3 8B over prompts and responses, per hazard category set to Flag, Ignore, or Block ([Guardrails](https://developers.cloudflare.com/ai-gateway/features/guardrails/)). **Billed** as Workers AI token inference ([Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)), adds roughly 500 ms per request, and does not support streaming ([Usage considerations](https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/)). Not applicable to us.

**DLP.** Scans prompts and responses for secrets, credentials, and regulated data, with Flag, Block, or Redact ([Data Loss Prevention](https://developers.cloudflare.com/ai-gateway/features/dlp/)). Free on all plans; accounts without Zero Trust get two predefined profiles, Financial Information and Social / Insurance / National Identifier Numbers ([Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)). Cloudflare pitches this straight at our use case: "Coding agents routinely send source code, configuration files, and snippets to model providers. That traffic can include API keys, customer data, or other sensitive material" ([Coding agents](https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/)). The catch is in §6.

**Logpush and OpenTelemetry.** Export logs to external storage, or trace spans to an OTel backend ([Workers Logpush](https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/), [OpenTelemetry](https://developers.cloudflare.com/ai-gateway/observability/otel-integration/)). **Logpush is Workers Paid only**, 10 million requests per month then $0.05 per million, 4 jobs per account, 1 MB per log ([Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/), [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)).

Summarised: the gateway's real value to us is token and cost analytics per review, spend limits, and retries. Everything else is either free and irrelevant, or a liability.

## 6. Downsides and gotchas

**Prompts and responses are stored by default.** This is the one that matters. "Logs, which include metrics as well as request and response data, are enabled by default for each gateway" ([Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)). The auto-created `default` gateway ships with Log collection **On** ([Manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/#default-gateway)). A Codex review request carries the diff and the file contents it read, so on default settings our users' private source code is written to Cloudflare's log store.

Three ways to stop it, from the same Logging page:

- Turn the gateway's **Logs** setting off in Settings. Applies to all requests on that gateway.
- Send `cf-aig-collect-log: false` per request. Skips the entire log entry, metadata included.
- Send `cf-aig-collect-log-payload: false` per request. Skips only the bodies: "metadata such as token counts, model, provider, status code, cost, and duration will still be logged."

The third is the one we want. It keeps the token and cost analytics that justify the gateway and drops the source code. If both are sent, `cf-aig-collect-log: false` wins and the metadata goes too.

**Zero Data Retention is not the answer to this.** ZDR routes traffic to provider endpoints that do not retain prompts, and Cloudflare says so explicitly: "ZDR does not control AI Gateway logging. To disable request/response logging in AI Gateway, update the logging settings separately" ([Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/#zero-data-retention-zdr)). It also "only applies to Unified Billing requests that use Cloudflare-managed credentials. It does not apply to BYOK or other AI Gateway requests" — so under BYOK, ZDR does nothing at all.

**DLP breaks streaming.** With response scanning on, "AI Gateway buffers the complete provider response before running DLP inspection [...] Time-to-first-token latency increases proportionally to the full response generation time" ([Data Loss Prevention](https://developers.cloudflare.com/ai-gateway/features/dlp/#streaming-behavior)). Setting the policy **Check** to **Request** only avoids the buffering. So the feature Cloudflare markets at coding agents costs us streaming unless we scan requests only.

**Guardrails breaks streaming harder.** "Guardrails does not support streaming (`stream: true`) requests." On `gateway.ai.cloudflare.com` endpoints — ours — "Guardrails buffers the full response, evaluates it, and returns a single non-streamed payload — the request no longer streams" ([Usage considerations](https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/#streaming-behavior)). Leave it off.

**Account-scoped tokens.** Covered in §2. `AI Gateway Run` cannot be narrowed to one gateway, and a token holding it can spend BYOK credentials on any gateway in the account ([Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).

**Rate limits.** Unified Billing is capped at 200 requests per 60 seconds per gateway, returning `429` past that; the cap "does not apply to requests that use your own provider keys through bring your own keys (BYOK)" ([Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)). Log writes are capped at 500 per second per gateway. Gateways are capped at 10 per account on the free plan, 20 on paid.

**Sizes.** Cacheable requests are capped at 25 MB and stored logs at 10 MB each; Logpush caps at 1 MB per log (same page). A **general maximum request body size** for AI Gateway is not documented in any primary source I checked.

**Latency.** The gateway is an extra network hop. Cloudflare publishes no added-latency figure for the proxy itself; the only quantified number in the docs is the roughly 500 ms Guardrails adds. **Not documented in any primary source I checked.**

**Timeouts.** `cf-aig-request-timeout` sets a per-request timeout, but a **default or maximum request timeout for AI Gateway** is not documented in any primary source I checked. The one documented behaviour at the edge of a retry sequence: "On the final retry attempt, your gateway will wait until the request completes, regardless of how long it takes" ([Request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)).

**Codex-specific.** OpenAI Responses-capable models only, and no environment-variable expansion in `base_url` (§3).

## 7. Recommendation

The options judged against secret exposure to untrusted repository code, moving parts, observability, cost, and whether Cloudflare stores our users' source code.

### (a) Outbound handler injects the OpenAI key, direct to `api.openai.com`

Secret exposure is the floor. The handler runs "in the Workers runtime — outside the sandbox", and "No token is exposed to the sandbox. The secret lives in the Worker's environment and is never passed into the sandbox" ([Handle outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)). Codex is configured with no `env_key` and `requires_openai_auth` unset, so it sends no credential and repository-controlled code has nothing to steal.

Moving parts: one handler, one secret. Observability: nothing beyond what we build. Cost: metered OpenAI pricing, no Cloudflare surcharge. Cloudflare stores nothing.

### (b) Container calls the gateway and holds a gateway token

Reject this one. It looks like it moves the secret out of the container, and it does the opposite. The container would hold a Cloudflare API token that cannot be scoped to one gateway and that "can send requests through every gateway in the account, including any configured with stored provider keys through BYOK, consuming those credentials" ([Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)). We would be handing untrusted repository code an account-wide Cloudflare credential in place of a single project-scoped OpenAI key. That is strictly worse exposure, and it buys nothing that (c) does not.

It also adds the moving parts of (c) — a gateway, a stored key, container-side gateway configuration — without the security property.

### (c) Handler injects auth and rewrites to the gateway URL

The container is configured exactly as in (a): a custom provider with no credential, pointed at `https://api.openai.com/v1`. The `outboundByHost` handler for `api.openai.com` rewrites the URL to the gateway's OpenAI endpoint and attaches `cf-aig-authorization`, with the OpenAI key either stored in the gateway under BYOK or attached by the handler as `Authorization`. Rerouting is a documented purpose of outbound handlers ([Handle outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)).

Secret exposure is identical to (a): the container holds nothing, and no Cloudflare token crosses into it. Observability is everything in §5. Cost is unchanged if we use BYOK — Unified Billing's 5% credit fee only applies if we let Cloudflare supply the key. Cloudflare stores our users' source code **unless** we send `cf-aig-collect-log-payload: false` on every request, which the handler can do in the same place it sets the auth header. Moving parts: a gateway, a BYOK secret in Secrets Store, a URL rewrite, and one extra header.

### Pick

**Ship (a) now. Move to (c) when we want per-review token and cost numbers.**

This is a layer, not a stopgap. In both options Codex is configured identically — a custom provider with no credential of its own — and the entire difference lives inside one `outboundByHost` handler. Going from (a) to (c) is a change to a handler body: rewrite the URL, add two headers. Nothing built for (a) is thrown away, which is the test that separates growing the system in layers from accepting a temporary shape.

Ship (a) first because it is the smallest thing that works end to end and because it keeps Cloudflare out of the path of our users' private code entirely, which is the strongest possible answer to that question while the review pipeline is still being proven. Take (c) when we need spend limits or per-PR cost attribution badly enough to own a gateway config and to guarantee `cf-aig-collect-log-payload: false` on every request.

Two rules if and when we adopt (c):

- Set the gateway's Logs setting off, **and** send `cf-aig-collect-log-payload: false` per request. Do not rely on one alone, and do not rely on ZDR, which does not govern Cloudflare's logs and does not apply to BYOK at all.
- Never put a Cloudflare API token inside the container. If the container ever needs to hold a credential, an OpenAI project key is the smaller blast radius.

## Sources

Cloudflare AI Gateway:

- https://developers.cloudflare.com/ai-gateway/
- https://developers.cloudflare.com/ai-gateway/llms.txt
- https://developers.cloudflare.com/ai-gateway/usage/
- https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
- https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
- https://developers.cloudflare.com/ai-gateway/usage/rest-api/
- https://developers.cloudflare.com/ai-gateway/usage/websockets-api/
- https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/
- https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/
- https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/openai-codex/
- https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/
- https://developers.cloudflare.com/ai-gateway/configuration/authentication/
- https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
- https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/
- https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/
- https://developers.cloudflare.com/ai-gateway/configuration/request-handling/
- https://developers.cloudflare.com/ai-gateway/configuration/fallbacks/
- https://developers.cloudflare.com/ai-gateway/features/unified-billing/
- https://developers.cloudflare.com/ai-gateway/features/caching/
- https://developers.cloudflare.com/ai-gateway/features/dlp/
- https://developers.cloudflare.com/ai-gateway/features/guardrails/
- https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/
- https://developers.cloudflare.com/ai-gateway/features/rate-limiting/
- https://developers.cloudflare.com/ai-gateway/features/spend-limits/
- https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/
- https://developers.cloudflare.com/ai-gateway/observability/logging/
- https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/
- https://developers.cloudflare.com/ai-gateway/observability/analytics/
- https://developers.cloudflare.com/ai-gateway/observability/costs/
- https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
- https://developers.cloudflare.com/ai-gateway/observability/otel-integration/
- https://developers.cloudflare.com/ai-gateway/reference/limits/
- https://developers.cloudflare.com/ai-gateway/reference/pricing/

Other Cloudflare documentation:

- https://developers.cloudflare.com/sandbox/guides/outbound-traffic/
- https://developers.cloudflare.com/secrets-store/
- https://developers.cloudflare.com/ai/models/

Prior research in this repository:

- `docs/research/codex-cli-authentication.md`
