---
status: accepted
---

# Host the ChatGPT subscription gateway in a Cloudflare Container behind a Worker

`apps/aisubs-gw` exposes a permanent OpenAI-compatible base URL backed by a ChatGPT (Codex) subscription, replacing the `aisubs dashboard` process that previously had to stay running on a laptop. A Worker owns the front door, the gateway key and the only durable state; a Cloudflare Container runs the real [`aisubs`](https://github.com/MpMeetPatel/aisubs) HTTP application and makes every outbound call to the provider.

Two measured facts forced this split, and both were verified against real deployments rather than inferred.

A deployed Worker cannot reach `chatgpt.com/backend-api/codex`: it receives a `403` Cloudflare bot challenge page. The same Worker reaches `auth.openai.com` (`200`) and `api.openai.com` (`401`), so this is not an IP or ASN block — the provider's bot rules reject the Worker signal specifically. A deployed Container performs the identical request successfully. Making the Worker's request look like something other than a Worker would be detection evasion, not engineering, and was rejected on those grounds.

The protocol translation that turns `/v1/chat/completions` into a Codex `/responses` call lives in `aisubs`' `dist/compatibility.js` (`proxyCompatible`), which is absent from the package `exports` map. It is therefore unreachable from a Worker bundle at all. Most OpenAI-compatible clients call `/chat/completions`, so a Worker-only build would have shipped a surface that fails for the majority of callers.

## Considered options

A pure Worker implementation was built first and abandoned. It bundles and boots — `aisubs` has no native dependencies and its `CredentialStore` interface is swappable — and its Durable-Object-backed credential store worked. It fails only at the last hop, and cannot serve `/chat/completions` at all.

Running `aisubs` on a private host behind a Cloudflare Tunnel was the certain fallback. It was rejected because it reintroduces exactly the always-on machine this work exists to remove.

Storing the rotating credential in Cloudflare Secrets Store was rejected on two independent grounds. A Worker binding exposes only `get()`, so a write requires the REST API and an account-scoped Secrets Store Edit token deployed into the Worker — a credential strictly more dangerous than the one being protected. Separately, OpenAI rotates the refresh token on use, so the value is not a static secret. Secrets Store holds the two long-lived keys (`AISUBS_GATEWAY_KEY`, `AISUBS_EGRESS_KEY`); the rotating credential lives in a Durable Object.

Workers KV was rejected for the credential because `CredentialStore.modify()` is a read-then-write and KV offers no compare-and-swap. A Durable Object provides a real critical section.

## Consequences

Exactly one component may refresh the credential. OpenAI rotates the refresh token on every use, so a second refresher invalidates the first. The container is the sole writer: there is no cron trigger, the Worker never calls `getAccessToken()`, and a local `aisubs dashboard` must not run against the same account once the gateway is seeded. `/admin/credential` is the single manual exception, used once at setup.

Cloudflare edge headers must be stripped before the request leaves our network. `aisubs` forwards unrecognised request headers upstream verbatim, so `cf-connecting-ip`, `cf-ray`, `cdn-loop` and `x-forwarded-*` reached the provider and triggered the bot challenge — visible as `GET /models` succeeding while `POST /chat/completions` returned `403`. The strip lists in `src/index.ts` and `src/container.ts` are load-bearing.

Sign-in cannot happen in the deployment. The browser OAuth flow binds a local callback socket, which neither a Worker nor a headless container can do. Credentials are minted on a workstation and seeded once through `/admin/credential`.

The container is a billed resource, so the design minimises awake time: the gateway key is checked in the Worker before the container is woken, `/health` is answered without waking it, and the instance is the smallest tier with `max_instances: 1` and a short `sleepAfter`. A sleeping container bills nothing.

Routing a consumer subscription through a hosted gateway may conflict with the provider's terms of service. That risk is accepted by the operator, not resolved by this design.
