import { Logger } from '@nestjs/common';

/**
 * The storage side of seller media (Phase 6-E).
 *
 * Phase 7-G added a third call to the same port — one that signs a *read* of a single object path, for the
 * reviewer surface — and nothing else about this module changed.
 *
 * **Why this is a port.** Provider calls stand between the database's authorization and the browser: one
 * that signs an upload for a single object path, one that says whether an object is there, and one that
 * signs a read of one object.
 * Everything else in 6-E — who may upload, where, of what type and size, and what may then be recorded — is
 * decided in `app_private` and is fully verifiable here. These two calls are not: they are Supabase Storage's
 * HTTP surface, and this project's standing rule is that no provider behaviour is asserted from memory and no
 * provider is exercised outside Final QA.
 *
 * So the interface below is the contract the rest of the API depends on, and {@link SupabaseStorageClient} is
 * the one adapter that speaks to the provider — exactly the shape {@link SupabaseAuthClient} already has for
 * Supabase Auth, which is hand-rolled for the same reason (this project carries no Supabase client library).
 * Every test in this increment drives the port, so the logic is proven independently of the provider; the
 * adapter's three URLs and the field names it reads are the single thing Final QA must confirm against the
 * live service, and they are listed in the increment report as such.
 *
 * **The adapter parses defensively rather than confidently.** It accepts the documented `url` field and the
 * `signedUrl`/`signedURL` spellings the Storage API has used, requires the result to be a usable URL, and
 * refuses anything else as unavailable. A wrong guess therefore fails closed — a 503 and no upload — rather
 * than handing a browser a URL that goes nowhere.
 *
 * **Nothing here is logged.** A signed URL is a bearer credential for one object for a few minutes, and the
 * way to keep one out of a log is to have no line that could take it. The error lines below carry a status at
 * most; never a URL, never a path, never the project key.
 */

/** What a signed upload authorization is, once the provider has issued it. */
export interface SignedUpload {
  /** Absolute, opaque, short-lived, and bound to the one object path it was issued for. */
  readonly uploadUrl: string;
  readonly expiresAt: Date;
}

/** What a signed read authorization is, once the provider has issued it. */
export interface SignedDownload {
  /** Absolute, opaque, short-lived, and bound to the one object path it was issued for. */
  readonly url: string;
  readonly expiresAt: Date;
}

export interface SellerMediaStoragePort {
  /** Signs one upload to `objectPath` inside `bucket`. Throws when the provider cannot be used. */
  signUpload(bucket: string, objectPath: string, contentType: string): Promise<SignedUpload>;
  /** Whether that object is now in the bucket. Throws when the provider cannot be asked. */
  objectExists(bucket: string, objectPath: string): Promise<boolean>;
  /**
   * Signs one read of `objectPath` inside `bucket` (Phase 7-G).
   *
   * **Why this exists, and why it is on this port rather than on a new one.** 6-E's two calls are an
   * upload authorization and an existence check; neither can show a reviewer a private document, and
   * 7-G's approved scope requires exactly that. The instruction was to reuse the existing storage model
   * if it has a reader and to add the minimum server-side one if it does not — it did not. So this is
   * one more method on the same port, served by the same adapter, against the same provider surface,
   * with the same credential handling and the same failure mode. There is no second storage client.
   *
   * **It is not an ambient capability.** The path is never composed here and never supplied by a
   * browser: it comes out of the database row that the reviewer's request named, so a signed read is
   * always for the one object that row points at. The bucket stays private; this issues a URL for a
   * single object and a few minutes, and nothing else in the system changes.
   */
  signDownload(bucket: string, objectPath: string): Promise<SignedDownload>;
}

export const SELLER_MEDIA_STORAGE = Symbol('SELLER_MEDIA_STORAGE');

/** Raised when the provider could not be reached, or answered in a way this client does not understand. */
export class SellerMediaStorageUnavailableError extends Error {
  constructor(override readonly cause: unknown) {
    super('The storage service is temporarily unavailable.');
    this.name = 'SellerMediaStorageUnavailableError';
  }
}

export interface SupabaseStorageConfig {
  readonly url: string;
  readonly secretKey: string;
  readonly fetch?: typeof fetch;
  /** Milliseconds before a provider call is abandoned. A hung provider must not hang a request. */
  readonly timeoutMs?: number;
  /** How long an authorization is valid for. The provider's own default is used if it disagrees. */
  readonly expirySeconds?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_EXPIRY_SECONDS = 120;

/** The one place a signed URL can be read out of a provider body, written once. */
function readSignedUrl(body: unknown, base: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as Record<string, unknown>;
  // The documented field, plus the two spellings the Storage API has used for a signed URL.
  for (const key of ['url', 'signedUrl', 'signedURL']) {
    const value = candidate[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const raw = value.trim();
    try {
      // An absolute URL is taken as it is. A relative one is resolved against the storage base — and any
      // leading slash is dropped first, because `new URL('/object/…', 'https://host/storage/v1/')` resolves
      // against the *origin* and would silently lose the `/storage/v1` prefix. The provider has returned this
      // field both ways; both have to arrive at the same URL.
      if (/^https?:\/\//i.test(raw)) return new URL(raw).toString();
      return new URL(raw.replace(/^\/+/, ''), base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

export class SupabaseStorageClient implements SellerMediaStoragePort {
  private readonly logger = new Logger(SupabaseStorageClient.name);
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly expirySeconds: number;

  constructor(private readonly config: SupabaseStorageConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.expirySeconds = config.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
  }

  /**
   * Signs one upload.
   *
   * The object path is the database's, already validated and already inside the caller's namespace; this
   * method encodes each segment and never builds a path of its own.
   */
  async signUpload(bucket: string, objectPath: string, contentType: string): Promise<SignedUpload> {
    const base = `${this.config.url}/storage/v1`;
    const target = `${base}/object/upload/sign/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`;

    const body = await this.call(target, {
      method: 'POST',
      body: JSON.stringify({ expiresIn: this.expirySeconds, contentType }),
    });

    const uploadUrl = readSignedUrl(body, `${base}/`);
    if (uploadUrl === null) {
      this.logger.error('Supabase Storage returned an upload authorization this client does not understand.');
      throw new SellerMediaStorageUnavailableError(new Error('unexpected provider payload'));
    }
    return { uploadUrl, expiresAt: new Date(Date.now() + this.expirySeconds * 1000) };
  }

  /**
   * Signs one read (Phase 7-G).
   *
   * The same `POST` shape as {@link signUpload} against Storage's own signing endpoint for reads, and
   * the same defensive parse: the documented field plus the two spellings the Storage API has used,
   * resolved against the storage base when it comes back relative. A shape this client does not
   * understand is unavailable — a reviewer sees "could not be loaded" rather than a broken link.
   */
  async signDownload(bucket: string, objectPath: string): Promise<SignedDownload> {
    const base = `${this.config.url}/storage/v1`;
    const target = `${base}/object/sign/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`;

    const body = await this.call(target, {
      method: 'POST',
      body: JSON.stringify({ expiresIn: this.expirySeconds }),
    });

    const url = readSignedUrl(body, `${base}/`);
    if (url === null) {
      this.logger.error('Supabase Storage returned a read authorization this client does not understand.');
      throw new SellerMediaStorageUnavailableError(new Error('unexpected provider payload'));
    }
    return { url, expiresAt: new Date(Date.now() + this.expirySeconds * 1000) };
  }

  /** Whether the object is there. A 404 is an answer, not a failure. */
  async objectExists(bucket: string, objectPath: string): Promise<boolean> {
    const target = `${this.config.url}/storage/v1/object/info/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch (error) {
      // The message is ours, not the provider's: an error string from fetch can contain the URL.
      this.logger.error('Supabase Storage could not be reached.');
      throw new SellerMediaStorageUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }

    await response.text().catch(() => '');
    if (response.status === 404) return false;
    if (!response.ok) {
      this.logger.error(`Supabase Storage answered ${response.status}.`);
      throw new SellerMediaStorageUnavailableError(new Error(`provider status ${response.status}`));
    }
    return true;
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.config.secretKey,
      authorization: `Bearer ${this.config.secretKey}`,
      'content-type': 'application/json',
    };
  }

  private async call(target: string, init: { method: string; body?: string }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: init.method,
        headers: this.headers(),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error('Supabase Storage could not be reached.');
      throw new SellerMediaStorageUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      await response.text().catch(() => '');
      this.logger.error(`Supabase Storage answered ${response.status}.`);
      throw new SellerMediaStorageUnavailableError(new Error(`provider status ${response.status}`));
    }

    try {
      return await response.json();
    } catch (error) {
      throw new SellerMediaStorageUnavailableError(error);
    }
  }
}

/** Encodes each path segment, keeping the separators the storage API expects. */
function encodePath(objectPath: string): string {
  return objectPath.split('/').map(encodeURIComponent).join('/');
}
