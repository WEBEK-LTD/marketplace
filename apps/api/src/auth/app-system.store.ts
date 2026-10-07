import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { AddressInput, CatalogFilters, UpdateBuyerSettingsRequest } from '@repo/contracts';
import { createDatabase, type Database } from '@repo/db';
import { type Kysely, sql } from 'kysely';
import type { AuthSecurityEvent, AuthSecurityEventStore } from './auth-security-events.service.js';
import type { LoginAttempt, LoginEnforcementStore } from './login-enforcement.service.js';
import type { ThrottleCounter } from './login-throttle.service.js';
import type { CategoryDetailRow, CategoryRow, CategoryStore } from '../catalog/categories.service.js';
import type { CategoryFacetRow, CategoryFeedPort } from '../catalog/category-feed.service.js';
import type {
  CmsPageDetailDbRow,
  CmsPageListDbRow,
  CmsPageTranslationDbRow,
  CmsPagesStore,
} from '../admin/cms-pages.service.js';
import type {
  CmsPublicStore,
  PublicCmsPageDbRow,
  PublicCmsPageLinkDbRow,
} from '../cms/cms-pages.service.js';
import type {
  BlogPublicStore,
  PublicBlogPostDbRow,
  PublicBlogPostListDbRow,
  PublicBlogTaxonomyDbRow,
} from '../cms/blog-public.service.js';
import type {
  BlogCategoryDbRow,
  BlogPostDetailDbRow,
  BlogPostListDbRow,
  BlogPostTranslationDbRow,
  BlogStore,
  BlogTagDbRow,
} from '../admin/blog.service.js';
import type {
  HomepageCategoryDbRow,
  HomepageListingDbRow,
  HomepagePostDbRow,
  HomepagePublicStore,
  HomepageSellerDbRow,
  PublicHomepageSectionDbRow,
} from '../cms/homepage-public.service.js';
import type {
  HomepageSectionDetailDbRow,
  HomepageSectionListDbRow,
  HomepageStore,
} from '../admin/homepage.service.js';
import type {
  NavigationPublicStore,
  PublicNavigationItemDbRow,
} from '../cms/navigation-public.service.js';
import type { FaqsPublicStore, PublicFaqDbRow } from '../cms/faqs-public.service.js';
import type {
  FaqDetailDbRow,
  FaqListDbRow,
  FaqTopicDbRow,
  FaqsStore,
} from '../admin/faqs.service.js';
import type { SeoSettingsDbRow, SeoSettingsStore } from '../admin/seo-settings.service.js';
import type {
  CmsCoverMediaDbRow,
  CmsMediaRow,
  CmsMediaStore,
  CmsMediaTargetRow,
  CmsMediaUsageRow,
} from '../admin/cms-media.service.js';
import type {
  NavigationItemDbRow,
  NavigationMenuDetailDbRow,
  NavigationMenuListDbRow,
  NavigationStore,
} from '../admin/navigation.service.js';
import type {
  RedirectResolutionRow,
  RobotsBodyRow,
  SeoStore,
  SitemapCountRow,
  SitemapEntryRow,
} from '../seo/seo.service.js';
import type {
  SeoRedirectDetailDbRow,
  SeoRedirectListDbRow,
  SeoRedirectsStore,
} from '../admin/seo-redirects.service.js';
import type {
  PublicSeoMetadataDbRow,
  SeoMetadataDetailDbRow,
  SeoMetadataListDbRow,
  SeoMetadataStore,
} from '../admin/seo-metadata.service.js';
import type {
  CategoriesStore,
  CategoryDetailDbRow,
  CategoryNodeDbRow,
  CategoryTranslationDbRow,
} from '../admin/categories.service.js';
import type {
  AttributeDefinitionDbRow,
  AttributeOptionDbRow,
  AttributesStore,
  CategoryAttributeDbRow,
  TagDbRow,
} from '../admin/attributes.service.js';
import type {
  SellerAttributeAnswerPayload,
  SellerListingAttributeOptionRow,
  SellerListingAttributeRow,
  SellerListingTagChoiceRow,
  SellerVocabularyContextRow,
  SellerVocabularyStore,
  SellerVocabularyWriteResult,
} from '../sellers/seller-vocabulary.service.js';
import type { ListingDetailRow, ListingRow, ListingStore } from '../catalog/listings.service.js';
import type { ServiceDetailRow, ServiceRow, ServiceStore } from '../catalog/services.service.js';
import type { SellerProfileRow, SellerStore } from '../catalog/sellers.service.js';
import type { SellerIdentityRow, SellerIdentityStore } from '../sellers/seller-identity.service.js';
import type {
  SellerCreateProfileInput,
  SellerCreateProfileResult,
  SellerOnboardingStore,
} from '../sellers/seller-onboarding.service.js';
import type {
  SellerMediaAttachInput,
  SellerMediaAttachResult,
  SellerMediaStore,
  SellerMediaTargetInput,
  SellerMediaTargetResult,
} from '../sellers/seller-media.service.js';
import type {
  SellerProfileUpdateStore,
  SellerUpdateProfileInput,
  SellerUpdateProfileResult,
} from '../sellers/seller-profile-update.service.js';
import type {
  SellerListingCreateInput,
  SellerListingRow,
  SellerListingStore,
  SellerListingUpdateInput,
  SellerListingWriteResult,
  SellerListingsQuery,
} from '../sellers/seller-listing.service.js';
import type {
  SellerServiceCreateInput,
  SellerServiceRow,
  SellerServiceStore,
  SellerServiceUpdateInput,
  SellerServicesQuery,
} from '../sellers/seller-service.service.js';
import type {
  SellerVerificationAttachInput,
  SellerVerificationCountRow,
  SellerVerificationRow,
  SellerVerificationStateRow,
  SellerVerificationStore,
  SellerVerificationTargetInput,
  SellerVerificationTargetRow,
} from '../sellers/seller-verification.service.js';
import type {
  SellerBalanceRow,
  SellerListingPerformanceRow,
  SellerOrderRow,
  SellerOrdersQuery,
  SellerPromotionPerformanceRow,
  SellerPromotionRow,
  SellerPromotionsQuery,
  SellerReadStore,
  SellerReviewRow,
  SellerReviewSummaryRow,
  SellerReviewsQuery,
} from '../sellers/seller-read.service.js';
import type {
  ListingAnalyticsDbRow,
  ListingAnalyticsStore,
} from '../analytics/listing-analytics.service.js';
import type { SearchPort, SearchRow } from '../catalog/search.service.js';
import type { KnownDeviceStore, LoginIdentityStore } from './login.service.js';
import type { ContactChangeStore } from '../users/contact-change.service.js';
import type { CurrentUserStore } from '../users/current-user.service.js';
import type {
  InboxRow,
  MessageAttachmentRow,
  MessageRow,
  MessagingStore,
} from '../messaging/messaging.service.js';
import type {
  MessageAttachmentAttachRow,
  MessageAttachmentObjectRow,
  MessageAttachmentStore,
  MessageAttachmentTargetRow,
} from '../messaging/message-attachments.service.js';
import type { MessagingWriteStore } from '../messaging/messaging-write.service.js';
import type { RecoveryStore } from './password-reset/recovery.service.js';
import type { RegistrationStore } from './registration.service.js';
import type { TotpStepUpStore } from './totp/totp.service.js';
import type { NotificationRow, NotificationsStore } from '../notifications/notifications.service.js';
import type { StaffConsoleRow, StaffConsoleStore } from '../admin/staff-console.service.js';
import type {
  ServiceQuoteDecisionRow,
  ServiceQuoteMutationRow,
  ServiceRequestDetailRow,
  ServiceRequestMutationRow,
  ServiceRequestRow,
  ServiceRequestStatusRow,
  ServiceRequestsStore,
} from '../services/service-requests.service.js';
import type {
  AdminServiceRequestDecisionRow,
  AdminServiceRequestDetailRow,
  AdminServiceRequestRow,
  AdminServiceRequestsStore,
  ServiceRequestPaymentInformationRow,
} from '../admin/service-requests-admin.service.js';
import type {
  OfferDecisionRow,
  OfferMutationRow,
  OfferRow,
  OffersStore,
  SellerOfferRow,
} from '../offers/offers.service.js';
import type {
  SupportAssignedRow,
  SupportAssignmentRow,
  SupportConsoleAttachmentRow,
  SupportConsoleDecisionRow,
  SupportConsoleMessagePostRow,
  SupportConsoleMessageRow,
  SupportConsoleStore,
  SupportConsoleTicketRow,
  SupportInternalNoteRow,
  SupportNoteAddRow,
  SupportQueueRow,
} from '../admin/support-console.service.js';
import type {
  SupportAttachmentLocationRow,
  SupportAttachmentRecordRow,
  SupportAttachmentTargetRow,
  SupportMessagePostRow,
  SupportMessageRow,
  SupportStore,
  SupportTicketClosureRow,
  SupportTicketDetailRow,
  SupportTicketOpenRow,
  SupportTicketRow,
} from '../support/support.service.js';
import type { ReporterReportRow, ReportsStore } from '../reports/reports.service.js';
import type {
  ListingModerationTrailRow,
  ModerationActionTrailRow,
  ModerationListingDetailRow,
  ModerationListingQueueRow,
  ModerationReportDetailRow,
  ModerationReportQueueRow,
  ModerationStore,
  ModerationWriteRow,
} from '../admin/moderation.service.js';
import type {
  AdminAuditDbRow,
  AdminOperationsStore,
  AdminRoleCatalogueRow,
  AdminSecurityEventRow,
  AdminSellerDetailRow,
  AdminSellerPageRow,
  AdminUserDetailRow,
  AdminUserPageRow,
  AdminUserRoleRow,
  RecoveryCompletionRow,
  RecoveryEvidenceDbRow,
  RecoveryQueueDbRow,
  RecoveryRequestDetailDbRow,
  RecoveryWriteRow,
  SellerStatusWriteRow,
  StaffGrantableRoleRow,
  StaffRoleWriteRow,
} from '../admin/admin-operations.service.js';
import type {
  ReviewActionDbRow,
  ReviewDetailDbRow,
  ReviewModerateRow,
  ReviewModerationStore,
  ReviewQueueDbRow,
} from '../admin/review-moderation.service.js';
import type {
  JobRunDbRow,
  JobRunDetailDbRow,
  OutboxDeadLetterDbRow,
  OutboxHealthDbRow,
  PlatformOperationsStore,
  ScheduleProblemDbRow,
  ScheduledJobDbRow,
} from '../admin/platform-operations.service.js';
import type {
  DisputeDetailDbRow,
  DisputeManagementStore,
  DisputeMessageDbRow,
  DisputeMessagePostRow,
  DisputeQueueDbRow,
  DisputeResolveRow,
} from '../admin/dispute-management.service.js';
import type {
  VerificationDecisionRow,
  VerificationDetailRow,
  VerificationDocumentRow,
  VerificationQueueRow,
  VerificationReviewStore,
} from '../admin/verification-review.service.js';
import type {
  AddressRow,
  BlockRow,
  BuyerAccountStore,
  BuyerProfileRow,
  BuyerSettingsRow,
  CountryRow,
  FavoriteRow,
  SavedSearchRow,
} from '../account/buyer-account.service.js';
import type {
  ConsumeResetTokenInput,
  ConsumeResetTokenRow,
  IssueResetTokenInput,
  IssueResetTokenRow,
  PasswordResetTokenStore,
} from './password-reset/password-reset.service.js';
import type {
  IssueOtpInput,
  IssueOtpResult,
  OtpChallengeStore,
  OtpVerifyOutcome,
  SettleOtpDeliveryInput,
} from './otp/otp.service.js';
import type {
  AuthorizedRun,
  IssueStepUpInput,
  IssueStepUpResult,
  StepUpAuthorization,
  StepUpOutcome,
  StepUpStore,
} from './step-up/step-up.service.js';

/**
 * Thrown to unwind the transaction when a grant could not be consumed.
 *
 * It never escapes {@link AppSystemStore.runWithStepUpGrant}: a refusal is an outcome, not an error, and
 * rolling back is simply how nothing is left behind.
 */
class NotAuthorized extends Error {
  constructor() {
    super('step-up grant not consumed');
    this.name = 'NotAuthorized';
  }
}

/** Raw shape both of 0071's service-request readers return. */
interface ServiceRequestRawRow {
  id: string;
  status: string;
  routing_mode: string | null;
  title: string | null;
  budget_minor: string | number | null;
  currency_code: string | null;
  currency_minor_unit: number | null;
  needed_by: Date | string | null;
  listing_slug: string | null;
  listing_title: string | null;
  counterparty_name: string | null;
  quote_count: string | number | null;
  live_quote_count: string | number | null;
  accepted_payment_due_at: Date | null;
  closed_at: Date | null;
  created_at: Date | null;
}

/** The one mapping both service-request readers share. Written once so the two cannot drift apart. */
function serviceRequestRow(row: ServiceRequestRawRow): ServiceRequestRow {
  return {
    id: row.id,
    status: row.status,
    routingMode: row.routing_mode ?? null,
    title: row.title ?? null,
    budgetMinor: row.budget_minor ?? null,
    currencyCode: row.currency_code ?? null,
    currencyMinorUnit:
      row.currency_minor_unit === null || row.currency_minor_unit === undefined
        ? null
        : Number(row.currency_minor_unit),
    neededBy: row.needed_by ?? null,
    listingSlug: row.listing_slug ?? null,
    listingTitle: row.listing_title ?? null,
    counterpartyName: row.counterparty_name ?? null,
    quoteCount: row.quote_count === null || row.quote_count === undefined ? null : Number(row.quote_count),
    liveQuoteCount:
      row.live_quote_count === null || row.live_quote_count === undefined
        ? null
        : Number(row.live_quote_count),
    acceptedPaymentDueAt: row.accepted_payment_due_at ?? null,
    closedAt: row.closed_at ?? null,
    createdAt: row.created_at ?? null,
  };
}

/** Raw shape returned by `app_private.issue_step_up_grant`. */
interface StepUpRow {
  outcome: StepUpOutcome;
  grant_id: string | null;
  expires_at: Date | null;
}

/** Raw shape returned by `app_private.issue_otp_challenge`. */
interface IssueOtpRow {
  outcome: IssueOtpResult['outcome'];
  challenge_id: string | null;
  outbox_id: string | null;
  send_count: number | null;
  retry_after_seconds: number | null;
  expires_at: Date | null;
}

/**
 * The `app_system` connection, and the only place the auth enforcement functions are called.
 *
 * `app_system` holds no table privileges anywhere — the 0031 role-boundary contract enforces that — so
 * every statement here goes through a named SECURITY DEFINER function. There is no query builder use and
 * no table access on purpose: if this file ever needs to read a table directly, the security model has
 * changed and that change belongs in a migration and an owner decision, not here.
 *
 * `app_system` is `noinherit` and logs in directly (migration 0003), so no `SET ROLE` is needed.
 */
@Injectable()
export class AppSystemStore
  implements
    LoginEnforcementStore,
    OtpChallengeStore,
    StepUpStore,
    ThrottleCounter,
    AuthSecurityEventStore,
    LoginIdentityStore,
    PasswordResetTokenStore,
    RecoveryStore,
    RegistrationStore,
    TotpStepUpStore,
    NotificationsStore,
    BuyerAccountStore,
    StaffConsoleStore,
    VerificationReviewStore,
    OffersStore,
    ServiceRequestsStore,
    AdminServiceRequestsStore,
    SupportStore,
    SupportConsoleStore,
    ReportsStore,
    ModerationStore,
    AdminOperationsStore,
    ReviewModerationStore,
    PlatformOperationsStore,
    DisputeManagementStore,
    ContactChangeStore,
    CurrentUserStore,
    KnownDeviceStore,
    MessagingStore,
    MessagingWriteStore,
    MessageAttachmentStore,
    CategoryStore,
    CmsPagesStore,
    CmsPublicStore,
    BlogPublicStore,
    BlogStore,
    HomepagePublicStore,
    HomepageStore,
    NavigationPublicStore,
    NavigationStore,
    FaqsPublicStore,
    FaqsStore,
    SeoSettingsStore,
    CmsMediaStore,
    SeoStore,
    SeoRedirectsStore,
    SeoMetadataStore,
    CategoriesStore,
    AttributesStore,
    SellerVocabularyStore,
    CategoryFeedPort,
    ListingStore,
    ServiceStore,
    SellerStore,
    SellerIdentityStore,
    SellerOnboardingStore,
    SellerProfileUpdateStore,
    SellerMediaStore,
    SellerListingStore,
    SellerServiceStore,
    SellerVerificationStore,
    SellerReadStore,
    SearchPort,
    ListingAnalyticsStore,
    OnApplicationShutdown
{
  private readonly logger = new Logger(AppSystemStore.name);

  constructor(private readonly db: Kysely<Database>) {}

  static fromConnectionString(connectionString: string, maxConnections: number): AppSystemStore {
    return new AppSystemStore(createDatabase<Database>({ connectionString, maxConnections }));
  }

  async isAccountLocked(userId: string): Promise<boolean> {
    const result = await sql<{ locked: boolean }>`
      select app_private.is_account_locked(${userId}::uuid) as locked
    `.execute(this.db);

    const locked = result.rows[0]?.locked;
    // An empty result is not "unlocked": it is an answer we did not get. Fail closed.
    if (typeof locked !== 'boolean') throw new Error('Lockout check returned no row.');
    return locked;
  }

  async recordLoginAttempt(attempt: LoginAttempt): Promise<boolean> {
    const result = await sql<{ locked: boolean }>`
      select app_private.record_login_attempt(
        ${attempt.userId}::uuid,
        ${attempt.identifierHash}::bytea,
        ${attempt.succeeded}::boolean,
        ${attempt.failureReason}::text,
        ${attempt.requestIp}::inet,
        ${attempt.userAgentHash}::bytea
      ) as locked
    `.execute(this.db);

    const locked = result.rows[0]?.locked;
    if (typeof locked !== 'boolean') throw new Error('Recording a login attempt returned no row.');
    return locked;
  }

  /**
   * The durable C-1 tier: `app_private.rate_limit_hit`, which returns whether the request is allowed.
   *
   * The window arrives in seconds and is handed over as an interval, so the database aligns the window
   * exactly as the Redis tier does and a fallback continues the same window.
   */
  async hit(bucket: string, subjectHash: Buffer, windowSeconds: number, limit: number): Promise<boolean> {
    const result = await sql<{ allowed: boolean }>`
      select app_private.rate_limit_hit(
        ${bucket}::text,
        ${subjectHash}::bytea,
        make_interval(secs => ${windowSeconds}::double precision),
        ${limit}::integer
      ) as allowed
    `.execute(this.db);

    const allowed = result.rows[0]?.allowed;
    // An answer we did not get is not permission. Fail closed.
    if (typeof allowed !== 'boolean') throw new Error('Throttle counter returned no row.');
    return allowed;
  }

  /** `app_private.record_auth_security_event` (C-20). Everything identifying arrives hashed. */
  async recordAuthSecurityEvent(event: AuthSecurityEvent): Promise<void> {
    await sql`
      select app_private.record_auth_security_event(
        ${event.eventType}::text,
        ${event.userId}::uuid,
        ${event.identifierHash}::bytea,
        ${event.ipHash}::bytea,
        ${event.userAgentHash}::bytea,
        ${event.requestId}::text,
        ${event.reasonCode}::text
      )
    `.execute(this.db);
  }

  /**
   * `app_private.user_id_for_login_identifier` (0038).
   *
   * The plaintext identifier is a parameter here and is never stored by that function: it exists so the
   * durable lockout can be applied before the provider is called. A null result is not an error and is
   * never surfaced to a caller — it simply means the login will fail at the provider like any other.
   */
  async userIdForLoginIdentifier(identifier: string): Promise<string | null> {
    const result = await sql<{ user_id: string | null }>`
      select app_private.user_id_for_login_identifier(${identifier}::text) as user_id
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Resolving a login identifier returned no row.');
    return row.user_id;
  }

  /**
   * `app_private.login_contact_confirmed` (0065).
   *
   * Read by the login path to apply the approved VERIFY FIRST rule. It answers false for an account that
   * does not exist, which is harmless: the login path only asks after the provider has already confirmed
   * the password, so there is always an account by then.
   */
  async loginContactConfirmed(userId: string): Promise<boolean> {
    const result = await sql<{ confirmed: boolean }>`
      select app_private.login_contact_confirmed(${userId}::uuid) as confirmed
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a confirmed contact returned no row.');
    return row.confirmed;
  }

  /**
   * `app_private.register_verify_contact` (0065).
   *
   * No account is passed in, because at this moment the person has none: registration verifies a contact
   * before any session exists. The function returns the account the challenge was issued for, and only on
   * the one outcome that proves the person holds the number.
   */
  async registerVerifyContact(input: {
    challengeId: string;
    codeHash: Buffer;
  }): Promise<{ outcome: string; userId: string | null }> {
    const result = await sql<{ outcome: string; user_id: string | null }>`
      select outcome, user_id
        from app_private.register_verify_contact(
          ${input.challengeId}::uuid,
          ${input.codeHash}::bytea
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Verifying a registration code returned no row.');
    return { outcome: row.outcome, userId: row.user_id };
  }

  /**
   * `app_private.register_resend_contact` (0065).
   *
   * There is no phone parameter, here or in the function: the number a resend reaches is the one the
   * account already holds, and only while that account has confirmed nothing.
   */
  async registerResendContact(challengeId: string): Promise<{
    outcome: string;
    userId: string | null;
    toPhoneE164: string | null;
  }> {
    const result = await sql<{ outcome: string; user_id: string | null; to_phone_e164: string | null }>`
      select outcome, user_id, to_phone_e164
        from app_private.register_resend_contact(${challengeId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Resolving a registration resend returned no row.');
    return { outcome: row.outcome, userId: row.user_id, toPhoneE164: row.to_phone_e164 };
  }

  async issueOtpChallenge(input: IssueOtpInput): Promise<IssueOtpResult> {
    const result = await sql<IssueOtpRow>`
      select outcome, challenge_id, outbox_id, send_count, retry_after_seconds, expires_at
        from app_private.issue_otp_challenge(
          ${input.purpose}::text,
          ${input.channel}::text,
          ${input.destinationHash}::bytea,
          ${input.codeHash}::bytea,
          ${input.toPhoneE164}::text,
          ${input.templateName}::text,
          ${input.templateLocale}::text,
          ${input.userId}::uuid,
          ${input.requestIp}::inet,
          ${input.ipHash}::bytea
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Issuing an OTP challenge returned no row.');
    return {
      outcome: row.outcome,
      challengeId: row.challenge_id,
      outboxId: row.outbox_id,
      sendCount: row.send_count,
      retryAfterSeconds: row.retry_after_seconds,
      expiresAt: row.expires_at,
    };
  }

  async beginOtpDelivery(outboxId: string): Promise<boolean> {
    const result = await sql<{ claimed: boolean }>`
      select app_private.begin_otp_delivery(${outboxId}::uuid) as claimed
    `.execute(this.db);
    const claimed = result.rows[0]?.claimed;
    if (typeof claimed !== 'boolean') throw new Error('Claiming an OTP delivery returned no row.');
    return claimed;
  }

  async settleOtpDelivery(input: SettleOtpDeliveryInput): Promise<boolean> {
    const result = await sql<{ settled: boolean }>`
      select app_private.settle_outbox_message(
        'whatsapp'::text,
        ${input.outboxId}::uuid,
        ${input.status}::text,
        ${input.providerMessageId}::text,
        ${input.errorType}::text,
        null::timestamptz
      ) as settled
    `.execute(this.db);
    const settled = result.rows[0]?.settled;
    if (typeof settled !== 'boolean') throw new Error('Settling an OTP delivery returned no row.');
    return settled;
  }

  async verifyOtpChallenge(challengeId: string, codeHash: Buffer): Promise<OtpVerifyOutcome> {
    const result = await sql<{ outcome: OtpVerifyOutcome }>`
      select app_private.verify_otp_challenge(${challengeId}::uuid, ${codeHash}::bytea) as outcome
    `.execute(this.db);
    const outcome = result.rows[0]?.outcome;
    if (outcome === undefined) throw new Error('Verifying an OTP challenge returned no row.');
    return outcome;
  }

  /**
   * `app_private.issue_password_reset_token` (0039, C-18).
   *
   * Only the digest crosses this boundary. The 15-minute lifetime is the function's, not a parameter,
   * so there is nothing here that could shorten or extend an approved value.
   */
  async issuePasswordResetToken(input: IssueResetTokenInput): Promise<IssueResetTokenRow> {
    const result = await sql<IssueResetTokenRow & { token_id: string | null; expires_at: Date | null }>`
      select outcome, token_id, expires_at
        from app_private.issue_password_reset_token(
          ${input.userId}::uuid,
          ${input.tokenHash}::bytea,
          ${input.requestIp}::inet
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Issuing a password reset token returned no row.');
    return { outcome: row.outcome, tokenId: row.token_id, expiresAt: row.expires_at };
  }

  /**
   * `app_private.consume_password_reset_token` (0039, C-18).
   *
   * The function locks the row and decides and writes in one place, so this is a single call and not a
   * read followed by a write: a second simultaneous consumption must lose, and only the database can
   * make that true.
   */
  async consumePasswordResetToken(input: ConsumeResetTokenInput): Promise<ConsumeResetTokenRow> {
    const result = await sql<{ outcome: ConsumeResetTokenRow['outcome']; user_id: string | null; token_id: string | null }>`
      select outcome, user_id, token_id
        from app_private.consume_password_reset_token(
          ${input.tokenHash}::bytea,
          ${input.expectedUserId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Consuming a password reset token returned no row.');
    return { outcome: row.outcome, userId: row.user_id, tokenId: row.token_id };
  }

  /** `app_private.password_reset_contact` (0040, F3). No row means no account **or** no verified contact. */
  async passwordResetContact(identifier: string): Promise<{ userId: string; phoneE164: string } | null> {
    const result = await sql<{ user_id: string; phone_e164: string }>`
      select user_id, phone_e164 from app_private.password_reset_contact(${identifier}::text)
    `.execute(this.db);
    const row = result.rows[0];
    return row === undefined ? null : { userId: row.user_id, phoneE164: row.phone_e164 };
  }

  /** `app_private.verified_contact_for_user` (0040, F3): where the post-reset notification goes. */
  async verifiedContactForUser(userId: string): Promise<string | null> {
    const result = await sql<{ phone: string | null }>`
      select app_private.verified_contact_for_user(${userId}::uuid) as phone
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Resolving a notification contact returned no row.');
    return row.phone;
  }

  /**
   * `app_private.verify_password_reset_otp` (0040, F3).
   *
   * One call because it is one transaction: the challenge is consumed and the C-18 token is issued
   * together, so a correct code can never yield two tokens.
   */
  async verifyPasswordResetOtp(input: {
    challengeId: string;
    codeHash: Buffer;
    tokenHash: Buffer;
  }): Promise<{ outcome: string; tokenId: string | null; expiresAt: Date | null }> {
    const result = await sql<{ outcome: string; token_id: string | null; expires_at: Date | null }>`
      select outcome, token_id, expires_at
        from app_private.verify_password_reset_otp(
          ${input.challengeId}::uuid,
          ${input.codeHash}::bytea,
          ${input.tokenHash}::bytea
        )
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Verifying a recovery code returned no row.');
    return { outcome: row.outcome, tokenId: row.token_id, expiresAt: row.expires_at };
  }

  /**
   * `app_private.register_known_device` (0043/0044, F6, C-15).
   *
   * The digest goes down; the raw device value never gets here, because the service hashes it and this
   * store has no way to reverse one. The 15-minute sighting window lives inside the function, so a
   * caller cannot write more often by calling more often.
   */
  async registerKnownDevice(input: {
    userId: string;
    deviceHash: Buffer;
    requestIp: string | null;
  }): Promise<{ outcome: string; deviceId: string | null }> {
    const result = await sql<{ outcome: string; device_id: string | null }>`
      select outcome, device_id
        from app_private.register_known_device(
          ${input.userId}::uuid,
          ${input.deviceHash}::bytea,
          ${input.requestIp}::inet
        )
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Registering a device returned no row.');
    return { outcome: row.outcome, deviceId: row.device_id };
  }

  /**
   * `app_private.public_categories` (0045, Phase 4-A): the published tree for one locale.
   *
   * The only read in this store that serves a request with no user behind it. It takes a locale and
   * returns four columns; there is no filter to pass and no row this caller could ask to see that the
   * function would not already have returned.
   */
  async publicCategories(locale: string): Promise<readonly CategoryRow[]> {
    const result = await sql<{ id: string; parent_id: string | null; slug: string; name: string }>`
      select id, parent_id, slug, name from app_private.public_categories(${locale}::text)
    `.execute(this.db);
    return result.rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      slug: row.slug,
      name: row.name,
    }));
  }

  /** `app_private.public_listings` (0046, Phase 4-B): one page of the browse list. */
  async publicListings(input: {
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ListingRow[]> {
    const result = await sql<{
      id: string;
      slug: string;
      title: string;
      city: string | null;
      price_minor: string | null;
      currency_code: string;
      currency_minor_unit: number;
      is_negotiable: boolean;
      listing_type_code: string;
      created_at: Date;
    }>`
      select id, slug, title, city, price_minor, currency_code, currency_minor_unit,
             is_negotiable, listing_type_code, created_at
        from app_private.public_listings(
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);
    return result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      city: row.city,
      priceMinor: row.price_minor,
      currencyCode: row.currency_code,
      currencyMinorUnit: Number(row.currency_minor_unit),
      isNegotiable: row.is_negotiable,
      listingTypeCode: row.listing_type_code,
      createdAt: row.created_at,
    }));
  }

  /** `app_private.public_listing_by_slug` (0046, Phase 4-B): one listing, a redirect, or nothing. */
  async publicListingBySlug(input: {
    slug: string;
    locale: string;
  }): Promise<Pick<ListingDetailRow, 'outcome' | 'canonicalSlug'> & Partial<ListingDetailRow>> {
    const result = await sql<Record<string, unknown>>`
      select outcome, canonical_slug, canonical_type, id, slug, title, description, content_language,
             city, price_minor, currency_code, currency_minor_unit, is_negotiable, listing_type_code,
             created_at, availability, category, seller, attributes, tags
        from app_private.public_listing_by_slug(${input.slug}::text, ${input.locale}::text)
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a listing returned no row.');

    const outcome = row['outcome'] as ListingDetailRow['outcome'];
    const canonicalSlug = (row['canonical_slug'] as string | null) ?? null;
    const canonicalType = (row['canonical_type'] as ListingDetailRow['canonicalType']) ?? null;
    if (outcome !== 'found') return { outcome, canonicalSlug, canonicalType };

    return {
      outcome,
      canonicalSlug,
      canonicalType,
      id: row['id'] as string,
      slug: row['slug'] as string,
      title: row['title'] as string,
      city: (row['city'] as string | null) ?? null,
      priceMinor: (row['price_minor'] as string | null) ?? null,
      currencyCode: row['currency_code'] as string,
      currencyMinorUnit: Number(row['currency_minor_unit']),
      isNegotiable: row['is_negotiable'] as boolean,
      listingTypeCode: row['listing_type_code'] as string,
      createdAt: row['created_at'] as Date,
      description: row['description'] as string,
      contentLanguage: row['content_language'] as string,
      availability: row['availability'] as ListingDetailRow['availability'],
      category: row['category'] as ListingDetailRow['category'],
      seller: row['seller'] as ListingDetailRow['seller'],
      attributes: row['attributes'] as ListingDetailRow['attributes'],
      tags: row['tags'] as ListingDetailRow['tags'],
    };
  }

  /** `app_private.public_search` (0051, Phase 4-F): one page of mixed public search results. */
  async publicSearch(input: {
    query: string;
    locale: string;
    filters: CatalogFilters;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SearchRow[]> {
    const result = await sql<SearchSqlRow>`
      select result_type, id, slug, title, city, price_minor, currency_code, currency_minor_unit,
             is_negotiable, listing_type_code, pricing_model, delivery_days, revisions_included,
             created_at
        from app_private.public_catalog_search(
          ${input.query}::text,
          ${input.locale}::text,
          ${JSON.stringify(input.filters)}::jsonb,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => searchRow(row));
  }

  /** `app_private.public_category_feed(text, jsonb, integer, timestamptz, uuid)` (0089). */
  async publicCategoryFeed(input: {
    slug: string;
    filters: CatalogFilters;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SearchRow[]> {
    const result = await sql<SearchSqlRow>`
      select result_type, id, slug, title, city, price_minor, currency_code, currency_minor_unit,
             is_negotiable, listing_type_code, pricing_model, delivery_days, revisions_included,
             created_at
        from app_private.public_category_feed(
          ${input.slug}::text,
          ${JSON.stringify(input.filters)}::jsonb,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => searchRow(row));
  }

  /** `app_private.public_category_facets(text, text, jsonb)` (0089). */
  async publicCategoryFacets(input: {
    slug: string;
    locale: string;
    filters: CatalogFilters;
  }): Promise<readonly CategoryFacetRow[]> {
    const result = await sql<{
      facet_kind: string;
      attribute_key: string | null;
      attribute_label: string | null;
      data_type: string | null;
      unit: string | null;
      attribute_sort_order: number;
      value: string | null;
      label: string | null;
      value_sort_order: number;
      match_count: number;
      number_min: string | null;
      number_max: string | null;
    }>`
      select facet_kind, attribute_key, attribute_label, data_type, unit, attribute_sort_order,
             value, label, value_sort_order, match_count, number_min, number_max
        from app_private.public_category_facets(
          ${input.slug}::text,
          ${input.locale}::text,
          ${JSON.stringify(input.filters)}::jsonb
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      facetKind: row.facet_kind,
      attributeKey: row.attribute_key ?? null,
      attributeLabel: row.attribute_label ?? null,
      dataType: row.data_type ?? null,
      unit: row.unit ?? null,
      attributeSortOrder: Number(row.attribute_sort_order),
      value: row.value ?? null,
      label: row.label ?? null,
      valueSortOrder: Number(row.value_sort_order),
      matchCount: Number(row.match_count),
      // `numeric` arrives as a string from the driver and stays one: a price in minor units outlives what a
      // JSON number holds exactly, and an attribute's range is not ours to round.
      numberMin: row.number_min ?? null,
      numberMax: row.number_max ?? null,
    }));
  }

  /**
   * `app_private.seller_identity(uuid)` — the caller's own storefront (0057, Phase 6-A).
   *
   * Distinct from `publicSellerBySlug` on purpose: that one answers a guest's question by slug and hides
   * the account's state, this one answers the owner's question by their own established id and reports it.
   * No row means the account is not a seller, which is not an error here.
   */
  async sellerIdentity(userId: string): Promise<SellerIdentityRow | null> {
    const result = await sql<{
      slug: string;
      display_name: string;
      status: string;
      verification_status: string;
      city: string | null;
      country_code: string;
    }>`
      select slug, display_name, status, verification_status, city, country_code
        from app_private.seller_identity(${userId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      slug: row.slug,
      displayName: row.display_name,
      status: row.status,
      verificationStatus: row.verification_status,
      city: row.city ?? null,
      countryCode: row.country_code,
    };
  }

  /**
   * `app_private.seller_create_profile(...)` (0058, Phase 6-C): the caller's own storefront.
   *
   * Eleven arguments, and the first is the owner. There is no `status` or `verification_status` argument to
   * pass — the function writes both as literals — so nothing in this method could create an active or
   * verified storefront even by mistake. The outcome comes back as a string and the six projected columns
   * come back null on every refusal.
   */
  async sellerCreateProfile(input: SellerCreateProfileInput): Promise<SellerCreateProfileResult> {
    const result = await sql<{
      outcome: string;
      slug: string | null;
      display_name: string | null;
      status: string | null;
      verification_status: string | null;
      city: string | null;
      country_code: string | null;
    }>`
      select outcome, slug, display_name, status, verification_status, city, country_code
        from app_private.seller_create_profile(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.displayName}::text,
          ${input.legalName}::text,
          ${input.bio}::text,
          ${input.contentLanguage}::text,
          ${input.countryCode}::text,
          ${input.governorate}::text,
          ${input.city}::text,
          ${input.contactEmail}::text,
          ${input.contactPhone}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Creating a seller profile returned no row.');
    return {
      outcome: row.outcome,
      slug: row.slug ?? null,
      displayName: row.display_name ?? null,
      status: row.status ?? null,
      verificationStatus: row.verification_status ?? null,
      city: row.city ?? null,
      // `char(2)` is blank-padded on the way out of Postgres; the contract's two characters are what a
      // client sees.
      countryCode: row.country_code === null ? null : row.country_code.trim(),
    };
  }

  /**
   * `app_private.seller_update_profile(...)` (0059, Phase 6-D): the caller's own storefront, edited.
   *
   * Nineteen arguments, and the shape is the point: a set-flag and a value per editable field, so that
   * "leave this alone" and "empty this" travel as different requests all the way down. There is no `slug`,
   * `status` or `verification_status` argument to pass, so nothing in this method could rename a storefront
   * or move its state even by mistake.
   */
  async sellerUpdateProfile(input: SellerUpdateProfileInput): Promise<SellerUpdateProfileResult> {
    const result = await sql<{
      outcome: string;
      slug: string | null;
      display_name: string | null;
      status: string | null;
      verification_status: string | null;
      city: string | null;
      country_code: string | null;
    }>`
      select outcome, slug, display_name, status, verification_status, city, country_code
        from app_private.seller_update_profile(
          ${input.userId}::uuid,
          ${input.setDisplayName}::boolean, ${input.displayName}::text,
          ${input.setLegalName}::boolean, ${input.legalName}::text,
          ${input.setBio}::boolean, ${input.bio}::text,
          ${input.setContentLanguage}::boolean, ${input.contentLanguage}::text,
          ${input.setCountryCode}::boolean, ${input.countryCode}::text,
          ${input.setGovernorate}::boolean, ${input.governorate}::text,
          ${input.setCity}::boolean, ${input.city}::text,
          ${input.setContactEmail}::boolean, ${input.contactEmail}::text,
          ${input.setContactPhone}::boolean, ${input.contactPhone}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Updating a seller profile returned no row.');
    return {
      outcome: row.outcome,
      slug: row.slug ?? null,
      displayName: row.display_name ?? null,
      status: row.status ?? null,
      verificationStatus: row.verification_status ?? null,
      city: row.city ?? null,
      // `char(2)` is blank-padded on the way out of Postgres; the contract's two characters are what a
      // client sees.
      countryCode: row.country_code === null ? null : row.country_code.trim(),
    };
  }

  /**
   * `app_private.seller_media_upload_target(...)` (0060, Phase 6-E): where the caller may upload.
   *
   * Four arguments and not one of them is a path, a bucket or a seller: the destination comes *back*, derived
   * in the database from the caller's own storefront. `bigint` returns as a string over the wire, so the size
   * is parsed rather than assumed to be a number.
   */
  async sellerMediaUploadTarget(input: SellerMediaTargetInput): Promise<SellerMediaTargetResult> {
    const result = await sql<{
      outcome: string;
      bucket_id: string | null;
      object_path: string | null;
      max_byte_size: string | number | null;
    }>`
      select outcome, bucket_id, object_path, max_byte_size
        from app_private.seller_media_upload_target(
          ${input.userId}::uuid,
          ${input.mediaKind}::text,
          ${input.contentType}::text,
          ${input.byteSize}::bigint
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Authorizing a seller media upload returned no row.');
    const limit = row.max_byte_size;
    return {
      outcome: row.outcome,
      bucketId: row.bucket_id ?? null,
      objectPath: row.object_path ?? null,
      maxByteSize: limit === null || limit === undefined ? null : Number(limit),
    };
  }

  /** `app_private.seller_media_attach(...)` (0060, Phase 6-E): record an upload that happened. */
  async sellerMediaAttach(input: SellerMediaAttachInput): Promise<SellerMediaAttachResult> {
    const result = await sql<{
      outcome: string;
      has_logo: boolean | null;
      has_banner: boolean | null;
    }>`
      select outcome, has_logo, has_banner
        from app_private.seller_media_attach(
          ${input.userId}::uuid,
          ${input.mediaKind}::text,
          ${input.objectPath}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a seller media object returned no row.');
    return {
      outcome: row.outcome,
      hasLogo: row.has_logo ?? null,
      hasBanner: row.has_banner ?? null,
    };
  }

  /**
   * `app_private.seller_listings(...)` (0061, Phase 6-F): the caller's own listings, one page.
   *
   * Four arguments and the first is the caller; there is no seller, listing or category identifier in either
   * direction. `bigint` and the media count come back as strings over the wire, so both are parsed rather than
   * assumed, and `char(2)`/`char(3)` are blank-padded on the way out of Postgres and trimmed here — the
   * contract's two and three characters are what a client sees.
   */
  async sellerListings(query: SellerListingsQuery): Promise<readonly SellerListingRow[]> {
    const result = await sql<{
      slug: string;
      title: string;
      description: string;
      listing_type_code: string;
      category_slug: string;
      status: string;
      currency_code: string;
      price_minor: string | number | null;
      is_negotiable: boolean;
      content_language: string;
      country_code: string;
      governorate: string | null;
      city: string | null;
      media_count: string | number;
      created_at: Date;
      updated_at: Date;
      submitted_at: Date | null;
      archived_at: Date | null;
    }>`
      select slug, title, description, listing_type_code, category_slug, status, currency_code,
             price_minor, is_negotiable, content_language, country_code, governorate, city,
             media_count, created_at, updated_at, submitted_at, archived_at
        from app_private.seller_listings(
          ${query.userId}::uuid,
          ${query.limit}::integer,
          ${query.cursorCreatedAt}::timestamptz,
          ${query.cursorSlug}::text
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      description: row.description,
      listingTypeCode: row.listing_type_code,
      categorySlug: row.category_slug,
      status: row.status,
      currencyCode: row.currency_code.trim(),
      priceMinor: row.price_minor === null || row.price_minor === undefined ? null : Number(row.price_minor),
      isNegotiable: row.is_negotiable,
      contentLanguage: row.content_language,
      countryCode: row.country_code.trim(),
      governorate: row.governorate ?? null,
      city: row.city ?? null,
      mediaCount: Number(row.media_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      submittedAt: row.submitted_at ?? null,
      archivedAt: row.archived_at ?? null,
    }));
  }

  /**
   * `app_private.seller_listing_create_draft(...)` (0061, Phase 6-F): one new draft.
   *
   * Thirteen arguments and the first is the owner. There is no `status` argument to pass — the function writes
   * `draft` as a literal — so nothing in this method could create a listing in any other state even by
   * mistake, and there is no `seller_user_id` argument either, so it cannot create one for anybody else.
   */
  async sellerListingCreateDraft(input: SellerListingCreateInput): Promise<SellerListingWriteResult> {
    const result = await sql<{ outcome: string; slug: string | null; status: string | null }>`
      select outcome, slug, status
        from app_private.seller_listing_create_draft(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.title}::text,
          ${input.description}::text,
          ${input.listingTypeCode}::text,
          ${input.categorySlug}::text,
          ${input.contentLanguage}::text,
          ${input.currencyCode}::text,
          ${input.countryCode}::text,
          ${input.priceMinor}::bigint,
          ${input.isNegotiable}::boolean,
          ${input.governorate}::text,
          ${input.city}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Creating a listing draft returned no row.');
    return { outcome: row.outcome, slug: row.slug ?? null, status: row.status ?? null };
  }

  /**
   * `app_private.seller_listing_update_draft(...)` (0061, Phase 6-F): edit one draft.
   *
   * Twenty arguments: the caller, the address, and a set-flag and value per editable column, which is how an
   * omitted field is told from one deliberately cleared. No slug, type, category, owner, status or timestamp
   * argument exists, so none of them can be changed from here.
   */
  async sellerListingUpdateDraft(input: SellerListingUpdateInput): Promise<SellerListingWriteResult> {
    const result = await sql<{ outcome: string; slug: string | null; status: string | null }>`
      select outcome, slug, status
        from app_private.seller_listing_update_draft(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.setTitle}::boolean, ${input.title}::text,
          ${input.setDescription}::boolean, ${input.description}::text,
          ${input.setPriceMinor}::boolean, ${input.priceMinor}::bigint,
          ${input.setIsNegotiable}::boolean, ${input.isNegotiable}::boolean,
          ${input.setContentLanguage}::boolean, ${input.contentLanguage}::text,
          ${input.setCurrencyCode}::boolean, ${input.currencyCode}::text,
          ${input.setCountryCode}::boolean, ${input.countryCode}::text,
          ${input.setGovernorate}::boolean, ${input.governorate}::text,
          ${input.setCity}::boolean, ${input.city}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Updating a listing draft returned no row.');
    return { outcome: row.outcome, slug: row.slug ?? null, status: row.status ?? null };
  }

  /** `app_private.seller_listing_submit(...)` (0061, Phase 6-F): submit one draft for review. */
  async sellerListingSubmit(input: { userId: string; slug: string }): Promise<SellerListingWriteResult> {
    const result = await sql<{ outcome: string; slug: string | null; status: string | null }>`
      select outcome, slug, status
        from app_private.seller_listing_submit(${input.userId}::uuid, ${input.slug}::text)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Submitting a listing returned no row.');
    return { outcome: row.outcome, slug: row.slug ?? null, status: row.status ?? null };
  }

  /** `app_private.seller_listing_archive(...)` (0061, Phase 6-F): withdraw one live listing from sale. */
  async sellerListingArchive(input: { userId: string; slug: string }): Promise<SellerListingWriteResult> {
    const result = await sql<{ outcome: string; slug: string | null; status: string | null }>`
      select outcome, slug, status
        from app_private.seller_listing_archive(${input.userId}::uuid, ${input.slug}::text)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Archiving a listing returned no row.');
    return { outcome: row.outcome, slug: row.slug ?? null, status: row.status ?? null };
  }

  /**
   * `app_private.seller_services(...)` (0062, Phase 6-G): the caller's own services, one page.
   *
   * Four arguments and the first is the caller; there is no seller, listing or category identifier in either
   * direction, and no listing type either — the function is scoped to services by its own where clause.
   * `bigint` and the smallint columns arrive as strings or numbers depending on the driver, so each is
   * normalised here rather than assumed. `price_minor` stays a **string**: that is how every contract in this
   * repository carries `listings.price_minor`, and it is what keeps the top of a bigint intact.
   */
  async sellerServices(query: SellerServicesQuery): Promise<readonly SellerServiceRow[]> {
    const result = await sql<{
      slug: string;
      title: string;
      description: string;
      category_slug: string;
      status: string;
      currency_code: string;
      currency_minor_unit: string | number;
      price_minor: string | null;
      is_negotiable: boolean;
      content_language: string;
      country_code: string;
      governorate: string | null;
      city: string | null;
      pricing_model: string | null;
      delivery_days: string | number | null;
      revisions_included: string | number | null;
      requires_brief: boolean | null;
      scope: string | null;
      media_count: string | number;
      created_at: Date;
      updated_at: Date;
      submitted_at: Date | null;
      archived_at: Date | null;
    }>`
      select slug, title, description, category_slug, status, currency_code, currency_minor_unit,
             price_minor, is_negotiable, content_language, country_code, governorate, city,
             pricing_model, delivery_days, revisions_included, requires_brief, scope,
             media_count, created_at, updated_at, submitted_at, archived_at
        from app_private.seller_services(
          ${query.userId}::uuid,
          ${query.limit}::integer,
          ${query.cursorCreatedAt}::timestamptz,
          ${query.cursorSlug}::text
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      description: row.description,
      categorySlug: row.category_slug,
      status: row.status,
      // `char(3)` and `char(2)` are blank-padded on the way out of Postgres.
      currencyCode: row.currency_code.trim(),
      currencyMinorUnit: Number(row.currency_minor_unit),
      priceMinor: row.price_minor ?? null,
      isNegotiable: row.is_negotiable,
      contentLanguage: row.content_language,
      countryCode: row.country_code.trim(),
      governorate: row.governorate ?? null,
      city: row.city ?? null,
      pricingModel: row.pricing_model ?? null,
      deliveryDays:
        row.delivery_days === null || row.delivery_days === undefined ? null : Number(row.delivery_days),
      revisionsIncluded:
        row.revisions_included === null || row.revisions_included === undefined
          ? null
          : Number(row.revisions_included),
      requiresBrief: row.requires_brief ?? null,
      scope: row.scope ?? null,
      mediaCount: Number(row.media_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      submittedAt: row.submitted_at ?? null,
      archivedAt: row.archived_at ?? null,
    }));
  }

  /**
   * `app_private.seller_service_create_draft(...)` (0062, Phase 6-G): one new service draft.
   *
   * Seventeen arguments and the first is the owner. There is no `listing_type_code` argument — the function
   * passes the literal `service` to 6-F's creator — and no `status` argument either, so nothing here could
   * create a product, or a service in any state but draft, even by mistake.
   */
  async sellerServiceCreateDraft(input: SellerServiceCreateInput): Promise<SellerListingWriteResult> {
    const result = await sql<{ outcome: string; slug: string | null; status: string | null }>`
      select outcome, slug, status
        from app_private.seller_service_create_draft(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.title}::text,
          ${input.description}::text,
          ${input.categorySlug}::text,
          ${input.contentLanguage}::text,
          ${input.currencyCode}::text,
          ${input.countryCode}::text,
          ${input.priceMinor}::bigint,
          ${input.isNegotiable}::boolean,
          ${input.governorate}::text,
          ${input.city}::text,
          ${input.pricingModel}::text,
          ${input.deliveryDays}::integer,
          ${input.revisionsIncluded}::integer,
          ${input.requiresBrief}::boolean,
          ${input.scope}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Creating a service draft returned no row.');
    return { outcome: row.outcome, slug: row.slug ?? null, status: row.status ?? null };
  }

  /**
   * `app_private.seller_service_update_draft(...)` (0062, Phase 6-G): edit one service draft.
   *
   * Thirty arguments: the caller, the address, and a set-flag and value per editable column — nine listing
   * columns and five detail columns. No slug, type, category, owner, status or timestamp argument exists, so
   * none of them can be changed from here.
   */
  async sellerServiceUpdateDraft(input: SellerServiceUpdateInput): Promise<SellerListingWriteResult> {
    const result = await sql<{ outcome: string; slug: string | null; status: string | null }>`
      select outcome, slug, status
        from app_private.seller_service_update_draft(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.setTitle}::boolean, ${input.title}::text,
          ${input.setDescription}::boolean, ${input.description}::text,
          ${input.setPriceMinor}::boolean, ${input.priceMinor}::bigint,
          ${input.setIsNegotiable}::boolean, ${input.isNegotiable}::boolean,
          ${input.setContentLanguage}::boolean, ${input.contentLanguage}::text,
          ${input.setCurrencyCode}::boolean, ${input.currencyCode}::text,
          ${input.setCountryCode}::boolean, ${input.countryCode}::text,
          ${input.setGovernorate}::boolean, ${input.governorate}::text,
          ${input.setCity}::boolean, ${input.city}::text,
          ${input.setPricingModel}::boolean, ${input.pricingModel}::text,
          ${input.setDeliveryDays}::boolean, ${input.deliveryDays}::integer,
          ${input.setRevisionsIncluded}::boolean, ${input.revisionsIncluded}::integer,
          ${input.setRequiresBrief}::boolean, ${input.requiresBrief}::boolean,
          ${input.setScope}::boolean, ${input.scope}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Updating a service draft returned no row.');
    return { outcome: row.outcome, slug: row.slug ?? null, status: row.status ?? null };
  }

  /** `app_private.public_seller_by_slug` (0050, Phase 4-E): one public seller profile. */
  async publicSellerBySlug(
    slug: string,
  ): Promise<Pick<SellerProfileRow, 'outcome'> & Partial<SellerProfileRow>> {
    const result = await sql<Record<string, unknown>>`
      select outcome, availability, slug, display_name, bio, content_language, city
        from app_private.public_seller_by_slug(${slug}::text)
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a seller profile returned no row.');

    const outcome = row['outcome'] as SellerProfileRow['outcome'];
    if (outcome !== 'found') return { outcome };

    return {
      outcome,
      availability: row['availability'] as SellerProfileRow['availability'],
      slug: row['slug'] as string,
      displayName: row['display_name'] as string,
      bio: (row['bio'] as string | null) ?? null,
      contentLanguage: (row['content_language'] as string | null) ?? null,
      city: (row['city'] as string | null) ?? null,
    };
  }

  /** `app_private.public_category_by_slug` (0049, Phase 4-D): one category, its parent and children. */
  async publicCategoryBySlug(input: {
    slug: string;
    locale: string;
  }): Promise<Pick<CategoryDetailRow, 'outcome'> & Partial<CategoryDetailRow>> {
    const result = await sql<Record<string, unknown>>`
      select outcome, id, slug, name, description, meta_title, meta_description, parent, children
        from app_private.public_category_by_slug(${input.slug}::text, ${input.locale}::text)
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a category returned no row.');

    const outcome = row['outcome'] as CategoryDetailRow['outcome'];
    if (outcome !== 'found') return { outcome };

    return {
      outcome,
      id: row['id'] as string,
      slug: row['slug'] as string,
      name: row['name'] as string,
      description: (row['description'] as string | null) ?? null,
      metaTitle: (row['meta_title'] as string | null) ?? null,
      metaDescription: (row['meta_description'] as string | null) ?? null,
      parent: (row['parent'] as CategoryDetailRow['parent']) ?? null,
      children: (row['children'] as CategoryDetailRow['children']) ?? [],
    };
  }

  /** `app_private.public_services` (0047, Phase 4-C): one page of the service list. */
  async publicServices(input: {
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ServiceRow[]> {
    const result = await sql<{
      id: string;
      slug: string;
      title: string;
      city: string | null;
      price_minor: string | null;
      currency_code: string;
      currency_minor_unit: number;
      pricing_model: string | null;
      delivery_days: number | null;
      revisions_included: number | null;
      created_at: Date;
    }>`
      select id, slug, title, city, price_minor, currency_code, currency_minor_unit,
             pricing_model, delivery_days, revisions_included, created_at
        from app_private.public_services(
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);
    return result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      city: row.city,
      priceMinor: row.price_minor,
      currencyCode: row.currency_code,
      currencyMinorUnit: Number(row.currency_minor_unit),
      pricingModel: (row.pricing_model as ServiceRow['pricingModel']) ?? null,
      deliveryDays: row.delivery_days === null ? null : Number(row.delivery_days),
      revisionsIncluded: row.revisions_included === null ? null : Number(row.revisions_included),
      createdAt: row.created_at,
    }));
  }

  /** `app_private.public_service_by_slug` (0047, Phase 4-C): one service, a redirect, or nothing. */
  async publicServiceBySlug(input: {
    slug: string;
    locale: string;
  }): Promise<Pick<ServiceDetailRow, 'outcome' | 'canonicalSlug'> & Partial<ServiceDetailRow>> {
    const result = await sql<Record<string, unknown>>`
      select outcome, canonical_slug, canonical_type, id, slug, title, description, content_language,
             city, price_minor, currency_code, currency_minor_unit, pricing_model, delivery_days,
             revisions_included, requires_brief, scope, availability, category, seller, attributes, tags
        from app_private.public_service_by_slug(${input.slug}::text, ${input.locale}::text)
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a service returned no row.');

    const outcome = row['outcome'] as ServiceDetailRow['outcome'];
    const canonicalSlug = (row['canonical_slug'] as string | null) ?? null;
    const canonicalType = (row['canonical_type'] as ServiceDetailRow['canonicalType']) ?? null;
    if (outcome !== 'found') return { outcome, canonicalSlug, canonicalType };

    const deliveryDays = row['delivery_days'];
    const revisions = row['revisions_included'];
    return {
      outcome,
      canonicalSlug,
      canonicalType,
      id: row['id'] as string,
      slug: row['slug'] as string,
      title: row['title'] as string,
      city: (row['city'] as string | null) ?? null,
      priceMinor: (row['price_minor'] as string | null) ?? null,
      currencyCode: row['currency_code'] as string,
      currencyMinorUnit: Number(row['currency_minor_unit']),
      pricingModel: (row['pricing_model'] as ServiceRow['pricingModel']) ?? null,
      deliveryDays: deliveryDays === null || deliveryDays === undefined ? null : Number(deliveryDays),
      revisionsIncluded: revisions === null || revisions === undefined ? null : Number(revisions),
      description: row['description'] as string,
      contentLanguage: row['content_language'] as string,
      requiresBrief: (row['requires_brief'] as boolean | null) ?? null,
      scope: (row['scope'] as string | null) ?? null,
      availability: row['availability'] as ServiceDetailRow['availability'],
      category: row['category'] as ServiceDetailRow['category'],
      seller: row['seller'] as ServiceDetailRow['seller'],
      attributes: row['attributes'] as ServiceDetailRow['attributes'],
      tags: row['tags'] as ServiceDetailRow['tags'],
    };
  }

  /** `app_private.password_reset_token_status` (0040, F3): a read that never consumes. */
  async passwordResetTokenStatus(tokenHash: Buffer): Promise<{ status: string; userId: string | null }> {
    const result = await sql<{ status: string; user_id: string | null }>`
      select status, user_id from app_private.password_reset_token_status(${tokenHash}::bytea)
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a reset token status returned no row.');
    return { status: row.status, userId: row.user_id };
  }

  /** `app_private.queue_whatsapp_otp` (0008): one outbox row, here for the post-reset notification. */
  async queueWhatsAppMessage(input: {
    toPhoneE164: string;
    templateName: string;
    templateLocale: string;
    userId: string | null;
  }): Promise<string | null> {
    const result = await sql<{ id: string | null }>`
      select app_private.queue_whatsapp_otp(
        ${input.toPhoneE164}::text,
        ${input.templateName}::text,
        ${input.templateLocale}::text,
        ${input.userId}::uuid,
        '{}'::jsonb,
        null::text
      ) as id
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Queueing a notification returned no row.');
    return row.id;
  }

  /**
   * `app_private.verify_contact_change_otp` (0041, F4).
   *
   * The account is a parameter because the function checks it: a challenge that belongs to someone else,
   * or that was issued for another purpose, comes back as `not_found` rather than being verified.
   */
  async verifyContactChangeOtp(input: {
    challengeId: string;
    codeHash: Buffer;
    userId: string;
  }): Promise<{ outcome: string; newPhoneE164: string | null }> {
    const result = await sql<{ outcome: string; new_phone_e164: string | null }>`
      select outcome, new_phone_e164
        from app_private.verify_contact_change_otp(
          ${input.challengeId}::uuid,
          ${input.codeHash}::bytea,
          ${input.userId}::uuid
        )
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Verifying a contact-change code returned no row.');
    return { outcome: row.outcome, newPhoneE164: row.new_phone_e164 };
  }

  async issueStepUpGrant(input: IssueStepUpInput): Promise<IssueStepUpResult> {
    const result = await sql<StepUpRow>`
      select outcome, grant_id, expires_at
        from app_private.issue_step_up_grant(
          ${input.challengeId}::uuid,
          ${input.codeHash}::bytea,
          ${input.operation}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Issuing a step-up grant returned no row.');
    return { outcome: row.outcome, grantId: row.grant_id, expiresAt: row.expires_at };
  }

  /**
   * `app_private.issue_totp_step_up_grant` (0042, Phase 7-B).
   *
   * The companion to {@link issueStepUpGrant}, for the other source of proof F5 names. Two parameters and
   * no more: `granted_via = 'totp'` and C-16's ten minutes are literals inside the function, so this call
   * can name the account and the operation and can influence nothing else about the grant it records.
   *
   * The grant it writes is spent by the same {@link runWithStepUpGrant}, under the same C-19 rules. There
   * is one grant table, and a TOTP grant is not a different kind of thing from an OTP one.
   */
  async issueTotpStepUpGrant(input: {
    userId: string;
    operation: string;
  }): Promise<{ outcome: string; grantId: string | null; expiresAt: Date | null }> {
    const result = await sql<StepUpRow>`
      select outcome, grant_id, expires_at
        from app_private.issue_totp_step_up_grant(
          ${input.userId}::uuid,
          ${input.operation}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Issuing a TOTP step-up grant returned no row.');
    return { outcome: row.outcome, grantId: row.grant_id, expiresAt: row.expires_at };
  }

  /**
   * Consumes a step-up grant and runs the protected operation in one transaction (C-19).
   *
   * The ordering is deliberate and load-bearing. The consume is a single conditional UPDATE, so two
   * simultaneous callers cannot both take the grant; the row then stays locked for the rest of this
   * transaction, so if `operation` throws, the rollback returns the grant and a waiting caller may still
   * use it. That is what makes the grant spent on success rather than on attempt.
   *
   * An error from `operation` is re-thrown unchanged after the rollback: the caller needs to know their
   * operation failed, not merely that it was not authorised.
   */
  async runWithStepUpGrant<T>(
    authorization: StepUpAuthorization,
    operation: () => Promise<T>,
  ): Promise<AuthorizedRun<T>> {
    try {
      const result = await this.db.transaction().execute(async (trx) => {
        const consumed = await sql<{ consumed: boolean }>`
          select app_private.consume_step_up_grant(
            ${authorization.grantId}::uuid,
            ${authorization.userId}::uuid,
            ${authorization.operation}::text
          ) as consumed
        `.execute(trx);

        const authorized = consumed.rows[0]?.consumed;
        if (typeof authorized !== 'boolean') throw new Error('Consuming a step-up grant returned no row.');
        if (!authorized) throw new NotAuthorized();

        return await operation();
      });
      return { authorized: true, result };
    } catch (error) {
      if (error instanceof NotAuthorized) return { authorized: false };
      throw error;
    }
  }

  /**
   * `app_private.messaging_inbox(...)` — one page of the caller's inbox (Phase 5-C).
   *
   * Every value the cursor contributes is bound as a parameter. There is no interpolation here and no
   * fragment of this statement is built from caller input, which is what keeps an opaque cursor opaque
   * all the way down rather than only at the boundary.
   */
  /**
   * `app_private.notifications_inbox` (0066).
   *
   * The account is a parameter and appears in the function's own predicate, so a page of somebody else's
   * notifications is not something this call can ask for. `archived` chooses the inbox or the archived
   * view, which is the split 0029's index and unread count already draw.
   */
  async notificationsInbox(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
    archived: boolean;
  }): Promise<readonly NotificationRow[]> {
    const result = await sql<Record<string, unknown>>`
      select id, category, event_type, subject_type, subject_id, action_path,
             created_at, read_at, archived_at
        from app_private.notifications_inbox(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid,
          ${input.archived}::boolean
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row['id'] as string,
      category: row['category'] as string,
      eventType: row['event_type'] as string,
      subjectType: (row['subject_type'] as string | null) ?? null,
      subjectId: (row['subject_id'] as string | null) ?? null,
      actionPath: (row['action_path'] as string | null) ?? null,
      createdAt: row['created_at'] as Date,
      readAt: (row['read_at'] as Date | null) ?? null,
      archivedAt: (row['archived_at'] as Date | null) ?? null,
    }));
  }

  /** `app_private.notifications_unread_count` (0066). A bigint, carried as digits. */
  async notificationsUnreadCount(userId: string): Promise<string> {
    const result = await sql<{ unread_count: string }>`
      select app_private.notifications_unread_count(${userId}::uuid) as unread_count
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading an unread notification count returned no row.');
    return String(row.unread_count);
  }

  /**
   * `app_private.mark_notifications_read` (0029, unchanged by 7-C).
   *
   * A null array is that function's own "all of them" form. The account is a parameter and is in the
   * UPDATE's predicate, so an identifier belonging to somebody else matches no row.
   */
  async markNotificationsRead(input: {
    userId: string;
    ids: readonly string[] | null;
  }): Promise<number> {
    const result = await sql<{ marked: number }>`
      select app_private.mark_notifications_read(
        ${input.userId}::uuid,
        ${input.ids === null ? null : [...input.ids]}::uuid[]
      ) as marked
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Marking notifications read returned no row.');
    return Number(row.marked);
  }

  /** `app_private.archive_notifications` (0066). Identifiers are always explicit. */
  async archiveNotifications(input: { userId: string; ids: readonly string[] }): Promise<number> {
    const result = await sql<{ archived: number }>`
      select app_private.archive_notifications(
        ${input.userId}::uuid,
        ${[...input.ids]}::uuid[]
      ) as archived
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Archiving notifications returned no row.');
    return Number(row.archived);
  }

  async messagingInbox(input: {
    userId: string;
    limit: number;
    cursorLastMessageAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly InboxRow[]> {
    const result = await sql<Record<string, unknown>>`
      select conversation_id, subject_type, listing_id, listing_title_snapshot, membership_state,
             is_muted, is_closed, closed_at, unread_count, last_message_id, last_message_seq,
             last_message_at, last_message_type, last_message_body, last_message_sender_user_id,
             last_message_deleted_at, created_at
        from app_private.messaging_inbox(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorLastMessageAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      conversationId: row['conversation_id'] as string,
      subjectType: row['subject_type'] as string,
      listingId: (row['listing_id'] as string | null) ?? null,
      listingTitleSnapshot: (row['listing_title_snapshot'] as string | null) ?? null,
      membershipState: row['membership_state'] as string,
      isMuted: row['is_muted'] as boolean,
      isClosed: row['is_closed'] as boolean,
      closedAt: (row['closed_at'] as Date | null) ?? null,
      unreadCount: String(row['unread_count']),
      lastMessageId: (row['last_message_id'] as string | null) ?? null,
      lastMessageSeq: row['last_message_seq'] === null ? null : String(row['last_message_seq']),
      lastMessageAt: (row['last_message_at'] as Date | null) ?? null,
      lastMessageType: (row['last_message_type'] as string | null) ?? null,
      lastMessageBody: (row['last_message_body'] as string | null) ?? null,
      lastMessageSenderUserId: (row['last_message_sender_user_id'] as string | null) ?? null,
      lastMessageDeletedAt: (row['last_message_deleted_at'] as Date | null) ?? null,
      createdAt: row['created_at'] as Date,
    }));
  }

  /** `app_private.messaging_conversation_messages(...)` — one page of a conversation (Phase 5-C). */
  /* ---------------------------------------------------------------------------------------------- */
  /* Message attachments (0104)                                                                      */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * `app_private.messaging_message_attachments` (0104).
   *
   * A sibling of the message reader, keyed on the page's own ids. The function re-applies the participant test
   * itself, so the ids filter and never grant, and it returns no object path.
   */
  async messagingMessageAttachments(input: {
    userId: string;
    conversationId: string;
    messageIds: readonly string[];
  }): Promise<readonly MessageAttachmentRow[]> {
    const result = await sql<Record<string, unknown>>`
      select id, message_id, content_type, byte_size, created_at
        from app_private.messaging_message_attachments(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid,
          ${[...input.messageIds]}::uuid[]
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row['id'] as string,
      messageId: row['message_id'] as string,
      contentType: row['content_type'] as string,
      byteSize: String(row['byte_size']),
      createdAt: row['created_at'] as Date,
    }));
  }

  /** `app_private.message_attachment_target` (0104). Authorizes an upload and writes nothing. */
  async messageAttachmentTarget(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    contentType: string;
    byteSize: number;
  }): Promise<MessageAttachmentTargetRow> {
    const result = await sql<Record<string, unknown>>`
      select outcome, bucket_id, object_path, max_byte_size
        from app_private.message_attachment_target(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid,
          ${input.messageId}::uuid,
          ${input.contentType}::text,
          ${input.byteSize}::bigint
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Authorizing an attachment returned no row.');
    return {
      outcome: row['outcome'] as MessageAttachmentTargetRow['outcome'],
      bucketId: (row['bucket_id'] as string | null) ?? null,
      objectPath: (row['object_path'] as string | null) ?? null,
      maxByteSize:
        row['max_byte_size'] === null || row['max_byte_size'] === undefined
          ? null
          : Number(row['max_byte_size']),
    };
  }

  /** `app_private.message_attachment_attach` (0104). Called only after the object is confirmed to exist. */
  async messageAttachmentAttach(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    objectPath: string;
    contentType: string;
    byteSize: number;
  }): Promise<MessageAttachmentAttachRow> {
    const result = await sql<Record<string, unknown>>`
      select outcome, attachment_id, attachment_count
        from app_private.message_attachment_attach(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid,
          ${input.messageId}::uuid,
          ${input.objectPath}::text,
          ${input.contentType}::text,
          ${input.byteSize}::bigint
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording an attachment returned no row.');
    return {
      outcome: row['outcome'] as MessageAttachmentAttachRow['outcome'],
      attachmentId: (row['attachment_id'] as string | null) ?? null,
      attachmentCount:
        row['attachment_count'] === null || row['attachment_count'] === undefined
          ? null
          : Number(row['attachment_count']),
    };
  }

  /** `app_private.message_attachment_for_participant` (0104). The object a signed read should target. */
  async messageAttachmentForParticipant(input: {
    userId: string;
    conversationId: string;
    attachmentId: string;
  }): Promise<MessageAttachmentObjectRow> {
    const result = await sql<Record<string, unknown>>`
      select outcome, bucket_id, object_path, content_type
        from app_private.message_attachment_for_participant(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid,
          ${input.attachmentId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Resolving an attachment returned no row.');
    return {
      outcome: row['outcome'] as MessageAttachmentObjectRow['outcome'],
      bucketId: (row['bucket_id'] as string | null) ?? null,
      objectPath: (row['object_path'] as string | null) ?? null,
      contentType: (row['content_type'] as string | null) ?? null,
    };
  }

  async messagingConversationMessages(input: {
    userId: string;
    conversationId: string;
    limit: number;
    cursorSeq: string | null;
  }): Promise<readonly MessageRow[]> {
    const result = await sql<Record<string, unknown>>`
      select id, seq, conversation_id, sender_user_id, is_own_message, message_type, body,
             reference_type, reference_id, created_at, edited_at, deleted_at
        from app_private.messaging_conversation_messages(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid,
          ${input.limit}::integer,
          ${input.cursorSeq}::bigint
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row['id'] as string,
      seq: String(row['seq']),
      conversationId: row['conversation_id'] as string,
      senderUserId: (row['sender_user_id'] as string | null) ?? null,
      isOwnMessage: row['is_own_message'] as boolean,
      messageType: row['message_type'] as string,
      body: (row['body'] as string | null) ?? null,
      referenceType: (row['reference_type'] as string | null) ?? null,
      referenceId: (row['reference_id'] as string | null) ?? null,
      createdAt: row['created_at'] as Date,
      editedAt: (row['edited_at'] as Date | null) ?? null,
      deletedAt: (row['deleted_at'] as Date | null) ?? null,
    }));
  }

  /** `app_private.messaging_unread_count(uuid)` — the caller's total, as digits (Phase 5-C). */
  async messagingUnreadCount(userId: string): Promise<string> {
    const result = await sql<{ unread_count: string }>`
      select app_private.messaging_unread_count(${userId}::uuid) as unread_count
    `.execute(this.db);

    const row = result.rows[0];
    // An empty result is not "nothing unread": it is an answer we did not get.
    if (row === undefined) throw new Error('Reading an unread count returned no row.');
    return String(row.unread_count);
  }

  /**
   * `app_private.messaging_start_conversation(...)` — start or resolve a conversation (Phase 5-E).
   *
   * Every value is bound as a parameter. The outcome is a value the function returns, not an exception to
   * interpret, so a refusal and a success travel the same way.
   */
  async messagingStartConversation(input: {
    userId: string;
    subjectType: 'listing' | 'direct';
    listingId: string | null;
    sellerSlug: string | null;
  }): Promise<{ outcome: string; conversationId: string | null }> {
    const result = await sql<{ outcome: string; conversation_id: string | null }>`
      select outcome, conversation_id
        from app_private.messaging_start_conversation(
          ${input.userId}::uuid,
          ${input.subjectType}::text,
          ${input.listingId}::uuid,
          ${input.sellerSlug}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Starting a conversation returned no row.');
    return { outcome: row.outcome, conversationId: row.conversation_id ?? null };
  }

  /** `app_private.messaging_send_message(...)` — one text message as the caller (Phase 5-E). */
  async messagingSendMessage(input: {
    userId: string;
    conversationId: string;
    body: string;
  }): Promise<{ outcome: string; messageId: string | null; seq: string | null }> {
    const result = await sql<{ outcome: string; message_id: string | null; seq: string | null }>`
      select outcome, message_id, seq
        from app_private.messaging_send_message(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid,
          ${input.body}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Sending a message returned no row.');
    return {
      outcome: row.outcome,
      messageId: row.message_id ?? null,
      seq: row.seq === null ? null : String(row.seq),
    };
  }

  /** `app_private.messaging_mark_read(...)` — move the caller's own marker forward (Phase 5-E). */
  async messagingMarkRead(input: {
    userId: string;
    conversationId: string;
    seq: string;
  }): Promise<{ outcome: string; lastReadSeq: string | null }> {
    const result = await sql<{ outcome: string; last_read_seq: string | null }>`
      select outcome, last_read_seq
        from app_private.messaging_mark_read(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid,
          ${input.seq}::bigint
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Marking read returned no row.');
    return {
      outcome: row.outcome,
      lastReadSeq: row.last_read_seq === null ? null : String(row.last_read_seq),
    };
  }

  /** `app_private.messaging_set_muted(...)` — the caller's own mute flag (Phase 5-E). */
  async messagingSetMuted(input: {
    userId: string;
    conversationId: string;
    isMuted: boolean;
  }): Promise<{ outcome: string; isMuted: boolean | null }> {
    const result = await sql<{ outcome: string; is_muted: boolean | null }>`
      select outcome, is_muted
        from app_private.messaging_set_muted(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid,
          ${input.isMuted}::boolean
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Setting mute returned no row.');
    return { outcome: row.outcome, isMuted: row.is_muted ?? null };
  }

  /** `app_private.messaging_leave_conversation(...)` — the caller leaves their own membership. */
  async messagingLeaveConversation(input: {
    userId: string;
    conversationId: string;
  }): Promise<{ outcome: string }> {
    const result = await sql<{ outcome: string }>`
      select outcome
        from app_private.messaging_leave_conversation(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Leaving a conversation returned no row.');
    return { outcome: row.outcome };
  }

  /** `app_private.messaging_close_conversation(...)` — close, idempotently (Phase 5-E). */
  /**
   * `app_private.messaging_file_report(...)` — report a message or a conversation (Phase 5-H).
   *
   * The reporter is the caller's own id, established from their session before this is reached. 0027 owns
   * the report itself; the function called here owns only the question of whether this caller may report
   * this subject at all.
   */
  async messagingFileReport(input: {
    userId: string;
    subjectType: 'message' | 'conversation';
    subjectId: string;
    reasonCode: string;
  }): Promise<{ outcome: string; reportId: string | null }> {
    const result = await sql<{ outcome: string; report_id: string | null }>`
      select outcome, report_id
        from app_private.messaging_file_report(
          ${input.userId}::uuid,
          ${input.subjectType}::text,
          ${input.subjectId}::uuid,
          ${input.reasonCode}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Filing a report returned no row.');
    return { outcome: row.outcome, reportId: row.report_id ?? null };
  }

  async messagingCloseConversation(input: {
    userId: string;
    conversationId: string;
  }): Promise<{ outcome: string; closedAt: Date | null }> {
    const result = await sql<{ outcome: string; closed_at: Date | null }>`
      select outcome, closed_at
        from app_private.messaging_close_conversation(
          ${input.userId}::uuid,
          ${input.conversationId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Closing a conversation returned no row.');
    return { outcome: row.outcome, closedAt: row.closed_at ?? null };
  }

  /**
   * `app_private.user_identity(uuid)` — the caller's own id and display name (Phase 5-A).
   *
   * No row means no identity: the profile is deleted, or the account never had one. That is returned as
   * `null` rather than raised, because it is an answer and not a failure — the service turns it into the
   * same "no usable session" refusal a missing token gets.
   */
  async userIdentity(userId: string): Promise<{ id: string; displayName: string | null } | null> {
    const result = await sql<{ id: string; display_name: string | null }>`
      select id, display_name from app_private.user_identity(${userId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return { id: row.id, displayName: row.display_name ?? null };
  }

  /* ------------------------------------------------------------------------------------------------------ *
   * Phase 6-I — the seller's own verification submission
   *
   * Six calls, and between them they pass the caller's own user id, a document type, a content type, a size,
   * a path the database itself issued, a filename and a document id. **No call below passes a status, a
   * reviewer, a review time or a decision reason**, because no function accepts one: `approved` and
   * `rejected` are unreachable from this store, not merely unused by it.
   *
   * Every argument is a bound parameter and every function is `app_private`; nothing here builds SQL.
   * ------------------------------------------------------------------------------------------------------ */

  /**
   * `app_private.seller_verification(uuid)` (0063, Phase 6-I): the caller's own attempt and its documents.
   *
   * One argument, the caller. The `documents` column arrives as `jsonb` and is handed on untouched for the
   * service to project field by field — this store does not reshape it, and the function has already left out
   * the object path, the review note, the reviewer and every identifier but each document's own.
   */
  async sellerVerification(userId: string): Promise<SellerVerificationRow> {
    const result = await sql<{
      outcome: string;
      status: string | null;
      submitted_at: Date | null;
      created_at: Date | null;
      email_verified: boolean | null;
      phone_verified: boolean | null;
      document_count: string | number | null;
      documents: unknown;
    }>`
      select outcome, status, submitted_at, created_at, email_verified, phone_verified,
             document_count, documents
        from app_private.seller_verification(${userId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a seller verification returned no row.');
    const count = row.document_count;
    return {
      outcome: row.outcome,
      status: row.status ?? null,
      submittedAt: row.submitted_at ?? null,
      createdAt: row.created_at ?? null,
      emailVerified: row.email_verified ?? null,
      phoneVerified: row.phone_verified ?? null,
      documentCount: count === null || count === undefined ? null : Number(count),
      documents: row.documents,
    };
  }

  /** `app_private.seller_verification_start(uuid)` (0063): open one attempt, always as a draft. */
  async sellerVerificationStart(userId: string): Promise<SellerVerificationStateRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status from app_private.seller_verification_start(${userId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Starting a seller verification returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /**
   * `app_private.seller_verification_document_target(...)` (0063): where the caller may upload.
   *
   * Four arguments and not one of them is a path, a bucket or a seller: the destination comes *back*, derived
   * in the database from the caller's own storefront and a fresh uuid. `bigint` returns as a string over the
   * wire, so the size is parsed rather than assumed to be a number.
   */
  async sellerVerificationDocumentTarget(
    input: SellerVerificationTargetInput,
  ): Promise<SellerVerificationTargetRow> {
    const result = await sql<{
      outcome: string;
      bucket_id: string | null;
      object_path: string | null;
      max_byte_size: string | number | null;
    }>`
      select outcome, bucket_id, object_path, max_byte_size
        from app_private.seller_verification_document_target(
          ${input.userId}::uuid,
          ${input.documentType}::text,
          ${input.contentType}::text,
          ${input.byteSize}::bigint
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Authorizing a verification document upload returned no row.');
    const limit = row.max_byte_size;
    return {
      outcome: row.outcome,
      bucketId: row.bucket_id ?? null,
      objectPath: row.object_path ?? null,
      maxByteSize: limit === null || limit === undefined ? null : Number(limit),
    };
  }

  /** `app_private.seller_verification_document_attach(...)` (0063): record an upload that happened. */
  async sellerVerificationDocumentAttach(
    input: SellerVerificationAttachInput,
  ): Promise<SellerVerificationCountRow> {
    const result = await sql<{ outcome: string; document_count: string | number | null }>`
      select outcome, document_count
        from app_private.seller_verification_document_attach(
          ${input.userId}::uuid,
          ${input.documentType}::text,
          ${input.objectPath}::text,
          ${input.originalFilename}::text,
          ${input.contentType}::text,
          ${input.byteSize}::bigint
        )
    `.execute(this.db);

    return this.#verificationCount(result.rows[0], 'Recording a verification document');
  }

  /**
   * `app_private.seller_verification_document_remove(uuid, uuid)` (0063): remove one of the caller's own.
   *
   * Two arguments, and the first is the caller: ownership is resolved in the function, so this store passes a
   * document id without having established anything about it. A document that is not the caller's, and one on
   * an attempt that has reached the reviewer, both come back `not_found`.
   */
  async sellerVerificationDocumentRemove(
    userId: string,
    documentId: string,
  ): Promise<SellerVerificationCountRow> {
    const result = await sql<{ outcome: string; document_count: string | number | null }>`
      select outcome, document_count
        from app_private.seller_verification_document_remove(${userId}::uuid, ${documentId}::uuid)
    `.execute(this.db);

    return this.#verificationCount(result.rows[0], 'Removing a verification document');
  }

  /** `app_private.seller_verification_submit(uuid)` (0063): draft → submitted. Requires no document. */
  async sellerVerificationSubmit(userId: string): Promise<SellerVerificationStateRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status from app_private.seller_verification_submit(${userId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Submitting a seller verification returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  #verificationCount(
    row: { outcome: string; document_count: string | number | null } | undefined,
    what: string,
  ): SellerVerificationCountRow {
    if (row === undefined) throw new Error(`${what} returned no row.`);
    const count = row.document_count;
    return {
      outcome: row.outcome,
      documentCount: count === null || count === undefined ? null : Number(count),
    };
  }

  /* ------------------------------------------------------------------------------------------------------ *
   * Phase 6-J — the read-only seller surfaces
   *
   * Six calls, every one a select from an `app_private` reader that is declared `stable`. **Not one of them
   * writes**, and none could: there is no insert, update or delete in this section, and the functions they
   * call contain none either.
   *
   * Each passes the caller's own user id and, where the surface pages, a clamped limit and a keyset position.
   * No call passes a seller, an owner, a buyer or a status, because no reader accepts one.
   *
   * `bigint` columns come back as strings from the driver and are kept as strings all the way out: that is how
   * this repository carries every minor amount, and it is what keeps the top of a bigint intact.
   * ------------------------------------------------------------------------------------------------------ */

  /** `app_private.seller_orders(...)` (0064, Phase 6-J): one page of the caller's own orders. */
  async sellerOrders(query: SellerOrdersQuery): Promise<readonly SellerOrderRow[]> {
    const result = await sql<{
      outcome: string;
      order_number: string | null;
      order_type: string | null;
      status: string | null;
      currency_code: string | null;
      currency_decimal_places: number | null;
      subtotal_minor: string | null;
      shipping_total_minor: string | null;
      tax_total_minor: string | null;
      discount_total_minor: string | null;
      commission_total_minor: string | null;
      grand_total_minor: string | null;
      seller_net_minor: string | null;
      item_count: number | null;
      placed_at: Date | null;
      paid_at: Date | null;
      shipped_at: Date | null;
      delivered_at: Date | null;
      completed_at: Date | null;
      cancelled_at: Date | null;
      items: unknown;
    }>`
      select outcome, order_number, order_type, status, currency_code, currency_decimal_places,
             subtotal_minor, shipping_total_minor, tax_total_minor, discount_total_minor,
             commission_total_minor, grand_total_minor, seller_net_minor, item_count,
             placed_at, paid_at, shipped_at, delivered_at, completed_at, cancelled_at, items
        from app_private.seller_orders(
          ${query.userId}::uuid,
          ${query.limit}::integer,
          ${query.cursorPlacedAt}::timestamptz,
          ${query.cursorOrderNumber}::text
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      outcome: row.outcome,
      orderNumber: row.order_number ?? null,
      orderType: row.order_type ?? null,
      status: row.status ?? null,
      currencyCode: row.currency_code ?? null,
      currencyDecimalPlaces:
        row.currency_decimal_places === null || row.currency_decimal_places === undefined
          ? null
          : Number(row.currency_decimal_places),
      subtotalMinor: row.subtotal_minor ?? null,
      shippingTotalMinor: row.shipping_total_minor ?? null,
      taxTotalMinor: row.tax_total_minor ?? null,
      discountTotalMinor: row.discount_total_minor ?? null,
      commissionTotalMinor: row.commission_total_minor ?? null,
      grandTotalMinor: row.grand_total_minor ?? null,
      sellerNetMinor: row.seller_net_minor ?? null,
      itemCount: row.item_count === null || row.item_count === undefined ? null : Number(row.item_count),
      placedAt: row.placed_at ?? null,
      paidAt: row.paid_at ?? null,
      shippedAt: row.shipped_at ?? null,
      deliveredAt: row.delivered_at ?? null,
      completedAt: row.completed_at ?? null,
      cancelledAt: row.cancelled_at ?? null,
      items: row.items,
    }));
  }

  /** `app_private.seller_reviews(...)` (0064, Phase 6-J): one page of the caller's own reviews. */
  async sellerReviews(query: SellerReviewsQuery): Promise<readonly SellerReviewRow[]> {
    const result = await sql<{
      outcome: string;
      order_number: string | null;
      rating: number | null;
      title: string | null;
      body: string | null;
      status: string | null;
      published_at: Date | null;
      created_at: Date | null;
      reply_body: string | null;
      reply_status: string | null;
      reply_created_at: Date | null;
    }>`
      select outcome, order_number, rating, title, body, status, published_at, created_at,
             reply_body, reply_status, reply_created_at
        from app_private.seller_reviews(
          ${query.userId}::uuid,
          ${query.limit}::integer,
          ${query.cursorCreatedAt}::timestamptz,
          ${query.cursorOrderNumber}::text
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      outcome: row.outcome,
      orderNumber: row.order_number ?? null,
      rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
      title: row.title ?? null,
      body: row.body ?? null,
      status: row.status ?? null,
      publishedAt: row.published_at ?? null,
      createdAt: row.created_at ?? null,
      replyBody: row.reply_body ?? null,
      replyStatus: row.reply_status ?? null,
      replyCreatedAt: row.reply_created_at ?? null,
    }));
  }

  /**
   * `app_private.seller_reviews_summary(uuid)` (0064, Phase 6-J): the seller_ratings aggregate.
   *
   * Passed through unchanged. The average stays in basis points, which is the unit the view produces; this
   * store converts nothing, because converting it would be re-deciding a rounding rule already settled.
   */
  async sellerReviewsSummary(userId: string): Promise<SellerReviewSummaryRow> {
    const result = await sql<{
      outcome: string;
      review_count: number | null;
      average_rating_basis_points: number | null;
      five_star_count: number | null;
      four_star_count: number | null;
      three_star_count: number | null;
      two_star_count: number | null;
      one_star_count: number | null;
      latest_review_at: Date | null;
    }>`
      select outcome, review_count, average_rating_basis_points, five_star_count, four_star_count,
             three_star_count, two_star_count, one_star_count, latest_review_at
        from app_private.seller_reviews_summary(${userId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a seller rating summary returned no row.');
    const asNumber = (value: number | null | undefined): number | null =>
      value === null || value === undefined ? null : Number(value);
    return {
      outcome: row.outcome,
      reviewCount: asNumber(row.review_count),
      averageRatingBasisPoints: asNumber(row.average_rating_basis_points),
      fiveStarCount: asNumber(row.five_star_count),
      fourStarCount: asNumber(row.four_star_count),
      threeStarCount: asNumber(row.three_star_count),
      twoStarCount: asNumber(row.two_star_count),
      oneStarCount: asNumber(row.one_star_count),
      latestReviewAt: row.latest_review_at ?? null,
    };
  }

  /**
   * `app_private.seller_earnings(uuid)` (0064, Phase 6-J): the caller's own balances.
   *
   * Reads no ledger entry, journal, payout, payout destination or withdrawal — the reader touches none of
   * them — so there is nothing in this method that could carry a provider reference or destination material.
   */
  async sellerEarnings(userId: string): Promise<readonly SellerBalanceRow[]> {
    const result = await sql<{
      outcome: string;
      currency_code: string | null;
      currency_decimal_places: number | null;
      pending_minor: string | null;
      available_minor: string | null;
      reserved_minor: string | null;
      updated_at: Date | null;
    }>`
      select outcome, currency_code, currency_decimal_places, pending_minor, available_minor,
             reserved_minor, updated_at
        from app_private.seller_earnings(${userId}::uuid)
    `.execute(this.db);

    return result.rows.map((row) => ({
      outcome: row.outcome,
      currencyCode: row.currency_code ?? null,
      currencyDecimalPlaces:
        row.currency_decimal_places === null || row.currency_decimal_places === undefined
          ? null
          : Number(row.currency_decimal_places),
      pendingMinor: row.pending_minor ?? null,
      availableMinor: row.available_minor ?? null,
      reservedMinor: row.reserved_minor ?? null,
      updatedAt: row.updated_at ?? null,
    }));
  }

  /** `app_private.seller_promotions(...)` (0064, Phase 6-J): one page of the caller's own promotions. */
  async sellerPromotions(query: SellerPromotionsQuery): Promise<readonly SellerPromotionRow[]> {
    const result = await sql<{
      outcome: string;
      listing_slug: string | null;
      listing_title: string | null;
      status: string | null;
      currency_code: string | null;
      currency_decimal_places: number | null;
      price_minor: string | null;
      refunded_amount_minor: string | null;
      priority: number | null;
      duration_days: number | null;
      starts_at: Date | null;
      ends_at: Date | null;
      activated_at: Date | null;
      paused_at: Date | null;
      expired_at: Date | null;
      cancelled_at: Date | null;
      created_at: Date | null;
      cursor_id: string | null;
    }>`
      select outcome, listing_slug, listing_title, status, currency_code, currency_decimal_places,
             price_minor, refunded_amount_minor, priority, duration_days, starts_at, ends_at,
             activated_at, paused_at, expired_at, cancelled_at, created_at, cursor_id
        from app_private.seller_promotions(
          ${query.userId}::uuid,
          ${query.limit}::integer,
          ${query.cursorCreatedAt}::timestamptz,
          ${query.cursorId}::uuid
        )
    `.execute(this.db);

    const asNumber = (value: number | null | undefined): number | null =>
      value === null || value === undefined ? null : Number(value);
    return result.rows.map((row) => ({
      outcome: row.outcome,
      listingSlug: row.listing_slug ?? null,
      listingTitle: row.listing_title ?? null,
      status: row.status ?? null,
      currencyCode: row.currency_code ?? null,
      currencyDecimalPlaces: asNumber(row.currency_decimal_places),
      priceMinor: row.price_minor ?? null,
      refundedAmountMinor: row.refunded_amount_minor ?? null,
      priority: asNumber(row.priority),
      durationDays: asNumber(row.duration_days),
      startsAt: row.starts_at ?? null,
      endsAt: row.ends_at ?? null,
      activatedAt: row.activated_at ?? null,
      pausedAt: row.paused_at ?? null,
      expiredAt: row.expired_at ?? null,
      cancelledAt: row.cancelled_at ?? null,
      createdAt: row.created_at ?? null,
      cursorId: row.cursor_id ?? null,
    }));
  }

  /**
   * `app_private.seller_promotion_analytics(uuid, integer)` (0064, Phase 6-J).
   *
   * The rollup's own impressions, views and clicks, summed in the database. This method computes nothing: no
   * rate, no ratio, no click-through. The totals are bigint sums and stay strings.
   */
  async sellerPromotionAnalytics(
    userId: string,
    days: number,
  ): Promise<readonly SellerPromotionPerformanceRow[]> {
    const result = await sql<{
      outcome: string;
      listing_slug: string | null;
      listing_title: string | null;
      status: string | null;
      first_day: Date | string | null;
      last_day: Date | string | null;
      impressions: string | null;
      views: string | null;
      clicks: string | null;
    }>`
      select outcome, listing_slug, listing_title, status, first_day, last_day,
             impressions, views, clicks
        from app_private.seller_promotion_analytics(${userId}::uuid, ${days}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({
      outcome: row.outcome,
      listingSlug: row.listing_slug ?? null,
      listingTitle: row.listing_title ?? null,
      status: row.status ?? null,
      firstDay: row.first_day ?? null,
      lastDay: row.last_day ?? null,
      impressions: row.impressions ?? null,
      views: row.views ?? null,
      clicks: row.clicks ?? null,
    }));
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* 0102 — listing analytics: the rollup's two readers                                              */
  /*                                                                                                 */
  /* Two calls, both to named SECURITY DEFINER functions, and neither of them to the rollup itself:   */
  /* `rollup_listing_analytics` is granted to nobody and runs only through the scheduled-job          */
  /* dispatcher, so there is no method here that could write a rollup row.                            */
  /* ---------------------------------------------------------------------------------------------- */

  /** `app_private.seller_listing_analytics(uuid, integer)` (0102). Ownership-scoped; no permission key. */
  async sellerListingAnalytics(
    userId: string,
    days: number,
  ): Promise<readonly SellerListingPerformanceRow[]> {
    const result = await sql<{
      outcome: string;
      listing_slug: string | null;
      listing_title: string | null;
      listing_status: string | null;
      first_day: Date | string | null;
      last_day: Date | string | null;
      clicks: string | null;
      contacts: string | null;
      favorites: string | null;
      shares: string | null;
    }>`
      select outcome, listing_slug, listing_title, listing_status, first_day, last_day,
             clicks, contacts, favorites, shares
        from app_private.seller_listing_analytics(${userId}::uuid, ${days}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({
      outcome: row.outcome,
      listingSlug: row.listing_slug ?? null,
      listingTitle: row.listing_title ?? null,
      listingStatus: row.listing_status ?? null,
      firstDay: row.first_day ?? null,
      lastDay: row.last_day ?? null,
      clicks: row.clicks ?? null,
      contacts: row.contacts ?? null,
      favorites: row.favorites ?? null,
      shares: row.shares ?? null,
    }));
  }

  /**
   * `app_private.listing_analytics_page(uuid, boolean, integer, integer, date, uuid)` (0102).
   *
   * The permission and the assurance level are **parameters**, so the function decides and this gateway does
   * not: a caller who may not read receives no rows, which is the same answer as an empty window.
   */
  async listingAnalyticsPage(input: {
    userId: string;
    isAal2: boolean;
    days: number;
    limit: number;
    cursorDay: string | null;
    cursorListingId: string | null;
  }): Promise<readonly ListingAnalyticsDbRow[]> {
    const result = await sql<{
      day: Date | string;
      listing_slug: string;
      listing_title: string;
      listing_status: string;
      seller_slug: string | null;
      clicks: string;
      contacts: string;
      favorites: string;
      shares: string;
      computed_at: Date | string;
      cursor_day: Date | string;
      cursor_listing_id: string;
    }>`
      select day, listing_slug, listing_title, listing_status, seller_slug,
             clicks, contacts, favorites, shares, computed_at, cursor_day, cursor_listing_id
        from app_private.listing_analytics_page(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.days}::integer,
          ${input.limit}::integer,
          ${input.cursorDay}::date,
          ${input.cursorListingId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      day: row.day,
      listingSlug: row.listing_slug,
      listingTitle: row.listing_title,
      listingStatus: row.listing_status,
      sellerSlug: row.seller_slug ?? null,
      clicks: row.clicks,
      contacts: row.contacts,
      favorites: row.favorites,
      shares: row.shares,
      computedAt: row.computed_at,
      cursorDay: row.cursor_day,
      cursorListingId: row.cursor_listing_id,
    }));
  }


  /* ---------------------------------------------------------------------------------------------- */
  /* Phase 7-E — the buyer account surfaces (migration 0067)                                          */
  /*                                                                                                 */
  /* Sixteen calls, every one of them to a named SECURITY DEFINER function, and every one of them     */
  /* taking the account the API resolved from the caller's own access token. None takes two accounts, */
  /* and none reads a table: `app_system` holds no table privilege on any of the five, so a direct    */
  /* read would be refused by the database rather than by a review.                                   */
  /* ---------------------------------------------------------------------------------------------- */

  /** `app_private.buyer_favorites` (0067). The card columns are null for a listing no longer visible. */
  async buyerFavorites(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly FavoriteRow[]> {
    const result = await sql<Record<string, unknown>>`
      select listing_id, created_at, is_available, slug, title, city, price_minor,
             currency_code, currency_minor_unit, is_negotiable, listing_type_code
        from app_private.buyer_favorites(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      listingId: row['listing_id'] as string,
      createdAt: row['created_at'] as Date,
      isAvailable: row['is_available'] === true,
      slug: (row['slug'] as string | null) ?? null,
      title: (row['title'] as string | null) ?? null,
      city: (row['city'] as string | null) ?? null,
      priceMinor: row['price_minor'] === null || row['price_minor'] === undefined ? null : String(row['price_minor']),
      currencyCode: (row['currency_code'] as string | null) ?? null,
      currencyMinorUnit:
        row['currency_minor_unit'] === null || row['currency_minor_unit'] === undefined
          ? null
          : Number(row['currency_minor_unit']),
      isNegotiable: (row['is_negotiable'] as boolean | null) ?? null,
      listingTypeCode: (row['listing_type_code'] as string | null) ?? null,
    }));
  }

  /** `app_private.buyer_favorite_add` (0067). `not_found` is a listing that is not publicly visible. */
  async buyerFavoriteAdd(input: {
    userId: string;
    listingId: string;
  }): Promise<'added' | 'exists' | 'not_found'> {
    const result = await sql<{ outcome: 'added' | 'exists' | 'not_found' }>`
      select app_private.buyer_favorite_add(${input.userId}::uuid, ${input.listingId}::uuid) as outcome
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Saving a favorite returned no row.');
    return row.outcome;
  }

  /** `app_private.buyer_favorite_remove` (0067). False when there was nothing to remove. */
  async buyerFavoriteRemove(input: { userId: string; listingId: string }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.buyer_favorite_remove(${input.userId}::uuid, ${input.listingId}::uuid) as removed
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Removing a favorite returned no row.');
    return row.removed === true;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Blocking (0103)                                                                                 */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * `app_private.buyer_blocks` (0103).
   *
   * Scoped to the caller inside the function, so a row belonging to anybody else is never matched rather
   * than refused. `blocked_user_id` comes back here and the service turns it into an opaque reference; it
   * reaches no response.
   */
  async buyerBlocks(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorBlockedId: string | null;
  }): Promise<readonly BlockRow[]> {
    const result = await sql<Record<string, unknown>>`
      select blocked_user_id, display_name, seller_slug, reason, created_at
        from app_private.buyer_blocks(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorBlockedId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      blockedUserId: row['blocked_user_id'] as string,
      displayName: (row['display_name'] as string | null) ?? null,
      sellerSlug: (row['seller_slug'] as string | null) ?? null,
      reason: (row['reason'] as string | null) ?? null,
      createdAt: row['created_at'] as Date,
    }));
  }

  /**
   * `app_private.buyer_block_add` (0103).
   *
   * Both handles are passed as parameters and exactly one of them is non-null; the function refuses a call
   * carrying both. `not_found` is the single answer for every handle that resolves to nobody.
   */
  async buyerBlockAdd(input: {
    userId: string;
    conversationId: string | null;
    sellerSlug: string | null;
    reason: string | null;
  }): Promise<'blocked' | 'exists' | 'not_found'> {
    const result = await sql<{ outcome: 'blocked' | 'exists' | 'not_found' }>`
      select app_private.buyer_block_add(
        ${input.userId}::uuid,
        ${input.conversationId}::uuid,
        ${input.sellerSlug}::text,
        ${input.reason}::text
      ) as outcome
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Creating a block returned no row.');
    return row.outcome;
  }

  /** `app_private.buyer_block_remove` (0103). False when there was nothing to remove. */
  async buyerBlockRemove(input: { userId: string; blockedUserId: string }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.buyer_block_remove(${input.userId}::uuid, ${input.blockedUserId}::uuid) as removed
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Removing a block returned no row.');
    return row.removed === true;
  }

  /** `app_private.buyer_saved_searches` (0067). */
  async buyerSavedSearches(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SavedSearchRow[]> {
    const result = await sql<Record<string, unknown>>`
      select id, name, query, notify, last_matched_at, last_notified_at, created_at, updated_at
        from app_private.buyer_saved_searches(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row['id'] as string,
      name: row['name'] as string,
      query: row['query'],
      notify: row['notify'] === true,
      lastMatchedAt: (row['last_matched_at'] as Date | null) ?? null,
      lastNotifiedAt: (row['last_notified_at'] as Date | null) ?? null,
      createdAt: row['created_at'] as Date,
      updatedAt: row['updated_at'] as Date,
    }));
  }

  /** `app_private.buyer_saved_search_create` (0067). */
  async buyerSavedSearchCreate(input: {
    userId: string;
    name: string;
    query: unknown;
    notify: boolean;
  }): Promise<{ outcome: 'created' | 'duplicate_name'; id: string | null }> {
    const result = await sql<{ outcome: 'created' | 'duplicate_name'; id: string | null }>`
      select outcome, id
        from app_private.buyer_saved_search_create(
          ${input.userId}::uuid,
          ${input.name}::text,
          ${JSON.stringify(input.query ?? {})}::jsonb,
          ${input.notify}::boolean
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Creating a saved search returned no row.');
    return { outcome: row.outcome, id: row.id ?? null };
  }

  /** `app_private.buyer_saved_search_update` (0067). Never writes either matching timestamp. */
  async buyerSavedSearchUpdate(input: {
    userId: string;
    id: string;
    name: string;
    query: unknown;
    notify: boolean;
  }): Promise<'updated' | 'not_found' | 'duplicate_name'> {
    const result = await sql<{ outcome: 'updated' | 'not_found' | 'duplicate_name' }>`
      select app_private.buyer_saved_search_update(
        ${input.userId}::uuid,
        ${input.id}::uuid,
        ${input.name}::text,
        ${JSON.stringify(input.query ?? {})}::jsonb,
        ${input.notify}::boolean
      ) as outcome
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Editing a saved search returned no row.');
    return row.outcome;
  }

  /** `app_private.buyer_saved_search_delete` (0067). */
  async buyerSavedSearchDelete(input: { userId: string; id: string }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.buyer_saved_search_delete(${input.userId}::uuid, ${input.id}::uuid) as removed
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Deleting a saved search returned no row.');
    return row.removed === true;
  }

  /** `app_private.buyer_addresses` (0067). Defaults first; removed addresses are absent. */
  async buyerAddresses(userId: string): Promise<readonly AddressRow[]> {
    const result = await sql<Record<string, unknown>>`
      select id, label, purpose, recipient_name, phone_e164, country_code, governorate, city,
             district, street_address, building, apartment, postal_code, landmark,
             is_default_shipping, is_default_billing, created_at, updated_at
        from app_private.buyer_addresses(${userId}::uuid)
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row['id'] as string,
      label: (row['label'] as string | null) ?? null,
      purpose: row['purpose'] as string,
      recipientName: row['recipient_name'] as string,
      phoneE164: row['phone_e164'] as string,
      countryCode: row['country_code'] as string,
      governorate: row['governorate'] as string,
      city: row['city'] as string,
      district: (row['district'] as string | null) ?? null,
      streetAddress: row['street_address'] as string,
      building: (row['building'] as string | null) ?? null,
      apartment: (row['apartment'] as string | null) ?? null,
      postalCode: (row['postal_code'] as string | null) ?? null,
      landmark: (row['landmark'] as string | null) ?? null,
      isDefaultShipping: row['is_default_shipping'] === true,
      isDefaultBilling: row['is_default_billing'] === true,
      createdAt: row['created_at'] as Date,
      updatedAt: row['updated_at'] as Date,
    }));
  }

  /** `app_private.buyer_address_create` (0067). D17 arrives as a named outcome, never a raw error. */
  async buyerAddressCreate(input: {
    userId: string;
    address: AddressInput;
  }): Promise<{ outcome: 'created' | 'country_not_enabled' | 'invalid_country'; id: string | null }> {
    const a = input.address;
    const result = await sql<{
      outcome: 'created' | 'country_not_enabled' | 'invalid_country';
      id: string | null;
    }>`
      select outcome, id
        from app_private.buyer_address_create(
          ${input.userId}::uuid,
          ${a.label ?? null}::text,
          ${a.purpose}::text,
          ${a.recipientName}::text,
          ${a.phoneE164}::text,
          ${a.countryCode}::text,
          ${a.governorate}::text,
          ${a.city}::text,
          ${a.district ?? null}::text,
          ${a.streetAddress}::text,
          ${a.building ?? null}::text,
          ${a.apartment ?? null}::text,
          ${a.postalCode ?? null}::text,
          ${a.landmark ?? null}::text,
          ${a.isDefaultShipping ?? false}::boolean,
          ${a.isDefaultBilling ?? false}::boolean
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Creating an address returned no row.');
    return { outcome: row.outcome, id: row.id ?? null };
  }

  /** `app_private.buyer_address_update` (0067). */
  async buyerAddressUpdate(input: {
    userId: string;
    id: string;
    address: AddressInput;
  }): Promise<'updated' | 'not_found' | 'country_not_enabled' | 'invalid_country'> {
    const a = input.address;
    const result = await sql<{
      outcome: 'updated' | 'not_found' | 'country_not_enabled' | 'invalid_country';
    }>`
      select app_private.buyer_address_update(
        ${input.userId}::uuid,
        ${input.id}::uuid,
        ${a.label ?? null}::text,
        ${a.purpose}::text,
        ${a.recipientName}::text,
        ${a.phoneE164}::text,
        ${a.countryCode}::text,
        ${a.governorate}::text,
        ${a.city}::text,
        ${a.district ?? null}::text,
        ${a.streetAddress}::text,
        ${a.building ?? null}::text,
        ${a.apartment ?? null}::text,
        ${a.postalCode ?? null}::text,
        ${a.landmark ?? null}::text,
        ${a.isDefaultShipping ?? false}::boolean,
        ${a.isDefaultBilling ?? false}::boolean
      ) as outcome
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Editing an address returned no row.');
    return row.outcome;
  }

  /** `app_private.buyer_address_delete` (0067). A soft delete that clears the default flags. */
  async buyerAddressDelete(input: { userId: string; id: string }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.buyer_address_delete(${input.userId}::uuid, ${input.id}::uuid) as removed
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Removing an address returned no row.');
    return row.removed === true;
  }

  /** `app_private.buyer_profile` (0067). No row for a deleted profile. */
  async buyerProfile(userId: string): Promise<BuyerProfileRow | null> {
    const result = await sql<Record<string, unknown>>`
      select id, display_name, full_name, phone_e164, locale_code, timezone, status,
             email_verified_at, phone_verified_at, created_at
        from app_private.buyer_profile(${userId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row['id'] as string,
      displayName: (row['display_name'] as string | null) ?? null,
      fullName: (row['full_name'] as string | null) ?? null,
      phoneE164: (row['phone_e164'] as string | null) ?? null,
      localeCode: (row['locale_code'] as string | null) ?? null,
      timezone: row['timezone'] as string,
      status: row['status'] as string,
      emailVerifiedAt: (row['email_verified_at'] as Date | null) ?? null,
      phoneVerifiedAt: (row['phone_verified_at'] as Date | null) ?? null,
      createdAt: row['created_at'] as Date,
    };
  }

  /**
   * `app_private.buyer_profile_update` (0067).
   *
   * Four columns, and the function admits no others: there is no argument here for a phone number, a
   * verification timestamp, a status or a role, so no request shape could reach one.
   */
  async buyerProfileUpdate(input: {
    userId: string;
    displayName: string | null;
    fullName: string | null;
    localeCode: string | null;
    timezone: string | null;
  }): Promise<'updated' | 'not_found' | 'invalid_locale' | 'invalid_timezone'> {
    const result = await sql<{
      outcome: 'updated' | 'not_found' | 'invalid_locale' | 'invalid_timezone';
    }>`
      select app_private.buyer_profile_update(
        ${input.userId}::uuid,
        ${input.displayName}::text,
        ${input.fullName}::text,
        ${input.localeCode}::text,
        ${input.timezone}::text
      ) as outcome
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Editing a profile returned no row.');
    return row.outcome;
  }

  /** `app_private.buyer_settings` (0067). The free-form preferences object is never selected. */
  async buyerSettings(userId: string): Promise<BuyerSettingsRow | null> {
    const result = await sql<Record<string, unknown>>`
      select notify_email, notify_sms, notify_whatsapp, notify_in_app, marketing_opt_in, digit_style
        from app_private.buyer_settings(${userId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      notifyEmail: row['notify_email'] === true,
      notifySms: row['notify_sms'] === true,
      notifyWhatsapp: row['notify_whatsapp'] === true,
      notifyInApp: row['notify_in_app'] === true,
      marketingOptIn: row['marketing_opt_in'] === true,
      digitStyle: (row['digit_style'] as string | null) ?? null,
    };
  }

  /** `app_private.buyer_settings_update` (0067). A whole-state write; idempotent by construction. */
  async buyerSettingsUpdate(input: {
    userId: string;
    settings: UpdateBuyerSettingsRequest;
  }): Promise<boolean> {
    const s = input.settings;
    const result = await sql<{ written: boolean }>`
      select app_private.buyer_settings_update(
        ${input.userId}::uuid,
        ${s.notifyEmail}::boolean,
        ${s.notifySms}::boolean,
        ${s.notifyWhatsapp}::boolean,
        ${s.notifyInApp}::boolean,
        ${s.marketingOptIn}::boolean,
        ${s.digitStyle}::text
      ) as written
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Writing settings returned no row.');
    return row.written === true;
  }

  /** `app_private.reference_countries` (0067). Public reference data; takes no account. */
  async referenceCountries(): Promise<readonly CountryRow[]> {
    const result = await sql<Record<string, unknown>>`
      select code, name_en, name_ar, phone_code, is_marketplace_enabled
        from app_private.reference_countries()
    `.execute(this.db);

    return result.rows.map((row) => ({
      code: row['code'] as string,
      nameEn: row['name_en'] as string,
      nameAr: row['name_ar'] as string,
      phoneCode: row['phone_code'] as string,
      isMarketplaceEnabled: row['is_marketplace_enabled'] === true,
    }));
  }


  /**
   * `app_private.staff_console_access` (0068, Phase 7-F).
   *
   * The account and the assurance level are both parameters, and both are values the API established:
   * the account from the provider's answer about the token, the level from that same validated token's
   * own claim. Neither is ever taken from a request body, a header a browser controls or a query
   * string. The function applies 0003's `requires_mfa` rule itself, so what comes back is already the
   * effective set.
   */
  async staffConsoleAccess(input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> {
    const result = await sql<{
      has_console_role: boolean;
      requires_step_up: boolean;
      roles: string[] | null;
      permissions: string[] | null;
    }>`
      select has_console_role, requires_step_up, roles, permissions
        from app_private.staff_console_access(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    const row = result.rows[0];
    // Fail closed: an answer we did not get is not an answer that grants anything.
    if (row === undefined) throw new Error('Reading a console session returned no row.');
    return {
      hasConsoleRole: row.has_console_role === true,
      requiresStepUp: row.requires_step_up === true,
      roles: row.roles ?? [],
      permissions: row.permissions ?? [],
    };
  }

  /* ------------------------------------------------------------------------------------------------ */
  /* Phase 7-G — the seller verification review functions of migration 0069                            */
  /* ------------------------------------------------------------------------------------------------ */

  /**
   * `app_private.verification_review_queue(...)` (0069).
   *
   * The reviewer and the assurance level are parameters, both established by the API from a token the
   * provider validated — never from a request. The status filter and the cursor are **values**, bound as
   * parameters: no part of this statement is built from them, and the ordering is fixed in the function.
   */
  async verificationReviewQueue(input: {
    reviewerId: string;
    isAal2: boolean;
    status: string | null;
    limit: number;
    cursorSubmittedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly VerificationQueueRow[]> {
    const result = await sql<{
      id: string;
      status: string;
      submitted_at: Date | null;
      created_at: Date | null;
      reviewed_at: Date | null;
      email_verified: boolean | null;
      phone_verified: boolean | null;
      document_count: string | number | null;
      seller_slug: string | null;
      seller_display_name: string | null;
      seller_status: string | null;
      seller_verification_status: string | null;
    }>`
      select id, status, submitted_at, created_at, reviewed_at, email_verified, phone_verified,
             document_count, seller_slug, seller_display_name, seller_status, seller_verification_status
        from app_private.verification_review_queue(
          ${input.reviewerId}::uuid,
          ${input.isAal2}::boolean,
          ${input.status}::text,
          ${input.limit}::integer,
          ${input.cursorSubmittedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => {
      const count = row.document_count;
      return {
        id: row.id,
        status: row.status,
        submittedAt: row.submitted_at ?? null,
        createdAt: row.created_at ?? null,
        reviewedAt: row.reviewed_at ?? null,
        emailVerified: row.email_verified ?? null,
        phoneVerified: row.phone_verified ?? null,
        documentCount: count === null || count === undefined ? null : Number(count),
        sellerSlug: row.seller_slug ?? null,
        sellerDisplayName: row.seller_display_name ?? null,
        sellerStatus: row.seller_status ?? null,
        sellerVerificationStatus: row.seller_verification_status ?? null,
      };
    });
  }

  /** `app_private.verification_review_detail(uuid, boolean, uuid)` (0069). */
  async verificationReviewDetail(input: {
    reviewerId: string;
    isAal2: boolean;
    verificationId: string;
  }): Promise<VerificationDetailRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      status: string | null;
      submitted_at: Date | null;
      created_at: Date | null;
      updated_at: Date | null;
      reviewed_at: Date | null;
      decision_reason: string | null;
      expires_at: Date | null;
      email_verified: boolean | null;
      phone_verified: boolean | null;
      seller_slug: string | null;
      seller_display_name: string | null;
      seller_legal_name: string | null;
      seller_country_code: string | null;
      seller_governorate: string | null;
      seller_city: string | null;
      seller_contact_email: string | null;
      seller_contact_phone: string | null;
      seller_status: string | null;
      seller_verification_status: string | null;
      seller_created_at: Date | null;
      documents: unknown;
    }>`
      select outcome, id, status, submitted_at, created_at, updated_at, reviewed_at, decision_reason,
             expires_at, email_verified, phone_verified, seller_slug, seller_display_name,
             seller_legal_name, seller_country_code, seller_governorate, seller_city,
             seller_contact_email, seller_contact_phone, seller_status, seller_verification_status,
             seller_created_at, documents
        from app_private.verification_review_detail(
          ${input.reviewerId}::uuid,
          ${input.isAal2}::boolean,
          ${input.verificationId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a verification submission returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      status: row.status ?? null,
      submittedAt: row.submitted_at ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      reviewedAt: row.reviewed_at ?? null,
      decisionReason: row.decision_reason ?? null,
      expiresAt: row.expires_at ?? null,
      emailVerified: row.email_verified ?? null,
      phoneVerified: row.phone_verified ?? null,
      sellerSlug: row.seller_slug ?? null,
      sellerDisplayName: row.seller_display_name ?? null,
      sellerLegalName: row.seller_legal_name ?? null,
      sellerCountryCode: row.seller_country_code ?? null,
      sellerGovernorate: row.seller_governorate ?? null,
      sellerCity: row.seller_city ?? null,
      sellerContactEmail: row.seller_contact_email ?? null,
      sellerContactPhone: row.seller_contact_phone ?? null,
      sellerStatus: row.seller_status ?? null,
      sellerVerificationStatus: row.seller_verification_status ?? null,
      sellerCreatedAt: row.seller_created_at ?? null,
      documents: row.documents,
    };
  }

  /**
   * `app_private.verification_review_document(uuid, boolean, uuid)` (0069).
   *
   * Three arguments and not one of them is a path or a bucket: the location comes *back*, read from the
   * row the document id names, exactly as 6-I's upload target does in the other direction.
   */
  async verificationReviewDocument(input: {
    reviewerId: string;
    isAal2: boolean;
    documentId: string;
  }): Promise<VerificationDocumentRow> {
    const result = await sql<{
      outcome: string;
      verification_id: string | null;
      bucket_id: string | null;
      object_path: string | null;
      content_type: string | null;
      original_filename: string | null;
    }>`
      select outcome, verification_id, bucket_id, object_path, content_type, original_filename
        from app_private.verification_review_document(
          ${input.reviewerId}::uuid,
          ${input.isAal2}::boolean,
          ${input.documentId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Locating a verification document returned no row.');
    return {
      outcome: row.outcome,
      verificationId: row.verification_id ?? null,
      bucketId: row.bucket_id ?? null,
      objectPath: row.object_path ?? null,
      contentType: row.content_type ?? null,
      originalFilename: row.original_filename ?? null,
    };
  }

  /**
   * `app_private.verification_review_decide(uuid, boolean, uuid, text, text)` (0069).
   *
   * The whole of 7-G's write surface. The reviewer is a parameter the API established from a validated
   * token; the decision is one of two values the contract admits. There is no status here that the
   * seller's own flow owns, and no second statement — the function locks the row, applies 0009's rules
   * and performs 0009's own UPDATE.
   */
  async verificationReviewDecide(input: {
    reviewerId: string;
    isAal2: boolean;
    verificationId: string;
    decision: string;
    reason: string | null;
  }): Promise<VerificationDecisionRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.verification_review_decide(
          ${input.reviewerId}::uuid,
          ${input.isAal2}::boolean,
          ${input.verificationId}::uuid,
          ${input.decision}::text,
          ${input.reason}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a verification decision returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /* ------------------------------------------------------------------------------------------------ */
  /* Phase 7-H — the offer functions of migration 0070                                                 */
  /* ------------------------------------------------------------------------------------------------ */

  /**
   * `app_private.offers_for_buyer(...)` (0070).
   *
   * The account is a parameter and appears in the function's own predicate, so this call cannot ask about
   * anybody else's negotiations. `amount_minor` is a `bigint` and arrives as a string; it stays one.
   */
  async offersForBuyer(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly OfferRow[]> {
    const result = await sql<{
      id: string;
      listing_id: string;
      listing_slug: string | null;
      listing_title: string | null;
      seller_slug: string | null;
      seller_display_name: string | null;
      amount_minor: string | number | null;
      currency_code: string | null;
      currency_minor_unit: number | null;
      quantity: number | null;
      message: string | null;
      status: string;
      is_lapsed: boolean | null;
      expires_at: Date | null;
      responded_at: Date | null;
      accepted_at: Date | null;
      payment_due_at: Date | null;
      parent_offer_id: string | null;
      created_at: Date | null;
    }>`
      select id, listing_id, listing_slug, listing_title, seller_slug, seller_display_name,
             amount_minor, currency_code, currency_minor_unit, quantity, message, status, is_lapsed,
             expires_at, responded_at, accepted_at, payment_due_at, parent_offer_id, created_at
        from app_private.offers_for_buyer(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      listingId: row.listing_id,
      listingSlug: row.listing_slug ?? null,
      listingTitle: row.listing_title ?? null,
      sellerSlug: row.seller_slug ?? null,
      sellerDisplayName: row.seller_display_name ?? null,
      amountMinor: row.amount_minor ?? null,
      currencyCode: row.currency_code ?? null,
      currencyMinorUnit: row.currency_minor_unit === null || row.currency_minor_unit === undefined
        ? null
        : Number(row.currency_minor_unit),
      quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
      message: row.message ?? null,
      status: row.status,
      isLapsed: row.is_lapsed ?? null,
      expiresAt: row.expires_at ?? null,
      respondedAt: row.responded_at ?? null,
      acceptedAt: row.accepted_at ?? null,
      paymentDueAt: row.payment_due_at ?? null,
      parentOfferId: row.parent_offer_id ?? null,
      createdAt: row.created_at ?? null,
    }));
  }

  /** `app_private.offers_for_seller(...)` (0070): the same page from the other side. */
  async offersForSeller(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SellerOfferRow[]> {
    const result = await sql<{
      id: string;
      listing_id: string;
      listing_slug: string | null;
      listing_title: string | null;
      buyer_display_name: string | null;
      amount_minor: string | number | null;
      currency_code: string | null;
      currency_minor_unit: number | null;
      quantity: number | null;
      message: string | null;
      status: string;
      is_lapsed: boolean | null;
      expires_at: Date | null;
      responded_at: Date | null;
      accepted_at: Date | null;
      payment_due_at: Date | null;
      parent_offer_id: string | null;
      created_at: Date | null;
    }>`
      select id, listing_id, listing_slug, listing_title, buyer_display_name,
             amount_minor, currency_code, currency_minor_unit, quantity, message, status, is_lapsed,
             expires_at, responded_at, accepted_at, payment_due_at, parent_offer_id, created_at
        from app_private.offers_for_seller(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      listingId: row.listing_id,
      listingSlug: row.listing_slug ?? null,
      listingTitle: row.listing_title ?? null,
      buyerDisplayName: row.buyer_display_name ?? null,
      amountMinor: row.amount_minor ?? null,
      currencyCode: row.currency_code ?? null,
      currencyMinorUnit: row.currency_minor_unit === null || row.currency_minor_unit === undefined
        ? null
        : Number(row.currency_minor_unit),
      quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
      message: row.message ?? null,
      status: row.status,
      isLapsed: row.is_lapsed ?? null,
      expiresAt: row.expires_at ?? null,
      respondedAt: row.responded_at ?? null,
      acceptedAt: row.accepted_at ?? null,
      paymentDueAt: row.payment_due_at ?? null,
      parentOfferId: row.parent_offer_id ?? null,
      createdAt: row.created_at ?? null,
    }));
  }

  /**
   * `app_private.offer_create(...)` (0070).
   *
   * Five arguments and not one of them is a seller, a currency or an expiry: all three are derived in the
   * database from the listing, which is why a caller cannot name a seller who is not the listing's.
   */
  async offerCreate(input: {
    buyerId: string;
    listingId: string;
    amountMinor: string;
    quantity: number;
    message: string | null;
  }): Promise<OfferMutationRow> {
    const result = await sql<{ outcome: string; offer_id: string | null; status: string | null }>`
      select outcome, offer_id, status
        from app_private.offer_create(
          ${input.buyerId}::uuid,
          ${input.listingId}::uuid,
          ${input.amountMinor}::bigint,
          ${input.quantity}::integer,
          ${input.message}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Opening an offer returned no row.');
    return { outcome: row.outcome, offerId: row.offer_id ?? null, status: row.status ?? null };
  }

  /**
   * `app_private.offer_counter(...)` (0070).
   *
   * The parent is the only thing named, and the listing, seller and currency of the replacement are copied
   * from it inside the function — so there is no argument here through which a cross-listing or
   * cross-seller counter could be constructed.
   */
  async offerCounter(input: {
    buyerId: string;
    parentOfferId: string;
    amountMinor: string;
    quantity: number;
    message: string | null;
  }): Promise<OfferMutationRow> {
    const result = await sql<{ outcome: string; offer_id: string | null; status: string | null }>`
      select outcome, offer_id, status
        from app_private.offer_counter(
          ${input.buyerId}::uuid,
          ${input.parentOfferId}::uuid,
          ${input.amountMinor}::bigint,
          ${input.quantity}::integer,
          ${input.message}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Countering an offer returned no row.');
    return { outcome: row.outcome, offerId: row.offer_id ?? null, status: row.status ?? null };
  }

  /**
   * `app_private.offer_accept(uuid, uuid)` (0070).
   *
   * The obligation transition. No deadline is passed in and none is computed here: the function locks the
   * row, reads the admin-configured window and writes `accepted_at` and `payment_due_at` from one
   * timestamp, and what comes back is what it wrote.
   */
  async offerAccept(input: { sellerId: string; offerId: string }): Promise<OfferDecisionRow> {
    return await this.#offerDecision(
      sql<{
        outcome: string;
        status: string | null;
        accepted_at: Date | null;
        payment_due_at: Date | null;
      }>`
        select outcome, status, accepted_at, payment_due_at
          from app_private.offer_accept(${input.sellerId}::uuid, ${input.offerId}::uuid)
      `,
      'Accepting an offer returned no row.',
    );
  }

  /** `app_private.offer_reject(uuid, uuid)` (0070). */
  async offerReject(input: { sellerId: string; offerId: string }): Promise<OfferDecisionRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status from app_private.offer_reject(${input.sellerId}::uuid, ${input.offerId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Rejecting an offer returned no row.');
    return { outcome: row.outcome, status: row.status ?? null, acceptedAt: null, paymentDueAt: null };
  }

  /** `app_private.offer_withdraw(uuid, uuid)` (0070). */
  async offerWithdraw(input: { buyerId: string; offerId: string }): Promise<OfferDecisionRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status from app_private.offer_withdraw(${input.buyerId}::uuid, ${input.offerId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Withdrawing an offer returned no row.');
    return { outcome: row.outcome, status: row.status ?? null, acceptedAt: null, paymentDueAt: null };
  }

  async #offerDecision(
    query: {
      execute: (db: Kysely<Database>) => Promise<{
        rows: readonly {
          outcome: string;
          status: string | null;
          accepted_at: Date | null;
          payment_due_at: Date | null;
        }[];
      }>;
    },
    missing: string,
  ): Promise<OfferDecisionRow> {
    const result = await query.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(missing);
    return {
      outcome: row.outcome,
      status: row.status ?? null,
      acceptedAt: row.accepted_at ?? null,
      paymentDueAt: row.payment_due_at ?? null,
    };
  }

  /* ------------------------------------------------------------------------------------------------ */
  /* Phase 7-I — the service request and quote functions of migration 0071                              */
  /* ------------------------------------------------------------------------------------------------ */

  /**
   * `app_private.service_requests_for_buyer(...)` and `…_for_seller(...)` (0071).
   *
   * Two named functions rather than one with a side parameter, so the predicate is fixed in the database
   * and there is no argument that could show somebody the wrong inbox. Both statements are written out in
   * full rather than composed from a shared fragment: the function name is part of the statement, and the
   * only safe way to keep it out of anything dynamic is for each to be its own literal. `budget_minor` is a
   * `bigint` and arrives as a string; it stays one.
   */
  async serviceRequestsForBuyer(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ServiceRequestRow[]> {
    const result = await sql<ServiceRequestRawRow>`
      select id, status, routing_mode, title, budget_minor, currency_code, currency_minor_unit, needed_by,
             listing_slug, listing_title, counterparty_name, quote_count, live_quote_count,
             accepted_payment_due_at, closed_at, created_at
        from app_private.service_requests_for_buyer(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);
    return result.rows.map(serviceRequestRow);
  }

  async serviceRequestsForSeller(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ServiceRequestRow[]> {
    const result = await sql<ServiceRequestRawRow>`
      select id, status, routing_mode, title, budget_minor, currency_code, currency_minor_unit, needed_by,
             listing_slug, listing_title, counterparty_name, quote_count, live_quote_count,
             accepted_payment_due_at, closed_at, created_at
        from app_private.service_requests_for_seller(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);
    return result.rows.map(serviceRequestRow);
  }

  /** `app_private.service_request_detail(uuid, uuid)` (0071): one brief and its quotes, for either party. */
  async serviceRequestDetail(input: {
    userId: string;
    requestId: string;
  }): Promise<ServiceRequestDetailRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      status: string | null;
      routing_mode: string | null;
      is_buyer: boolean | null;
      is_seller: boolean | null;
      title: string | null;
      brief: string | null;
      budget_minor: string | number | null;
      currency_code: string | null;
      currency_minor_unit: number | null;
      needed_by: Date | string | null;
      listing_slug: string | null;
      listing_title: string | null;
      buyer_name: string | null;
      seller_slug: string | null;
      seller_name: string | null;
      closed_at: Date | null;
      created_at: Date | null;
      quotes: unknown;
    }>`
      select outcome, id, status, routing_mode, is_buyer, is_seller, title, brief, budget_minor,
             currency_code, currency_minor_unit, needed_by, listing_slug, listing_title, buyer_name,
             seller_slug, seller_name, closed_at, created_at, quotes
        from app_private.service_request_detail(${input.userId}::uuid, ${input.requestId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a service request returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      status: row.status ?? null,
      routingMode: row.routing_mode ?? null,
      isBuyer: row.is_buyer ?? null,
      isSeller: row.is_seller ?? null,
      title: row.title ?? null,
      brief: row.brief ?? null,
      budgetMinor: row.budget_minor ?? null,
      currencyCode: row.currency_code ?? null,
      currencyMinorUnit:
        row.currency_minor_unit === null || row.currency_minor_unit === undefined
          ? null
          : Number(row.currency_minor_unit),
      neededBy: row.needed_by ?? null,
      listingSlug: row.listing_slug ?? null,
      listingTitle: row.listing_title ?? null,
      buyerName: row.buyer_name ?? null,
      sellerSlug: row.seller_slug ?? null,
      sellerName: row.seller_name ?? null,
      closedAt: row.closed_at ?? null,
      createdAt: row.created_at ?? null,
      quotes: row.quotes,
    };
  }

  /**
   * `app_private.service_request_create(...)` (0071).
   *
   * Six arguments and not one of them is a seller or a currency: both are derived in the database from the
   * listing, which is what makes it impossible to brief somebody who does not own the service.
   */
  async serviceRequestCreate(input: {
    buyerId: string;
    listingId: string;
    title: string;
    brief: string;
    budgetMinor: string | null;
    neededBy: string | null;
  }): Promise<ServiceRequestMutationRow> {
    const result = await sql<{ outcome: string; request_id: string | null; status: string | null }>`
      select outcome, request_id, status
        from app_private.service_request_create(
          ${input.buyerId}::uuid,
          ${input.listingId}::uuid,
          ${input.title}::text,
          ${input.brief}::text,
          ${input.budgetMinor}::bigint,
          ${input.neededBy}::date
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Sending a service request returned no row.');
    return { outcome: row.outcome, requestId: row.request_id ?? null, status: row.status ?? null };
  }

  /**
   * `app_private.service_request_create_admin_only(...)` (0073).
   *
   * Seven arguments and not one of them is a seller, a listing, a currency or a routing mode: the function
   * writes `admin_only` and a null seller as literals and takes the currency from the platform's own default,
   * which is what makes it impossible for a caller to move a brief between the two flows.
   */
  async serviceRequestCreateAdminOnly(input: {
    buyerId: string;
    title: string;
    brief: string;
    preferredPaymentMethod: string;
    paymentNotes: string | null;
    budgetMinor: string | null;
    neededBy: string | null;
  }): Promise<ServiceRequestMutationRow> {
    const result = await sql<{ outcome: string; request_id: string | null; status: string | null }>`
      select outcome, request_id, status
        from app_private.service_request_create_admin_only(
          ${input.buyerId}::uuid,
          ${input.title}::text,
          ${input.brief}::text,
          ${input.preferredPaymentMethod}::text,
          ${input.paymentNotes}::text,
          ${input.budgetMinor}::bigint,
          ${input.neededBy}::date
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Sending an Admin Only service request returned no row.');
    return { outcome: row.outcome, requestId: row.request_id ?? null, status: row.status ?? null };
  }

  /** `app_private.service_request_cancel(uuid, uuid)` (0071). */
  async serviceRequestCancel(input: {
    buyerId: string;
    requestId: string;
  }): Promise<ServiceRequestStatusRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.service_request_cancel(${input.buyerId}::uuid, ${input.requestId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Cancelling a service request returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /** `app_private.service_request_decline(uuid, uuid)` (0071). */
  async serviceRequestDecline(input: {
    sellerId: string;
    requestId: string;
  }): Promise<ServiceRequestStatusRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.service_request_decline(${input.sellerId}::uuid, ${input.requestId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Declining a service request returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /**
   * `app_private.service_quote_create(...)` (0071).
   *
   * The request is the only thing named; the currency is copied from it inside the function, so 0015's
   * composite foreign key cannot be violated from here. `p_valid_for_days` is the validity window the schema
   * leaves to the writer, bounded in the function by 0015's own 1..365.
   */
  async serviceQuoteCreate(input: {
    sellerId: string;
    requestId: string;
    amountMinor: string;
    deliveryDays: number;
    revisionsIncluded: number;
    scope: string;
    validForDays: number;
  }): Promise<ServiceQuoteMutationRow> {
    const result = await sql<{ outcome: string; quote_id: string | null; status: string | null }>`
      select outcome, quote_id, status
        from app_private.service_quote_create(
          ${input.sellerId}::uuid,
          ${input.requestId}::uuid,
          ${input.amountMinor}::bigint,
          ${input.deliveryDays}::smallint,
          ${input.revisionsIncluded}::smallint,
          ${input.scope}::text,
          ${input.validForDays}::smallint
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Sending a service quote returned no row.');
    return { outcome: row.outcome, quoteId: row.quote_id ?? null, status: row.status ?? null };
  }

  /**
   * `app_private.service_quote_accept(uuid, uuid)` (0071).
   *
   * The obligation transition. No deadline is passed in and none is computed here: the function locks both
   * rows, reads the admin-configured window and writes `accepted_at` and `payment_due_at` from one timestamp,
   * and what comes back is what it wrote — plus the request the quote belongs to, so the API can refuse a
   * quote spent against a different one.
   */
  async serviceQuoteAccept(input: {
    buyerId: string;
    quoteId: string;
  }): Promise<ServiceQuoteDecisionRow> {
    const result = await sql<{
      outcome: string;
      status: string | null;
      request_id: string | null;
      accepted_at: Date | null;
      payment_due_at: Date | null;
    }>`
      select outcome, status, request_id, accepted_at, payment_due_at
        from app_private.service_quote_accept(${input.buyerId}::uuid, ${input.quoteId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Accepting a service quote returned no row.');
    return {
      outcome: row.outcome,
      status: row.status ?? null,
      requestId: row.request_id ?? null,
      acceptedAt: row.accepted_at ?? null,
      paymentDueAt: row.payment_due_at ?? null,
    };
  }

  /** `app_private.service_quote_reject(uuid, uuid)` (0071). */
  async serviceQuoteReject(input: {
    buyerId: string;
    quoteId: string;
  }): Promise<ServiceQuoteDecisionRow> {
    const result = await sql<{ outcome: string; status: string | null; request_id: string | null }>`
      select outcome, status, request_id
        from app_private.service_quote_reject(${input.buyerId}::uuid, ${input.quoteId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Rejecting a service quote returned no row.');
    return {
      outcome: row.outcome,
      status: row.status ?? null,
      requestId: row.request_id ?? null,
      acceptedAt: null,
      paymentDueAt: null,
    };
  }

  /** `app_private.service_quote_withdraw(uuid, uuid)` (0071). */
  async serviceQuoteWithdraw(input: {
    sellerId: string;
    quoteId: string;
  }): Promise<ServiceQuoteDecisionRow> {
    const result = await sql<{ outcome: string; status: string | null; request_id: string | null }>`
      select outcome, status, request_id
        from app_private.service_quote_withdraw(${input.sellerId}::uuid, ${input.quoteId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Withdrawing a service quote returned no row.');
    return {
      outcome: row.outcome,
      status: row.status ?? null,
      requestId: row.request_id ?? null,
      acceptedAt: null,
      paymentDueAt: null,
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
    this.logger.log('app_system connection pool closed');
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Admin Only service requests — Option 2 (Phase 7-J)                                              */
  /* ---------------------------------------------------------------------------------------------- */
  //
  // Each statement passes the staff account and the assurance level, because `app_system` carries no claims
  // and 0073's functions apply 0003's own `requires_mfa` rule to what it passes. **Neither the queue nor the
  // detail selects a payment column** — the functions behind them do not return one, so there is nothing to
  // select — and the one statement that does is the one gated on its own permission key.

  /** `app_private.service_requests_admin_only_queue(...)` (0073): the Admin Only queue, oldest first. */
  async serviceRequestsAdminOnlyQueue(input: {
    userId: string;
    isAal2: boolean;
    status: string | null;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly AdminServiceRequestRow[]> {
    const result = await sql<{
      id: string;
      status: string;
      title: string | null;
      budget_minor: string | number | null;
      currency_code: string | null;
      currency_minor_unit: number | null;
      needed_by: Date | string | null;
      buyer_name: string | null;
      has_payment_notes: boolean | null;
      closed_at: Date | null;
      created_at: Date | null;
      updated_at: Date | null;
    }>`
      select id, status, title, budget_minor, currency_code, currency_minor_unit, needed_by,
             buyer_name, has_payment_notes, closed_at, created_at, updated_at
        from app_private.service_requests_admin_only_queue(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.status}::text,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);
    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      title: row.title ?? null,
      budgetMinor: row.budget_minor ?? null,
      currencyCode: row.currency_code ?? null,
      currencyMinorUnit:
        row.currency_minor_unit === null || row.currency_minor_unit === undefined
          ? null
          : Number(row.currency_minor_unit),
      neededBy: row.needed_by ?? null,
      buyerName: row.buyer_name ?? null,
      hasPaymentNotes: row.has_payment_notes ?? null,
      closedAt: row.closed_at ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    }));
  }

  /** `app_private.service_request_admin_only_detail(uuid, boolean, uuid)` (0073). */
  async serviceRequestAdminOnlyDetail(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<AdminServiceRequestDetailRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      status: string | null;
      title: string | null;
      brief: string | null;
      budget_minor: string | number | null;
      currency_code: string | null;
      currency_minor_unit: number | null;
      needed_by: Date | string | null;
      buyer_name: string | null;
      has_payment_notes: boolean | null;
      closed_at: Date | null;
      created_at: Date | null;
      updated_at: Date | null;
    }>`
      select outcome, id, status, title, brief, budget_minor, currency_code, currency_minor_unit,
             needed_by, buyer_name, has_payment_notes, closed_at, created_at, updated_at
        from app_private.service_request_admin_only_detail(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.requestId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading an Admin Only service request returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? '',
      status: row.status ?? '',
      title: row.title ?? null,
      brief: row.brief ?? null,
      budgetMinor: row.budget_minor ?? null,
      currencyCode: row.currency_code ?? null,
      currencyMinorUnit:
        row.currency_minor_unit === null || row.currency_minor_unit === undefined
          ? null
          : Number(row.currency_minor_unit),
      neededBy: row.needed_by ?? null,
      buyerName: row.buyer_name ?? null,
      hasPaymentNotes: row.has_payment_notes ?? null,
      closedAt: row.closed_at ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  /**
   * `app_private.service_request_payment_information(uuid, boolean, uuid)` (0073).
   *
   * The only statement in this file that names either payment column, and the function it calls is the only one
   * in the database that selects them outside the retention job. It is gated on
   * `service_requests.payment_info.read` inside that function, with the assurance level passed through.
   */
  async serviceRequestPaymentInformation(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<ServiceRequestPaymentInformationRow> {
    const result = await sql<{
      outcome: string;
      preferred_payment_method: string | null;
      payment_notes: string | null;
    }>`
      select outcome, preferred_payment_method, payment_notes
        from app_private.service_request_payment_information(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.requestId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading payment information returned no row.');
    return {
      outcome: row.outcome,
      preferredPaymentMethod: row.preferred_payment_method ?? null,
      paymentNotes: row.payment_notes ?? null,
    };
  }

  /** `app_private.service_request_admin_decline(uuid, boolean, uuid)` (0073): the approved staff closure. */
  async serviceRequestAdminDecline(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<AdminServiceRequestDecisionRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.service_request_admin_decline(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.requestId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Closing an Admin Only service request returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }


  /* ---------------------------------------------------------------------------------------------- */
  /* Phase 7-K — support, the requester side                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  /** `app_private.support_tickets_for_requester(uuid, integer, timestamptz, uuid)` (0074). */
  async supportTicketsForRequester(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportTicketRow[]> {
    const result = await sql<{
      id: string;
      reference: string | null;
      subject: string | null;
      category: string | null;
      status: string | null;
      message_count: number | null;
      attachment_count: number | null;
      last_message_at: Date | null;
      resolved_at: Date | null;
      closed_at: Date | null;
      created_at: Date | null;
    }>`
      select id, reference, subject, category, status, message_count, attachment_count,
             last_message_at, resolved_at, closed_at, created_at
        from app_private.support_tickets_for_requester(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      reference: row.reference ?? null,
      subject: row.subject ?? null,
      category: row.category ?? null,
      status: row.status ?? null,
      messageCount: row.message_count ?? null,
      attachmentCount: row.attachment_count ?? null,
      lastMessageAt: row.last_message_at ?? null,
      resolvedAt: row.resolved_at ?? null,
      closedAt: row.closed_at ?? null,
      createdAt: row.created_at ?? null,
    }));
  }

  /** `app_private.support_ticket_for_requester(uuid, uuid)` (0074). */
  async supportTicketForRequester(input: {
    userId: string;
    ticketId: string;
  }): Promise<SupportTicketDetailRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      reference: string | null;
      subject: string | null;
      category: string | null;
      status: string | null;
      message_count: number | null;
      last_message_at: Date | null;
      resolved_at: Date | null;
      closed_at: Date | null;
      created_at: Date | null;
    }>`
      select outcome, id, reference, subject, category, status, message_count,
             last_message_at, resolved_at, closed_at, created_at
        from app_private.support_ticket_for_requester(
          ${input.userId}::uuid,
          ${input.ticketId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a support ticket returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      reference: row.reference ?? null,
      subject: row.subject ?? null,
      category: row.category ?? null,
      status: row.status ?? null,
      messageCount: row.message_count ?? null,
      lastMessageAt: row.last_message_at ?? null,
      resolvedAt: row.resolved_at ?? null,
      closedAt: row.closed_at ?? null,
      createdAt: row.created_at ?? null,
    };
  }

  /** `app_private.support_ticket_messages_for_requester(uuid, uuid, integer, timestamptz, uuid)` (0074). */
  async supportTicketMessagesForRequester(input: {
    userId: string;
    ticketId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportMessageRow[]> {
    const result = await sql<{
      id: string;
      author_role: string | null;
      is_own_message: boolean | null;
      body: string | null;
      created_at: Date | null;
      attachments: unknown;
    }>`
      select id, author_role, is_own_message, body, created_at, attachments
        from app_private.support_ticket_messages_for_requester(
          ${input.userId}::uuid,
          ${input.ticketId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      authorRole: row.author_role ?? null,
      isOwnMessage: row.is_own_message ?? null,
      body: row.body ?? null,
      createdAt: row.created_at ?? null,
      attachments: row.attachments ?? null,
    }));
  }

  /** `app_private.support_ticket_open_for_requester(uuid, text, text, text)` (0074). */
  async supportTicketOpenForRequester(input: {
    userId: string;
    subject: string;
    category: string;
    body: string;
  }): Promise<SupportTicketOpenRow> {
    const result = await sql<{
      outcome: string;
      ticket_id: string | null;
      message_id: string | null;
      reference: string | null;
      status: string | null;
    }>`
      select outcome, ticket_id, message_id, reference, status
        from app_private.support_ticket_open_for_requester(
          ${input.userId}::uuid,
          ${input.subject}::text,
          ${input.category}::text,
          ${input.body}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Opening a support ticket returned no row.');
    return {
      outcome: row.outcome,
      ticketId: row.ticket_id ?? null,
      messageId: row.message_id ?? null,
      reference: row.reference ?? null,
      status: row.status ?? null,
    };
  }

  /** `app_private.support_message_post_for_requester(uuid, uuid, text)` (0074). */
  async supportMessagePostForRequester(input: {
    userId: string;
    ticketId: string;
    body: string;
  }): Promise<SupportMessagePostRow> {
    const result = await sql<{ outcome: string; message_id: string | null; status: string | null }>`
      select outcome, message_id, status
        from app_private.support_message_post_for_requester(
          ${input.userId}::uuid,
          ${input.ticketId}::uuid,
          ${input.body}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Posting a support message returned no row.');
    return {
      outcome: row.outcome,
      messageId: row.message_id ?? null,
      status: row.status ?? null,
    };
  }

  /** `app_private.support_ticket_close_for_requester(uuid, uuid)` (0074). */
  async supportTicketCloseForRequester(input: {
    userId: string;
    ticketId: string;
  }): Promise<SupportTicketClosureRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.support_ticket_close_for_requester(
          ${input.userId}::uuid,
          ${input.ticketId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Closing a support ticket returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /** `app_private.support_attachment_target_for_requester(uuid, uuid, uuid, text, bigint)` (0074). */
  async supportAttachmentTargetForRequester(input: {
    userId: string;
    ticketId: string;
    messageId: string;
    contentType: string;
    byteSize: number;
  }): Promise<SupportAttachmentTargetRow> {
    const result = await sql<{
      outcome: string;
      bucket_id: string | null;
      object_path: string | null;
      max_byte_size: string | null;
    }>`
      select outcome, bucket_id, object_path, max_byte_size
        from app_private.support_attachment_target_for_requester(
          ${input.userId}::uuid,
          ${input.ticketId}::uuid,
          ${input.messageId}::uuid,
          ${input.contentType}::text,
          ${input.byteSize}::bigint
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Authorizing a support attachment returned no row.');
    return {
      outcome: row.outcome,
      bucketId: row.bucket_id ?? null,
      objectPath: row.object_path ?? null,
      maxByteSize: row.max_byte_size ?? null,
    };
  }

  /**
   * `app_private.support_attachment_attach_for_requester(...)` (0074).
   *
   * The object path is a bound parameter like every other value here. It was issued by the authorizing
   * function and is checked against the caller's own namespace again inside this one.
   */
  async supportAttachmentAttachForRequester(input: {
    userId: string;
    ticketId: string;
    messageId: string;
    objectPath: string;
    originalFilename: string;
    contentType: string;
    byteSize: number;
  }): Promise<SupportAttachmentRecordRow> {
    const result = await sql<{
      outcome: string;
      attachment_id: string | null;
      attachment_count: number | null;
    }>`
      select outcome, attachment_id, attachment_count
        from app_private.support_attachment_attach_for_requester(
          ${input.userId}::uuid,
          ${input.ticketId}::uuid,
          ${input.messageId}::uuid,
          ${input.objectPath}::text,
          ${input.originalFilename}::text,
          ${input.contentType}::text,
          ${input.byteSize}::bigint
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a support attachment returned no row.');
    return {
      outcome: row.outcome,
      attachmentId: row.attachment_id ?? null,
      attachmentCount: row.attachment_count ?? null,
    };
  }

  /** `app_private.support_attachment_for_requester(uuid, uuid, uuid)` (0074). */
  async supportAttachmentForRequester(input: {
    userId: string;
    ticketId: string;
    attachmentId: string;
  }): Promise<SupportAttachmentLocationRow> {
    const result = await sql<{
      outcome: string;
      bucket_id: string | null;
      object_path: string | null;
    }>`
      select outcome, bucket_id, object_path
        from app_private.support_attachment_for_requester(
          ${input.userId}::uuid,
          ${input.ticketId}::uuid,
          ${input.attachmentId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Locating a support attachment returned no row.');
    return {
      outcome: row.outcome,
      bucketId: row.bucket_id ?? null,
      objectPath: row.object_path ?? null,
    };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Phase 7-L — the support agent console                                                           */
  /* ---------------------------------------------------------------------------------------------- */

  /** `app_private.support_queue_for_agent(uuid, boolean, integer, timestamptz, uuid)` (0075). */
  async supportQueueForAgent(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportQueueRow[]> {
    const result = await sql<{
      id: string;
      reference: string | null;
      subject: string | null;
      category: string | null;
      priority: string | null;
      status: string | null;
      requester_name: string | null;
      message_count: number | null;
      attachment_count: number | null;
      note_count: number | null;
      last_message_at: Date | null;
      created_at: Date | null;
    }>`
      select id, reference, subject, category, priority, status, requester_name,
             message_count, attachment_count, note_count, last_message_at, created_at
        from app_private.support_queue_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      reference: row.reference ?? null,
      subject: row.subject ?? null,
      category: row.category ?? null,
      priority: row.priority ?? null,
      status: row.status ?? null,
      requesterName: row.requester_name ?? null,
      messageCount: row.message_count ?? null,
      attachmentCount: row.attachment_count ?? null,
      noteCount: row.note_count ?? null,
      lastMessageAt: row.last_message_at ?? null,
      createdAt: row.created_at ?? null,
    }));
  }

  /** `app_private.support_tickets_assigned_to_agent(uuid, boolean, integer, timestamptz, uuid)` (0075). */
  async supportTicketsAssignedToAgent(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportAssignedRow[]> {
    const result = await sql<{
      id: string;
      reference: string | null;
      subject: string | null;
      category: string | null;
      priority: string | null;
      status: string | null;
      requester_name: string | null;
      message_count: number | null;
      attachment_count: number | null;
      note_count: number | null;
      last_message_at: Date | null;
      resolved_at: Date | null;
      closed_at: Date | null;
      created_at: Date | null;
    }>`
      select id, reference, subject, category, priority, status, requester_name,
             message_count, attachment_count, note_count, last_message_at,
             resolved_at, closed_at, created_at
        from app_private.support_tickets_assigned_to_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      reference: row.reference ?? null,
      subject: row.subject ?? null,
      category: row.category ?? null,
      priority: row.priority ?? null,
      status: row.status ?? null,
      requesterName: row.requester_name ?? null,
      messageCount: row.message_count ?? null,
      attachmentCount: row.attachment_count ?? null,
      noteCount: row.note_count ?? null,
      lastMessageAt: row.last_message_at ?? null,
      resolvedAt: row.resolved_at ?? null,
      closedAt: row.closed_at ?? null,
      createdAt: row.created_at ?? null,
    }));
  }

  /** `app_private.support_ticket_for_agent(uuid, boolean, uuid)` (0075). */
  async supportTicketForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
  }): Promise<SupportConsoleTicketRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      reference: string | null;
      subject: string | null;
      category: string | null;
      priority: string | null;
      status: string | null;
      requester_name: string | null;
      is_mine: boolean | null;
      is_assigned: boolean | null;
      message_count: number | null;
      note_count: number | null;
      first_response_at: Date | null;
      last_message_at: Date | null;
      resolved_at: Date | null;
      closed_at: Date | null;
      created_at: Date | null;
    }>`
      select outcome, id, reference, subject, category, priority, status, requester_name,
             is_mine, is_assigned, message_count, note_count, first_response_at,
             last_message_at, resolved_at, closed_at, created_at
        from app_private.support_ticket_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.ticketId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a support ticket for an agent returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      reference: row.reference ?? null,
      subject: row.subject ?? null,
      category: row.category ?? null,
      priority: row.priority ?? null,
      status: row.status ?? null,
      requesterName: row.requester_name ?? null,
      isMine: row.is_mine ?? null,
      isAssigned: row.is_assigned ?? null,
      messageCount: row.message_count ?? null,
      noteCount: row.note_count ?? null,
      firstResponseAt: row.first_response_at ?? null,
      lastMessageAt: row.last_message_at ?? null,
      resolvedAt: row.resolved_at ?? null,
      closedAt: row.closed_at ?? null,
      createdAt: row.created_at ?? null,
    };
  }

  /** `app_private.support_ticket_messages_for_agent(uuid, boolean, uuid, integer, timestamptz, uuid)` (0075). */
  async supportTicketMessagesForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportConsoleMessageRow[]> {
    const result = await sql<{
      id: string;
      author_role: string | null;
      is_own_message: boolean | null;
      body: string | null;
      created_at: Date | null;
      attachments: unknown;
    }>`
      select id, author_role, is_own_message, body, created_at, attachments
        from app_private.support_ticket_messages_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.ticketId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      authorRole: row.author_role ?? null,
      isOwnMessage: row.is_own_message ?? null,
      body: row.body ?? null,
      createdAt: row.created_at ?? null,
      attachments: row.attachments ?? null,
    }));
  }

  /** `app_private.support_ticket_notes_for_agent(uuid, boolean, uuid, integer, timestamptz, uuid)` (0075). */
  async supportTicketNotesForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportInternalNoteRow[]> {
    const result = await sql<{
      id: string;
      is_own_note: boolean | null;
      body: string | null;
      created_at: Date | null;
    }>`
      select id, is_own_note, body, created_at
        from app_private.support_ticket_notes_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.ticketId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      isOwnNote: row.is_own_note ?? null,
      body: row.body ?? null,
      createdAt: row.created_at ?? null,
    }));
  }

  /** `app_private.support_attachment_for_agent(uuid, boolean, uuid, uuid)` (0075). */
  async supportAttachmentForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    attachmentId: string;
  }): Promise<SupportConsoleAttachmentRow> {
    const result = await sql<{
      outcome: string;
      bucket_id: string | null;
      object_path: string | null;
    }>`
      select outcome, bucket_id, object_path
        from app_private.support_attachment_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.ticketId}::uuid,
          ${input.attachmentId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Locating a support attachment for an agent returned no row.');
    return {
      outcome: row.outcome,
      bucketId: row.bucket_id ?? null,
      objectPath: row.object_path ?? null,
    };
  }

  /** `app_private.support_ticket_claim_for_agent(uuid, boolean, uuid)` (0075). */
  async supportTicketClaimForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
  }): Promise<SupportAssignmentRow> {
    const result = await sql<{ outcome: string; status: string | null; is_mine: boolean | null }>`
      select outcome, status, is_mine
        from app_private.support_ticket_claim_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.ticketId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Claiming a support ticket returned no row.');
    return { outcome: row.outcome, status: row.status ?? null, isMine: row.is_mine ?? null };
  }

  /** `app_private.support_ticket_release_for_agent(uuid, boolean, uuid)` (0075). */
  async supportTicketReleaseForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
  }): Promise<SupportAssignmentRow> {
    const result = await sql<{ outcome: string; status: string | null; is_mine: boolean | null }>`
      select outcome, status, is_mine
        from app_private.support_ticket_release_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.ticketId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Releasing a support ticket returned no row.');
    return { outcome: row.outcome, status: row.status ?? null, isMine: row.is_mine ?? null };
  }

  /** `app_private.support_message_post_for_agent(uuid, boolean, uuid, text)` (0075). */
  async supportMessagePostForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    body: string;
  }): Promise<SupportConsoleMessagePostRow> {
    const result = await sql<{ outcome: string; message_id: string | null; status: string | null }>`
      select outcome, message_id, status
        from app_private.support_message_post_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.ticketId}::uuid,
          ${input.body}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Posting an agent support message returned no row.');
    return { outcome: row.outcome, messageId: row.message_id ?? null, status: row.status ?? null };
  }

  /** `app_private.support_note_add_for_agent(uuid, boolean, uuid, text)` (0075). */
  async supportNoteAddForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    body: string;
  }): Promise<SupportNoteAddRow> {
    const result = await sql<{ outcome: string; note_id: string | null; note_count: number | null }>`
      select outcome, note_id, note_count
        from app_private.support_note_add_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.ticketId}::uuid,
          ${input.body}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Writing a support internal note returned no row.');
    return { outcome: row.outcome, noteId: row.note_id ?? null, noteCount: row.note_count ?? null };
  }

  /** `app_private.support_ticket_close_for_agent(uuid, boolean, uuid, text)` (0075). */
  async supportTicketCloseForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    status: string;
  }): Promise<SupportConsoleDecisionRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.support_ticket_close_for_agent(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.ticketId}::uuid,
          ${input.status}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a support ticket decision returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Reports — the reporter side (Phase 7-M)                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * `app_private.report_file_for_reporter(uuid, text, text, text, text)` (0076).
   *
   * The reporter is the caller's own id, established from their session before this is reached. The subject
   * arrives as the **slug** the public page is addressed by, because 0050's public seller projection never
   * publishes a seller's account id — so there is no id for a browser to hold and none is accepted. 0076
   * resolves the slug and delegates the report to 0027's own `file_report`.
   */
  async reportFileForReporter(input: {
    userId: string;
    subjectType: string;
    subjectSlug: string;
    reasonCode: string;
    details: string | null;
  }): Promise<{ outcome: string; reportId: string | null }> {
    const result = await sql<{ outcome: string; report_id: string | null }>`
      select outcome, report_id
        from app_private.report_file_for_reporter(
          ${input.userId}::uuid,
          ${input.subjectType}::text,
          ${input.subjectSlug}::text,
          ${input.reasonCode}::text,
          ${input.details}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Filing a report returned no row.');
    return { outcome: row.outcome, reportId: row.report_id ?? null };
  }

  /**
   * `app_private.reports_for_reporter(uuid, integer, timestamptz, uuid)` (0076).
   *
   * Scoped to the caller inside the statement. The projection carries no subject id and none of the seven
   * moderation columns, so there is nothing to leave out here.
   */
  async reportsForReporter(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ReporterReportRow[]> {
    const result = await sql<{
      id: string;
      subject_type: string;
      subject_slug: string | null;
      subject_label: string | null;
      reason_code: string;
      details: string | null;
      status: string;
      created_at: Date;
    }>`
      select id, subject_type, subject_slug, subject_label, reason_code, details, status, created_at
        from app_private.reports_for_reporter(
          ${input.userId}::uuid,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      subjectType: row.subject_type,
      subjectSlug: row.subject_slug ?? null,
      subjectLabel: row.subject_label ?? null,
      reasonCode: row.reason_code,
      details: row.details ?? null,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Listing moderation and report management (Phase 7-N)                                            */
  /* ---------------------------------------------------------------------------------------------- */
  //
  // Every method passes the staff account and the assurance level, because the connection carries no
  // claims; the five permission keys are literals inside 0077's own predicates, and each function
  // re-applies its own test. The two writers delegate to 0027's `resolve_report` and `moderate_listing`,
  // which lock the row and write both trails and the outbox event themselves.

  /** `app_private.moderation_report_queue(uuid, boolean, integer, text, timestamptz, uuid)` (0077). */
  async moderationReportQueue(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ModerationReportQueueRow[]> {
    const result = await sql<{
      id: string;
      subject_type: string;
      subject_label: string | null;
      reason_code: string;
      status: string;
      priority: string;
      is_own_report: boolean;
      action_count: number;
      created_at: Date;
    }>`
      select id, subject_type, subject_label, reason_code, status, priority, is_own_report,
             action_count, created_at
        from app_private.moderation_report_queue(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.status}::text,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      subjectType: row.subject_type,
      subjectLabel: row.subject_label ?? null,
      reasonCode: row.reason_code,
      status: row.status,
      priority: row.priority,
      isOwnReport: row.is_own_report,
      actionCount: Number(row.action_count),
      createdAt: row.created_at,
    }));
  }

  /** `app_private.moderation_report_for_staff(uuid, boolean, uuid)` (0077). */
  async moderationReportForStaff(input: {
    userId: string;
    isAal2: boolean;
    reportId: string;
  }): Promise<ModerationReportDetailRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      subject_type: string | null;
      subject_slug: string | null;
      subject_label: string | null;
      subject_status: string | null;
      subject_is_resolvable: boolean | null;
      reason_code: string | null;
      details: string | null;
      status: string | null;
      priority: string | null;
      is_own_report: boolean | null;
      resolution: string | null;
      resolution_note: string | null;
      resolved_at: Date | null;
      resolved_by_me: boolean | null;
      duplicate_of_report_id: string | null;
      created_at: Date | null;
      updated_at: Date | null;
    }>`
      select outcome, id, subject_type, subject_slug, subject_label, subject_status,
             subject_is_resolvable, reason_code, details, status, priority, is_own_report,
             resolution, resolution_note, resolved_at, resolved_by_me, duplicate_of_report_id,
             created_at, updated_at
        from app_private.moderation_report_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.reportId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a report returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      subjectType: row.subject_type ?? null,
      subjectSlug: row.subject_slug ?? null,
      subjectLabel: row.subject_label ?? null,
      subjectStatus: row.subject_status ?? null,
      subjectIsResolvable: row.subject_is_resolvable ?? null,
      reasonCode: row.reason_code ?? null,
      details: row.details ?? null,
      status: row.status ?? null,
      priority: row.priority ?? null,
      isOwnReport: row.is_own_report ?? null,
      resolution: row.resolution ?? null,
      resolutionNote: row.resolution_note ?? null,
      resolvedAt: row.resolved_at ?? null,
      resolvedByMe: row.resolved_by_me ?? null,
      duplicateOfReportId: row.duplicate_of_report_id ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  /** `app_private.moderation_actions_for_subject(uuid, boolean, text, uuid, integer)` (0077). */
  async moderationActionsForSubject(input: {
    userId: string;
    isAal2: boolean;
    subjectType: string;
    subjectId: string;
    limit: number;
  }): Promise<readonly ModerationActionTrailRow[]> {
    const result = await sql<ActionTrailColumns>`
      select id, action, reason, notes, report_id, expires_at, reverses_action_id, is_own_action,
             created_at
        from app_private.moderation_actions_for_subject(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.subjectType}::text,
          ${input.subjectId}::uuid,
          ${input.limit}::integer
        )
    `.execute(this.db);

    return result.rows.map(actionTrailRow);
  }

  /** `app_private.moderation_actions_for_report(uuid, boolean, uuid, integer)` (0077). */
  async moderationActionsForReport(input: {
    userId: string;
    isAal2: boolean;
    reportId: string;
    limit: number;
  }): Promise<readonly ModerationActionTrailRow[]> {
    const result = await sql<ActionTrailColumns>`
      select id, action, reason, notes, report_id, expires_at, reverses_action_id, is_own_action,
             created_at
        from app_private.moderation_actions_for_report(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.reportId}::uuid,
          ${input.limit}::integer
        )
    `.execute(this.db);

    return result.rows.map(actionTrailRow);
  }

  /** `app_private.listing_moderation_history(uuid, boolean, uuid, integer)` (0077). */
  async listingModerationHistory(input: {
    userId: string;
    isAal2: boolean;
    listingId: string;
    limit: number;
  }): Promise<readonly ListingModerationTrailRow[]> {
    const result = await sql<{
      id: string;
      action: string;
      from_status: string;
      to_status: string;
      reason: string;
      report_id: string | null;
      is_own_action: boolean;
      created_at: Date;
    }>`
      select id, action, from_status, to_status, reason, report_id, is_own_action, created_at
        from app_private.listing_moderation_history(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.listingId}::uuid,
          ${input.limit}::integer
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      reportId: row.report_id ?? null,
      isOwnAction: row.is_own_action,
      createdAt: row.created_at,
    }));
  }

  /** `app_private.moderation_listing_queue(uuid, boolean, integer, timestamptz, uuid)` (0077). */
  async moderationListingQueue(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ModerationListingQueueRow[]> {
    const result = await sql<{
      id: string;
      slug: string;
      title: string;
      status: string;
      listing_type_code: string;
      currency_code: string;
      price_minor: string | null;
      is_own_listing: boolean;
      report_count: number;
      created_at: Date;
    }>`
      select id, slug, title, status, listing_type_code, currency_code, price_minor, is_own_listing,
             report_count, created_at
        from app_private.moderation_listing_queue(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status,
      listingTypeCode: row.listing_type_code,
      currencyCode: row.currency_code,
      priceMinor: row.price_minor ?? null,
      isOwnListing: row.is_own_listing,
      reportCount: Number(row.report_count),
      createdAt: row.created_at,
    }));
  }

  /** `app_private.moderation_listing_for_staff(uuid, boolean, uuid)` (0077). */
  async moderationListingForStaff(input: {
    userId: string;
    isAal2: boolean;
    listingId: string;
  }): Promise<ModerationListingDetailRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      slug: string | null;
      title: string | null;
      description: string | null;
      content_language: string | null;
      status: string | null;
      listing_type_code: string | null;
      currency_code: string | null;
      price_minor: string | null;
      city: string | null;
      seller_slug: string | null;
      seller_display_name: string | null;
      is_own_listing: boolean | null;
      can_moderate: boolean | null;
      open_report_count: number | null;
      created_at: Date | null;
      approved_at: Date | null;
    }>`
      select outcome, id, slug, title, description, content_language, status, listing_type_code,
             currency_code, price_minor, city, seller_slug, seller_display_name, is_own_listing,
             can_moderate, open_report_count, created_at, approved_at
        from app_private.moderation_listing_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.listingId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a listing for moderation returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      slug: row.slug ?? null,
      title: row.title ?? null,
      description: row.description ?? null,
      contentLanguage: row.content_language ?? null,
      status: row.status ?? null,
      listingTypeCode: row.listing_type_code ?? null,
      currencyCode: row.currency_code ?? null,
      priceMinor: row.price_minor ?? null,
      city: row.city ?? null,
      sellerSlug: row.seller_slug ?? null,
      sellerDisplayName: row.seller_display_name ?? null,
      isOwnListing: row.is_own_listing ?? null,
      canModerate: row.can_moderate ?? null,
      openReportCount: row.open_report_count === null ? null : Number(row.open_report_count),
      createdAt: row.created_at ?? null,
      approvedAt: row.approved_at ?? null,
    };
  }

  /** `app_private.moderation_report_resolve_for_staff(uuid, boolean, uuid, text, text, uuid)` (0077). */
  async moderationReportResolve(input: {
    userId: string;
    isAal2: boolean;
    reportId: string;
    status: string;
    resolutionNote: string | null;
    duplicateOfReportId: string | null;
  }): Promise<ModerationWriteRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.moderation_report_resolve_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.reportId}::uuid,
          ${input.status}::text,
          ${input.resolutionNote}::text,
          ${input.duplicateOfReportId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a report decision returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /** `app_private.moderation_listing_moderate_for_staff(uuid, boolean, uuid, text, text, uuid)` (0077). */
  async moderationListingModerate(input: {
    userId: string;
    isAal2: boolean;
    listingId: string;
    action: string;
    reason: string;
    reportId: string | null;
  }): Promise<ModerationWriteRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.moderation_listing_moderate_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.listingId}::uuid,
          ${input.action}::text,
          ${input.reason}::text,
          ${input.reportId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a listing moderation decision returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }
  /* ---------------------------------------------------------------------------------------------- */
  /* Seller, user and role reads, recovery review, the audit trail (Phase 7-O)                        */
  /* ---------------------------------------------------------------------------------------------- */
  //
  // Every method passes the staff account and the assurance level, because the connection carries no
  // claims; the six permission keys are literals inside 0078's own predicates, and each function
  // re-applies its own test. The three recovery writers delegate to 0028's `review_recovery_request`,
  // `decide_recovery_request` and `complete_recovery_request`, which lock the row and write the approval
  // trail, the security event and the outbox event themselves.
  //
  // **There is no method here that writes `public.user_roles` or `public.seller_profiles`.** Neither
  // capability has an authoritative writer in this repository, and both are reported as gaps rather than
  // given a generic one. Every method below is a read, except the three recovery steps.

  /** `app_private.admin_seller_page(uuid, boolean, integer, text, text, timestamptz, text)` (0078). */
  async adminSellerPage(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    verificationStatus: string | null;
    cursorCreatedAt: Date | null;
    cursorSlug: string | null;
  }): Promise<readonly AdminSellerPageRow[]> {
    const result = await sql<{
      slug: string;
      display_name: string;
      status: string;
      verification_status: string;
      country_code: string | null;
      city: string | null;
      listing_count: number;
      open_report_count: number;
      created_at: Date;
    }>`
      select slug, display_name, status, verification_status, country_code, city,
             listing_count, open_report_count, created_at
        from app_private.admin_seller_page(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.status}::text,
          ${input.verificationStatus}::text,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorSlug}::text
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      slug: row.slug,
      displayName: row.display_name,
      status: row.status,
      verificationStatus: row.verification_status,
      countryCode: row.country_code ?? null,
      city: row.city ?? null,
      listingCount: Number(row.listing_count),
      openReportCount: Number(row.open_report_count),
      createdAt: row.created_at,
    }));
  }

  /** `app_private.admin_seller_detail(uuid, boolean, text)` (0078). */
  async adminSellerDetail(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
  }): Promise<AdminSellerDetailRow> {
    const result = await sql<{
      outcome: string;
      slug: string | null;
      display_name: string | null;
      bio: string | null;
      content_language: string | null;
      status: string | null;
      suspended_at: Date | null;
      suspension_reason: string | null;
      closed_at: Date | null;
      verification_status: string | null;
      verified_at: Date | null;
      country_code: string | null;
      governorate: string | null;
      city: string | null;
      listing_count: number | null;
      live_listing_count: number | null;
      open_report_count: number | null;
      is_own_storefront: boolean | null;
      created_at: Date | null;
    }>`
      select outcome, slug, display_name, bio, content_language, status, suspended_at,
             suspension_reason, closed_at, verification_status, verified_at, country_code,
             governorate, city, listing_count, live_listing_count, open_report_count,
             is_own_storefront, created_at
        from app_private.admin_seller_detail(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.slug}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a storefront returned no row.');
    return {
      outcome: row.outcome,
      slug: row.slug ?? null,
      displayName: row.display_name ?? null,
      bio: row.bio ?? null,
      contentLanguage: row.content_language ?? null,
      status: row.status ?? null,
      suspendedAt: row.suspended_at ?? null,
      suspensionReason: row.suspension_reason ?? null,
      closedAt: row.closed_at ?? null,
      verificationStatus: row.verification_status ?? null,
      verifiedAt: row.verified_at ?? null,
      countryCode: row.country_code ?? null,
      governorate: row.governorate ?? null,
      city: row.city ?? null,
      listingCount: row.listing_count === null ? null : Number(row.listing_count),
      liveListingCount: row.live_listing_count === null ? null : Number(row.live_listing_count),
      openReportCount: row.open_report_count === null ? null : Number(row.open_report_count),
      isOwnStorefront: row.is_own_storefront ?? null,
      createdAt: row.created_at ?? null,
    };
  }

  /**
   * `app_private.admin_seller_status_set(uuid, boolean, text, text, text)` (0079).
   *
   * The one write on this surface that is not a recovery step. It locks the storefront row, applies the seven
   * legal transitions and writes four columns of one table — nothing cascades, and the audit row is 0009's
   * own trigger's.
   */
  async sellerStatusSetForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    status: string;
    reason: string | null;
  }): Promise<SellerStatusWriteRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.admin_seller_status_set(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.slug}::text,
          ${input.status}::text,
          ${input.reason}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Changing a storefront status returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /**
   * `app_private.record_listing_events(jsonb)` (0013). The degraded direct path O-21 approves.
   *
   * Answers how many rows were inserted, which is not how many were sent: the writer de-duplicates on the
   * event id alone, through 0107's identity ledger, so a retried batch legitimately inserts none whatever its
   * `occurred_at` says. Ingestion does not report this number onward.
   */
  async recordListingEvents(rows: readonly Record<string, unknown>[]): Promise<number> {
    const result = await sql<{ inserted: number }>`
      select app_private.record_listing_events(${JSON.stringify(rows)}::jsonb) as inserted
    `.execute(this.db);

    return result.rows[0]?.inserted ?? 0;
  }

  /**
   * `app_private.staff_role_grantable(uuid, boolean)` (0100).
   *
   * The roles this caller may grant, computed in the database from their own effective roles. No row for a
   * caller without `users.role.manage` at the required assurance level.
   */
  async staffRoleGrantable(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly StaffGrantableRoleRow[]> {
    const result = await sql<StaffGrantableRoleRow>`
      select role_key as "roleKey",
             name_en as "nameEn",
             name_ar as "nameAr",
             requires_mfa as "requiresMfa",
             is_admin_console as "isAdminConsole"
        from app_private.staff_role_grantable(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean
        )
    `.execute(this.db);

    return result.rows;
  }

  /** `app_private.staff_role_grant(uuid, boolean, uuid, text, text, timestamptz)` (0100). */
  async staffRoleGrant(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
    roleKey: string;
    reason: string;
    expiresAt: Date | null;
  }): Promise<StaffRoleWriteRow> {
    const result = await sql<{ outcome: string; roleKey: string | null }>`
      select outcome, role_key as "roleKey"
        from app_private.staff_role_grant(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.targetUserId}::uuid,
          ${input.roleKey}::text,
          ${input.reason}::text,
          ${input.expiresAt}::timestamptz
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Granting a role returned no row.');
    return { outcome: row.outcome, roleKey: row.roleKey ?? null };
  }

  /** `app_private.staff_role_revoke(uuid, boolean, uuid, text, text)` (0100). */
  async staffRoleRevoke(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
    roleKey: string;
    reason: string;
  }): Promise<StaffRoleWriteRow> {
    const result = await sql<{ outcome: string; roleKey: string | null }>`
      select outcome, role_key as "roleKey"
        from app_private.staff_role_revoke(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.targetUserId}::uuid,
          ${input.roleKey}::text,
          ${input.reason}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Withdrawing a role returned no row.');
    return { outcome: row.outcome, roleKey: row.roleKey ?? null };
  }

  /** `app_private.admin_user_page(uuid, boolean, integer, text, timestamptz, uuid)` (0078). */
  async adminUserPage(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly AdminUserPageRow[]> {
    const result = await sql<{
      id: string;
      display_name: string | null;
      status: string;
      locale_code: string | null;
      has_verified_email: boolean;
      has_verified_phone: boolean;
      is_staff: boolean;
      is_seller: boolean;
      is_self: boolean;
      created_at: Date;
    }>`
      select id, display_name, status, locale_code, has_verified_email, has_verified_phone,
             is_staff, is_seller, is_self, created_at
        from app_private.admin_user_page(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.status}::text,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name ?? null,
      status: row.status,
      localeCode: row.locale_code ?? null,
      hasVerifiedEmail: row.has_verified_email,
      hasVerifiedPhone: row.has_verified_phone,
      isStaff: row.is_staff,
      isSeller: row.is_seller,
      isSelf: row.is_self,
      createdAt: row.created_at,
    }));
  }

  /** `app_private.admin_user_detail(uuid, boolean, uuid)` (0078). */
  async adminUserDetail(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
  }): Promise<AdminUserDetailRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      display_name: string | null;
      status: string | null;
      locale_code: string | null;
      timezone: string | null;
      has_verified_email: boolean | null;
      has_verified_phone: boolean | null;
      is_staff: boolean | null;
      is_seller: boolean | null;
      seller_slug: string | null;
      is_self: boolean | null;
      last_seen_at: Date | null;
      created_at: Date | null;
    }>`
      select outcome, id, display_name, status, locale_code, timezone, has_verified_email,
             has_verified_phone, is_staff, is_seller, seller_slug, is_self, last_seen_at, created_at
        from app_private.admin_user_detail(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.targetUserId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading an account returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      displayName: row.display_name ?? null,
      status: row.status ?? null,
      localeCode: row.locale_code ?? null,
      timezone: row.timezone ?? null,
      hasVerifiedEmail: row.has_verified_email ?? null,
      hasVerifiedPhone: row.has_verified_phone ?? null,
      isStaff: row.is_staff ?? null,
      isSeller: row.is_seller ?? null,
      sellerSlug: row.seller_slug ?? null,
      isSelf: row.is_self ?? null,
      lastSeenAt: row.last_seen_at ?? null,
      createdAt: row.created_at ?? null,
    };
  }

  /** `app_private.admin_user_roles(uuid, boolean, uuid)` (0078). A read; there is no writer beside it. */
  async adminUserRoles(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
  }): Promise<readonly AdminUserRoleRow[]> {
    const result = await sql<{
      role_key: string;
      name_en: string;
      name_ar: string;
      requires_mfa: boolean;
      is_admin_console: boolean;
      granted_at: Date;
      expires_at: Date | null;
      revoked_at: Date | null;
      is_effective: boolean;
      permission_count: number;
    }>`
      select role_key, name_en, name_ar, requires_mfa, is_admin_console, granted_at, expires_at,
             revoked_at, is_effective, permission_count
        from app_private.admin_user_roles(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.targetUserId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      roleKey: row.role_key,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      requiresMfa: row.requires_mfa,
      isAdminConsole: row.is_admin_console,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at ?? null,
      revokedAt: row.revoked_at ?? null,
      isEffective: row.is_effective,
      permissionCount: Number(row.permission_count),
    }));
  }

  /** `app_private.admin_role_catalogue(uuid, boolean)` (0078). */
  async adminRoleCatalogue(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly AdminRoleCatalogueRow[]> {
    const result = await sql<{
      role_key: string;
      name_en: string;
      name_ar: string;
      requires_mfa: boolean;
      is_admin_console: boolean;
      is_assignable: boolean;
      permission_count: number;
      holder_count: number;
    }>`
      select role_key, name_en, name_ar, requires_mfa, is_admin_console, is_assignable,
             permission_count, holder_count
        from app_private.admin_role_catalogue(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      roleKey: row.role_key,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      requiresMfa: row.requires_mfa,
      isAdminConsole: row.is_admin_console,
      isAssignable: row.is_assignable,
      permissionCount: Number(row.permission_count),
      holderCount: Number(row.holder_count),
    }));
  }

  /** `app_private.admin_account_security_timeline(uuid, boolean, uuid, integer)` (0078). */
  async adminAccountSecurityTimeline(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
    limit: number;
  }): Promise<readonly AdminSecurityEventRow[]> {
    const result = await sql<{
      id: string | number;
      event_type: string;
      details: unknown;
      occurred_at: Date;
    }>`
      select id, event_type, details, occurred_at
        from app_private.admin_account_security_timeline(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.targetUserId}::uuid,
          ${input.limit}::integer
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      details: row.details ?? null,
      occurredAt: row.occurred_at,
    }));
  }

  /** `app_private.recovery_review_queue(uuid, boolean, integer, text, timestamptz, uuid)` (0078). */
  async recoveryReviewQueue(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly RecoveryQueueDbRow[]> {
    const result = await sql<{
      id: string;
      status: string;
      claimed_contact_channel: string;
      new_contact_channel: string | null;
      matched_an_account: boolean;
      is_own_request: boolean;
      is_the_reviewer: boolean;
      has_been_reviewed: boolean;
      contact_verified: boolean;
      evidence_count: number;
      expires_at: Date;
      created_at: Date;
    }>`
      select id, status, claimed_contact_channel, new_contact_channel, matched_an_account,
             is_own_request, is_the_reviewer, has_been_reviewed, contact_verified, evidence_count,
             expires_at, created_at
        from app_private.recovery_review_queue(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.status}::text,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      claimedContactChannel: row.claimed_contact_channel,
      newContactChannel: row.new_contact_channel ?? null,
      matchedAnAccount: row.matched_an_account,
      isOwnRequest: row.is_own_request,
      isTheReviewer: row.is_the_reviewer,
      hasBeenReviewed: row.has_been_reviewed,
      contactVerified: row.contact_verified,
      evidenceCount: Number(row.evidence_count),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  /** `app_private.recovery_request_for_staff(uuid, boolean, uuid)` (0078). */
  async recoveryRequestForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<RecoveryRequestDetailDbRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      status: string | null;
      claimed_contact_channel: string | null;
      new_contact_channel: string | null;
      matched_an_account: boolean | null;
      is_own_request: boolean | null;
      is_the_reviewer: boolean | null;
      reviewed_by_me: boolean | null;
      review_note: string | null;
      reviewed_at: Date | null;
      approved_at: Date | null;
      rejection_reason: string | null;
      contact_verified_at: Date | null;
      sessions_revoked_at: Date | null;
      mfa_reset_at: Date | null;
      hold_until: Date | null;
      completed_at: Date | null;
      closed_at: Date | null;
      expires_at: Date | null;
      created_at: Date | null;
    }>`
      select outcome, id, status, claimed_contact_channel, new_contact_channel, matched_an_account,
             is_own_request, is_the_reviewer, reviewed_by_me, review_note, reviewed_at, approved_at,
             rejection_reason, contact_verified_at, sessions_revoked_at, mfa_reset_at, hold_until,
             completed_at, closed_at, expires_at, created_at
        from app_private.recovery_request_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.requestId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a recovery request returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      status: row.status ?? null,
      claimedContactChannel: row.claimed_contact_channel ?? null,
      newContactChannel: row.new_contact_channel ?? null,
      matchedAnAccount: row.matched_an_account ?? null,
      isOwnRequest: row.is_own_request ?? null,
      isTheReviewer: row.is_the_reviewer ?? null,
      reviewedByMe: row.reviewed_by_me ?? null,
      reviewNote: row.review_note ?? null,
      reviewedAt: row.reviewed_at ?? null,
      approvedAt: row.approved_at ?? null,
      rejectionReason: row.rejection_reason ?? null,
      contactVerifiedAt: row.contact_verified_at ?? null,
      sessionsRevokedAt: row.sessions_revoked_at ?? null,
      mfaResetAt: row.mfa_reset_at ?? null,
      holdUntil: row.hold_until ?? null,
      completedAt: row.completed_at ?? null,
      closedAt: row.closed_at ?? null,
      expiresAt: row.expires_at ?? null,
      createdAt: row.created_at ?? null,
    };
  }

  /** `app_private.recovery_evidence_for_staff(uuid, boolean, uuid)` (0078). No object path crosses. */
  async recoveryEvidenceForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<readonly RecoveryEvidenceDbRow[]> {
    const result = await sql<{
      id: string;
      evidence_type: string;
      original_filename: string | null;
      content_type: string | null;
      byte_size: string | number | null;
      uploaded_at: Date;
    }>`
      select id, evidence_type, original_filename, content_type, byte_size, uploaded_at
        from app_private.recovery_evidence_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.requestId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      evidenceType: row.evidence_type,
      originalFilename: row.original_filename ?? null,
      contentType: row.content_type ?? null,
      byteSize: row.byte_size ?? null,
      uploadedAt: row.uploaded_at,
    }));
  }

  /** `app_private.recovery_review_for_staff(uuid, boolean, uuid, text)` (0078). */
  async recoveryReviewForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
    note: string | null;
  }): Promise<RecoveryWriteRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.recovery_review_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.requestId}::uuid,
          ${input.note}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a recovery review returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /** `app_private.recovery_decide_for_staff(uuid, boolean, uuid, text, text)` (0078). */
  async recoveryDecideForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
    decision: string;
    note: string | null;
  }): Promise<RecoveryWriteRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.recovery_decide_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.requestId}::uuid,
          ${input.decision}::text,
          ${input.note}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a recovery decision returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }

  /** `app_private.recovery_complete_for_staff(uuid, boolean, uuid, boolean)` (0078). */
  async recoveryCompleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
    mfaWasReset: boolean;
  }): Promise<RecoveryCompletionRow> {
    const result = await sql<{ outcome: string; hold_until: Date | null }>`
      select outcome, hold_until
        from app_private.recovery_complete_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.requestId}::uuid,
          ${input.mfaWasReset}::boolean
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Completing a recovery returned no row.');
    return { outcome: row.outcome, holdUntil: row.hold_until ?? null };
  }

  /**
   * `app_private.admin_audit_page(uuid, boolean, integer, text, text, text, timestamptz, bigint)` (0078).
   *
   * `changed_columns` is a `text[]` of column **names**. There is no `old_values` or `new_values` in this
   * projection to map, which is the whole point of it.
   */
  async adminAuditPage(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    tableSchema: string | null;
    tableName: string | null;
    recordId: string | null;
    cursorOccurredAt: Date | null;
    cursorId: bigint | null;
  }): Promise<readonly AdminAuditDbRow[]> {
    const result = await sql<{
      id: string | number;
      occurred_at: Date;
      actor_type: string | null;
      is_own_action: boolean;
      action: string;
      table_schema: string | null;
      table_name: string | null;
      record_id: string | null;
      changed_columns: string[] | null;
      request_id: string | null;
    }>`
      select id, occurred_at, actor_type, is_own_action, action, table_schema, table_name,
             record_id, changed_columns, request_id
        from app_private.admin_audit_page(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.tableSchema}::text,
          ${input.tableName}::text,
          ${input.recordId}::text,
          ${input.cursorOccurredAt}::timestamptz,
          ${input.cursorId === null ? null : input.cursorId.toString()}::bigint
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      actorType: row.actor_type ?? null,
      isOwnAction: row.is_own_action,
      action: row.action,
      tableSchema: row.table_schema ?? null,
      tableName: row.table_name ?? null,
      recordId: row.record_id ?? null,
      changedColumns: row.changed_columns ?? null,
      requestId: row.request_id ?? null,
    }));
  }
  /* ---------------------------------------------------------------------------------------------- */
  /* Review moderation (Phase 7-P)                                                                   */
  /* ---------------------------------------------------------------------------------------------- */
  //
  // Every method passes the staff account and the assurance level, because the connection carries no claims;
  // the three permission keys are literals inside 0080's own predicates, and each function re-applies its own
  // test. The one writer delegates to 0026's `moderate_review`, which locks the row, records who ruled,
  // clears the automatic hiding reason and enqueues its own event.
  //
  // **There is no method here that writes `public.review_replies`.** Moderating a reply has no writer in this
  // repository, and that gap is reported rather than given a generic one.

  /** `app_private.review_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid)` (0080). */
  async reviewQueueForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ReviewQueueDbRow[]> {
    const result = await sql<{
      id: string;
      rating: number;
      title: string | null;
      status: string;
      has_body: boolean;
      auto_hidden_reason: string | null;
      is_moderated: boolean;
      moderated_by_me: boolean;
      is_party: boolean;
      seller_slug: string;
      seller_display_name: string;
      has_reply: boolean;
      reply_status: string | null;
      created_at: Date;
    }>`
      select id, rating, title, status, has_body, auto_hidden_reason, is_moderated, moderated_by_me,
             is_party, seller_slug, seller_display_name, has_reply, reply_status, created_at
        from app_private.review_queue_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.status}::text,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      rating: Number(row.rating),
      title: row.title ?? null,
      status: row.status,
      hasBody: row.has_body,
      autoHiddenReason: row.auto_hidden_reason ?? null,
      isModerated: row.is_moderated,
      moderatedByMe: row.moderated_by_me,
      isParty: row.is_party,
      sellerSlug: row.seller_slug,
      sellerDisplayName: row.seller_display_name,
      hasReply: row.has_reply,
      replyStatus: row.reply_status ?? null,
      createdAt: row.created_at,
    }));
  }

  /** `app_private.review_for_staff(uuid, boolean, uuid)` (0080). */
  async reviewForStaff(input: {
    userId: string;
    isAal2: boolean;
    reviewId: string;
  }): Promise<ReviewDetailDbRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      rating: number | null;
      title: string | null;
      body: string | null;
      status: string | null;
      auto_hidden_reason: string | null;
      moderation_reason: string | null;
      moderated_at: Date | null;
      moderated_by_me: boolean | null;
      is_party: boolean | null;
      can_moderate: boolean | null;
      publication_block: string | null;
      seller_slug: string | null;
      seller_display_name: string | null;
      seller_status: string | null;
      reply_body: string | null;
      reply_status: string | null;
      reply_moderation_reason: string | null;
      reply_created_at: Date | null;
      created_at: Date | null;
      updated_at: Date | null;
    }>`
      select outcome, id, rating, title, body, status, auto_hidden_reason, moderation_reason, moderated_at,
             moderated_by_me, is_party, can_moderate, publication_block, seller_slug, seller_display_name,
             seller_status, reply_body, reply_status, reply_moderation_reason, reply_created_at,
             created_at, updated_at
        from app_private.review_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.reviewId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a review returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      rating: row.rating === null ? null : Number(row.rating),
      title: row.title ?? null,
      body: row.body ?? null,
      status: row.status ?? null,
      autoHiddenReason: row.auto_hidden_reason ?? null,
      moderationReason: row.moderation_reason ?? null,
      moderatedAt: row.moderated_at ?? null,
      moderatedByMe: row.moderated_by_me ?? null,
      isParty: row.is_party ?? null,
      canModerate: row.can_moderate ?? null,
      publicationBlock: row.publication_block ?? null,
      sellerSlug: row.seller_slug ?? null,
      sellerDisplayName: row.seller_display_name ?? null,
      sellerStatus: row.seller_status ?? null,
      replyBody: row.reply_body ?? null,
      replyStatus: row.reply_status ?? null,
      replyModerationReason: row.reply_moderation_reason ?? null,
      replyCreatedAt: row.reply_created_at ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  /** `app_private.review_moderation_actions(uuid, boolean, uuid, integer)` (0080). */
  async reviewModerationActions(input: {
    userId: string;
    isAal2: boolean;
    reviewId: string;
    limit: number;
  }): Promise<readonly ReviewActionDbRow[]> {
    const result = await sql<{
      id: string;
      action: string;
      reason: string;
      notes: string | null;
      report_id: string | null;
      is_own_action: boolean;
      created_at: Date;
    }>`
      select id, action, reason, notes, report_id, is_own_action, created_at
        from app_private.review_moderation_actions(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.reviewId}::uuid,
          ${input.limit}::integer
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      reason: row.reason,
      notes: row.notes ?? null,
      reportId: row.report_id ?? null,
      isOwnAction: row.is_own_action,
      createdAt: row.created_at,
    }));
  }

  /** `app_private.review_moderate_for_staff(uuid, boolean, uuid, text, text)` (0080). */
  async reviewModerateForStaff(input: {
    userId: string;
    isAal2: boolean;
    reviewId: string;
    status: string;
    reason: string;
  }): Promise<ReviewModerateRow> {
    const result = await sql<{ outcome: string; status: string | null }>`
      select outcome, status
        from app_private.review_moderate_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.reviewId}::uuid,
          ${input.status}::text,
          ${input.reason}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a review moderation decision returned no row.');
    return { outcome: row.outcome, status: row.status ?? null };
  }
  /* ---------------------------------------------------------------------------------------------- */
  /* Platform job runs and outbox health (Phase 7-Q)                                                 */
  /* ---------------------------------------------------------------------------------------------- */
  //
  // Six readers, and **not one writer**. Every method passes the staff account and the assurance level,
  // because the connection carries no claims; `platform.job.read` is a literal inside 0081's own predicate and
  // each function re-applies it.
  //
  // **Nothing here writes a job run or an outbox event.** 0007's `start_job_run`, `finish_job_run`,
  // `claim_outbox_events`, `complete_outbox_event`, `sweep_outbox_events` and `dead_letter_outbox_event` are
  // the workers' and are not called from this gateway at all. There is no retry, no cancel and no replay,
  // because no writer for one exists.
  //
  // **`job_runs.details` is never selected.** 0081's functions read two keys out of it — the SQLSTATE and the
  // job key — and the third, `message`, is `left(sqlerrm, 500)`: a raw error message quotes the row that
  // caused it. No column below could carry it.

  /** `app_private.job_run_page(uuid, boolean, integer, text, text, timestamptz, uuid)` (0081). */
  async jobRunPage(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    jobName: string | null;
    cursorStartedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly JobRunDbRow[]> {
    const result = await sql<{
      id: string;
      job_name: string;
      status: string;
      scheduled_for: Date | null;
      started_at: Date;
      finished_at: Date | null;
      duration_ms: string | null;
      error_type: string | null;
      processed_count: number | null;
      is_contracted: boolean;
    }>`
      select id, job_name, status, scheduled_for, started_at, finished_at, duration_ms, error_type,
             processed_count, is_contracted
        from app_private.job_run_page(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.status}::text,
          ${input.jobName}::text,
          ${input.cursorStartedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      jobName: row.job_name,
      status: row.status,
      scheduledFor: row.scheduled_for ?? null,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? null,
      durationMs: row.duration_ms ?? null,
      errorType: row.error_type ?? null,
      processedCount: row.processed_count ?? null,
      isContracted: row.is_contracted,
    }));
  }

  /** `app_private.job_run_detail(uuid, boolean, uuid)` (0081). */
  async jobRunDetail(input: {
    userId: string;
    isAal2: boolean;
    runId: string;
  }): Promise<JobRunDetailDbRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      job_name: string | null;
      status: string | null;
      scheduled_for: Date | null;
      started_at: Date | null;
      finished_at: Date | null;
      duration_ms: string | null;
      error_type: string | null;
      error_sqlstate: string | null;
      detail_job_key: string | null;
      processed_count: number | null;
      is_contracted: boolean | null;
      cron_schedule: string | null;
      target_signature: string | null;
      purpose: string | null;
    }>`
      select outcome, id, job_name, status, scheduled_for, started_at, finished_at, duration_ms,
             error_type, error_sqlstate, detail_job_key, processed_count, is_contracted,
             cron_schedule, target_signature, purpose
        from app_private.job_run_detail(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.runId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a job run returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      jobName: row.job_name ?? null,
      status: row.status ?? null,
      scheduledFor: row.scheduled_for ?? null,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
      durationMs: row.duration_ms ?? null,
      errorType: row.error_type ?? null,
      errorSqlstate: row.error_sqlstate ?? null,
      detailJobKey: row.detail_job_key ?? null,
      processedCount: row.processed_count ?? null,
      isContracted: row.is_contracted ?? null,
      cronSchedule: row.cron_schedule ?? null,
      targetSignature: row.target_signature ?? null,
      purpose: row.purpose ?? null,
    };
  }

  /** `app_private.scheduled_job_catalogue(uuid, boolean)` (0081). */
  async scheduledJobCatalogue(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly ScheduledJobDbRow[]> {
    const result = await sql<{
      job_key: string;
      cron_schedule: string;
      target_signature: string;
      purpose: string;
      run_count: string;
      failure_count: string;
      last_status: string | null;
      last_started_at: Date | null;
      last_finished_at: Date | null;
      last_duration_ms: string | null;
      last_error_type: string | null;
      last_processed_count: number | null;
    }>`
      select job_key, cron_schedule, target_signature, purpose, run_count, failure_count, last_status,
             last_started_at, last_finished_at, last_duration_ms, last_error_type, last_processed_count
        from app_private.scheduled_job_catalogue(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map((row) => ({
      jobKey: row.job_key,
      cronSchedule: row.cron_schedule,
      targetSignature: row.target_signature,
      purpose: row.purpose,
      runCount: row.run_count,
      failureCount: row.failure_count,
      lastStatus: row.last_status ?? null,
      lastStartedAt: row.last_started_at ?? null,
      lastFinishedAt: row.last_finished_at ?? null,
      lastDurationMs: row.last_duration_ms ?? null,
      lastErrorType: row.last_error_type ?? null,
      lastProcessedCount: row.last_processed_count ?? null,
    }));
  }

  /** `app_private.outbox_health(uuid, boolean)` (0081). */
  async outboxHealth(input: { userId: string; isAal2: boolean }): Promise<OutboxHealthDbRow> {
    const result = await sql<{
      outcome: string;
      pending_count: string | null;
      due_count: string | null;
      in_flight_count: string | null;
      completed_count: string | null;
      dead_lettered_count: string | null;
      oldest_pending_at: Date | null;
      oldest_in_flight_at: Date | null;
      latest_dead_lettered_at: Date | null;
      max_attempts: number | null;
    }>`
      select outcome, pending_count, due_count, in_flight_count, completed_count, dead_lettered_count,
             oldest_pending_at, oldest_in_flight_at, latest_dead_lettered_at, max_attempts
        from app_private.outbox_health(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading outbox health returned no row.');
    return {
      outcome: row.outcome,
      pendingCount: row.pending_count ?? null,
      dueCount: row.due_count ?? null,
      inFlightCount: row.in_flight_count ?? null,
      completedCount: row.completed_count ?? null,
      deadLetteredCount: row.dead_lettered_count ?? null,
      oldestPendingAt: row.oldest_pending_at ?? null,
      oldestInFlightAt: row.oldest_in_flight_at ?? null,
      latestDeadLetteredAt: row.latest_dead_lettered_at ?? null,
      maxAttempts: row.max_attempts ?? null,
    };
  }

  /** `app_private.outbox_dead_letters(uuid, boolean, integer)` (0081). */
  async outboxDeadLetters(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
  }): Promise<readonly OutboxDeadLetterDbRow[]> {
    const result = await sql<{
      event_type: string;
      last_error_type: string | null;
      event_count: string;
      first_dead_lettered_at: Date;
      last_dead_lettered_at: Date;
      max_attempts: number;
    }>`
      select event_type, last_error_type, event_count, first_dead_lettered_at, last_dead_lettered_at,
             max_attempts
        from app_private.outbox_dead_letters(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      eventType: row.event_type,
      lastErrorType: row.last_error_type ?? null,
      eventCount: row.event_count,
      firstDeadLetteredAt: row.first_dead_lettered_at,
      lastDeadLetteredAt: row.last_dead_lettered_at,
      maxAttempts: row.max_attempts,
    }));
  }

  /** `app_private.platform_schedule_problems(uuid, boolean)` (0081). */
  async platformScheduleProblems(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly ScheduleProblemDbRow[]> {
    const result = await sql<{ object: string; problem: string }>`
      select object, problem
        from app_private.platform_schedule_problems(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map((row) => ({ object: row.object, problem: row.problem }));
  }
  /* ---------------------------------------------------------------------------------------------- */
  /* Dispute management (Phase 7-R)                                                                  */
  /* ---------------------------------------------------------------------------------------------- */
  //
  // Three readers and two non-financial writers. Every method passes the staff account and the assurance
  // level, because the connection carries no claims; the two permission keys are literals inside 0082's own
  // predicates, and each function re-applies its own test.
  //
  // **Nothing here moves money.** No method below writes `refunds`, `refund_items`, `payments`,
  // `payment_disputes`, `ledger_entries`, `ledger_journals`, `seller_balances`, `withdrawals` or `payouts`,
  // and none calls a provider. A resolution records a decision; issuing the refund it may imply is a separate
  // operation that does not exist in this platform yet.
  //
  // **The two amounts are strings on both sides.** `claim_amount_minor`, `resolution_amount_minor` and the
  // order total are `bigint`, which `pg` returns as a string because a JavaScript number cannot hold one.
  // They are read as strings, and the resolution amount is bound back as `bigint` from a string — never
  // through `Number`.

  /** `app_private.dispute_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid)` (0082). */
  async disputeQueueForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly DisputeQueueDbRow[]> {
    const result = await sql<{
      id: string;
      status: string;
      reason_code: string;
      currency_code: string;
      claim_amount_minor: string | null;
      order_number: string | null;
      order_status: string;
      order_type: string;
      seller_slug: string | null;
      seller_display_name: string | null;
      is_party: boolean;
      resolved_by_me: boolean;
      resolution: string | null;
      message_count: string;
      has_details: boolean;
      due_at: Date | null;
      created_at: Date;
    }>`
      select id, status, reason_code, currency_code, claim_amount_minor, order_number, order_status,
             order_type, seller_slug, seller_display_name, is_party, resolved_by_me, resolution,
             message_count, has_details, due_at, created_at
        from app_private.dispute_queue_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.status}::text,
          ${input.cursorCreatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      reasonCode: row.reason_code,
      currencyCode: row.currency_code,
      claimAmountMinor: row.claim_amount_minor ?? null,
      orderNumber: row.order_number ?? null,
      orderStatus: row.order_status,
      orderType: row.order_type,
      sellerSlug: row.seller_slug ?? null,
      sellerDisplayName: row.seller_display_name ?? null,
      isParty: row.is_party,
      resolvedByMe: row.resolved_by_me,
      resolution: row.resolution ?? null,
      messageCount: row.message_count,
      hasDetails: row.has_details,
      dueAt: row.due_at ?? null,
      createdAt: row.created_at,
    }));
  }

  /** `app_private.dispute_for_staff(uuid, boolean, uuid)` (0082). */
  async disputeForStaff(input: {
    userId: string;
    isAal2: boolean;
    disputeId: string;
  }): Promise<DisputeDetailDbRow> {
    const result = await sql<{
      outcome: string;
      id: string | null;
      status: string | null;
      reason_code: string | null;
      details: string | null;
      currency_code: string | null;
      claim_amount_minor: string | null;
      order_number: string | null;
      order_status: string | null;
      order_type: string | null;
      order_grand_total_minor: string | null;
      order_status_before: string | null;
      order_placed_at: Date | null;
      seller_slug: string | null;
      seller_display_name: string | null;
      opened_by_role: string | null;
      resolution: string | null;
      resolution_amount_minor: string | null;
      resolution_note: string | null;
      resolved_at: Date | null;
      resolved_by_me: boolean | null;
      is_party: boolean | null;
      can_manage: boolean | null;
      due_at: Date | null;
      created_at: Date | null;
      updated_at: Date | null;
    }>`
      select outcome, id, status, reason_code, details, currency_code, claim_amount_minor, order_number,
             order_status, order_type, order_grand_total_minor, order_status_before, order_placed_at,
             seller_slug, seller_display_name, opened_by_role, resolution, resolution_amount_minor,
             resolution_note, resolved_at, resolved_by_me, is_party, can_manage, due_at, created_at,
             updated_at
        from app_private.dispute_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.disputeId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Reading a dispute returned no row.');
    return {
      outcome: row.outcome,
      id: row.id ?? null,
      status: row.status ?? null,
      reasonCode: row.reason_code ?? null,
      details: row.details ?? null,
      currencyCode: row.currency_code ?? null,
      claimAmountMinor: row.claim_amount_minor ?? null,
      orderNumber: row.order_number ?? null,
      orderStatus: row.order_status ?? null,
      orderType: row.order_type ?? null,
      orderGrandTotalMinor: row.order_grand_total_minor ?? null,
      orderStatusBefore: row.order_status_before ?? null,
      orderPlacedAt: row.order_placed_at ?? null,
      sellerSlug: row.seller_slug ?? null,
      sellerDisplayName: row.seller_display_name ?? null,
      openedByRole: row.opened_by_role ?? null,
      resolution: row.resolution ?? null,
      resolutionAmountMinor: row.resolution_amount_minor ?? null,
      resolutionNote: row.resolution_note ?? null,
      resolvedAt: row.resolved_at ?? null,
      resolvedByMe: row.resolved_by_me ?? null,
      isParty: row.is_party ?? null,
      canManage: row.can_manage ?? null,
      dueAt: row.due_at ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  /** `app_private.dispute_messages_for_staff(uuid, boolean, uuid, integer)` (0082). */
  async disputeMessagesForStaff(input: {
    userId: string;
    isAal2: boolean;
    disputeId: string;
    limit: number;
  }): Promise<readonly DisputeMessageDbRow[]> {
    const result = await sql<{
      id: string;
      author_role: string;
      body: string;
      is_internal: boolean;
      is_own_message: boolean;
      created_at: Date;
    }>`
      select id, author_role, body, is_internal, is_own_message, created_at
        from app_private.dispute_messages_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.disputeId}::uuid,
          ${input.limit}::integer
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      authorRole: row.author_role,
      body: row.body,
      isInternal: row.is_internal,
      isOwnMessage: row.is_own_message,
      createdAt: row.created_at,
    }));
  }

  /** `app_private.dispute_message_post_for_staff(uuid, boolean, uuid, text, boolean)` (0082). */
  async disputeMessagePostForStaff(input: {
    userId: string;
    isAal2: boolean;
    disputeId: string;
    body: string;
    isInternal: boolean;
  }): Promise<DisputeMessagePostRow> {
    const result = await sql<{ outcome: string; message_id: string | null }>`
      select outcome, message_id
        from app_private.dispute_message_post_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.disputeId}::uuid,
          ${input.body}::text,
          ${input.isInternal}::boolean
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Adding a dispute message returned no row.');
    return { outcome: row.outcome, messageId: row.message_id ?? null };
  }

  /**
   * `app_private.dispute_resolve_for_staff(uuid, boolean, uuid, text, text, bigint)` (0082).
   *
   * **This records a decision and moves no money.** The amount is bound from a string straight to the
   * `bigint` parameter, so a large decision keeps its precision.
   */
  async disputeResolveForStaff(input: {
    userId: string;
    isAal2: boolean;
    disputeId: string;
    resolution: string;
    resolutionNote: string;
    resolutionAmountMinor: string | null;
  }): Promise<DisputeResolveRow> {
    const result = await sql<{ outcome: string; status: string | null; resolution: string | null }>`
      select outcome, status, resolution
        from app_private.dispute_resolve_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.disputeId}::uuid,
          ${input.resolution}::text,
          ${input.resolutionNote}::text,
          ${input.resolutionAmountMinor}::bigint
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('Recording a dispute resolution returned no row.');
    return {
      outcome: row.outcome,
      status: row.status ?? null,
      resolution: row.resolution ?? null,
    };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* CMS static pages (0085)                                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  /** `app_private.cms_pages_for_public(text)` (0085). */
  async cmsPagesForPublic(locale: string): Promise<readonly PublicCmsPageLinkDbRow[]> {
    const result = await sql<{
      page_id: string;
      slug: string;
      page_key: string | null;
      template: string;
      is_indexable: boolean;
      sort_order: number;
      published_at: Date | null;
      updated_at: Date;
      resolved_locale: string;
      title: string;
    }>`
      select page_id, slug, page_key, template, is_indexable, sort_order, published_at, updated_at,
             resolved_locale, title
        from app_private.cms_pages_for_public(${locale}::text)
    `.execute(this.db);

    return result.rows.map((row) => ({
      pageId: row.page_id,
      slug: row.slug,
      pageKey: row.page_key ?? null,
      template: row.template,
      isIndexable: row.is_indexable,
      sortOrder: row.sort_order,
      publishedAt: row.published_at ?? null,
      updatedAt: row.updated_at,
      resolvedLocale: row.resolved_locale,
      title: row.title,
    }));
  }

  /** `app_private.cms_page_for_public(text, text)` (0085). Always one row: a page, a redirect or absence. */
  async cmsPageForPublic(input: { slug: string; locale: string }): Promise<PublicCmsPageDbRow | null> {
    const result = await sql<{
      kind: string;
      page_id: string | null;
      slug: string | null;
      page_key: string | null;
      template: string | null;
      is_indexable: boolean | null;
      published_at: Date | null;
      updated_at: Date | null;
      resolved_locale: string | null;
      title: string | null;
      excerpt: string | null;
      body: string | null;
      meta_title: string | null;
      meta_description: string | null;
      cover_object_path: string | null;
    }>`
      select kind, page_id, slug, page_key, template, is_indexable, published_at, updated_at,
             resolved_locale, title, excerpt, body, meta_title, meta_description, cover_object_path
        from app_private.cms_page_for_public(${input.slug}::text, ${input.locale}::text)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      kind: row.kind,
      pageId: row.page_id ?? null,
      slug: row.slug ?? null,
      pageKey: row.page_key ?? null,
      template: row.template ?? null,
      isIndexable: row.is_indexable ?? null,
      publishedAt: row.published_at ?? null,
      updatedAt: row.updated_at ?? null,
      resolvedLocale: row.resolved_locale ?? null,
      title: row.title ?? null,
      excerpt: row.excerpt ?? null,
      body: row.body ?? null,
      metaTitle: row.meta_title ?? null,
      metaDescription: row.meta_description ?? null,
      coverObjectPath: row.cover_object_path ?? null,
    };
  }

  /** `app_private.cms_pages_for_staff(uuid, boolean, integer, text, timestamptz, uuid)` (0085). */
  async cmsPagesForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorUpdatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly CmsPageListDbRow[]> {
    const result = await sql<{
      page_id: string;
      slug: string;
      page_key: string | null;
      status: string;
      template: string;
      is_indexable: boolean;
      sort_order: number;
      scheduled_for: Date | null;
      published_at: Date | null;
      archived_at: Date | null;
      updated_at: Date;
      translated_locales: string[] | null;
      title: string | null;
    }>`
      select page_id, slug, page_key, status, template, is_indexable, sort_order, scheduled_for,
             published_at, archived_at, updated_at, translated_locales, title
        from app_private.cms_pages_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.status}::text,
          ${input.cursorUpdatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      pageId: row.page_id,
      slug: row.slug,
      pageKey: row.page_key ?? null,
      status: row.status,
      template: row.template,
      isIndexable: row.is_indexable,
      sortOrder: row.sort_order,
      scheduledFor: row.scheduled_for ?? null,
      publishedAt: row.published_at ?? null,
      archivedAt: row.archived_at ?? null,
      updatedAt: row.updated_at,
      translatedLocales: row.translated_locales ?? null,
      title: row.title ?? null,
    }));
  }

  /** `app_private.cms_page_for_staff(uuid, boolean, uuid)` (0085). No row for absence or for no permission. */
  async cmsPageForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
  }): Promise<CmsPageDetailDbRow | null> {
    const result = await sql<{
      page_id: string;
      slug: string;
      page_key: string | null;
      status: string;
      template: string;
      is_indexable: boolean;
      sort_order: number;
      scheduled_for: Date | null;
      published_at: Date | null;
      archived_at: Date | null;
      created_at: Date;
      updated_at: Date;
      created_by: string | null;
      updated_by: string | null;
      can_manage: boolean;
      previous_slugs: string[] | null;
    }>`
      select page_id, slug, page_key, status, template, is_indexable, sort_order, scheduled_for,
             published_at, archived_at, created_at, updated_at, created_by, updated_by, can_manage,
             previous_slugs
        from app_private.cms_page_for_staff(
          ${input.userId}::uuid, ${input.isAal2}::boolean, ${input.pageId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      pageId: row.page_id,
      slug: row.slug,
      pageKey: row.page_key ?? null,
      status: row.status,
      template: row.template,
      isIndexable: row.is_indexable,
      sortOrder: row.sort_order,
      scheduledFor: row.scheduled_for ?? null,
      publishedAt: row.published_at ?? null,
      archivedAt: row.archived_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by ?? null,
      updatedBy: row.updated_by ?? null,
      canManage: row.can_manage,
      previousSlugs: row.previous_slugs ?? null,
    };
  }

  /** `app_private.cms_page_translations_for_staff(uuid, boolean, uuid)` (0085). */
  async cmsPageTranslationsForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
  }): Promise<readonly CmsPageTranslationDbRow[]> {
    const result = await sql<{
      locale_code: string;
      title: string;
      excerpt: string | null;
      body: string;
      meta_title: string | null;
      meta_description: string | null;
      updated_at: Date;
    }>`
      select locale_code, title, excerpt, body, meta_title, meta_description, updated_at
        from app_private.cms_page_translations_for_staff(
          ${input.userId}::uuid, ${input.isAal2}::boolean, ${input.pageId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      localeCode: row.locale_code,
      title: row.title,
      excerpt: row.excerpt ?? null,
      body: row.body,
      metaTitle: row.meta_title ?? null,
      metaDescription: row.meta_description ?? null,
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.cms_page_create_for_staff(...)` (0085). Raises 42501 without the manage key. */
  async cmsPageCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    pageKey: string | null;
    template: string;
    sortOrder: number;
    isIndexable: boolean;
  }): Promise<string> {
    const result = await sql<{ id: string }>`
      select app_private.cms_page_create_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.slug}::text,
        ${input.pageKey}::text,
        ${input.template}::text,
        ${input.sortOrder}::integer,
        ${input.isIndexable}::boolean
      ) as id
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('The page was not created.');
    return row.id;
  }

  /** `app_private.cms_page_update_for_staff(...)` (0085). False when no such page. */
  async cmsPageUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    slug: string | null;
    pageKey: string | null;
    template: string | null;
    sortOrder: number | null;
    isIndexable: boolean | null;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.cms_page_update_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.pageId}::uuid,
        ${input.slug}::text,
        ${input.pageKey}::text,
        ${input.template}::text,
        ${input.sortOrder}::integer,
        ${input.isIndexable}::boolean
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /**
   * `app_private.cms_page_cover_for_staff(...)` (0099). False when no such page.
   *
   * Three behaviours, and the caller picks one: a media id attaches it, `clearCover` removes whatever is
   * there, and neither leaves the cover alone. A media id that names no library entry raises `23503`.
   */
  async cmsPageCoverForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    coverMediaId: string | null;
    clearCover: boolean;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.cms_page_cover_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.pageId}::uuid,
        ${input.coverMediaId}::uuid,
        ${input.clearCover}::boolean
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /**
   * `app_private.cms_cover_media_for_staff(...)` (0099). The cover attached to one page or one post.
   *
   * No row covers all of: nothing attached, no such entity, an unrecognised entity type, and a caller
   * without that section's read key. Reports the stored object path, never a URL.
   */
  async cmsCoverMediaForStaff(input: {
    userId: string;
    isAal2: boolean;
    entityType: 'page' | 'blog_post';
    entityId: string;
  }): Promise<CmsCoverMediaDbRow | null> {
    const result = await sql<CmsCoverMediaDbRow>`
      select media_id as "mediaId",
             object_path as "objectPath",
             alt_text_en as "altTextEn",
             alt_text_ar as "altTextAr"
        from app_private.cms_cover_media_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.entityType}::text,
          ${input.entityId}::uuid
        )
    `.execute(this.db);

    return result.rows[0] ?? null;
  }

  /** `app_private.cms_page_status_for_staff(...)` (0085). The only writer that changes a page's state. */
  async cmsPageStatusForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    status: string;
    scheduledFor: Date | null;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.cms_page_status_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.pageId}::uuid,
        ${input.status}::text,
        ${input.scheduledFor}::timestamptz
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.cms_page_translation_save_for_staff(...)` (0085). */
  async cmsPageTranslationSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    localeCode: string;
    title: string;
    body: string;
    excerpt: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  }): Promise<boolean> {
    const result = await sql<{ saved: boolean }>`
      select app_private.cms_page_translation_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.pageId}::uuid,
        ${input.localeCode}::text,
        ${input.title}::text,
        ${input.body}::text,
        ${input.excerpt}::text,
        ${input.metaTitle}::text,
        ${input.metaDescription}::text
      ) as saved
    `.execute(this.db);

    return result.rows[0]?.saved === true;
  }

  /** `app_private.cms_page_translation_delete_for_staff(...)` (0085). */
  async cmsPageTranslationDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    localeCode: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.cms_page_translation_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.pageId}::uuid,
        ${input.localeCode}::text
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  // -------------------------------------------------------------------------------------------------
  // The category tree (0087)
  // -------------------------------------------------------------------------------------------------
  /** `app_private.categories_for_staff(uuid, boolean)` (0087). */
  async categoriesForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly CategoryNodeDbRow[]> {
    const result = await sql<{
      category_id: string;
      parent_id: string | null;
      slug: string;
      depth: number;
      sort_order: number;
      listing_type_code: string | null;
      is_active: boolean;
      is_visible: boolean;
      child_count: number;
      listing_count: number;
      translated_locales: string[] | null;
      name: string | null;
      updated_at: Date;
    }>`
      select category_id, parent_id, slug, depth, sort_order, listing_type_code, is_active, is_visible,
             child_count, listing_count, translated_locales, name, updated_at
        from app_private.categories_for_staff(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map((row) => ({
      categoryId: row.category_id,
      parentId: row.parent_id ?? null,
      slug: row.slug,
      depth: Number(row.depth),
      sortOrder: Number(row.sort_order),
      listingTypeCode: row.listing_type_code ?? null,
      isActive: row.is_active,
      isVisible: row.is_visible,
      childCount: Number(row.child_count),
      listingCount: Number(row.listing_count),
      translatedLocales: row.translated_locales ?? [],
      name: row.name ?? null,
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.category_for_staff(uuid, boolean, uuid)` (0087). */
  async categoryForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
  }): Promise<CategoryDetailDbRow | null> {
    const result = await sql<{
      category_id: string;
      parent_id: string | null;
      parent_slug: string | null;
      slug: string;
      depth: number;
      sort_order: number;
      listing_type_code: string | null;
      is_active: boolean;
      is_visible: boolean;
      child_count: number;
      listing_count: number;
      translated_locales: string[] | null;
      created_at: Date;
      updated_at: Date;
      can_manage: boolean;
    }>`
      select category_id, parent_id, parent_slug, slug, depth, sort_order, listing_type_code, is_active,
             is_visible, child_count, listing_count, translated_locales, created_at, updated_at, can_manage
        from app_private.category_for_staff(
          ${input.userId}::uuid, ${input.isAal2}::boolean, ${input.categoryId}::uuid)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      categoryId: row.category_id,
      parentId: row.parent_id ?? null,
      parentSlug: row.parent_slug ?? null,
      slug: row.slug,
      depth: Number(row.depth),
      sortOrder: Number(row.sort_order),
      listingTypeCode: row.listing_type_code ?? null,
      isActive: row.is_active,
      isVisible: row.is_visible,
      childCount: Number(row.child_count),
      listingCount: Number(row.listing_count),
      translatedLocales: row.translated_locales ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canManage: row.can_manage,
    };
  }

  /** `app_private.category_translations_for_staff(uuid, boolean, uuid)` (0087). */
  async categoryTranslationsForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
  }): Promise<readonly CategoryTranslationDbRow[]> {
    const result = await sql<{
      locale_code: string;
      name: string;
      description: string | null;
      meta_title: string | null;
      meta_description: string | null;
      updated_at: Date;
    }>`
      select locale_code, name, description, meta_title, meta_description, updated_at
        from app_private.category_translations_for_staff(
          ${input.userId}::uuid, ${input.isAal2}::boolean, ${input.categoryId}::uuid)
    `.execute(this.db);

    return result.rows.map((row) => ({
      localeCode: row.locale_code,
      name: row.name,
      description: row.description ?? null,
      metaTitle: row.meta_title ?? null,
      metaDescription: row.meta_description ?? null,
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.category_create_for_staff(...)` (0087). */
  async categoryCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    parentId: string | null;
    listingTypeCode: string | null;
    sortOrder: number;
  }): Promise<string> {
    const result = await sql<{ category_id: string }>`
      select app_private.category_create_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.slug}::text,
        ${input.parentId}::uuid,
        ${input.listingTypeCode}::text,
        ${input.sortOrder}::integer
      ) as category_id
    `.execute(this.db);

    const id = result.rows[0]?.category_id;
    if (id === undefined || id === null) throw new Error('the category writer returned no identifier');
    return id;
  }

  /** `app_private.category_update_for_staff(...)` (0087). */
  async categoryUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    setParent: boolean;
    parentId: string | null;
    listingTypeCode: string | null;
    sortOrder: number | null;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.category_update_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.categoryId}::uuid,
        ${input.setParent}::boolean,
        ${input.parentId}::uuid,
        ${input.listingTypeCode}::text,
        ${input.sortOrder}::integer
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.category_state_for_staff(...)` (0087). */
  async categoryStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.category_state_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.categoryId}::uuid,
        ${input.isActive}::boolean
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.category_translation_save_for_staff(...)` (0087). */
  async categoryTranslationSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    localeCode: string;
    name: string;
    description: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.category_translation_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.categoryId}::uuid,
        ${input.localeCode}::text,
        ${input.name}::text,
        ${input.description}::text,
        ${input.metaTitle}::text,
        ${input.metaDescription}::text
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.category_translation_delete_for_staff(...)` (0087). */
  async categoryTranslationDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    localeCode: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.category_translation_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.categoryId}::uuid,
        ${input.localeCode}::text
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  // -------------------------------------------------------------------------------------------------
  // Per-entity SEO metadata (0091)
  // -------------------------------------------------------------------------------------------------
  /**
   * `app_private.public_seo_metadata_for_entity(text, text, text)` (0091). No row means no override.
   *
   * Addressed by slug, because two public contracts carry no identifier and the slug resolution belongs in the
   * database anyway. The two owner decisions — a canonical withheld for a listing, a category and a seller, and
   * directives reduced to their restrictions — are applied inside that function, so what arrives here is already
   * what a page may act on.
   */
  async publicSeoMetadataForEntity(input: {
    entityType: string;
    slug: string;
    locale: string;
  }): Promise<PublicSeoMetadataDbRow | null> {
    const result = await sql<{
      meta_title: string | null;
      meta_description: string | null;
      canonical_path: string | null;
      robots_directives: string[] | null;
      og_title: string | null;
      og_description: string | null;
      share_object_path: string | null;
    }>`
      select meta_title, meta_description, canonical_path, robots_directives, og_title, og_description,
             share_object_path
        from app_private.public_seo_metadata_for_entity(
          ${input.entityType}::text,
          ${input.slug}::text,
          ${input.locale}::text
        )
    `.execute(this.db);

    return metadataRow(result.rows[0]);
  }

  /** `app_private.public_seo_metadata_for_route(text, text)` (0091). A route honours its stored canonical. */
  async publicSeoMetadataForRoute(input: {
    routePath: string;
    locale: string;
  }): Promise<PublicSeoMetadataDbRow | null> {
    const result = await sql<{
      meta_title: string | null;
      meta_description: string | null;
      canonical_path: string | null;
      robots_directives: string[] | null;
      og_title: string | null;
      og_description: string | null;
      share_object_path: string | null;
    }>`
      select meta_title, meta_description, canonical_path, robots_directives, og_title, og_description,
             share_object_path
        from app_private.public_seo_metadata_for_route(${input.routePath}::text, ${input.locale}::text)
    `.execute(this.db);

    return metadataRow(result.rows[0]);
  }

  /** `app_private.seo_metadata_for_staff(...)` (0091). Empty for a caller without `seo.metadata.read`. */
  async seoMetadataForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    entityType: string | null;
    locale: string | null;
    cursorUpdatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SeoMetadataListDbRow[]> {
    const result = await sql<MetadataListSqlRow>`
      select entry_id, entity_type, entity_id, route_path, target_slug, locale_code, meta_title, meta_description,
             canonical_path, robots_directives, og_title, og_description, share_media_id, canonical_is_honoured,
             updated_at
        from app_private.seo_metadata_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.entityType}::text,
          ${input.locale}::text,
          ${input.cursorUpdatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => metadataListRow(row));
  }

  /** `app_private.seo_metadata_entry_for_staff(uuid, boolean, uuid)` (0091). No row for absence or no permission. */
  async seoMetadataEntryForStaff(input: {
    userId: string;
    isAal2: boolean;
    entryId: string;
  }): Promise<SeoMetadataDetailDbRow | null> {
    const result = await sql<
      MetadataListSqlRow & {
        share_object_path: string | null;
        effective_canonical_path: string | null;
        effective_robots_directives: string[] | null;
        created_at: Date;
        updated_by: string | null;
        can_manage: boolean;
      }
    >`
      select entry_id, entity_type, entity_id, route_path, target_slug, locale_code, meta_title, meta_description,
             canonical_path, robots_directives, og_title, og_description, share_media_id, canonical_is_honoured,
             updated_at, share_object_path, effective_canonical_path, effective_robots_directives, created_at,
             updated_by, can_manage
        from app_private.seo_metadata_entry_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.entryId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ...metadataListRow(row),
      shareObjectPath: row.share_object_path ?? null,
      effectiveCanonicalPath: row.effective_canonical_path ?? null,
      effectiveRobotsDirectives: row.effective_robots_directives ?? null,
      createdAt: row.created_at,
      updatedBy: row.updated_by ?? null,
      canManage: row.can_manage,
    };
  }

  /** `app_private.seo_metadata_save_for_staff(...)` (0091). Creating and replacing are the same call. */
  async seoMetadataSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    entityType: string;
    entityId: string | null;
    routePath: string | null;
    localeCode: string;
    metaTitle: string | null;
    metaDescription: string | null;
    canonicalPath: string | null;
    robotsDirectives: readonly string[] | null;
    ogTitle: string | null;
    ogDescription: string | null;
    shareMediaId: string | null;
  }): Promise<string> {
    const result = await sql<{ id: string }>`
      select app_private.seo_metadata_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.entityType}::text,
        ${input.entityId}::uuid,
        ${input.routePath}::text,
        ${input.localeCode}::text,
        ${input.metaTitle}::text,
        ${input.metaDescription}::text,
        ${input.canonicalPath}::text,
        ${input.robotsDirectives === null ? null : [...input.robotsDirectives]}::text[],
        ${input.ogTitle}::text,
        ${input.ogDescription}::text,
        ${input.shareMediaId}::uuid
      ) as id
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('The metadata override was not written.');
    return row.id;
  }

  /** `app_private.seo_metadata_delete_for_staff(...)` (0091). False when no such entry. */
  async seoMetadataDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    entryId: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.seo_metadata_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.entryId}::uuid
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  // -------------------------------------------------------------------------------------------------
  // The SEO redirect map (0090)
  // -------------------------------------------------------------------------------------------------
  /**
   * `app_private.public_redirect_resolve(text)` (0090). No row means the map names no redirect for that path.
   *
   * The public half, asked only about a path the web app has already decided answers 404 — the approved
   * precedence is LIVE PAGE WINS, resolved there and not here. The chain, the five-hop limit, the cycle stop and
   * the inactive-entry rule all belong to 0030's resolver, which 0090's reader composes.
   */
  async publicRedirectResolve(path: string): Promise<RedirectResolutionRow | null> {
    const result = await sql<{ to_path: string; status_code: number }>`
      select to_path, status_code from app_private.public_redirect_resolve(${path}::text)
    `.execute(this.db);

    const row = result.rows[0];
    return row === undefined ? null : { toPath: row.to_path, statusCode: Number(row.status_code) };
  }

  /** `app_private.redirects_for_staff(...)` (0090). Empty for a caller without `seo.redirect.read`. */
  async redirectsForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    search: string | null;
    isActive: boolean | null;
    cursorUpdatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SeoRedirectListDbRow[]> {
    const result = await sql<{
      redirect_id: string;
      from_path: string;
      to_path: string;
      status_code: number;
      is_active: boolean;
      note: string | null;
      created_at: Date;
      updated_at: Date;
    }>`
      select redirect_id, from_path, to_path, status_code, is_active, note, created_at, updated_at
        from app_private.redirects_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.search}::text,
          ${input.isActive}::boolean,
          ${input.cursorUpdatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      redirectId: row.redirect_id,
      fromPath: row.from_path,
      toPath: row.to_path,
      statusCode: row.status_code,
      isActive: row.is_active,
      note: row.note ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.redirect_for_staff(uuid, boolean, uuid)` (0090). No row for absence or for no permission. */
  async redirectForStaff(input: {
    userId: string;
    isAal2: boolean;
    redirectId: string;
  }): Promise<SeoRedirectDetailDbRow | null> {
    const result = await sql<{
      redirect_id: string;
      from_path: string;
      to_path: string;
      status_code: number;
      is_active: boolean;
      note: string | null;
      created_at: Date;
      updated_at: Date;
      created_by: string | null;
      can_manage: boolean;
      resolved_to_path: string | null;
      resolved_status_code: number | null;
    }>`
      select redirect_id, from_path, to_path, status_code, is_active, note, created_at, updated_at,
             created_by, can_manage, resolved_to_path, resolved_status_code
        from app_private.redirect_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.redirectId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      redirectId: row.redirect_id,
      fromPath: row.from_path,
      toPath: row.to_path,
      statusCode: row.status_code,
      isActive: row.is_active,
      note: row.note ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by ?? null,
      canManage: row.can_manage,
      resolvedToPath: row.resolved_to_path ?? null,
      resolvedStatusCode: row.resolved_status_code ?? null,
    };
  }

  /** `app_private.redirect_create_for_staff(...)` (0090). */
  async redirectCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    fromPath: string;
    toPath: string;
    statusCode: number;
    note: string | null;
    isActive: boolean;
  }): Promise<string> {
    const result = await sql<{ id: string }>`
      select app_private.redirect_create_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.fromPath}::text,
        ${input.toPath}::text,
        ${input.statusCode}::integer,
        ${input.note}::text,
        ${input.isActive}::boolean
      ) as id
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) throw new Error('The redirect was not created.');
    return row.id;
  }

  /** `app_private.redirect_update_for_staff(...)` (0090). False when no such entry. Never changes the state. */
  async redirectUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    redirectId: string;
    fromPath: string | null;
    toPath: string | null;
    statusCode: number | null;
    note: string | null;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.redirect_update_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.redirectId}::uuid,
        ${input.fromPath}::text,
        ${input.toPath}::text,
        ${input.statusCode}::integer,
        ${input.note}::text
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.redirect_state_for_staff(...)` (0090). The only writer that changes whether one is active. */
  async redirectStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    redirectId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.redirect_state_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.redirectId}::uuid,
        ${input.isActive}::boolean
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.redirect_delete_for_staff(...)` (0090). False when no such entry. */
  async redirectDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    redirectId: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.redirect_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.redirectId}::uuid
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  // -------------------------------------------------------------------------------------------------
  // Public SEO delivery (0086)
  // -------------------------------------------------------------------------------------------------
  /** `app_private.public_robots_body()` (0086). No row means nobody has authored a body. */
  async publicRobotsBody(): Promise<RobotsBodyRow | null> {
    const result = await sql<{ locale_code: string; robots_txt_body: string | null }>`
      select locale_code, robots_txt_body from app_private.public_robots_body()
    `.execute(this.db);

    const row = result.rows[0];
    return row === undefined ? null : { localeCode: row.locale_code, body: row.robots_txt_body ?? null };
  }

  /** `app_private.public_sitemap_counts()` (0086). */
  async publicSitemapCounts(): Promise<readonly SitemapCountRow[]> {
    const result = await sql<{ entry_type: string; entry_count: string | number }>`
      select entry_type, entry_count from app_private.public_sitemap_counts()
    `.execute(this.db);

    // `count(*)` is bigint, which arrives as a string: converted here rather than left for a caller to
    // discover when it compares it to a number.
    return result.rows.map((row) => ({ entryType: row.entry_type, entryCount: Number(row.entry_count) }));
  }

  /** `app_private.public_sitemap_pages(integer, integer)` (0086). Carries the locales that resolve. */
  async publicSitemapPages(limit: number, offset: number): Promise<readonly SitemapEntryRow[]> {
    const result = await sql<{ slug: string; updated_at: Date; locales: string[] | null }>`
      select slug, updated_at, locales
        from app_private.public_sitemap_pages(${limit}::integer, ${offset}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({
      slug: row.slug,
      updatedAt: row.updated_at,
      locales: row.locales ?? [],
    }));
  }

  /**
   * `app_private.public_sitemap_blog_posts(integer, integer)` (0097). Carries the locales that resolve.
   *
   * Same shape as the page reader for the same reason: a post, like a static page, can be written in one language
   * and not the other, so the locales it answers in are the database's answer rather than an assumption here.
   */
  async publicSitemapBlogPosts(limit: number, offset: number): Promise<readonly SitemapEntryRow[]> {
    const result = await sql<{ slug: string; updated_at: Date; locales: string[] | null }>`
      select slug, updated_at, locales
        from app_private.public_sitemap_blog_posts(${limit}::integer, ${offset}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({
      slug: row.slug,
      updatedAt: row.updated_at,
      locales: row.locales ?? [],
    }));
  }

  /** `app_private.public_sitemap_listings(integer, integer)` (0086). */
  async publicSitemapListings(limit: number, offset: number): Promise<readonly SitemapEntryRow[]> {
    const result = await sql<{ slug: string; updated_at: Date }>`
      select slug, updated_at
        from app_private.public_sitemap_listings(${limit}::integer, ${offset}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({ slug: row.slug, updatedAt: row.updated_at }));
  }

  /** `app_private.public_sitemap_services(integer, integer)` (0086). */
  async publicSitemapServices(limit: number, offset: number): Promise<readonly SitemapEntryRow[]> {
    const result = await sql<{ slug: string; updated_at: Date }>`
      select slug, updated_at
        from app_private.public_sitemap_services(${limit}::integer, ${offset}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({ slug: row.slug, updatedAt: row.updated_at }));
  }

  /** `app_private.public_sitemap_categories(integer, integer)` (0086). */
  async publicSitemapCategories(limit: number, offset: number): Promise<readonly SitemapEntryRow[]> {
    const result = await sql<{ slug: string; updated_at: Date }>`
      select slug, updated_at
        from app_private.public_sitemap_categories(${limit}::integer, ${offset}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({ slug: row.slug, updatedAt: row.updated_at }));
  }

  /** `app_private.public_sitemap_sellers(integer, integer)` (0086). */
  async publicSitemapSellers(limit: number, offset: number): Promise<readonly SitemapEntryRow[]> {
    const result = await sql<{ slug: string; updated_at: Date }>`
      select slug, updated_at
        from app_private.public_sitemap_sellers(${limit}::integer, ${offset}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({ slug: row.slug, updatedAt: row.updated_at }));
  }

  // -------------------------------------------------------------------------------------------------
  // Phase 8-C: the attribute and tag vocabulary, and the seller's own answers (0088)
  // -------------------------------------------------------------------------------------------------
  // Every one of these is a named `app_private` function and nothing else. No table is named, no predicate is
  // rebuilt here, and the three permission keys are pinned inside the functions rather than passed in.

  /** `app_private.attribute_can_manage(uuid, boolean)` (0088). */
  async attributeCanManage(input: { userId: string; isAal2: boolean }): Promise<boolean> {
    const result = await sql<{ allowed: boolean }>`
      select app_private.attribute_can_manage(${input.userId}::uuid, ${input.isAal2}::boolean) as allowed
    `.execute(this.db);
    return result.rows[0]?.allowed === true;
  }

  /** `app_private.tag_can_manage(uuid, boolean)` (0088). */
  async tagCanManage(input: { userId: string; isAal2: boolean }): Promise<boolean> {
    const result = await sql<{ allowed: boolean }>`
      select app_private.tag_can_manage(${input.userId}::uuid, ${input.isAal2}::boolean) as allowed
    `.execute(this.db);
    return result.rows[0]?.allowed === true;
  }

  /** `app_private.category_can_manage(uuid, boolean)` (0087), which is what governs a category's attributes. */
  async categoryCanManage(input: { userId: string; isAal2: boolean }): Promise<boolean> {
    const result = await sql<{ allowed: boolean }>`
      select app_private.category_can_manage(${input.userId}::uuid, ${input.isAal2}::boolean) as allowed
    `.execute(this.db);
    return result.rows[0]?.allowed === true;
  }

  /** `app_private.attribute_definitions_for_staff(uuid, boolean)` (0088). */
  async attributeDefinitionsForStaff(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly AttributeDefinitionDbRow[]> {
    const result = await sql<AttributeDefinitionSqlRow>`
      select definition_id, key, data_type, unit, name_en, name_ar, is_filterable, is_active, sort_order,
             option_count, category_count, answer_count, created_at, updated_at
        from app_private.attribute_definitions_for_staff(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);
    return result.rows.map((row) => attributeDefinitionRow(row));
  }

  /** `app_private.attribute_definition_for_staff(uuid, boolean, uuid)` (0088). */
  async attributeDefinitionForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
  }): Promise<AttributeDefinitionDbRow | null> {
    const result = await sql<AttributeDefinitionSqlRow>`
      select definition_id, key, data_type, unit, name_en, name_ar, is_filterable, is_active, sort_order,
             option_count, category_count, answer_count, created_at, updated_at
        from app_private.attribute_definition_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.definitionId}::uuid
        )
    `.execute(this.db);
    const row = result.rows[0];
    return row === undefined ? null : attributeDefinitionRow(row);
  }

  /** `app_private.attribute_options_for_staff(uuid, boolean, uuid)` (0088). */
  async attributeOptionsForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
  }): Promise<readonly AttributeOptionDbRow[]> {
    const result = await sql<{
      option_id: string;
      value: string;
      label_en: string;
      label_ar: string;
      sort_order: number;
      is_active: boolean;
      answer_count: number;
    }>`
      select option_id, value, label_en, label_ar, sort_order, is_active, answer_count
        from app_private.attribute_options_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.definitionId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      optionId: row.option_id,
      value: row.value,
      labelEn: row.label_en,
      labelAr: row.label_ar,
      sortOrder: Number(row.sort_order),
      isActive: row.is_active,
      answerCount: Number(row.answer_count),
    }));
  }

  /** `app_private.attribute_definition_create_for_staff(...)` (0088). */
  async attributeDefinitionCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    key: string;
    dataType: string;
    nameEn: string;
    nameAr: string;
    unit: string | null;
    isFilterable: boolean;
    sortOrder: number;
  }): Promise<string> {
    const result = await sql<{ definition_id: string }>`
      select app_private.attribute_definition_create_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.key}::text,
        ${input.dataType}::text,
        ${input.nameEn}::text,
        ${input.nameAr}::text,
        ${input.unit}::text,
        ${input.isFilterable}::boolean,
        ${input.sortOrder}::integer
      ) as definition_id
    `.execute(this.db);

    const definitionId = result.rows[0]?.definition_id;
    if (definitionId === undefined) throw new Error('the attribute definition writer returned no identifier');
    return definitionId;
  }

  /** `app_private.attribute_definition_update_for_staff(...)` (0088). */
  async attributeDefinitionUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
    nameEn: string;
    nameAr: string;
    unit: string | null;
    isFilterable: boolean;
    sortOrder: number;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.attribute_definition_update_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.definitionId}::uuid,
        ${input.nameEn}::text,
        ${input.nameAr}::text,
        ${input.unit}::text,
        ${input.isFilterable}::boolean,
        ${input.sortOrder}::integer
      ) as changed
    `.execute(this.db);
    return result.rows[0]?.changed === true;
  }

  /** `app_private.attribute_definition_state_for_staff(...)` (0088). */
  async attributeDefinitionStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.attribute_definition_state_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.definitionId}::uuid,
        ${input.isActive}::boolean
      ) as changed
    `.execute(this.db);
    return result.rows[0]?.changed === true;
  }

  /** `app_private.attribute_option_create_for_staff(...)` (0088). */
  async attributeOptionCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
    value: string;
    labelEn: string;
    labelAr: string;
    sortOrder: number;
  }): Promise<string> {
    const result = await sql<{ option_id: string }>`
      select app_private.attribute_option_create_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.definitionId}::uuid,
        ${input.value}::text,
        ${input.labelEn}::text,
        ${input.labelAr}::text,
        ${input.sortOrder}::integer
      ) as option_id
    `.execute(this.db);

    const optionId = result.rows[0]?.option_id;
    if (optionId === undefined) throw new Error('the attribute option writer returned no identifier');
    return optionId;
  }

  /** `app_private.attribute_option_update_for_staff(...)` (0088). */
  async attributeOptionUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    optionId: string;
    labelEn: string;
    labelAr: string;
    sortOrder: number;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.attribute_option_update_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.optionId}::uuid,
        ${input.labelEn}::text,
        ${input.labelAr}::text,
        ${input.sortOrder}::integer
      ) as changed
    `.execute(this.db);
    return result.rows[0]?.changed === true;
  }

  /** `app_private.attribute_option_state_for_staff(...)` (0088). */
  async attributeOptionStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    optionId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.attribute_option_state_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.optionId}::uuid,
        ${input.isActive}::boolean
      ) as changed
    `.execute(this.db);
    return result.rows[0]?.changed === true;
  }

  /** `app_private.tags_for_staff(uuid, boolean)` (0088). */
  async tagsForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly TagDbRow[]> {
    const result = await sql<{
      tag_id: string;
      slug: string;
      name_en: string;
      name_ar: string;
      is_active: boolean;
      usage_count: number;
      created_at: Date;
      updated_at: Date;
    }>`
      select tag_id, slug, name_en, name_ar, is_active, usage_count, created_at, updated_at
        from app_private.tags_for_staff(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map((row) => ({
      tagId: row.tag_id,
      slug: row.slug,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      isActive: row.is_active,
      usageCount: Number(row.usage_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.tag_create_for_staff(...)` (0088). */
  async tagCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    nameEn: string;
    nameAr: string;
  }): Promise<string> {
    const result = await sql<{ tag_id: string }>`
      select app_private.tag_create_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.slug}::text,
        ${input.nameEn}::text,
        ${input.nameAr}::text
      ) as tag_id
    `.execute(this.db);

    const tagId = result.rows[0]?.tag_id;
    if (tagId === undefined) throw new Error('the tag writer returned no identifier');
    return tagId;
  }

  /** `app_private.tag_update_for_staff(...)` (0088). */
  async tagUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    tagId: string;
    nameEn: string;
    nameAr: string;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.tag_update_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.tagId}::uuid,
        ${input.nameEn}::text,
        ${input.nameAr}::text
      ) as changed
    `.execute(this.db);
    return result.rows[0]?.changed === true;
  }

  /** `app_private.tag_state_for_staff(...)` (0088). */
  async tagStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    tagId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.tag_state_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.tagId}::uuid,
        ${input.isActive}::boolean
      ) as changed
    `.execute(this.db);
    return result.rows[0]?.changed === true;
  }

  /** `app_private.category_attributes_for_staff(uuid, boolean, uuid)` (0088). */
  async categoryAttributesForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
  }): Promise<readonly CategoryAttributeDbRow[]> {
    const result = await sql<{
      definition_id: string;
      key: string;
      data_type: string;
      unit: string | null;
      name_en: string;
      name_ar: string;
      definition_is_active: boolean;
      is_required: boolean;
      is_filterable: boolean;
      sort_order: number;
      option_count: number;
    }>`
      select definition_id, key, data_type, unit, name_en, name_ar, definition_is_active, is_required,
             is_filterable, sort_order, option_count
        from app_private.category_attributes_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.categoryId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      definitionId: row.definition_id,
      key: row.key,
      dataType: row.data_type,
      unit: row.unit ?? null,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      definitionIsActive: row.definition_is_active,
      isRequired: row.is_required,
      isFilterable: row.is_filterable,
      sortOrder: Number(row.sort_order),
      optionCount: Number(row.option_count),
    }));
  }

  /** `app_private.category_attribute_attach_for_staff(...)` (0088). */
  async categoryAttributeAttachForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    definitionId: string;
    isRequired: boolean;
    isFilterable: boolean;
    sortOrder: number;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.category_attribute_attach_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.categoryId}::uuid,
        ${input.definitionId}::uuid,
        ${input.isRequired}::boolean,
        ${input.isFilterable}::boolean,
        ${input.sortOrder}::integer
      ) as changed
    `.execute(this.db);
    return result.rows[0]?.changed === true;
  }

  /** `app_private.category_attribute_detach_for_staff(...)` (0088). */
  async categoryAttributeDetachForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    definitionId: string;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.category_attribute_detach_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.categoryId}::uuid,
        ${input.definitionId}::uuid
      ) as changed
    `.execute(this.db);
    return result.rows[0]?.changed === true;
  }

  /** `app_private.seller_listing_vocabulary_context(uuid, text, text)` (0088). */
  async sellerListingVocabularyContext(input: {
    userId: string;
    slug: string;
    expectedType: string;
  }): Promise<SellerVocabularyContextRow> {
    const result = await sql<{ outcome: string; is_editable: boolean }>`
      select outcome, is_editable
        from app_private.seller_listing_vocabulary_context(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.expectedType}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    // No row at all is the same answer as `not_found`: there is nothing to report about a listing that is not
    // the caller's, and inventing an outcome here would be deciding something the function did not say.
    return row === undefined
      ? { outcome: 'not_found', isEditable: false }
      : { outcome: row.outcome, isEditable: row.is_editable };
  }

  /** `app_private.seller_listing_attributes(uuid, text, text, text)` (0088). */
  async sellerListingAttributes(input: {
    userId: string;
    slug: string;
    expectedType: string;
    locale: string;
  }): Promise<readonly SellerListingAttributeRow[]> {
    const result = await sql<{
      definition_id: string;
      key: string;
      data_type: string;
      unit: string | null;
      label: string;
      is_required: boolean;
      sort_order: number;
      value_text: string | null;
      value_number: string | number | null;
      value_boolean: boolean | null;
      option_ids: string[] | null;
    }>`
      select definition_id, key, data_type, unit, label, is_required, sort_order, value_text, value_number,
             value_boolean, option_ids
        from app_private.seller_listing_attributes(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.expectedType}::text,
          ${input.locale}::text
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      definitionId: row.definition_id,
      key: row.key,
      dataType: row.data_type,
      unit: row.unit ?? null,
      label: row.label,
      isRequired: row.is_required,
      sortOrder: Number(row.sort_order),
      valueText: row.value_text ?? null,
      // `numeric` arrives as a string from the driver, so the conversion is explicit rather than implied.
      valueNumber: row.value_number === null ? null : Number(row.value_number),
      valueBoolean: row.value_boolean ?? null,
      optionIds: row.option_ids ?? [],
    }));
  }

  /** `app_private.seller_listing_attribute_options(uuid, text, text, text)` (0088). */
  async sellerListingAttributeOptions(input: {
    userId: string;
    slug: string;
    expectedType: string;
    locale: string;
  }): Promise<readonly SellerListingAttributeOptionRow[]> {
    const result = await sql<{
      definition_id: string;
      option_id: string;
      value: string;
      label: string;
      sort_order: number;
    }>`
      select definition_id, option_id, value, label, sort_order
        from app_private.seller_listing_attribute_options(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.expectedType}::text,
          ${input.locale}::text
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      definitionId: row.definition_id,
      optionId: row.option_id,
      value: row.value,
      label: row.label,
      sortOrder: Number(row.sort_order),
    }));
  }

  /** `app_private.seller_listing_attributes_save(uuid, text, text, jsonb)` (0088). */
  async sellerListingAttributesSave(input: {
    userId: string;
    slug: string;
    expectedType: string;
    answers: readonly SellerAttributeAnswerPayload[];
  }): Promise<SellerVocabularyWriteResult> {
    const result = await sql<{ outcome: string }>`
      select outcome
        from app_private.seller_listing_attributes_save(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.expectedType}::text,
          ${JSON.stringify(input.answers)}::jsonb
        )
    `.execute(this.db);

    return { outcome: result.rows[0]?.outcome ?? 'not_found' };
  }

  /** `app_private.seller_listing_tag_choices(uuid, text, text, text)` (0088). */
  async sellerListingTagChoices(input: {
    userId: string;
    slug: string;
    expectedType: string;
    locale: string;
  }): Promise<readonly SellerListingTagChoiceRow[]> {
    const result = await sql<{ slug: string; label: string; is_selected: boolean }>`
      select slug, label, is_selected
        from app_private.seller_listing_tag_choices(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.expectedType}::text,
          ${input.locale}::text
        )
    `.execute(this.db);

    return result.rows.map((row) => ({ slug: row.slug, label: row.label, isSelected: row.is_selected }));
  }

  /** `app_private.seller_listing_tags_save(uuid, text, text, text[])` (0088). */
  async sellerListingTagsSave(input: {
    userId: string;
    slug: string;
    expectedType: string;
    tags: readonly string[];
  }): Promise<SellerVocabularyWriteResult> {
    const result = await sql<{ outcome: string }>`
      select outcome
        from app_private.seller_listing_tags_save(
          ${input.userId}::uuid,
          ${input.slug}::text,
          ${input.expectedType}::text,
          ${[...input.tags]}::text[]
        )
    `.execute(this.db);

    return { outcome: result.rows[0]?.outcome ?? 'not_found' };
  }

  // -------------------------------------------------------------------------------------------------
  // The blog (0092)
  // -------------------------------------------------------------------------------------------------
  /** `app_private.blog_post_for_public(text, text)` (0092): one post, one redirect, or absence. */
  async blogPostForPublic(input: { slug: string; locale: string }): Promise<PublicBlogPostDbRow | null> {
    const result = await sql<{
      kind: string;
      post_id: string | null;
      slug: string | null;
      is_indexable: boolean | null;
      is_featured: boolean | null;
      published_at: Date | null;
      updated_at: Date | null;
      category_slug: string | null;
      category_name: string | null;
      cover_object_path: string | null;
      resolved_locale: string | null;
      title: string | null;
      excerpt: string | null;
      body: string | null;
      meta_title: string | null;
      meta_description: string | null;
      tag_slugs: string[] | null;
      tag_names: string[] | null;
    }>`
      select kind, post_id, slug, is_indexable, is_featured, published_at, updated_at, category_slug,
             category_name, cover_object_path, resolved_locale, title, excerpt, body, meta_title,
             meta_description, tag_slugs, tag_names
        from app_private.blog_post_for_public(${input.slug}::text, ${input.locale}::text)
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      kind: row.kind,
      postId: row.post_id ?? null,
      slug: row.slug ?? null,
      isIndexable: row.is_indexable ?? null,
      isFeatured: row.is_featured ?? null,
      publishedAt: row.published_at ?? null,
      updatedAt: row.updated_at ?? null,
      categorySlug: row.category_slug ?? null,
      categoryName: row.category_name ?? null,
      coverObjectPath: row.cover_object_path ?? null,
      resolvedLocale: row.resolved_locale ?? null,
      title: row.title ?? null,
      excerpt: row.excerpt ?? null,
      body: row.body ?? null,
      metaTitle: row.meta_title ?? null,
      metaDescription: row.meta_description ?? null,
      tagSlugs: row.tag_slugs ?? null,
      tagNames: row.tag_names ?? null,
    };
  }

  /** `app_private.blog_posts_for_public(text, text, text, integer, timestamptz, uuid)` (0092). */
  async blogPostsForPublic(input: {
    locale: string;
    categorySlug: string | null;
    tagSlug: string | null;
    limit: number;
    cursorPublishedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly PublicBlogPostListDbRow[]> {
    const result = await sql<{
      post_id: string;
      slug: string;
      is_featured: boolean;
      published_at: Date;
      updated_at: Date;
      category_slug: string | null;
      category_name: string | null;
      cover_object_path: string | null;
      resolved_locale: string;
      title: string;
      excerpt: string | null;
    }>`
      select post_id, slug, is_featured, published_at, updated_at, category_slug, category_name,
             cover_object_path, resolved_locale, title, excerpt
        from app_private.blog_posts_for_public(
          ${input.locale}::text,
          ${input.categorySlug}::text,
          ${input.tagSlug}::text,
          ${input.limit}::integer,
          ${input.cursorPublishedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      postId: row.post_id,
      slug: row.slug,
      isFeatured: row.is_featured,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
      categorySlug: row.category_slug ?? null,
      categoryName: row.category_name ?? null,
      coverObjectPath: row.cover_object_path ?? null,
      resolvedLocale: row.resolved_locale,
      title: row.title,
      excerpt: row.excerpt ?? null,
    }));
  }

  /** `app_private.blog_taxonomy_for_public(text)` (0092). */
  async blogTaxonomyForPublic(locale: string): Promise<readonly PublicBlogTaxonomyDbRow[]> {
    const result = await sql<{
      entry_type: string;
      entry_id: string;
      slug: string;
      name: string;
      sort_order: number;
      post_count: string;
    }>`
      select entry_type, entry_id, slug, name, sort_order, post_count
        from app_private.blog_taxonomy_for_public(${locale}::text)
    `.execute(this.db);

    return result.rows.map((row) => ({
      entryType: row.entry_type,
      entryId: row.entry_id,
      slug: row.slug,
      name: row.name,
      sortOrder: Number(row.sort_order),
      postCount: Number(row.post_count),
    }));
  }

  /** `app_private.blog_posts_for_staff(uuid, boolean, integer, text, text, uuid, timestamptz, uuid)` (0092). */
  async blogPostsForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    search: string | null;
    categoryId: string | null;
    cursorUpdatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly BlogPostListDbRow[]> {
    const result = await sql<{
      post_id: string;
      slug: string;
      status: string;
      blog_category_id: string | null;
      category_slug: string | null;
      is_indexable: boolean;
      is_featured: boolean;
      scheduled_for: Date | null;
      published_at: Date | null;
      archived_at: Date | null;
      updated_at: Date;
      translated_locales: string[] | null;
      tag_count: number;
      title: string | null;
    }>`
      select post_id, slug, status, blog_category_id, category_slug, is_indexable, is_featured,
             scheduled_for, published_at, archived_at, updated_at, translated_locales, tag_count, title
        from app_private.blog_posts_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.limit}::integer,
          ${input.status}::text,
          ${input.search}::text,
          ${input.categoryId}::uuid,
          ${input.cursorUpdatedAt}::timestamptz,
          ${input.cursorId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      postId: row.post_id,
      slug: row.slug,
      status: row.status,
      blogCategoryId: row.blog_category_id ?? null,
      categorySlug: row.category_slug ?? null,
      isIndexable: row.is_indexable,
      isFeatured: row.is_featured,
      scheduledFor: row.scheduled_for ?? null,
      publishedAt: row.published_at ?? null,
      archivedAt: row.archived_at ?? null,
      updatedAt: row.updated_at,
      translatedLocales: row.translated_locales ?? null,
      tagCount: Number(row.tag_count),
      title: row.title ?? null,
    }));
  }

  /** `app_private.blog_post_for_staff(uuid, boolean, uuid)` (0092). */
  async blogPostForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
  }): Promise<BlogPostDetailDbRow | null> {
    const result = await sql<{
      post_id: string;
      slug: string;
      status: string;
      blog_category_id: string | null;
      category_slug: string | null;
      is_indexable: boolean;
      is_featured: boolean;
      cover_media_id: string | null;
      cover_object_path: string | null;
      author_user_id: string | null;
      scheduled_for: Date | null;
      published_at: Date | null;
      archived_at: Date | null;
      created_at: Date;
      updated_at: Date;
      created_by: string | null;
      updated_by: string | null;
      can_manage: boolean;
      previous_slugs: string[] | null;
      translated_locales: string[] | null;
      tag_ids: string[] | null;
    }>`
      select post_id, slug, status, blog_category_id, category_slug, is_indexable, is_featured,
             cover_media_id, cover_object_path, author_user_id, scheduled_for, published_at, archived_at,
             created_at, updated_at, created_by, updated_by, can_manage, previous_slugs,
             translated_locales, tag_ids
        from app_private.blog_post_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.postId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      postId: row.post_id,
      slug: row.slug,
      status: row.status,
      blogCategoryId: row.blog_category_id ?? null,
      categorySlug: row.category_slug ?? null,
      isIndexable: row.is_indexable,
      isFeatured: row.is_featured,
      coverMediaId: row.cover_media_id ?? null,
      coverObjectPath: row.cover_object_path ?? null,
      authorUserId: row.author_user_id ?? null,
      scheduledFor: row.scheduled_for ?? null,
      publishedAt: row.published_at ?? null,
      archivedAt: row.archived_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by ?? null,
      updatedBy: row.updated_by ?? null,
      canManage: row.can_manage,
      previousSlugs: row.previous_slugs ?? null,
      translatedLocales: row.translated_locales ?? null,
      tagIds: row.tag_ids ?? null,
    };
  }

  /** `app_private.blog_post_translations_for_staff(uuid, boolean, uuid)` (0092). */
  async blogPostTranslationsForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
  }): Promise<readonly BlogPostTranslationDbRow[]> {
    const result = await sql<{
      locale_code: string;
      title: string;
      excerpt: string | null;
      body: string;
      meta_title: string | null;
      meta_description: string | null;
      updated_at: Date;
    }>`
      select locale_code, title, excerpt, body, meta_title, meta_description, updated_at
        from app_private.blog_post_translations_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.postId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      localeCode: row.locale_code,
      title: row.title,
      excerpt: row.excerpt ?? null,
      body: row.body,
      metaTitle: row.meta_title ?? null,
      metaDescription: row.meta_description ?? null,
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.blog_categories_for_staff(uuid, boolean)` (0092). */
  async blogCategoriesForStaff(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly BlogCategoryDbRow[]> {
    const result = await sql<{
      category_id: string;
      slug: string;
      name_en: string;
      name_ar: string | null;
      description_en: string | null;
      description_ar: string | null;
      sort_order: number;
      is_active: boolean;
      post_count: string;
      updated_at: Date;
    }>`
      select category_id, slug, name_en, name_ar, description_en, description_ar, sort_order, is_active,
             post_count, updated_at
        from app_private.blog_categories_for_staff(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map((row) => ({
      categoryId: row.category_id,
      slug: row.slug,
      nameEn: row.name_en,
      nameAr: row.name_ar ?? null,
      descriptionEn: row.description_en ?? null,
      descriptionAr: row.description_ar ?? null,
      sortOrder: Number(row.sort_order),
      isActive: row.is_active,
      postCount: Number(row.post_count),
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.blog_tags_for_staff(uuid, boolean)` (0092). */
  async blogTagsForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly BlogTagDbRow[]> {
    const result = await sql<{
      tag_id: string;
      slug: string;
      name_en: string;
      name_ar: string | null;
      is_active: boolean;
      post_count: string;
      updated_at: Date;
    }>`
      select tag_id, slug, name_en, name_ar, is_active, post_count, updated_at
        from app_private.blog_tags_for_staff(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map((row) => ({
      tagId: row.tag_id,
      slug: row.slug,
      nameEn: row.name_en,
      nameAr: row.name_ar ?? null,
      isActive: row.is_active,
      postCount: Number(row.post_count),
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.blog_post_create_for_staff(uuid, boolean, text, uuid, boolean)` (0092). */
  async blogPostCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    categoryId: string | null;
    isIndexable: boolean;
  }): Promise<string> {
    const result = await sql<{ id: string }>`
      select app_private.blog_post_create_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.slug}::text,
        ${input.categoryId}::uuid,
        ${input.isIndexable}::boolean
      ) as id
    `.execute(this.db);

    const id = result.rows[0]?.id;
    if (id === undefined || id === null) throw new Error('The post was not created.');
    return id;
  }

  /** `app_private.blog_post_update_for_staff(...)` (0092). */
  async blogPostUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    slug: string | null;
    categoryId: string | null;
    clearCategory: boolean;
    coverMediaId: string | null;
    clearCover: boolean;
    isIndexable: boolean | null;
    isFeatured: boolean | null;
  }): Promise<boolean> {
    const result = await sql<{ updated: boolean }>`
      select app_private.blog_post_update_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.postId}::uuid,
        ${input.slug}::text,
        ${input.categoryId}::uuid,
        ${input.clearCategory}::boolean,
        ${input.coverMediaId}::uuid,
        ${input.clearCover}::boolean,
        ${input.isIndexable}::boolean,
        ${input.isFeatured}::boolean
      ) as updated
    `.execute(this.db);

    return result.rows[0]?.updated === true;
  }

  /** `app_private.blog_post_status_for_staff(uuid, boolean, uuid, text, timestamptz)` (0092). */
  async blogPostStatusForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    status: string;
    scheduledFor: Date | null;
  }): Promise<boolean> {
    const result = await sql<{ updated: boolean }>`
      select app_private.blog_post_status_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.postId}::uuid,
        ${input.status}::text,
        ${input.scheduledFor}::timestamptz
      ) as updated
    `.execute(this.db);

    return result.rows[0]?.updated === true;
  }

  /** `app_private.blog_post_translation_save_for_staff(...)` (0092). */
  async blogPostTranslationSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    localeCode: string;
    title: string;
    body: string;
    excerpt: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  }): Promise<boolean> {
    const result = await sql<{ saved: boolean }>`
      select app_private.blog_post_translation_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.postId}::uuid,
        ${input.localeCode}::text,
        ${input.title}::text,
        ${input.body}::text,
        ${input.excerpt}::text,
        ${input.metaTitle}::text,
        ${input.metaDescription}::text
      ) as saved
    `.execute(this.db);

    return result.rows[0]?.saved === true;
  }

  /** `app_private.blog_post_translation_delete_for_staff(uuid, boolean, uuid, text)` (0092). */
  async blogPostTranslationDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    localeCode: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.blog_post_translation_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.postId}::uuid,
        ${input.localeCode}::text
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  /** `app_private.blog_post_tags_set_for_staff(uuid, boolean, uuid, uuid[])` (0092). */
  async blogPostTagsSetForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    tagIds: readonly string[];
  }): Promise<boolean> {
    const result = await sql<{ saved: boolean }>`
      select app_private.blog_post_tags_set_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.postId}::uuid,
        ${[...input.tagIds]}::uuid[]
      ) as saved
    `.execute(this.db);

    return result.rows[0]?.saved === true;
  }

  /** `app_private.blog_category_save_for_staff(...)` (0092). Null means the named category does not exist. */
  async blogCategorySaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string | null;
    slug: string | null;
    nameEn: string | null;
    nameAr: string | null;
    descriptionEn: string | null;
    descriptionAr: string | null;
    sortOrder: number | null;
    isActive: boolean | null;
  }): Promise<string | null> {
    const result = await sql<{ id: string | null }>`
      select app_private.blog_category_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.categoryId}::uuid,
        ${input.slug}::text,
        ${input.nameEn}::text,
        ${input.nameAr}::text,
        ${input.descriptionEn}::text,
        ${input.descriptionAr}::text,
        ${input.sortOrder}::integer,
        ${input.isActive}::boolean
      ) as id
    `.execute(this.db);

    return result.rows[0]?.id ?? null;
  }

  /** `app_private.blog_tag_save_for_staff(...)` (0092). Null means the named tag does not exist. */
  async blogTagSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    tagId: string | null;
    slug: string | null;
    nameEn: string | null;
    nameAr: string | null;
    isActive: boolean | null;
  }): Promise<string | null> {
    const result = await sql<{ id: string | null }>`
      select app_private.blog_tag_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.tagId}::uuid,
        ${input.slug}::text,
        ${input.nameEn}::text,
        ${input.nameAr}::text,
        ${input.isActive}::boolean
      ) as id
    `.execute(this.db);

    return result.rows[0]?.id ?? null;
  }

  // -------------------------------------------------------------------------------------------------
  // The homepage (0093)
  // -------------------------------------------------------------------------------------------------
  /** `app_private.public_homepage_sections(text)` (0093). */
  async publicHomepageSections(locale: string): Promise<readonly PublicHomepageSectionDbRow[]> {
    const result = await sql<{
      section_id: string;
      section_key: string;
      section_type: string;
      title: string | null;
      subtitle: string | null;
      sort_order: number;
      config: unknown;
    }>`
      select section_id, section_key, section_type, title, subtitle, sort_order, config
        from app_private.public_homepage_sections(${locale}::text)
    `.execute(this.db);

    return result.rows.map((row) => ({
      sectionId: row.section_id,
      sectionKey: row.section_key,
      sectionType: row.section_type,
      title: row.title ?? null,
      subtitle: row.subtitle ?? null,
      sortOrder: Number(row.sort_order),
      config: row.config,
    }));
  }

  /** `app_private.public_homepage_listings(uuid[], integer)` (0093). Order is the administrator's. */
  async publicHomepageListings(input: {
    ids: readonly string[];
    limit: number;
  }): Promise<readonly HomepageListingDbRow[]> {
    const result = await sql<HomepageListingSqlRow>`
      select result_type, slug, title, city, price_minor, currency_code, currency_minor_unit, is_negotiable
        from app_private.public_homepage_listings(${[...input.ids]}::uuid[], ${input.limit}::integer)
       order by chosen_position
    `.execute(this.db);

    return result.rows.map(homepageListingRow);
  }

  /** `app_private.public_homepage_latest_listings(integer)` (0093). */
  async publicHomepageLatestListings(limit: number): Promise<readonly HomepageListingDbRow[]> {
    const result = await sql<HomepageListingSqlRow>`
      select result_type, slug, title, city, price_minor, currency_code, currency_minor_unit, is_negotiable
        from app_private.public_homepage_latest_listings(${limit}::integer)
    `.execute(this.db);

    return result.rows.map(homepageListingRow);
  }

  /** `app_private.public_homepage_categories(uuid[], text, integer)` (0093). */
  async publicHomepageCategories(input: {
    ids: readonly string[];
    locale: string;
    limit: number;
  }): Promise<readonly HomepageCategoryDbRow[]> {
    const result = await sql<{
      slug: string;
      name: string;
      listing_type_code: string | null;
      icon: string | null;
    }>`
      select slug, name, listing_type_code, icon
        from app_private.public_homepage_categories(
          ${[...input.ids]}::uuid[],
          ${input.locale}::text,
          ${input.limit}::integer
        )
       order by chosen_position
    `.execute(this.db);

    return result.rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      listingTypeCode: row.listing_type_code ?? null,
      icon: row.icon ?? null,
    }));
  }

  /** `app_private.public_homepage_sellers(uuid[], integer)` (0093). */
  async publicHomepageSellers(input: {
    ids: readonly string[];
    limit: number;
  }): Promise<readonly HomepageSellerDbRow[]> {
    const result = await sql<{
      slug: string;
      display_name: string;
      city: string | null;
      bio: string | null;
    }>`
      select slug, display_name, city, bio
        from app_private.public_homepage_sellers(${[...input.ids]}::uuid[], ${input.limit}::integer)
       order by chosen_position
    `.execute(this.db);

    return result.rows.map((row) => ({
      slug: row.slug,
      displayName: row.display_name,
      city: row.city ?? null,
      bio: row.bio ?? null,
    }));
  }

  /** `app_private.public_homepage_posts(text, integer)` (0093). */
  async publicHomepagePosts(input: {
    locale: string;
    limit: number;
  }): Promise<readonly HomepagePostDbRow[]> {
    const result = await sql<{
      slug: string;
      resolved_locale: string;
      title: string;
      excerpt: string | null;
      category_slug: string | null;
      category_name: string | null;
      published_at: Date;
    }>`
      select slug, resolved_locale, title, excerpt, category_slug, category_name, published_at
        from app_private.public_homepage_posts(${input.locale}::text, ${input.limit}::integer)
    `.execute(this.db);

    return result.rows.map((row) => ({
      slug: row.slug,
      resolvedLocale: row.resolved_locale,
      title: row.title,
      excerpt: row.excerpt ?? null,
      categorySlug: row.category_slug ?? null,
      categoryName: row.category_name ?? null,
      publishedAt: row.published_at,
    }));
  }

  /** `app_private.homepage_sections_for_staff(uuid, boolean)` (0093). */
  async homepageSectionsForStaff(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly HomepageSectionListDbRow[]> {
    const result = await sql<HomepageSectionSqlRow>`
      select section_id, section_key, section_type, title_en, title_ar, subtitle_en, subtitle_ar, config,
             sort_order, is_active, is_served, updated_at
        from app_private.homepage_sections_for_staff(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map(homepageSectionRow);
  }

  /** `app_private.homepage_section_for_staff(uuid, boolean, uuid)` (0093). */
  async homepageSectionForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionId: string;
  }): Promise<HomepageSectionDetailDbRow | null> {
    const result = await sql<
      HomepageSectionSqlRow & {
        created_at: Date;
        can_manage: boolean;
        chosen_count: number;
        renderable_count: number;
      }
    >`
      select section_id, section_key, section_type, title_en, title_ar, subtitle_en, subtitle_ar, config,
             sort_order, is_active, is_served, created_at, updated_at, can_manage, chosen_count,
             renderable_count
        from app_private.homepage_section_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.sectionId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ...homepageSectionRow(row),
      createdAt: row.created_at,
      canManage: row.can_manage,
      chosenCount: Number(row.chosen_count),
      renderableCount: Number(row.renderable_count),
    };
  }

  /** `app_private.homepage_section_save_for_staff(...)` (0093). Null means the named section does not exist. */
  async homepageSectionSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionId: string | null;
    sectionKey: string | null;
    sectionType: string | null;
    titleEn: string | null;
    titleAr: string | null;
    subtitleEn: string | null;
    subtitleAr: string | null;
    config: unknown;
    sortOrder: number | null;
  }): Promise<string | null> {
    // `null` for an absent document rather than `{}`: the writer reads null as "leave the stored config alone",
    // and an empty object would silently clear it on every edit that did not mean to.
    const config = input.config === null || input.config === undefined ? null : JSON.stringify(input.config);
    const result = await sql<{ id: string | null }>`
      select app_private.homepage_section_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.sectionId}::uuid,
        ${input.sectionKey}::text,
        ${input.sectionType}::text,
        ${input.titleEn}::text,
        ${input.titleAr}::text,
        ${input.subtitleEn}::text,
        ${input.subtitleAr}::text,
        ${config}::jsonb,
        ${input.sortOrder}::integer
      ) as id
    `.execute(this.db);

    return result.rows[0]?.id ?? null;
  }

  /** `app_private.homepage_section_state_for_staff(uuid, boolean, uuid, boolean)` (0093). */
  async homepageSectionStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const result = await sql<{ updated: boolean }>`
      select app_private.homepage_section_state_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.sectionId}::uuid,
        ${input.isActive}::boolean
      ) as updated
    `.execute(this.db);

    return result.rows[0]?.updated === true;
  }

  /** `app_private.homepage_sections_reorder_for_staff(uuid, boolean, uuid[])` (0093). */
  async homepageSectionsReorderForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionIds: readonly string[];
  }): Promise<number> {
    const result = await sql<{ moved: number }>`
      select app_private.homepage_sections_reorder_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${[...input.sectionIds]}::uuid[]
      ) as moved
    `.execute(this.db);

    return Number(result.rows[0]?.moved ?? 0);
  }

  /** `app_private.homepage_section_delete_for_staff(uuid, boolean, uuid)` (0093). */
  async homepageSectionDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionId: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.homepage_section_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.sectionId}::uuid
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  // -------------------------------------------------------------------------------------------------
  // Navigation (0094)
  // -------------------------------------------------------------------------------------------------
  /**
   * `app_private.public_navigation_items(text[], text)` (0094).
   *
   * One round trip for every menu a page renders. The order is the function's own — a parent before the children
   * that sit under it — so this method sends no `order by` of its own and the service relies on it.
   */
  async publicNavigationItems(input: {
    menuKeys: readonly string[];
    locale: string;
  }): Promise<readonly PublicNavigationItemDbRow[]> {
    const result = await sql<{
      menu_key: string;
      menu_label: string | null;
      item_id: string;
      parent_item_id: string | null;
      depth: number;
      label: string | null;
      target_kind: string;
      target_slug: string | null;
      target_path: string | null;
      opens_in_new_tab: boolean | null;
      sort_order: number;
    }>`
      select menu_key, menu_label, item_id, parent_item_id, depth, label, target_kind, target_slug,
             target_path, opens_in_new_tab, sort_order
        from app_private.public_navigation_items(${[...input.menuKeys]}::text[], ${input.locale}::text)
    `.execute(this.db);

    return result.rows.map((row) => ({
      menuKey: row.menu_key,
      menuLabel: row.menu_label ?? null,
      itemId: row.item_id,
      parentItemId: row.parent_item_id ?? null,
      depth: Number(row.depth),
      label: row.label ?? null,
      targetKind: row.target_kind,
      targetSlug: row.target_slug ?? null,
      targetPath: row.target_path ?? null,
      opensInNewTab: row.opens_in_new_tab ?? null,
      sortOrder: Number(row.sort_order),
    }));
  }

  /** `app_private.navigation_menus_for_staff(uuid, boolean)` (0094). */
  async navigationMenusForStaff(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly NavigationMenuListDbRow[]> {
    const result = await sql<NavigationMenuSqlRow>`
      select menu_id, menu_key, label_en, label_ar, is_active, is_served, item_count,
             renderable_item_count, created_at, updated_at, false as can_manage
        from app_private.navigation_menus_for_staff(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map(navigationMenuRow);
  }

  /** `app_private.navigation_menu_for_staff(uuid, boolean, uuid)` (0094). */
  async navigationMenuForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
  }): Promise<NavigationMenuDetailDbRow | null> {
    const result = await sql<NavigationMenuSqlRow>`
      select menu_id, menu_key, label_en, label_ar, is_active, is_served, item_count,
             renderable_item_count, created_at, updated_at, can_manage
        from app_private.navigation_menu_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.menuId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    return row === undefined ? null : navigationMenuRow(row);
  }

  /** `app_private.navigation_items_for_staff(uuid, boolean, uuid, text)` (0094). Tree order is the function's. */
  async navigationItemsForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
    locale: string;
  }): Promise<readonly NavigationItemDbRow[]> {
    const result = await sql<{
      item_id: string;
      parent_item_id: string | null;
      depth: number;
      label_en: string;
      label_ar: string | null;
      target_kind: string;
      page_id: string | null;
      blog_post_id: string | null;
      category_id: string | null;
      target_path: string | null;
      target_slug: string | null;
      target_title: string | null;
      target_state: string;
      opens_in_new_tab: boolean;
      sort_order: number;
      is_active: boolean;
      created_at: Date | string;
      updated_at: Date | string;
    }>`
      select item_id, parent_item_id, depth, label_en, label_ar, target_kind, page_id, blog_post_id,
             category_id, target_path, target_slug, target_title, target_state, opens_in_new_tab,
             sort_order, is_active, created_at, updated_at
        from app_private.navigation_items_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.menuId}::uuid,
          ${input.locale}::text
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      itemId: row.item_id,
      parentItemId: row.parent_item_id ?? null,
      depth: Number(row.depth),
      labelEn: row.label_en,
      labelAr: row.label_ar ?? null,
      targetKind: row.target_kind,
      pageId: row.page_id ?? null,
      blogPostId: row.blog_post_id ?? null,
      categoryId: row.category_id ?? null,
      targetPath: row.target_path ?? null,
      targetSlug: row.target_slug ?? null,
      targetTitle: row.target_title ?? null,
      targetState: row.target_state,
      opensInNewTab: row.opens_in_new_tab === true,
      sortOrder: Number(row.sort_order),
      isActive: row.is_active === true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.navigation_menu_save_for_staff(...)` (0094). Null means the id named nothing. */
  async navigationMenuSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string | null;
    menuKey: string | null;
    labelEn: string | null;
    labelAr: string | null;
  }): Promise<string | null> {
    const result = await sql<{ id: string | null }>`
      select app_private.navigation_menu_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.menuId}::uuid,
        ${input.menuKey}::text,
        ${input.labelEn}::text,
        ${input.labelAr}::text
      ) as id
    `.execute(this.db);

    return result.rows[0]?.id ?? null;
  }

  /** `app_private.navigation_menu_state_for_staff(uuid, boolean, uuid, boolean)` (0094). */
  async navigationMenuStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.navigation_menu_state_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.menuId}::uuid,
        ${input.isActive}::boolean
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.navigation_menu_delete_for_staff(uuid, boolean, uuid)` (0094). */
  async navigationMenuDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.navigation_menu_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.menuId}::uuid
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  /**
   * `app_private.navigation_item_save_for_staff(...)` (0094). Null means the id named nothing.
   *
   * The four target columns are passed together: naming a kind replaces all four in one statement, and sending
   * none leaves the target alone. That is the writer's contract, not this method's opinion.
   */
  async navigationItemSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    itemId: string | null;
    menuId: string | null;
    labelEn: string | null;
    labelAr: string | null;
    targetKind: string | null;
    pageId: string | null;
    blogPostId: string | null;
    categoryId: string | null;
    path: string | null;
    parentId: string | null;
    opensInNewTab: boolean | null;
    sortOrder: number | null;
  }): Promise<string | null> {
    const result = await sql<{ id: string | null }>`
      select app_private.navigation_item_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.itemId}::uuid,
        ${input.menuId}::uuid,
        ${input.labelEn}::text,
        ${input.labelAr}::text,
        ${input.targetKind}::text,
        ${input.pageId}::uuid,
        ${input.blogPostId}::uuid,
        ${input.categoryId}::uuid,
        ${input.path}::text,
        ${input.parentId}::uuid,
        ${input.opensInNewTab}::boolean,
        ${input.sortOrder}::integer
      ) as id
    `.execute(this.db);

    return result.rows[0]?.id ?? null;
  }

  /** `app_private.navigation_item_promote_for_staff(uuid, boolean, uuid)` (0094). */
  async navigationItemPromoteForStaff(input: {
    userId: string;
    isAal2: boolean;
    itemId: string;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.navigation_item_promote_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.itemId}::uuid
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.navigation_item_state_for_staff(uuid, boolean, uuid, boolean)` (0094). */
  async navigationItemStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    itemId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.navigation_item_state_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.itemId}::uuid,
        ${input.isActive}::boolean
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.navigation_items_reorder_for_staff(uuid, boolean, uuid, uuid[])` (0094). */
  async navigationItemsReorderForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
    itemIds: readonly string[];
  }): Promise<number> {
    const result = await sql<{ moved: number }>`
      select app_private.navigation_items_reorder_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.menuId}::uuid,
        ${[...input.itemIds]}::uuid[]
      ) as moved
    `.execute(this.db);

    return Number(result.rows[0]?.moved ?? 0);
  }

  /** `app_private.navigation_item_delete_for_staff(uuid, boolean, uuid)` (0094). */
  async navigationItemDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    itemId: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.navigation_item_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.itemId}::uuid
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  // -------------------------------------------------------------------------------------------------
  // The help centre (0095)
  // -------------------------------------------------------------------------------------------------
  /** `app_private.public_faqs(text, text)` (0095). The order is the operator's own. */
  async publicFaqs(input: { topic: string; locale: string }): Promise<readonly PublicFaqDbRow[]> {
    const result = await sql<{
      faq_id: string;
      question: string;
      answer: string;
      sort_order: number;
    }>`
      select faq_id, question, answer, sort_order
        from app_private.public_faqs(${input.topic}::text, ${input.locale}::text)
    `.execute(this.db);

    return result.rows.map((row) => ({
      faqId: row.faq_id,
      question: row.question,
      answer: row.answer,
      sortOrder: Number(row.sort_order),
    }));
  }

  /** `app_private.faq_topics_for_staff(uuid, boolean)` (0095). */
  async faqTopicsForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly FaqTopicDbRow[]> {
    const result = await sql<{
      topic: string;
      entry_count: number;
      published_count: number;
      is_mapped: boolean;
      page_slug: string | null;
    }>`
      select topic, entry_count, published_count, is_mapped, page_slug
        from app_private.faq_topics_for_staff(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map((row) => ({
      topic: row.topic,
      entryCount: Number(row.entry_count),
      publishedCount: Number(row.published_count),
      isMapped: row.is_mapped === true,
      pageSlug: row.page_slug ?? null,
    }));
  }

  /**
   * `app_private.faqs_for_staff(uuid, boolean, text, text, integer, uuid, integer)` (0095).
   *
   * The cursor arrives as three typed parameters rather than as text: a position is bound, never interpolated.
   */
  async faqsForStaff(input: {
    userId: string;
    isAal2: boolean;
    topic: string | null;
    afterTopic: string | null;
    afterSortOrder: number | null;
    afterId: string | null;
    limit: number;
  }): Promise<readonly FaqListDbRow[]> {
    const result = await sql<FaqSqlRow>`
      select faq_id, topic, question_en, question_ar, answer_en, answer_ar, sort_order, is_published,
             is_mapped, page_slug, created_at, updated_at, false as can_manage
        from app_private.faqs_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.topic}::text,
          ${input.afterTopic}::text,
          ${input.afterSortOrder}::integer,
          ${input.afterId}::uuid,
          ${input.limit}::integer
        )
    `.execute(this.db);

    return result.rows.map(faqRow);
  }

  /** `app_private.faq_for_staff(uuid, boolean, uuid)` (0095). */
  async faqForStaff(input: {
    userId: string;
    isAal2: boolean;
    faqId: string;
  }): Promise<FaqDetailDbRow | null> {
    const result = await sql<FaqSqlRow>`
      select faq_id, topic, question_en, question_ar, answer_en, answer_ar, sort_order, is_published,
             is_mapped, page_slug, created_at, updated_at, can_manage
        from app_private.faq_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.faqId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    return row === undefined ? null : faqRow(row);
  }

  /** `app_private.faq_save_for_staff(...)` (0095). Null means the id named nothing. */
  async faqSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    faqId: string | null;
    topic: string | null;
    questionEn: string | null;
    questionAr: string | null;
    answerEn: string | null;
    answerAr: string | null;
    sortOrder: number | null;
  }): Promise<string | null> {
    const result = await sql<{ id: string | null }>`
      select app_private.faq_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.faqId}::uuid,
        ${input.topic}::text,
        ${input.questionEn}::text,
        ${input.questionAr}::text,
        ${input.answerEn}::text,
        ${input.answerAr}::text,
        ${input.sortOrder}::integer
      ) as id
    `.execute(this.db);

    return result.rows[0]?.id ?? null;
  }

  /** `app_private.faq_state_for_staff(uuid, boolean, uuid, boolean)` (0095). */
  async faqStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    faqId: string;
    isPublished: boolean;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.faq_state_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.faqId}::uuid,
        ${input.isPublished}::boolean
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.faqs_reorder_for_staff(uuid, boolean, text, uuid[])` (0095). */
  async faqsReorderForStaff(input: {
    userId: string;
    isAal2: boolean;
    topic: string;
    faqIds: readonly string[];
  }): Promise<number> {
    const result = await sql<{ moved: number }>`
      select app_private.faqs_reorder_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.topic}::text,
        ${[...input.faqIds]}::uuid[]
      ) as moved
    `.execute(this.db);

    return Number(result.rows[0]?.moved ?? 0);
  }

  /** `app_private.faq_delete_for_staff(uuid, boolean, uuid)` (0095). */
  async faqDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    faqId: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.faq_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.faqId}::uuid
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  // -------------------------------------------------------------------------------------------------
  // The CMS media library (0098)
  // -------------------------------------------------------------------------------------------------
  /** `app_private.cms_media_upload_target(uuid, boolean, text, bigint)` (0098). */
  async cmsMediaUploadTarget(input: {
    userId: string;
    isAal2: boolean;
    contentType: string;
    byteSize: number;
  }): Promise<CmsMediaTargetRow> {
    const result = await sql<{
      outcome: string;
      bucket_id: string | null;
      object_path: string | null;
      max_byte_size: string | null;
    }>`
      select outcome, bucket_id, object_path, max_byte_size
        from app_private.cms_media_upload_target(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.contentType}::text,
          ${input.byteSize}::bigint
        )
    `.execute(this.db);

    const row = result.rows[0];
    return {
      outcome: row?.outcome ?? 'invalid',
      bucketId: row?.bucket_id ?? null,
      objectPath: row?.object_path ?? null,
      maxByteSize: row?.max_byte_size ?? null,
    };
  }

  /** `app_private.cms_media_attach(...)` (0098). */
  async cmsMediaAttach(input: {
    userId: string;
    isAal2: boolean;
    objectPath: string;
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    altTextEn: string | null;
    altTextAr: string | null;
  }): Promise<{ outcome: string; mediaId: string | null }> {
    const result = await sql<{ outcome: string; media_id: string | null }>`
      select outcome, media_id
        from app_private.cms_media_attach(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.objectPath}::text,
          ${input.mimeType}::text,
          ${input.byteSize}::bigint,
          ${input.width}::integer,
          ${input.height}::integer,
          ${input.altTextEn}::text,
          ${input.altTextAr}::text
        )
    `.execute(this.db);

    const row = result.rows[0];
    return { outcome: row?.outcome ?? 'invalid', mediaId: row?.media_id ?? null };
  }

  /**
   * `app_private.cms_media_for_staff(uuid, boolean, timestamptz, uuid, integer)` (0098).
   *
   * The cursor arrives as two typed parameters rather than as text: a position is bound, never interpolated.
   */
  async cmsMediaForStaff(input: {
    userId: string;
    isAal2: boolean;
    afterCreatedAt: string | null;
    afterId: string | null;
    limit: number;
  }): Promise<readonly CmsMediaRow[]> {
    const result = await sql<{
      media_id: string;
      object_path: string;
      mime_type: string;
      width: number | null;
      height: number | null;
      byte_size: string;
      alt_text_en: string | null;
      alt_text_ar: string | null;
      usage_count: number;
      created_at: Date;
      updated_at: Date;
    }>`
      select media_id, object_path, mime_type, width, height, byte_size, alt_text_en, alt_text_ar,
             usage_count, created_at, updated_at
        from app_private.cms_media_for_staff(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.afterCreatedAt}::timestamptz,
          ${input.afterId}::uuid,
          ${input.limit}::integer
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      mediaId: row.media_id,
      objectPath: row.object_path,
      mimeType: row.mime_type,
      width: row.width ?? null,
      height: row.height ?? null,
      byteSize: row.byte_size,
      altTextEn: row.alt_text_en ?? null,
      altTextAr: row.alt_text_ar ?? null,
      usageCount: row.usage_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** `app_private.cms_media_usage(uuid, boolean, uuid)` (0098). */
  async cmsMediaUsage(input: {
    userId: string;
    isAal2: boolean;
    mediaId: string;
  }): Promise<readonly CmsMediaUsageRow[]> {
    const result = await sql<{
      entity_type: string;
      entity_id: string | null;
      entity_label: string;
      entity_column: string;
    }>`
      select entity_type, entity_id, entity_label, entity_column
        from app_private.cms_media_usage(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.mediaId}::uuid
        )
    `.execute(this.db);

    return result.rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id ?? null,
      entityLabel: row.entity_label,
      entityColumn: row.entity_column,
    }));
  }

  /** `app_private.cms_media_read_target(uuid, boolean, uuid)` (0098). */
  async cmsMediaReadTarget(input: {
    userId: string;
    isAal2: boolean;
    mediaId: string;
  }): Promise<{ outcome: string; bucketId: string | null; objectPath: string | null }> {
    const result = await sql<{ outcome: string; bucket_id: string | null; object_path: string | null }>`
      select outcome, bucket_id, object_path
        from app_private.cms_media_read_target(
          ${input.userId}::uuid,
          ${input.isAal2}::boolean,
          ${input.mediaId}::uuid
        )
    `.execute(this.db);

    const row = result.rows[0];
    return {
      outcome: row?.outcome ?? 'not_found',
      bucketId: row?.bucket_id ?? null,
      objectPath: row?.object_path ?? null,
    };
  }

  /** `app_private.cms_media_alt_text_for_staff(uuid, boolean, uuid, text, text)` (0098). */
  async cmsMediaAltTextForStaff(input: {
    userId: string;
    isAal2: boolean;
    mediaId: string;
    altTextEn: string | null;
    altTextAr: string | null;
  }): Promise<boolean> {
    const result = await sql<{ changed: boolean }>`
      select app_private.cms_media_alt_text_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.mediaId}::uuid,
        ${input.altTextEn}::text,
        ${input.altTextAr}::text
      ) as changed
    `.execute(this.db);

    return result.rows[0]?.changed === true;
  }

  /** `app_private.cms_media_delete_for_staff(uuid, boolean, uuid)` (0098). */
  async cmsMediaDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    mediaId: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.cms_media_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.mediaId}::uuid
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }

  // -------------------------------------------------------------------------------------------------
  // Site-wide SEO settings (0096)
  // -------------------------------------------------------------------------------------------------
  /**
   * `app_private.seo_settings_for_staff(uuid, boolean)` (0096).
   *
   * One row per active locale, authored or not. `robots_is_served` is the database's own answer about which
   * locale's body `/robots.txt` serves, and is read rather than recomputed anywhere above this line.
   */
  async seoSettingsForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly SeoSettingsDbRow[]> {
    const result = await sql<{
      locale_code: string;
      locale_name_en: string;
      locale_name_native: string;
      is_default_locale: boolean;
      is_authored: boolean;
      robots_is_served: boolean;
      site_name: string | null;
      default_meta_title: string | null;
      default_meta_description: string | null;
      default_share_media_id: string | null;
      share_media_object_path: string | null;
      twitter_site: string | null;
      robots_txt_body: string | null;
      organization_structured_data: unknown;
      updated_at: Date | string | null;
    }>`
      select locale_code, locale_name_en, locale_name_native, is_default_locale, is_authored, robots_is_served,
             site_name, default_meta_title, default_meta_description, default_share_media_id,
             share_media_object_path, twitter_site, robots_txt_body, organization_structured_data, updated_at
        from app_private.seo_settings_for_staff(${input.userId}::uuid, ${input.isAal2}::boolean)
    `.execute(this.db);

    return result.rows.map((row) => ({
      localeCode: row.locale_code,
      localeNameEn: row.locale_name_en,
      localeNameNative: row.locale_name_native,
      isDefaultLocale: row.is_default_locale === true,
      isAuthored: row.is_authored === true,
      robotsIsServed: row.robots_is_served === true,
      siteName: row.site_name ?? null,
      defaultMetaTitle: row.default_meta_title ?? null,
      defaultMetaDescription: row.default_meta_description ?? null,
      defaultShareMediaId: row.default_share_media_id ?? null,
      shareMediaObjectPath: row.share_media_object_path ?? null,
      twitterSite: row.twitter_site ?? null,
      robotsTxtBody: row.robots_txt_body ?? null,
      organizationStructuredData: row.organization_structured_data ?? null,
      updatedAt: row.updated_at ?? null,
    }));
  }

  /**
   * `app_private.seo_settings_save_for_staff(...)` (0096). False means the locale is not an active locale.
   *
   * The organization document travels as `jsonb`, serialised once here and never interpolated.
   */
  async seoSettingsSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    localeCode: string;
    siteName: string;
    defaultMetaTitle: string | null;
    defaultMetaDescription: string | null;
    defaultShareMediaId: string | null;
    twitterSite: string | null;
    robotsTxtBody: string | null;
    organizationStructuredData: unknown;
  }): Promise<boolean> {
    const structuredData =
      input.organizationStructuredData === null || input.organizationStructuredData === undefined
        ? null
        : JSON.stringify(input.organizationStructuredData);

    const result = await sql<{ written: boolean }>`
      select app_private.seo_settings_save_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.localeCode}::text,
        ${input.siteName}::text,
        ${input.defaultMetaTitle}::text,
        ${input.defaultMetaDescription}::text,
        ${input.defaultShareMediaId}::uuid,
        ${input.twitterSite}::text,
        ${input.robotsTxtBody}::text,
        ${structuredData}::jsonb
      ) as written
    `.execute(this.db);

    return result.rows[0]?.written === true;
  }

  /** `app_private.seo_settings_delete_for_staff(uuid, boolean, text)` (0096). */
  async seoSettingsDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    localeCode: string;
  }): Promise<boolean> {
    const result = await sql<{ removed: boolean }>`
      select app_private.seo_settings_delete_for_staff(
        ${input.userId}::uuid,
        ${input.isAal2}::boolean,
        ${input.localeCode}::text
      ) as removed
    `.execute(this.db);

    return result.rows[0]?.removed === true;
  }
}

/**
 * The columns both FAQ readers return.
 *
 * One shape, so one mapper. The list reader has no `can_manage` of its own — the capability is a property of the
 * caller rather than of an entry, and the list reports it once at the top level — so it selects a literal `false`
 * and the service never reads the field.
 */
interface FaqSqlRow {
  readonly faq_id: string;
  readonly topic: string;
  readonly question_en: string;
  readonly question_ar: string | null;
  readonly answer_en: string;
  readonly answer_ar: string | null;
  readonly sort_order: number;
  readonly is_published: boolean;
  readonly is_mapped: boolean;
  readonly page_slug: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly can_manage: boolean;
}

function faqRow(row: FaqSqlRow): FaqDetailDbRow {
  return {
    faqId: row.faq_id,
    topic: row.topic,
    questionEn: row.question_en,
    questionAr: row.question_ar ?? null,
    answerEn: row.answer_en,
    answerAr: row.answer_ar ?? null,
    sortOrder: Number(row.sort_order),
    isPublished: row.is_published === true,
    isMapped: row.is_mapped === true,
    pageSlug: row.page_slug ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canManage: row.can_manage === true,
  };
}

/** The card columns both homepage listing readers return; one shape, so one mapper. */
interface HomepageListingSqlRow {
  readonly result_type: string;
  readonly slug: string;
  readonly title: string;
  readonly city: string | null;
  readonly price_minor: string | null;
  readonly currency_code: string;
  readonly currency_minor_unit: number;
  readonly is_negotiable: boolean | null;
}

function homepageListingRow(row: HomepageListingSqlRow): HomepageListingDbRow {
  return {
    resultType: row.result_type,
    slug: row.slug,
    title: row.title,
    city: row.city ?? null,
    priceMinor: row.price_minor ?? null,
    currencyCode: row.currency_code,
    currencyMinorUnit: Number(row.currency_minor_unit),
    isNegotiable: row.is_negotiable ?? null,
  };
}

/**
 * The columns both navigation menu readers return.
 *
 * One shape, so one mapper. The list reader has no `can_manage` of its own — the capability is a property of the
 * caller rather than of a menu, and the list reports it once at the top level — so it selects a literal `false`
 * and the service never reads the field.
 */
interface NavigationMenuSqlRow {
  readonly menu_id: string;
  readonly menu_key: string;
  readonly label_en: string;
  readonly label_ar: string | null;
  readonly is_active: boolean;
  readonly is_served: boolean;
  readonly item_count: number;
  readonly renderable_item_count: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly can_manage: boolean;
}

function navigationMenuRow(row: NavigationMenuSqlRow): NavigationMenuDetailDbRow {
  return {
    menuId: row.menu_id,
    menuKey: row.menu_key,
    labelEn: row.label_en,
    labelAr: row.label_ar ?? null,
    isActive: row.is_active === true,
    isServed: row.is_served === true,
    itemCount: Number(row.item_count),
    renderableItemCount: Number(row.renderable_item_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canManage: row.can_manage === true,
  };
}

/** The columns both homepage section readers return. */
interface HomepageSectionSqlRow {
  readonly section_id: string;
  readonly section_key: string;
  readonly section_type: string;
  readonly title_en: string | null;
  readonly title_ar: string | null;
  readonly subtitle_en: string | null;
  readonly subtitle_ar: string | null;
  readonly config: unknown;
  readonly sort_order: number;
  readonly is_active: boolean;
  readonly is_served: boolean;
  readonly updated_at: Date;
}

function homepageSectionRow(row: HomepageSectionSqlRow): HomepageSectionListDbRow {
  return {
    sectionId: row.section_id,
    sectionKey: row.section_key,
    sectionType: row.section_type,
    titleEn: row.title_en ?? null,
    titleAr: row.title_ar ?? null,
    subtitleEn: row.subtitle_en ?? null,
    subtitleAr: row.subtitle_ar ?? null,
    config: row.config,
    sortOrder: Number(row.sort_order),
    isActive: row.is_active,
    isServed: row.is_served,
    updatedAt: row.updated_at,
  };
}

/** The columns both attribute-definition readers return; one shape, so one mapper. */
interface AttributeDefinitionSqlRow {
  readonly definition_id: string;
  readonly key: string;
  readonly data_type: string;
  readonly unit: string | null;
  readonly name_en: string;
  readonly name_ar: string;
  readonly is_filterable: boolean;
  readonly is_active: boolean;
  readonly sort_order: number;
  readonly option_count: number;
  readonly category_count: number;
  readonly answer_count: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function attributeDefinitionRow(row: AttributeDefinitionSqlRow): AttributeDefinitionDbRow {
  return {
    definitionId: row.definition_id,
    key: row.key,
    dataType: row.data_type,
    unit: row.unit ?? null,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    isFilterable: row.is_filterable,
    isActive: row.is_active,
    sortOrder: Number(row.sort_order),
    optionCount: Number(row.option_count),
    categoryCount: Number(row.category_count),
    answerCount: Number(row.answer_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The fourteen-column card projection both the search reader and the category feed return. */
/**
 * The columns both metadata staff readers share (0091).
 *
 * One shape rather than two, because the detail is the list row plus three fields and keeping them apart would mean
 * two lists of column names to keep in step.
 */
interface MetadataListSqlRow {
  entry_id: string;
  entity_type: string;
  entity_id: string | null;
  route_path: string | null;
  target_slug: string | null;
  locale_code: string;
  meta_title: string | null;
  meta_description: string | null;
  canonical_path: string | null;
  robots_directives: string[] | null;
  og_title: string | null;
  og_description: string | null;
  share_media_id: string | null;
  canonical_is_honoured: boolean;
  updated_at: Date;
}

function metadataListRow(row: MetadataListSqlRow): SeoMetadataListDbRow {
  return {
    entryId: row.entry_id,
    entityType: row.entity_type,
    entityId: row.entity_id ?? null,
    routePath: row.route_path ?? null,
    targetSlug: row.target_slug ?? null,
    localeCode: row.locale_code,
    metaTitle: row.meta_title ?? null,
    metaDescription: row.meta_description ?? null,
    canonicalPath: row.canonical_path ?? null,
    robotsDirectives: row.robots_directives ?? null,
    ogTitle: row.og_title ?? null,
    ogDescription: row.og_description ?? null,
    shareMediaId: row.share_media_id ?? null,
    canonicalIsHonoured: row.canonical_is_honoured,
    updatedAt: row.updated_at,
  };
}

/** One row of either public metadata reader, or null when the reader returned none. */
function metadataRow(
  row:
    | {
        meta_title: string | null;
        meta_description: string | null;
        canonical_path: string | null;
        robots_directives: string[] | null;
        og_title: string | null;
        og_description: string | null;
        share_object_path: string | null;
      }
    | undefined,
): PublicSeoMetadataDbRow | null {
  if (row === undefined) return null;
  return {
    metaTitle: row.meta_title ?? null,
    metaDescription: row.meta_description ?? null,
    canonicalPath: row.canonical_path ?? null,
    robotsDirectives: row.robots_directives ?? null,
    ogTitle: row.og_title ?? null,
    ogDescription: row.og_description ?? null,
    shareObjectPath: row.share_object_path ?? null,
  };
}

interface SearchSqlRow {
  readonly result_type: string;
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly city: string | null;
  readonly price_minor: string | null;
  readonly currency_code: string;
  readonly currency_minor_unit: number;
  readonly is_negotiable: boolean | null;
  readonly listing_type_code: string | null;
  readonly pricing_model: string | null;
  readonly delivery_days: number | null;
  readonly revisions_included: number | null;
  readonly created_at: Date;
}

function searchRow(row: SearchSqlRow): SearchRow {
  return {
    resultType: row.result_type === 'service' ? 'service' : 'listing',
    id: row.id,
    slug: row.slug,
    title: row.title,
    city: row.city,
    priceMinor: row.price_minor,
    currencyCode: row.currency_code,
    currencyMinorUnit: Number(row.currency_minor_unit),
    isNegotiable: row.is_negotiable,
    listingTypeCode: row.listing_type_code,
    pricingModel: (row.pricing_model as SearchRow['pricingModel']) ?? null,
    deliveryDays: row.delivery_days === null ? null : Number(row.delivery_days),
    revisionsIncluded: row.revisions_included === null ? null : Number(row.revisions_included),
    createdAt: row.created_at,
  };
}

/** The columns both generic-trail readers return; one shape, so one mapper. */
interface ActionTrailColumns {
  id: string;
  action: string;
  reason: string;
  notes: string | null;
  report_id: string | null;
  expires_at: Date | null;
  reverses_action_id: string | null;
  is_own_action: boolean;
  created_at: Date;
}

function actionTrailRow(row: ActionTrailColumns): ModerationActionTrailRow {
  return {
    id: row.id,
    action: row.action,
    reason: row.reason,
    notes: row.notes ?? null,
    reportId: row.report_id ?? null,
    expiresAt: row.expires_at ?? null,
    reversesActionId: row.reverses_action_id ?? null,
    isOwnAction: row.is_own_action,
    createdAt: row.created_at,
  };
}
