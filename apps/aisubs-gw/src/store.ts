import { DurableObject } from "cloudflare:workers";
import type { CredentialStore, OAuthCredential, ProviderId } from "aisubs";

/** Storage key prefix so credentials never collide with future DO bookkeeping. */
const PREFIX = "cred:";

const storageKey = (provider: string) => `${PREFIX}${provider}`;

type UpdateFn = (
  current: OAuthCredential | null,
) => OAuthCredential | null | Promise<OAuthCredential | null>;

/**
 * Single-instance Durable Object holding the OAuth credential.
 *
 * aisubs' CredentialStore.modify() is a read-then-write, so it needs
 * compare-and-swap. KV has none. A DO does: one instance runs in one isolate,
 * so an in-memory promise chain gives us a real critical section, and the
 * update callback is invoked *inside* it via RPC. Two concurrent token
 * refreshes therefore serialize instead of racing and clobbering each other.
 */
export class CredentialStoreDO extends DurableObject {
  /** Tail of the critical-section queue. Never rejects, so the chain survives errors. */
  #tail: Promise<void> = Promise.resolve();

  #critical<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async read(provider: string): Promise<OAuthCredential | null> {
    return (await this.ctx.storage.get<OAuthCredential>(storageKey(provider))) ?? null;
  }

  async listKeys(): Promise<string[]> {
    const entries = await this.ctx.storage.list<OAuthCredential>({ prefix: PREFIX });
    return [...entries.keys()].map((key) => key.slice(PREFIX.length));
  }

  /**
   * `update` arrives as a Workers RPC function stub, so the caller's closure
   * runs here, between our read and our write, under the critical section.
   */
  async modify(provider: string, update: UpdateFn): Promise<OAuthCredential | null> {
    return this.#critical(async () => {
      const current = (await this.ctx.storage.get<OAuthCredential>(storageKey(provider))) ?? null;
      const next = await update(current);
      if (next) await this.ctx.storage.put(storageKey(provider), next);
      else await this.ctx.storage.delete(storageKey(provider));
      return next ?? null;
    });
  }

  async remove(provider: string): Promise<void> {
    await this.#critical(async () => {
      await this.ctx.storage.delete(storageKey(provider));
    });
  }

  /** Bootstrap path used by POST /admin/credential. Overwrites unconditionally. */
  async put(provider: string, credential: OAuthCredential): Promise<void> {
    await this.#critical(async () => {
      await this.ctx.storage.put(storageKey(provider), credential);
    });
  }
}

/** Adapts the Durable Object to the aisubs CredentialStore interface. */
export class DurableObjectCredentialStore implements CredentialStore {
  constructor(private readonly stub: DurableObjectStub<CredentialStoreDO>) {}

  read(provider: ProviderId): Promise<OAuthCredential | null> {
    return this.stub.read(provider);
  }

  listKeys(): Promise<string[]> {
    return this.stub.listKeys();
  }

  modify(provider: ProviderId, update: UpdateFn): Promise<OAuthCredential | null> {
    return this.stub.modify(provider, update);
  }

  delete(provider: ProviderId): Promise<void> {
    return this.stub.remove(provider);
  }
}
