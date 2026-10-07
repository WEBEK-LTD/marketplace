import { Module, type DynamicModule } from '@nestjs/common';
import { DeviceIdentity, PseudonymousUserId } from '@repo/server-config';
import type { ApiEnv } from '../config/env.js';
import { CATEGORY_STORE } from '../catalog/categories.service.js';
import { CMS_PAGES_STORE, CmsPagesAdminService } from '../admin/cms-pages.service.js';
import { CMS_PUBLIC_STORE, CmsPagesService } from '../cms/cms-pages.service.js';
import { BLOG_PUBLIC_STORE, BlogPublicService } from '../cms/blog-public.service.js';
import { BLOG_STORE, BlogAdminService } from '../admin/blog.service.js';
import { HOMEPAGE_PUBLIC_STORE, HomepagePublicService } from '../cms/homepage-public.service.js';
import { HOMEPAGE_STORE, HomepageAdminService } from '../admin/homepage.service.js';
import { NAVIGATION_PUBLIC_STORE, NavigationPublicService } from '../cms/navigation-public.service.js';
import { NAVIGATION_STORE, NavigationAdminService } from '../admin/navigation.service.js';
import { FAQS_PUBLIC_STORE, FaqsPublicService } from '../cms/faqs-public.service.js';
import { FAQS_STORE, FaqsAdminService } from '../admin/faqs.service.js';
import { SEO_STORE, SeoService } from '../seo/seo.service.js';
import { SEO_REDIRECTS_STORE, SeoRedirectsAdminService } from '../admin/seo-redirects.service.js';
import { SEO_METADATA_STORE, SeoMetadataAdminService } from '../admin/seo-metadata.service.js';
import { SEO_SETTINGS_STORE, SeoSettingsAdminService } from '../admin/seo-settings.service.js';
import { CMS_MEDIA_STORE, CmsMediaAdminService } from '../admin/cms-media.service.js';
import { CATEGORIES_STORE, CategoriesAdminService } from '../admin/categories.service.js';
import { ATTRIBUTES_STORE, AttributesAdminService } from '../admin/attributes.service.js';
import { CATEGORY_FEED_PORT, CategoryFeedService } from '../catalog/category-feed.service.js';
import {
  SELLER_VOCABULARY_STORE,
  SellerVocabularyService,
} from '../sellers/seller-vocabulary.service.js';
import { LISTING_STORE } from '../catalog/listings.service.js';
import { SEARCH_PORT } from '../catalog/search.service.js';
import { SELLER_STORE } from '../catalog/sellers.service.js';
import { SELLER_IDENTITY_STORE } from '../sellers/seller-identity.service.js';
import {
  SELLER_ONBOARDING_STORE,
  SellerOnboardingService,
} from '../sellers/seller-onboarding.service.js';
import {
  SELLER_MEDIA_STORE,
  SellerMediaService,
} from '../sellers/seller-media.service.js';
import {
  SELLER_MEDIA_STORAGE,
  SupabaseStorageClient,
} from '../sellers/seller-media.storage.js';
import {
  SELLER_LISTING_STORE,
  SellerListingService,
} from '../sellers/seller-listing.service.js';
import {
  SELLER_PROFILE_UPDATE_STORE,
  SellerProfileUpdateService,
} from '../sellers/seller-profile-update.service.js';
import {
  SELLER_SERVICE_STORE,
  SellerServiceService,
} from '../sellers/seller-service.service.js';
import {
  SELLER_VERIFICATION_STORE,
  SellerVerificationService,
} from '../sellers/seller-verification.service.js';
import { SELLER_READ_STORE, SellerReadService } from '../sellers/seller-read.service.js';
import { SellerThrottleService } from '../sellers/seller-throttle.service.js';
import { SERVICE_STORE } from '../catalog/services.service.js';
import { PSEUDONYMOUS_USER_ID } from '../logging/log-identity.js';
import { AppSystemStore } from './app-system.store.js';
import { AUTH_SECURITY_EVENT_STORE, AuthSecurityEventsService } from './auth-security-events.service.js';
import { LOGIN_ENFORCEMENT_STORE, LoginEnforcementService } from './login-enforcement.service.js';
import {
  DURABLE_THROTTLE_COUNTER,
  LoginThrottleService,
  REDIS_THROTTLE_COUNTER,
} from './login-throttle.service.js';
import {
  DEVICE_IDENTITY,
  KNOWN_DEVICE_STORE,
  LOGIN_IDENTITY_STORE,
  LoginService,
  SUPABASE_AUTH_CLIENT,
} from './login.service.js';
import { RedisThrottleCounter } from './redis-throttle.counter.js';
import {
  ListingEventIngestionService,
  LISTING_EVENT_STORE,
} from '../analytics/listing-events.service.js';
import {
  ListingAnalyticsService,
  LISTING_ANALYTICS_STORE,
} from '../analytics/listing-analytics.service.js';
import {
  LISTING_EVENT_STREAM_PORT,
  RedisListingEventStream,
} from '../analytics/listing-events.stream.js';
import { SupabaseAuthClient } from './supabase-auth.client.js';
import { OtpPepper } from './otp/otp-digest.js';
import { OTP_CHALLENGE_STORE, OTP_PEPPER, OtpService } from './otp/otp.service.js';
import { PASSWORD_RESET_TOKEN_STORE, PasswordResetService } from './password-reset/password-reset.service.js';
import { RECOVERY_STORE, RecoveryService, WEB_PUBLIC_ORIGIN } from './password-reset/recovery.service.js';
import { REGISTRATION_STORE, RegistrationService } from './registration.service.js';
import { CONTACT_CHANGE_STORE, ContactChangeService } from '../users/contact-change.service.js';
import { CURRENT_USER_STORE, CurrentUserService } from '../users/current-user.service.js';
import { MESSAGING_STORE, MessagingService } from '../messaging/messaging.service.js';
import { MESSAGING_WRITE_STORE, MessagingWriteService } from '../messaging/messaging-write.service.js';
import {
  MESSAGE_ATTACHMENT_STORE,
  MessageAttachmentsService,
} from '../messaging/message-attachments.service.js';
import { NOTIFICATIONS_STORE, NotificationsService } from '../notifications/notifications.service.js';
import { BUYER_ACCOUNT_STORE, BuyerAccountService } from '../account/buyer-account.service.js';
import { STAFF_CONSOLE_STORE, StaffConsoleService } from '../admin/staff-console.service.js';
import {
  VERIFICATION_REVIEW_STORE,
  VerificationReviewService,
} from '../admin/verification-review.service.js';
import { OFFERS_STORE, OffersService } from '../offers/offers.service.js';
import {
  SERVICE_REQUESTS_STORE,
  ServiceRequestsService,
} from '../services/service-requests.service.js';
import {
  ADMIN_SERVICE_REQUESTS_STORE,
  AdminServiceRequestsService,
} from '../admin/service-requests-admin.service.js';
import { SUPPORT_STORE, SupportService } from '../support/support.service.js';
import {
  SUPPORT_CONSOLE_STORE,
  SupportConsoleService,
} from '../admin/support-console.service.js';
import { SupportThrottleService } from '../support/support-throttle.service.js';
import { REPORTS_STORE, ReportsService } from '../reports/reports.service.js';
import { MODERATION_STORE, ModerationService } from '../admin/moderation.service.js';
import {
  ADMIN_OPERATIONS_STORE,
  AdminOperationsService,
} from '../admin/admin-operations.service.js';
import {
  REVIEW_MODERATION_STORE,
  ReviewModerationService,
} from '../admin/review-moderation.service.js';
import {
  PLATFORM_OPERATIONS_STORE,
  PlatformOperationsService,
} from '../admin/platform-operations.service.js';
import {
  DISPUTE_MANAGEMENT_STORE,
  DisputeManagementService,
} from '../admin/dispute-management.service.js';
import { ReportsThrottleService } from '../reports/reports-throttle.service.js';
import { MessagingThrottleService } from '../messaging/messaging-throttle.service.js';
import { SessionService } from './session.service.js';
import { WaabekClient } from './otp/waabek.client.js';
import { STEP_UP_STORE, StepUpService } from './step-up/step-up.service.js';
import { TOTP_STEP_UP_STORE, TotpService } from './totp/totp.service.js';

/**
 * Authentication (Phase 3, F2).
 *
 * Everything an authenticated login needs lives here and only here: the C-1 throttle with its Redis and
 * durable counters, the durable 0034 lockout gate, the server-side Supabase Auth client and the C-20
 * event writer. Under owner Decision 1 (Option B) every authentication operation stays behind NestJS,
 * so there is no Supabase client anywhere else in the monorepo — not in the browser, not in the BFF,
 * not in a shared package.
 *
 * The single `AppSystemStore` satisfies four narrow interfaces at once. That is deliberate: one
 * connection pool, and each consumer sees only the handful of functions it is allowed to call.
 */
@Module({})
export class AuthModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        {
          // One pool, shared by both consumers: the store implements both narrow interfaces.
          provide: AppSystemStore,
          useFactory: () =>
            AppSystemStore.fromConnectionString(
              env.appSystemDatabaseUrl,
              env.appSystemDatabaseMaxConnections,
            ),
        },
        { provide: LOGIN_ENFORCEMENT_STORE, useExisting: AppSystemStore },
        { provide: DURABLE_THROTTLE_COUNTER, useExisting: AppSystemStore },
        { provide: AUTH_SECURITY_EVENT_STORE, useExisting: AppSystemStore },
        { provide: LOGIN_IDENTITY_STORE, useExisting: AppSystemStore },
        {
          // The first C-1 tier. If it cannot be constructed the durable counter still answers, so the
          // throttle degrades rather than disappearing.
          provide: REDIS_THROTTLE_COUNTER,
          useFactory: () => RedisThrottleCounter.fromUrl(env.redisUrl),
        },
        {
          provide: SUPABASE_AUTH_CLIENT,
          useFactory: () =>
            new SupabaseAuthClient({ url: env.supabaseUrl, secretKey: env.supabaseSecretKey }),
        },
        { provide: OTP_CHALLENGE_STORE, useExisting: AppSystemStore },
        { provide: STEP_UP_STORE, useExisting: AppSystemStore },
        // Phase 7-B: 0042's TOTP grant writer, through the same one gateway as every other.
        { provide: TOTP_STEP_UP_STORE, useExisting: AppSystemStore },
        { provide: PASSWORD_RESET_TOKEN_STORE, useExisting: AppSystemStore },
        { provide: RECOVERY_STORE, useExisting: AppSystemStore },
        // Phase 7-A: registration's one new reader, through the same one gateway.
        { provide: REGISTRATION_STORE, useExisting: AppSystemStore },
        { provide: CONTACT_CHANGE_STORE, useExisting: AppSystemStore },
        // Phase 5-A: the same gateway answers the caller's own identity read.
        { provide: CURRENT_USER_STORE, useExisting: AppSystemStore },
        // Phase 5-C: and the three messaging readers of migration 0053.
        { provide: MESSAGING_STORE, useExisting: AppSystemStore },
        // Phase 5-E: and the six writers of migration 0054.
        { provide: MESSAGING_WRITE_STORE, useExisting: AppSystemStore },
        // 0104: and the three attachment operations of migration 0104. It reuses SELLER_MEDIA_STORAGE below
        // for the private message-attachments bucket rather than introducing a second client, exactly as 6-I,
        // 7-G, 7-K and the CMS media surface do.
        { provide: MESSAGE_ATTACHMENT_STORE, useExisting: AppSystemStore },
        // Phase 7-C: the notification read surface, through the same one gateway.
        { provide: NOTIFICATIONS_STORE, useExisting: AppSystemStore },
        // Phase 7-E: the buyer account surfaces, through the same one gateway as every other.
        { provide: BUYER_ACCOUNT_STORE, useExisting: AppSystemStore },
        // Phase 7-F: the staff console session, through the same one gateway as every other.
        { provide: STAFF_CONSOLE_STORE, useExisting: AppSystemStore },
        // Phase 7-G: the seller verification review readers and the one decision writer of migration
        // 0069, through that same gateway. It reuses SELLER_MEDIA_STORAGE for the private verification
        // bucket rather than introducing a second provider client, exactly as 6-I does.
        { provide: VERIFICATION_REVIEW_STORE, useExisting: AppSystemStore },
        // Phase 7-H: the two offer readers and the five writers of migration 0070, through that same
        // gateway. No throttle counter is wired to them: 0015's one-open-per-buyer index is the rate
        // limit the schema itself imposes on opening offers.
        { provide: OFFERS_STORE, useExisting: AppSystemStore },
        // Phase 7-I: the three service-request readers and the seven writers of migration 0071, through
        // that same gateway.
        { provide: SERVICE_REQUESTS_STORE, useExisting: AppSystemStore },
        // Phase 7-J: the Admin Only queue, detail, payment-information reader and staff closure of
        // migration 0073, through that same gateway. Each passes the staff account and the assurance
        // level, because the connection carries no claims; the permission keys are literals in 0073.
        { provide: ADMIN_SERVICE_REQUESTS_STORE, useExisting: AppSystemStore },
        // Phase 7-K: the requester's three support readers, three wrappers around 0028's own writers and
        // three attachment functions of migration 0074, through that same gateway. It reuses
        // SELLER_MEDIA_STORAGE for the private support-attachments bucket rather than introducing a second
        // provider client, exactly as 6-I and 7-G do.
        { provide: SUPPORT_STORE, useExisting: AppSystemStore },
        // Phase 7-L: the agent console's five readers and four wrappers of migration 0075, through that
        // same gateway. Each passes the staff account and the assurance level, because the connection
        // carries no claims; the two permission keys are literals in 0075's own predicates. It reuses
        // SELLER_MEDIA_STORAGE for the private support bucket rather than introducing a second client.
        { provide: SUPPORT_CONSOLE_STORE, useExisting: AppSystemStore },
        // Phase 7-M: the reporter's filing wrapper and own-reports reader of migration 0076, through the
        // same gateway. The wrapper resolves a public slug and delegates the report to 0027's own writer,
        // so nothing here names a subject id and nothing here decides what may be reported.
        { provide: REPORTS_STORE, useExisting: AppSystemStore },
        // Phase 7-N: 0077's six readers and two write wrappers, through the same gateway. Each passes the
        // staff account and the assurance level, because the connection carries no claims; the five
        // permission keys are literals in 0077's own predicates, and the writers delegate to 0027's
        // resolve_report and moderate_listing, which lock the row and write both trails themselves.
        { provide: MODERATION_STORE, useExisting: AppSystemStore },
        // Phase 7-O: 0078's thirteen readers and three recovery write wrappers, through the same gateway.
        // Each passes the staff account and the assurance level, because the connection carries no claims;
        // the six permission keys are literals in 0078's own predicates. The three writers delegate to
        // 0028's review, decide and complete, which lock the row and write the approval trail, the security
        // event and the outbox event themselves. There is deliberately no role writer and no seller-status
        // writer here: neither exists in this repository, and both are reported as capability gaps.
        { provide: ADMIN_OPERATIONS_STORE, useExisting: AppSystemStore },
        // Phase 7-P. Three keys — `reviews.review.read`, `reviews.review.moderate` and 0027's own
        // `moderation.action.read` — each a literal inside 0080's own predicates, and the one writer delegates
        // to 0026's `moderate_review`, which locks the row, refuses a moderator who is a party, clears the
        // automatic hiding reason and enqueues its own event. There is deliberately no reply writer here:
        // none exists in this repository, and it is reported as a capability gap.
        { provide: REVIEW_MODERATION_STORE, useExisting: AppSystemStore },
        // Phase 7-Q. One key — `platform.job.read`, a literal inside 0081's own predicate — and six readers
        // behind it. **No writer is provided here, because none exists:** 0007's run and outbox writers belong
        // to `app_worker`, and this gateway calls not one of them.
        { provide: PLATFORM_OPERATIONS_STORE, useExisting: AppSystemStore },
        // Phase 7-R. Two keys — `disputes.dispute.read` and `disputes.dispute.manage`, each a literal inside
        // 0082's own predicates — and five operations behind them. The two writers delegate to 0027's
        // `post_dispute_message` and `resolve_dispute`, which lock the row, work the author's role out
        // themselves, refuse a party, restore the order's snapshot status and enqueue their own events.
        // **Neither moves money:** no refund, payment, ledger, balance, payout or provider writer is reachable
        // from here, and none exists in this repository to reach.
        { provide: DISPUTE_MANAGEMENT_STORE, useExisting: AppSystemStore },
        { provide: KNOWN_DEVICE_STORE, useExisting: AppSystemStore },
        // Phase 4-A: the same single app_system gateway also answers the public catalogue read.
        { provide: CATEGORY_STORE, useExisting: AppSystemStore },
        // Phase 8-D: the category feed and its facets, through the same single gateway.
        { provide: CATEGORY_FEED_PORT, useExisting: AppSystemStore },
        { provide: CMS_PAGES_STORE, useExisting: AppSystemStore },
        { provide: CMS_PUBLIC_STORE, useExisting: AppSystemStore },
        { provide: BLOG_STORE, useExisting: AppSystemStore },
        { provide: BLOG_PUBLIC_STORE, useExisting: AppSystemStore },
        { provide: HOMEPAGE_STORE, useExisting: AppSystemStore },
        { provide: HOMEPAGE_PUBLIC_STORE, useExisting: AppSystemStore },
        { provide: NAVIGATION_STORE, useExisting: AppSystemStore },
        { provide: NAVIGATION_PUBLIC_STORE, useExisting: AppSystemStore },
        { provide: FAQS_STORE, useExisting: AppSystemStore },
        { provide: FAQS_PUBLIC_STORE, useExisting: AppSystemStore },
        { provide: SEO_STORE, useExisting: AppSystemStore },
        // Phase 8-E: the SEO redirect map, admin and public halves, through the same single gateway.
        { provide: SEO_REDIRECTS_STORE, useExisting: AppSystemStore },
        // Phase 8-F: the per-entity metadata overrides, admin and public halves, through the same gateway.
        { provide: SEO_METADATA_STORE, useExisting: AppSystemStore },
        // Phase 8, increment 0096: the site-wide SEO defaults, authoring only, through the same gateway.
        { provide: SEO_SETTINGS_STORE, useExisting: AppSystemStore },
        // Phase 8, increment 0098: the CMS media library, through the same gateway. Its provider calls reuse
        // SELLER_MEDIA_STORAGE below for the private cms-media bucket rather than introducing a second client.
        { provide: CMS_MEDIA_STORE, useExisting: AppSystemStore },
        { provide: CATEGORIES_STORE, useExisting: AppSystemStore },
        // Phase 8-C: the attribute and tag vocabulary, and the seller's own answers, through the same gateway.
        { provide: ATTRIBUTES_STORE, useExisting: AppSystemStore },
        { provide: SELLER_VOCABULARY_STORE, useExisting: AppSystemStore },
        { provide: LISTING_STORE, useExisting: AppSystemStore },
        { provide: SERVICE_STORE, useExisting: AppSystemStore },
        { provide: SELLER_STORE, useExisting: AppSystemStore },
        // Phase 6-A: the authenticated seller's own identity, through the same one gateway.
        { provide: SELLER_IDENTITY_STORE, useExisting: AppSystemStore },
        // Phase 6-C: onboarding writes through that same gateway and no other.
        { provide: SELLER_ONBOARDING_STORE, useExisting: AppSystemStore },
        // Phase 6-D: and so does editing.
        { provide: SELLER_PROFILE_UPDATE_STORE, useExisting: AppSystemStore },
        // Phase 6-E: media authorization reads the same gateway; only the signing itself leaves the process.
        { provide: SELLER_MEDIA_STORE, useExisting: AppSystemStore },
        // Phase 6-F: and so do the seller's own listing reads and writes.
        { provide: SELLER_LISTING_STORE, useExisting: AppSystemStore },
        // Phase 6-G: and the service reads and writes, which compose 6-F's.
        { provide: SELLER_SERVICE_STORE, useExisting: AppSystemStore },
        // Phase 6-I: and the seller's own verification submission. It reuses SELLER_MEDIA_STORAGE below for
        // the verification bucket rather than introducing a second provider client.
        { provide: SELLER_VERIFICATION_STORE, useExisting: AppSystemStore },
        // Phase 6-J: the five read-only surfaces, through the same one gateway. No throttle counter is
        // wired to them, because a read spends no write bucket.
        { provide: SELLER_READ_STORE, useExisting: AppSystemStore },
        {
          provide: SELLER_MEDIA_STORAGE,
          useFactory: () =>
            new SupabaseStorageClient({ url: env.supabaseUrl, secretKey: env.supabaseSecretKey }),
        },
        { provide: SEARCH_PORT, useExisting: AppSystemStore },
        // 0101. The degraded direct path writes through the same store as everything else; the stream is a
        // port so a deployment without Redis still ingests, durably, through that path.
        { provide: LISTING_EVENT_STORE, useExisting: AppSystemStore },
        // 0102. The rollup's two readers go through the same one gateway; the rollup itself is granted to
        // nobody and runs only through the scheduled-job dispatcher, so nothing here can write one.
        { provide: LISTING_ANALYTICS_STORE, useExisting: AppSystemStore },
        {
          provide: LISTING_EVENT_STREAM_PORT,
          useFactory: () => RedisListingEventStream.fromUrl(env.redisUrl),
        },
        // Its own key, never one of the other two (0101 owner decision 4).
        { provide: 'ANALYTICS_SESSION_KEY', useValue: env.analyticsSessionKey },
        ListingEventIngestionService,
        ListingAnalyticsService,
        { provide: WEB_PUBLIC_ORIGIN, useValue: env.webPublicOrigin },
        { provide: OTP_PEPPER, useFactory: () => new OtpPepper(env.otpPepper) },
        // C-13: one key per environment, shared with the worker, so the same person reads the same in
        // both services' logs. Constructed once; the key itself never leaves the instance.
        {
          provide: PSEUDONYMOUS_USER_ID,
          useFactory: () => new PseudonymousUserId(env.pseudonymousUserIdKey),
        },
        // C-15: its own key, separate from the C-13 one by owner decision. Constructed once; the key
        // itself never leaves the instance.
        { provide: DEVICE_IDENTITY, useFactory: () => new DeviceIdentity(env.deviceIdentityKey) },
        {
          provide: WaabekClient,
          useFactory: () => new WaabekClient({ baseUrl: env.waabekBaseUrl, apiKey: env.waabekApiKey }),
        },
        LoginEnforcementService,
        LoginThrottleService,
        AuthSecurityEventsService,
        LoginService,
        OtpService,
        StepUpService,
        TotpService,
        PasswordResetService,
        RecoveryService,
        RegistrationService,
        ContactChangeService,
        SessionService,
        CurrentUserService,
        MessagingService,
        MessagingThrottleService,
        MessagingWriteService,
        MessageAttachmentsService,
        NotificationsService,
        BuyerAccountService,
        StaffConsoleService,
        VerificationReviewService,
        OffersService,
        ServiceRequestsService,
        AdminServiceRequestsService,
        SupportService,
        SupportThrottleService,
        SupportConsoleService,
        // Phase 7-M. Here rather than in the v1 module for the same reason the messaging, support and
        // seller throttles are: the two counters it injects live here.
        ReportsService,
        ReportsThrottleService,
        ModerationService,
        AdminOperationsService,
        ReviewModerationService,
        CmsPagesAdminService,
        CmsPagesService,
        BlogAdminService,
        BlogPublicService,
        HomepageAdminService,
        HomepagePublicService,
        NavigationAdminService,
        NavigationPublicService,
        FaqsAdminService,
        FaqsPublicService,
        SeoService,
        SeoRedirectsAdminService,
        SeoMetadataAdminService,
        SeoSettingsAdminService,
        CmsMediaAdminService,
        CategoriesAdminService,
        AttributesAdminService,
        CategoryFeedService,
        SellerVocabularyService,
        PlatformOperationsService,
        DisputeManagementService,
        // Phase 6-C. Here rather than in the v1 module because the throttle counters live here, exactly as
        // the messaging throttle does.
        SellerThrottleService,
        SellerOnboardingService,
        SellerProfileUpdateService,
        SellerMediaService,
        SellerListingService,
        SellerServiceService,
        SellerVerificationService,
        SellerReadService,
      ],
      exports: [
        CATEGORY_STORE,
        CATEGORY_FEED_PORT,
        CMS_PAGES_STORE,
        CMS_PUBLIC_STORE,
        BLOG_STORE,
        BLOG_PUBLIC_STORE,
        HOMEPAGE_STORE,
        HOMEPAGE_PUBLIC_STORE,
        NAVIGATION_STORE,
        NAVIGATION_PUBLIC_STORE,
        FAQS_STORE,
        FAQS_PUBLIC_STORE,
        SEO_STORE,
        SEO_REDIRECTS_STORE,
        SEO_METADATA_STORE,
        SEO_SETTINGS_STORE,
        CMS_MEDIA_STORE,
        CATEGORIES_STORE,
        ATTRIBUTES_STORE,
        SELLER_VOCABULARY_STORE,
        LISTING_STORE,
        SERVICE_STORE,
        SELLER_STORE,
        SELLER_IDENTITY_STORE,
        SELLER_ONBOARDING_STORE,
        SELLER_PROFILE_UPDATE_STORE,
        SELLER_MEDIA_STORE,
        SELLER_LISTING_STORE,
        SELLER_SERVICE_STORE,
        SELLER_VERIFICATION_STORE,
        SELLER_READ_STORE,
        SELLER_MEDIA_STORAGE,
        SEARCH_PORT,
        ListingEventIngestionService,
        ListingAnalyticsService,
        LoginEnforcementService,
        LoginService,
        OtpService,
        StepUpService,
        TotpService,
        PasswordResetService,
        RecoveryService,
        RegistrationService,
        ContactChangeService,
        SessionService,
        CurrentUserService,
        MessagingService,
        MessagingWriteService,
        MessageAttachmentsService,
        NotificationsService,
        BuyerAccountService,
        StaffConsoleService,
        VerificationReviewService,
        OffersService,
        ServiceRequestsService,
        AdminServiceRequestsService,
        SupportService,
        SupportThrottleService,
        SupportConsoleService,
        ReportsService,
        ReportsThrottleService,
        ModerationService,
        AdminOperationsService,
        ReviewModerationService,
        CmsPagesAdminService,
        CmsPagesService,
        BlogAdminService,
        BlogPublicService,
        HomepageAdminService,
        HomepagePublicService,
        NavigationAdminService,
        NavigationPublicService,
        FaqsAdminService,
        FaqsPublicService,
        SeoService,
        SeoRedirectsAdminService,
        SeoMetadataAdminService,
        SeoSettingsAdminService,
        CmsMediaAdminService,
        CategoriesAdminService,
        AttributesAdminService,
        CategoryFeedService,
        SellerVocabularyService,
        PlatformOperationsService,
        DisputeManagementService,
        SellerOnboardingService,
        SellerProfileUpdateService,
        SellerMediaService,
        SellerListingService,
        SellerServiceService,
        SellerVerificationService,
        SellerReadService,
      ],
    };
  }
}
