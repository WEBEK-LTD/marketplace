import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CMS_MEDIA_DEFAULT_LIMIT,
  CMS_MEDIA_MAX_LIMIT,
  type CmsMediaAttachRequest,
  type CmsMediaEntry,
  type CmsMediaPageResponse,
  type CmsMediaPreviewResponse,
  type CmsMediaUpload,
  type CmsMediaUploadRequest,
  type CmsMediaUsage,
  type CmsMediaUsageResponse,
  type CmsMediaUsageType,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
  type SellerMediaStoragePort,
} from '../sellers/seller-media.storage.js';
import { StaffConsoleService } from './staff-console.service.js';
import { decodeCmsMediaCursor, encodeCmsMediaCursor } from './cms-media.cursor.js';
import type { CmsMediaRefusalCode } from './cms-media.errors.js';
import {
  CmsMediaNotFoundError,
  CmsMediaRefusedError,
  CmsMediaUnavailableError,
} from './cms-media.errors.js';

/**
 * The CMS media library (0098).
 *
 * **Authorization, in the one order it is ever done**, which is this console's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa` rule.
 *      Both roles that hold this key require MFA, so staff at `aal1` hold nothing at all.
 *   4. Every `app_private` function below **re-applies the same test itself**, with the account and the assurance
 *      level as parameters and the key as a **literal**. No bug in this file can turn into somebody putting a file
 *      into the platform's storage.
 *
 * **One key, `cms.media.manage`.** 0033 seeds no `cms.media.read` and none is invented, so whoever can reach this
 * surface may change it — the same shape 0088's vocabularies and 0096's SEO settings have. `canManage` is reported
 * as true for anyone who gets an answer, because there is no second capability for it to distinguish.
 *
 * **One storage client, and it is not this file's.** Every provider call goes through the port Phase 6-E introduced
 * and Phase 7-G extended with `signDownload` — the same port the verification review and the support console already
 * inject for their own private buckets. There is no second client and no second credential path.
 *
 * **The database owns every rule.** Whether the caller may upload, what the object path is, which types and sizes
 * the bucket allows, whether a path may be recorded and where an entry is used are all decided in `app_private`.
 * This service passes the caller's account, orders the two provider calls correctly, shapes the answer, and
 * **checks nothing a second time**.
 *
 * **Failure-safe in both directions.** A signature that cannot be issued is a 503 and no upload; an object that
 * cannot be confirmed present is a 503 or a refusal and never a recorded row. The one ordering that matters is in
 * `confirmUpload`: storage is asked whether the object is there *before* anything is written, so a confirmation for
 * a file nobody uploaded never reaches a write.
 *
 * **Nothing here is read by a public surface** (owner decision 4), and nothing logged below could carry a signed
 * URL or an object path: a signed URL is a bearer credential for one object for a few minutes, and the way to keep
 * one out of a log is to have no line that could take it.
 */

export const CMS_MEDIA_MANAGE = 'cms.media.manage';

export const CMS_MEDIA_STORE = Symbol('CMS_MEDIA_STORE');

/** The bucket this service's objects live in. Named once; every path comes from the database. */
const CMS_MEDIA_BUCKET = 'cms-media';

/** One row of `app_private.cms_media_for_staff` (0098). */
export interface CmsMediaRow {
  readonly mediaId: string;
  readonly objectPath: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly byteSize: number | string;
  readonly altTextEn: string | null;
  readonly altTextAr: string | null;
  readonly usageCount: number | string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

/** One row of `app_private.cms_media_upload_target` or `cms_media_read_target` (0098). */
export interface CmsMediaTargetRow {
  readonly outcome: string;
  readonly bucketId: string | null;
  readonly objectPath: string | null;
  readonly maxByteSize: number | string | null;
}

/** One row of `app_private.cms_media_usage` (0098). */
export interface CmsMediaUsageRow {
  readonly entityType: string;
  readonly entityId: string | null;
  readonly entityLabel: string;
  readonly entityColumn: string;
}

/**
 * One row of `app_private.cms_cover_media_for_staff` (0099): the library entry a page or a post currently
 * has as its cover.
 *
 * It lives here rather than in either content service because both of them read the same shared database
 * function, and one shape for one function is better than two that can drift. It carries a stored object
 * path and never a URL: the `cms-media` bucket is private and nothing on this path is signed.
 */
export interface CmsCoverMediaDbRow {
  readonly mediaId: string;
  readonly objectPath: string;
  readonly altTextEn: string | null;
  readonly altTextAr: string | null;
}

export interface CmsMediaStore {
  cmsMediaUploadTarget(input: {
    userId: string;
    isAal2: boolean;
    contentType: string;
    byteSize: number;
  }): Promise<CmsMediaTargetRow>;

  cmsMediaAttach(input: {
    userId: string;
    isAal2: boolean;
    objectPath: string;
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    altTextEn: string | null;
    altTextAr: string | null;
  }): Promise<{ outcome: string; mediaId: string | null }>;

  cmsMediaForStaff(input: {
    userId: string;
    isAal2: boolean;
    afterCreatedAt: string | null;
    afterId: string | null;
    limit: number;
  }): Promise<readonly CmsMediaRow[]>;

  cmsMediaUsage(input: {
    userId: string;
    isAal2: boolean;
    mediaId: string;
  }): Promise<readonly CmsMediaUsageRow[]>;

  cmsMediaReadTarget(input: {
    userId: string;
    isAal2: boolean;
    mediaId: string;
  }): Promise<{ outcome: string; bucketId: string | null; objectPath: string | null }>;

  cmsMediaAltTextForStaff(input: {
    userId: string;
    isAal2: boolean;
    mediaId: string;
    altTextEn: string | null;
    altTextAr: string | null;
  }): Promise<boolean>;

  cmsMediaDeleteForStaff(input: { userId: string; isAal2: boolean; mediaId: string }): Promise<boolean>;
}

/**
 * The SQLSTATEs a refused write arrives as, each with **our own** code and sentence.
 *
 * The database's text is deliberately not forwarded: a PostgreSQL constraint message is a different kind of value
 * from an API response, and mapping the five characters to a code we control means a change to a constraint's
 * wording cannot change what a browser is shown.
 */
const REFUSALS: ReadonlyMap<string, { readonly code: CmsMediaRefusalCode; readonly detail: string }> = new Map([
  [
    '23514',
    { code: 'CMS_MEDIA_NOT_ALLOWED' as const, detail: 'That is not an allowed value for a media upload.' },
  ],
  [
    '23505',
    { code: 'CMS_MEDIA_PATH_TAKEN' as const, detail: 'That uploaded file already has a library entry.' },
  ],
]);

function sqlstateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

@Injectable()
export class CmsMediaAdminService {
  private readonly logger = new Logger(CmsMediaAdminService.name);

  constructor(
    @Inject(CMS_MEDIA_STORE) private readonly store: CmsMediaStore,
    @Inject(SELLER_MEDIA_STORAGE) private readonly storage: SellerMediaStoragePort,
    private readonly console: StaffConsoleService,
  ) {}

  /** One page of the library, newest first. */
  async list(input: { accessToken: string; cursor: string | null; limit: number | null }): Promise<CmsMediaPageResponse> {
    const staff = await this.#operator(input.accessToken);

    const position = input.cursor === null ? null : decodeCmsMediaCursor(input.cursor);
    // A cursor that does not decode is an absence rather than a validation failure: the value came from a link
    // somebody followed, and the honest answer to a made-up position is that there is nothing at it.
    if (input.cursor !== null && position === null) throw new CmsMediaNotFoundError();

    const limit = Math.min(Math.max(input.limit ?? CMS_MEDIA_DEFAULT_LIMIT, 1), CMS_MEDIA_MAX_LIMIT);

    let rows: readonly CmsMediaRow[];
    try {
      // One more than the page, so "is there another page" is known rather than guessed.
      rows = await this.store.cmsMediaForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        afterCreatedAt: position?.createdAt ?? null,
        afterId: position?.id ?? null,
        limit: limit + 1,
      });
    } catch (error) {
      this.logger.error('The media library could not be read.');
      throw new CmsMediaUnavailableError(error);
    }

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row): CmsMediaEntry => this.#entry(row)),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCmsMediaCursor({ createdAt: toIso(last.createdAt), id: last.mediaId })
          : null,
      // One key: a caller who reached this line holds it, so there is no second capability to report.
      canManage: true,
    };
  }

  /**
   * Authorizes one upload and signs it.
   *
   * The database decides whether the caller may upload at all, what the path is and what the limits are; only then
   * does anything leave this process for the provider, with a path this service did not compose.
   */
  async authorizeUpload(input: { accessToken: string; request: CmsMediaUploadRequest }): Promise<CmsMediaUpload> {
    const staff = await this.#operator(input.accessToken);

    let target: CmsMediaTargetRow;
    try {
      target = await this.store.cmsMediaUploadTarget({
        userId: staff.id,
        isAal2: staff.isAal2,
        contentType: input.request.contentType,
        byteSize: input.request.byteSize,
      });
    } catch (error) {
      this.logger.error('A media upload could not be authorized.');
      throw new CmsMediaUnavailableError(error);
    }

    if (target.outcome === 'not_found') throw new CmsMediaNotFoundError();
    if (target.outcome === 'invalid') {
      throw new CmsMediaRefusedError('CMS_MEDIA_NOT_ALLOWED', 'That is not an allowed value for a media upload.');
    }
    if (target.outcome !== 'authorized') {
      this.logger.error('An upload authorization returned an outcome this service does not understand.');
      throw new CmsMediaUnavailableError(new Error('unexpected outcome'));
    }
    if (target.bucketId === null || target.objectPath === null || target.maxByteSize === null) {
      this.logger.error('An authorized upload came back without its target.');
      throw new CmsMediaUnavailableError(new Error('incomplete upload target'));
    }

    let signed: Awaited<ReturnType<SellerMediaStoragePort['signUpload']>>;
    try {
      signed = await this.storage.signUpload(target.bucketId, target.objectPath, input.request.contentType);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('Signing a media upload failed.');
      }
      // Failure-safe: no signature means no upload, never an upload nobody authorized.
      throw new CmsMediaUnavailableError(error);
    }

    return {
      uploadUrl: signed.uploadUrl,
      objectPath: target.objectPath,
      expiresAt: signed.expiresAt.toISOString(),
      maxByteSize: toNumber(target.maxByteSize),
    };
  }

  /**
   * Confirms an upload that happened, and records it.
   *
   * **The object is checked first, and that ordering is the point.** Asking storage before anything is written means
   * a confirmation for a file nobody uploaded never reaches a write, so the library cannot come to hold a row
   * pointing at nothing. The database then re-checks the path's whole shape regardless of what storage said.
   */
  async confirmUpload(input: { accessToken: string; request: CmsMediaAttachRequest }): Promise<string> {
    const staff = await this.#operator(input.accessToken);

    let exists: boolean;
    try {
      exists = await this.storage.objectExists(CMS_MEDIA_BUCKET, input.request.objectPath);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('Checking an uploaded media object failed.');
      }
      throw new CmsMediaUnavailableError(error);
    }
    if (!exists) {
      throw new CmsMediaRefusedError(
        'CMS_MEDIA_OBJECT_MISSING',
        'No uploaded file was found at that location.',
      );
    }

    const result = await this.#write(async () =>
      this.store.cmsMediaAttach({
        userId: staff.id,
        isAal2: staff.isAal2,
        objectPath: input.request.objectPath,
        mimeType: input.request.contentType,
        byteSize: input.request.byteSize,
        width: input.request.width ?? null,
        height: input.request.height ?? null,
        altTextEn: input.request.altTextEn ?? null,
        altTextAr: input.request.altTextAr ?? null,
      }),
    );

    if (result.outcome === 'not_found') throw new CmsMediaNotFoundError();
    if (result.outcome === 'taken') {
      throw new CmsMediaRefusedError('CMS_MEDIA_PATH_TAKEN', 'That uploaded file already has a library entry.');
    }
    if (result.outcome === 'invalid') {
      throw new CmsMediaRefusedError('CMS_MEDIA_NOT_ALLOWED', 'That is not an allowed value for a media upload.');
    }
    if (result.outcome !== 'attached' || result.mediaId === null) {
      this.logger.error('A recorded media object came back without its identifier.');
      throw new CmsMediaUnavailableError(new Error('incomplete attach result'));
    }
    return result.mediaId;
  }

  /** Every CMS row that points at one entry, which a console shows before offering to delete it. */
  async usage(input: { accessToken: string; mediaId: string }): Promise<CmsMediaUsageResponse> {
    const staff = await this.#operator(input.accessToken);

    let rows: readonly CmsMediaUsageRow[];
    try {
      rows = await this.store.cmsMediaUsage({
        userId: staff.id,
        isAal2: staff.isAal2,
        mediaId: input.mediaId,
      });
    } catch (error) {
      this.logger.error('The references to a media entry could not be read.');
      throw new CmsMediaUnavailableError(error);
    }

    return {
      id: input.mediaId,
      references: rows.map(
        (row): CmsMediaUsage => ({
          entityType: row.entityType as CmsMediaUsageType,
          entityId: row.entityId,
          label: row.entityLabel,
          column: row.entityColumn,
        }),
      ),
    };
  }

  /** A short-lived signed URL for exactly the object one entry stores. */
  async preview(input: { accessToken: string; mediaId: string }): Promise<CmsMediaPreviewResponse> {
    const staff = await this.#operator(input.accessToken);

    let target: { outcome: string; bucketId: string | null; objectPath: string | null };
    try {
      target = await this.store.cmsMediaReadTarget({
        userId: staff.id,
        isAal2: staff.isAal2,
        mediaId: input.mediaId,
      });
    } catch (error) {
      this.logger.error('A media preview target could not be located.');
      throw new CmsMediaUnavailableError(error);
    }

    if (target.outcome !== 'authorized') throw new CmsMediaNotFoundError();
    if (target.bucketId === null || target.objectPath === null) {
      this.logger.error('An authorized media preview came back without its location.');
      throw new CmsMediaUnavailableError(new Error('incomplete preview target'));
    }

    let signed: Awaited<ReturnType<SellerMediaStoragePort['signDownload']>>;
    try {
      signed = await this.storage.signDownload(target.bucketId, target.objectPath);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('Signing a media preview read failed.');
      }
      throw new CmsMediaUnavailableError(error);
    }

    return { id: input.mediaId, url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  /** Replaces one entry's two alt texts. Neither is required. */
  async saveAltText(input: {
    accessToken: string;
    mediaId: string;
    altTextEn: string | null;
    altTextAr: string | null;
  }): Promise<void> {
    const staff = await this.#operator(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.cmsMediaAltTextForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        mediaId: input.mediaId,
        altTextEn: input.altTextEn,
        altTextAr: input.altTextAr,
      }),
    );
    if (!changed) throw new CmsMediaNotFoundError();
  }

  /**
   * Removes one entry from the library.
   *
   * Every reference to it becomes null through 0030's own foreign keys and through nothing else; the console shows
   * those references first. The stored object stays in the private bucket and becomes unreachable, because a signed
   * read is only ever issued for an object an entry still points at.
   */
  async remove(input: { accessToken: string; mediaId: string }): Promise<void> {
    const staff = await this.#operator(input.accessToken);
    const deleted = await this.#write(async () =>
      this.store.cmsMediaDeleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        mediaId: input.mediaId,
      }),
    );
    if (!deleted) throw new CmsMediaNotFoundError();
  }

  /* ---------------------------------------------------------------------------------------------- */

  #entry(row: CmsMediaRow): CmsMediaEntry {
    return {
      id: row.mediaId,
      objectPath: row.objectPath,
      contentType: row.mimeType,
      width: row.width,
      height: row.height,
      byteSize: toNumber(row.byteSize),
      altTextEn: row.altTextEn,
      altTextAr: row.altTextAr,
      usageCount: toNumber(row.usageCount),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  /**
   * Runs a write and sorts its failures.
   *
   * `42501` is the database refusing a caller who does not hold `cms.media.manage`. It becomes a 404 rather than a
   * 403, which keeps this surface's one rule: a refusal and an absence look alike.
   */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new CmsMediaNotFoundError();
      const refusal = sqlstate === null ? undefined : REFUSALS.get(sqlstate);
      if (refusal !== undefined) throw new CmsMediaRefusedError(refusal.code, refusal.detail);
      this.logger.error('A media library write failed.');
      throw new CmsMediaUnavailableError(error);
    }
  }

  async #operator(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(CMS_MEDIA_MANAGE)) throw new CmsMediaNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
