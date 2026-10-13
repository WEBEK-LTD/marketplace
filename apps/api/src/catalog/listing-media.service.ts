import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ListingMediaAttachRequest,
  ListingMediaItem,
  ListingMediaUploadRequest,
  ListingMediaUploadTarget,
} from '@repo/contracts';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
  type SellerMediaStoragePort,
} from '../sellers/seller-media.storage.js';
import { MEDIA_PUBLIC_ORIGIN, publicObjectUrl } from './listing-images.js';

/**
 * Attaching, ordering and withdrawing a listing's photographs (increment 0116, migration 0114).
 *
 * **Every authorization decision is the database's.** `app_private.listing_media_can_manage` decides who may
 * touch a listing's photographs — its own seller while the storefront is pending or active, or staff holding
 * `catalog.listing.moderate` at AAL2 — and every function below calls it first. This service passes the
 * caller's identifier and their assurance level, forwards the outcome as the approved problem, and decides
 * nothing: it composes no object path, checks no size limit a second time, and has no branch that could let a
 * caller through on its own say-so.
 *
 * **The browser never names a destination.** An authorization request carries a variant key, a content type
 * and a byte size; the path comes back from the database, derived from the listing's own identifier, and the
 * confirmation sends that path back. `listing_media_attach` then re-derives the prefix each key belongs to and
 * refuses a path outside it, so a caller that edited one is refused by the same function that would have
 * stored it.
 *
 * **The storage client is the one that already exists.** 6-E's port signs an upload to one object path and
 * says whether an object arrived; that is exactly what this needs, and {@link SellerMediaStoragePort}'s own
 * note records the rule that there is no second storage client. Its name is 6-E's; its job is this project's.
 *
 * **A confirmation is refused for an object that is not there.** Four objects are checked before anything is
 * written, because a `listing_media` row pointing at bytes nobody uploaded is a card that renders a broken
 * image — and the existence check is what 6-E learned to do for exactly that reason.
 *
 * **Nothing here is logged but a verb.** A signed URL is a bearer credential for one object; an object path
 * names somebody's listing. No line below can take either.
 */

/** One row of `app_private.listing_media_for_manager(uuid, uuid, boolean)`. */
export interface ListingMediaManagerRow {
  readonly mediaId: string;
  readonly mediaPosition: number;
  readonly isPrimary: boolean;
  readonly status: string;
  readonly variantKey: string;
  readonly objectPath: string;
  readonly width: number;
  readonly height: number;
  /** Whether this variant is published. A draft's are not. */
  readonly isPublic: boolean;
}

export interface ListingMediaTargetResult {
  readonly outcome: string;
  readonly bucketId: string | null;
  readonly objectPath: string | null;
  readonly maxByteSize: number | null;
}

export interface ListingMediaWriteStore {
  /**
   * `app_private.listing_media_resolve(uuid, text, boolean)` (0114): a slug to the identifier the other five
   * functions take — null unless this caller may manage that listing's photographs.
   */
  listingMediaResolve(input: { userId: string; slug: string; isAal2: boolean }): Promise<string | null>;
  /** `app_private.listing_media_upload_target(...)` (0114). */
  listingMediaUploadTarget(input: {
    userId: string;
    listingId: string;
    variantKey: string;
    contentType: string;
    byteSize: number;
    isAal2: boolean;
  }): Promise<ListingMediaTargetResult>;
  /** `app_private.listing_media_attach(...)` (0114). */
  listingMediaAttach(input: {
    userId: string;
    listingId: string;
    variants: readonly {
      variantKey: string;
      objectPath: string;
      width: number;
      height: number;
      byteSize: number;
    }[];
    isAal2: boolean;
  }): Promise<{ outcome: string; mediaId: string | null }>;
  /**
   * `app_private.listing_media_withdraw(...)` (0114). False for a caller who may not, and for a photograph
   * that is not there — one answer, deliberately, so neither can be told from the other.
   */
  listingMediaWithdraw(input: {
    userId: string;
    listingId: string;
    mediaId: string;
    isAal2: boolean;
  }): Promise<boolean>;
  /** `app_private.listing_media_set_primary(...)` (0114). False on the same two cases. */
  listingMediaSetPrimary(input: {
    userId: string;
    listingId: string;
    mediaId: string;
    isAal2: boolean;
  }): Promise<boolean>;
  /** `app_private.listing_media_for_manager(...)` (0114). */
  listingMediaForManager(input: {
    userId: string;
    listingId: string;
    isAal2: boolean;
  }): Promise<readonly ListingMediaManagerRow[]>;
}

export const LISTING_MEDIA_WRITE_STORE = Symbol('LISTING_MEDIA_WRITE_STORE');

/** The listing is not one this caller may manage photographs for — or does not exist. Identical answers. */
export class ListingMediaNotFoundError extends Error {
  readonly problem = { status: 404, code: 'NOT_FOUND' } as const;

  constructor() {
    super('The requested resource was not found.');
    this.name = 'ListingMediaNotFoundError';
  }
}

/** The request named something the database would not accept. Which field is the strict contract's business. */
export class ListingMediaInvalidError extends Error {
  readonly problem = { status: 422, code: 'VALIDATION_FAILED' } as const;

  constructor() {
    super('The request is invalid.');
    this.name = 'ListingMediaInvalidError';
  }
}

/**
 * A confirmation for bytes that are not in the bucket.
 *
 * 409 and its own code, as 0030's library reports the same thing: the remedy is specific — upload the bytes
 * and confirm again — and a generic conflict would leave a client guessing which of four objects was missing.
 * Nothing says which one, because that is the client's own list.
 */
export class ListingMediaObjectMissingError extends Error {
  readonly problem = { status: 409, code: 'LISTING_MEDIA_OBJECT_MISSING' } as const;

  constructor() {
    super('The upload could not be confirmed.');
    this.name = 'ListingMediaObjectMissingError';
  }
}

/** The photographs could not be read or written. */
export class ListingMediaUnavailableError extends Error {
  readonly problem = { status: 503, code: 'SERVICE_UNAVAILABLE' } as const;

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'ListingMediaUnavailableError';
  }
}

export interface ListingMediaCaller {
  readonly userId: string;
  readonly isAal2: boolean;
}

@Injectable()
export class ListingMediaService {
  private readonly logger = new Logger(ListingMediaService.name);

  constructor(
    @Inject(LISTING_MEDIA_WRITE_STORE) private readonly store: ListingMediaWriteStore,
    @Inject(SELLER_MEDIA_STORAGE) private readonly storage: SellerMediaStoragePort,
    @Inject(MEDIA_PUBLIC_ORIGIN) private readonly origin: string,
  ) {}

  /**
   * One listing's identifier, from the slug every surface addresses it by.
   *
   * **A 404 here is the only refusal most of these routes need.** The resolver's predicate is the same
   * `listing_media_can_manage` every function below applies, so a slug belonging to somebody else and a slug
   * that does not exist both arrive as null and both leave as the same not-found. Nothing downstream has to
   * repeat the check, and nothing above it ever sees a listing identifier.
   */
  async resolve(caller: ListingMediaCaller, slug: string): Promise<string> {
    let listingId: string | null;
    try {
      listingId = await this.store.listingMediaResolve({
        userId: caller.userId,
        slug,
        isAal2: caller.isAal2,
      });
    } catch (error) {
      this.logger.error('A listing could not be resolved for its photographs.');
      throw new ListingMediaUnavailableError(error);
    }
    if (listingId === null) throw new ListingMediaNotFoundError();
    return listingId;
  }

  /**
   * Authorizes the four objects of one photograph, and signs them.
   *
   * Four calls to the authorizer rather than one, because the database's function authorizes one object: each
   * answers for its own key, its own bucket and its own ceiling. The first refusal ends it — a photograph with
   * three authorized objects is nothing anybody can use, and signing the rest would leave four minutes of
   * credentials lying around for an upload that cannot be confirmed.
   */
  async authorizeUpload(
    caller: ListingMediaCaller,
    listingId: string,
    request: ListingMediaUploadRequest,
  ): Promise<readonly ListingMediaUploadTarget[]> {
    const targets: ListingMediaUploadTarget[] = [];

    for (const item of request.variants) {
      let target: ListingMediaTargetResult;
      try {
        target = await this.store.listingMediaUploadTarget({
          userId: caller.userId,
          listingId,
          variantKey: item.variantKey,
          contentType: item.contentType,
          byteSize: item.byteSize,
          isAal2: caller.isAal2,
        });
      } catch (error) {
        this.logger.error('A listing photograph upload could not be authorized.');
        throw new ListingMediaUnavailableError(error);
      }

      this.#assert(target.outcome, 'authorized');
      if (target.bucketId === null || target.objectPath === null || target.maxByteSize === null) {
        this.logger.error('An authorized upload came back without its target.');
        throw new ListingMediaUnavailableError(new Error('incomplete upload target'));
      }

      let signed: Awaited<ReturnType<SellerMediaStoragePort['signUpload']>>;
      try {
        signed = await this.storage.signUpload(target.bucketId, target.objectPath, item.contentType);
      } catch (error) {
        if (!(error instanceof SellerMediaStorageUnavailableError)) {
          this.logger.error('Signing a listing photograph upload failed.');
        }
        throw new ListingMediaUnavailableError(error);
      }

      targets.push({
        variantKey: item.variantKey,
        uploadUrl: signed.uploadUrl,
        objectPath: target.objectPath,
        expiresAt: signed.expiresAt.toISOString(),
        maxByteSize: target.maxByteSize,
      });
    }

    return targets;
  }

  /** Confirms the four uploads and records them as one photograph. */
  async confirmUpload(
    caller: ListingMediaCaller,
    listingId: string,
    request: ListingMediaAttachRequest,
  ): Promise<{ attachedId: string; items: readonly ListingMediaItem[] }> {
    // All four objects, before anything is written. The bucket each one belongs to is the key's, exactly as
    // the authorizer decided it — this derives nothing, it reads the same rule the contract documents.
    for (const item of request.variants) {
      const bucket = item.variantKey === 'original' ? 'listing-originals' : 'listing-variants';
      // Outside the `try`, deliberately. `#withinBucket` refuses a path that is not under the bucket its key
      // belongs to, and that is a 422 about the request — inside the block it was caught by the handler below
      // and reported as a 503, so a caller that edited one path was told the service was down.
      const withinBucket = this.#withinBucket(bucket, item.objectPath);

      let exists: boolean;
      try {
        exists = await this.storage.objectExists(bucket, withinBucket);
      } catch (error) {
        throw new ListingMediaUnavailableError(error);
      }
      if (!exists) throw new ListingMediaObjectMissingError();
    }

    let result: { outcome: string; mediaId: string | null };
    try {
      result = await this.store.listingMediaAttach({
        userId: caller.userId,
        listingId,
        variants: request.variants.map((item) => ({
          variantKey: item.variantKey,
          objectPath: item.objectPath,
          width: item.width,
          height: item.height,
          byteSize: item.byteSize,
        })),
        isAal2: caller.isAal2,
      });
    } catch (error) {
      this.logger.error('A listing photograph could not be recorded.');
      throw new ListingMediaUnavailableError(error);
    }

    this.#assert(result.outcome, 'attached');
    if (result.mediaId === null) {
      this.logger.error('A recorded photograph came back without its identifier.');
      throw new ListingMediaUnavailableError(new Error('incomplete attach result'));
    }

    return { attachedId: result.mediaId, items: await this.list(caller, listingId) };
  }

  /** Withdraws one photograph. The database promotes the next one if this was the primary. */
  async withdraw(
    caller: ListingMediaCaller,
    listingId: string,
    mediaId: string,
  ): Promise<readonly ListingMediaItem[]> {
    let done: boolean;
    try {
      done = await this.store.listingMediaWithdraw({
        userId: caller.userId,
        listingId,
        mediaId,
        isAal2: caller.isAal2,
      });
    } catch (error) {
      this.logger.error('A listing photograph could not be withdrawn.');
      throw new ListingMediaUnavailableError(error);
    }
    if (!done) throw new ListingMediaNotFoundError();
    return this.list(caller, listingId);
  }

  /** Makes one photograph the one the card shows. */
  async setPrimary(
    caller: ListingMediaCaller,
    listingId: string,
    mediaId: string,
  ): Promise<readonly ListingMediaItem[]> {
    let done: boolean;
    try {
      done = await this.store.listingMediaSetPrimary({
        userId: caller.userId,
        listingId,
        mediaId,
        isAal2: caller.isAal2,
      });
    } catch (error) {
      this.logger.error('A listing photograph could not be made primary.');
      throw new ListingMediaUnavailableError(error);
    }
    if (!done) throw new ListingMediaNotFoundError();
    return this.list(caller, listingId);
  }

  /**
   * One listing's photographs, for whoever may manage them.
   *
   * **No rows is not an error, and it is not a refusal either.** The reader's predicate is the authorizer, so
   * a caller who may not manage this listing gets the same empty list as a listing with no photographs. That
   * is the shape 0114 chose deliberately — a predicate rather than an exception — and the surfaces above it
   * are screens a seller reaches from their own listing, so the distinction costs nothing there.
   */
  async list(caller: ListingMediaCaller, listingId: string): Promise<readonly ListingMediaItem[]> {
    let rows: readonly ListingMediaManagerRow[];
    try {
      rows = await this.store.listingMediaForManager({
        userId: caller.userId,
        listingId,
        isAal2: caller.isAal2,
      });
    } catch (error) {
      this.logger.error("A listing's photographs could not be read.");
      throw new ListingMediaUnavailableError(error);
    }
    return this.#group(rows);
  }

  /**
   * Rows into photographs.
   *
   * The reader orders by position, then id, then width, so one photograph's rows arrive together with its
   * variants smallest first; this keeps that order. A variant key outside the three served sizes cannot
   * appear — the original is not a `media_variants` row — and one that somehow did is dropped rather than
   * carried into a contract whose enum names three.
   */
  #group(rows: readonly ListingMediaManagerRow[]): readonly ListingMediaItem[] {
    const items: ListingMediaItem[] = [];
    const index = new Map<string, number>();

    for (const row of rows) {
      if (row.variantKey !== 'thumb' && row.variantKey !== 'card' && row.variantKey !== 'full') continue;

      let at = index.get(row.mediaId);
      if (at === undefined) {
        at = items.length;
        index.set(row.mediaId, at);
        items.push({
          id: row.mediaId,
          position: row.mediaPosition,
          isPrimary: row.isPrimary,
          status: this.#status(row.status),
          // A photograph is published when its variants are. They are set together, so the first one answers.
          isPublished: row.isPublic,
          variants: [],
        });
      }

      items[at]!.variants.push({
        key: row.variantKey,
        url: publicObjectUrl(this.origin, row.objectPath),
        width: row.width,
        height: row.height,
      });
    }

    return items;
  }

  /** 0011's own four statuses. Anything else is a row this release did not write. */
  #status(value: string): ListingMediaItem['status'] {
    return value === 'pending' || value === 'processing' || value === 'ready' || value === 'failed'
      ? value
      : 'failed';
  }

  /**
   * Strips the bucket prefix the database put on the path, for a port whose calls take the two separately.
   *
   * `media_variants.object_path` carries the bucket name as its first segment, because a stored path that
   * names its own bucket is a path a reader can resolve without being told which one it came from. The
   * storage port takes a bucket and a path inside it, so one of the two has to give — and it is this, at the
   * one call site, rather than storing a path that means nothing on its own.
   *
   * A path that does not start with the bucket it should is refused here rather than asked about: the
   * database's own confirmation would refuse it too, and asking storage first would mean an existence check
   * against a path nobody authorized.
   */
  #withinBucket(bucket: string, objectPath: string): string {
    const prefix = `${bucket}/`;
    if (!objectPath.startsWith(prefix)) throw new ListingMediaInvalidError();
    return objectPath.slice(prefix.length);
  }

  /**
   * The refusals the two table-returning functions share.
   *
   * `not_found` and `invalid` are both answers a caller gets rather than reasons they are told: the first is
   * the same 404 a listing that does not exist gets, which is what keeps this from being a way to ask whether
   * somebody else's listing is there, and the second names no field because the strict contract already told
   * an honest client which one.
   *
   * `withdraw` and `set_primary` return a boolean rather than an outcome and are handled where they are
   * called — a false from either means exactly the same two things as `not_found`.
   */
  #assert(outcome: string, success: 'authorized' | 'attached'): void {
    if (outcome === success) return;
    if (outcome === 'not_found') throw new ListingMediaNotFoundError();
    if (outcome === 'invalid') throw new ListingMediaInvalidError();
    this.logger.error('A listing photograph operation returned an outcome this service does not understand.');
    throw new ListingMediaUnavailableError(new Error('unexpected outcome'));
  }
}
