import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { LoginRequestSchema, LoginResponseSchema } from '../auth-login.js';
import {
  CATALOG_LISTING_TYPES,
  CategoryFeedResponseSchema,
} from '../catalog-filters.js';
import {
  CategoriesResponseSchema,
  CategoryDetailResponseSchema,
  CategoryNodeSchema,
  PublicLocaleSchema,
} from '../categories.js';
import {
  CMS_PAGES_DEFAULT_LIMIT,
  CMS_PAGES_MAX_LIMIT,
  CmsPageDetailResponseSchema,
  CmsPagePageResponseSchema,
  CmsPageSlugSchema,
  CmsPageCoverRequestSchema,
  CmsPageStatusRequestSchema,
  CmsPageWriteResponseSchema,
  CreateCmsPageRequestSchema,
  CreateCmsPageResponseSchema,
  PublicCmsPageLookupResponseSchema,
  PublicCmsPagesResponseSchema,
  SaveCmsPageTranslationRequestSchema,
  UpdateCmsPageRequestSchema,
} from '../cms-pages.js';
import {
  BlogPostDetailResponseSchema,
  BlogPostPageResponseSchema,
  BlogPostStatusRequestSchema,
  BlogSlugSchema,
  BlogTaxonomyResponseSchema,
  BlogWriteResponseSchema,
  CreateBlogPostRequestSchema,
  CreateBlogPostResponseSchema,
  PublicBlogIndexResponseSchema,
  PublicBlogPostLookupResponseSchema,
  PublicBlogTaxonomyResponseSchema,
  SaveBlogCategoryRequestSchema,
  SaveBlogPostTagsRequestSchema,
  SaveBlogPostTranslationRequestSchema,
  SaveBlogTagRequestSchema,
  SaveBlogTaxonomyResponseSchema,
  UpdateBlogPostRequestSchema,
} from '../blog.js';
import {
  CreateHomepageSectionRequestSchema,
  CreateHomepageSectionResponseSchema,
  HomepageSectionDetailResponseSchema,
  HomepageSectionStateRequestSchema,
  HomepageSectionsResponseSchema,
  HomepageWriteResponseSchema,
  PublicHomepageResponseSchema,
  ReorderHomepageSectionsRequestSchema,
  UpdateHomepageSectionRequestSchema,
} from '../homepage.js';
import {
  CreateNavigationItemRequestSchema,
  CreateNavigationItemResponseSchema,
  CreateNavigationMenuRequestSchema,
  CreateNavigationMenuResponseSchema,
  NavigationMenuDetailResponseSchema,
  NavigationMenusResponseSchema,
  NavigationStateRequestSchema,
  NavigationWriteResponseSchema,
  PublicNavigationResponseSchema,
  ReorderNavigationItemsRequestSchema,
  UpdateNavigationItemRequestSchema,
  UpdateNavigationMenuRequestSchema,
} from '../navigation.js';
import {
  CreateFaqRequestSchema,
  CreateFaqResponseSchema,
  FAQ_DEFAULT_LIMIT,
  FAQ_MAX_LIMIT,
  FaqDetailResponseSchema,
  FaqPageResponseSchema,
  FaqStateRequestSchema,
  FaqTopicSchema,
  FaqTopicsResponseSchema,
  FaqWriteResponseSchema,
  PublicFaqsResponseSchema,
  ReorderFaqsRequestSchema,
  UpdateFaqRequestSchema,
} from '../faqs.js';
import {
  CreateSeoRedirectRequestSchema,
  CreateSeoRedirectResponseSchema,
  RedirectResolutionResponseSchema,
  SEO_REDIRECTS_DEFAULT_LIMIT,
  SEO_REDIRECTS_MAX_LIMIT,
  SeoRedirectDetailResponseSchema,
  SeoRedirectStateRequestSchema,
  SeoRedirectWriteResponseSchema,
  SeoRedirectsResponseSchema,
  UpdateSeoRedirectRequestSchema,
} from '../seo-redirects.js';
import {
  PublicSeoMetadataResponseSchema,
  SEO_METADATA_DEFAULT_LIMIT,
  SEO_METADATA_MAX_LIMIT,
  SaveSeoMetadataRequestSchema,
  SaveSeoMetadataResponseSchema,
  SeoMetadataDetailResponseSchema,
  SeoMetadataEntriesResponseSchema,
  SeoMetadataWriteResponseSchema,
} from '../seo-metadata.js';
import {
  SaveSeoSettingsRequestSchema,
  SeoSettingsResponseSchema,
  SeoSettingsWriteResponseSchema,
} from '../seo-settings.js';
import {
  CMS_MEDIA_DEFAULT_LIMIT,
  CMS_MEDIA_MAX_BYTES,
  CMS_MEDIA_MAX_LIMIT,
  CmsMediaAltTextRequestSchema,
  CmsMediaAttachRequestSchema,
  CmsMediaAttachResponseSchema,
  CmsMediaPageResponseSchema,
  CmsMediaPreviewResponseSchema,
  CmsMediaUploadRequestSchema,
  CmsMediaUploadResponseSchema,
  CmsMediaUsageResponseSchema,
  CmsMediaWriteResponseSchema,
} from '../cms-media.js';
import {
  AdminCategoryDetailResponseSchema,
  AdminCategoryTreeResponseSchema,
  CategoryStateRequestSchema,
  CategoryWriteResponseSchema,
  CreateCategoryRequestSchema,
  CreateCategoryResponseSchema,
  SaveCategoryTranslationRequestSchema,
  UpdateCategoryRequestSchema,
} from '../categories-admin.js';
import {
  AdminAttributeDefinitionsResponseSchema,
  AdminAttributeDetailResponseSchema,
  AdminCategoryAttributesResponseSchema,
  AdminTagsResponseSchema,
  AttachCategoryAttributeRequestSchema,
  CreateAttributeDefinitionRequestSchema,
  CreateAttributeDefinitionResponseSchema,
  CreateAttributeOptionRequestSchema,
  CreateAttributeOptionResponseSchema,
  CreateTagRequestSchema,
  CreateTagResponseSchema,
  UpdateAttributeDefinitionRequestSchema,
  UpdateAttributeOptionRequestSchema,
  UpdateTagRequestSchema,
  VocabularyStateRequestSchema,
  VocabularyWriteResponseSchema,
} from '../attributes-admin.js';
import {
  SaveSellerListingAttributesRequestSchema,
  SaveSellerListingTagsRequestSchema,
  SellerListingAttributesResponseSchema,
  SellerListingAttributesWriteResponseSchema,
  SellerListingTagsResponseSchema,
} from '../seller-listing-attributes.js';
import {
  RobotsSettingsResponseSchema,
  SitemapApiEntryTypeSchema,
  SitemapCountsResponseSchema,
  SitemapPageResponseSchema,
} from '../seo.js';
import {
  RESET_TOKEN_HEADER,
  RecoveryResetRequestSchema,
  RecoveryResetResponseSchema,
  RecoveryStartRequestSchema,
  RecoveryStartResponseSchema,
  RecoveryVerifyRequestSchema,
  RecoveryVerifyResponseSchema,
} from '../auth-recovery.js';
import {
  ArchiveNotificationsRequestSchema,
  MarkNotificationsReadRequestSchema,
  NOTIFICATIONS_DEFAULT_LIMIT,
  NOTIFICATIONS_MAX_LIMIT,
  NotificationsMutationResponseSchema,
  NotificationsResponseSchema,
  NotificationsUnreadCountResponseSchema,
} from '../notifications.js';
import {
  TotpChallengeRequestSchema,
  TotpChallengeResponseSchema,
  TotpEnrolmentResponseSchema,
  TotpStatusResponseSchema,
  TotpVerifyRequestSchema,
  TotpVerifyResponseSchema,
} from '../auth-totp.js';
import {
  RegisterRequestSchema,
  RegisterResendRequestSchema,
  RegisterResendResponseSchema,
  RegisterResponseSchema,
  RegisterVerifyRequestSchema,
  RegisterVerifyResponseSchema,
} from '../auth-register.js';
import {
  ContactPhoneStartRequestSchema,
  ContactPhoneStartResponseSchema,
  ContactPhoneVerifyRequestSchema,
  ContactPhoneVerifyResponseSchema,
  SESSION_TOKEN_HEADER,
} from '../contact-change.js';
import {
  CurrentUserResponseSchema,
  LogoutResponseSchema,
  REFRESH_TOKEN_HEADER,
  SessionRefreshResponseSchema,
} from '../auth-session.js';
import { HealthResponseSchema, ReadinessResponseSchema } from '../health.js';
import {
  CloseConversationResponseSchema,
  FileMessagingReportRequestSchema,
  FileMessagingReportResponseSchema,
  ConversationMessagesResponseSchema,
  LeaveConversationResponseSchema,
  MESSAGING_INBOX_DEFAULT_LIMIT,
  MESSAGING_INBOX_MAX_LIMIT,
  MESSAGING_MESSAGES_DEFAULT_LIMIT,
  MESSAGING_MESSAGES_MAX_LIMIT,
  MarkReadRequestSchema,
  MarkReadResponseSchema,
  MessagingInboxResponseSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  SetMutedRequestSchema,
  SetMutedResponseSchema,
  StartConversationRequestSchema,
  StartConversationResponseSchema,
  UnreadCountResponseSchema,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_PER_MESSAGE,
  MessageAttachmentLinkResponseSchema,
  MessageAttachmentRecordRequestSchema,
  MessageAttachmentRecordResponseSchema,
  MessageAttachmentUploadRequestSchema,
  MessageAttachmentUploadResponseSchema,
} from '../messaging.js';
import {
  LISTINGS_DEFAULT_LIMIT,
  LISTINGS_MAX_LIMIT,
  ListingDetailResponseSchema,
  ListingsResponseSchema,
} from '../listings.js';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_QUERY_LENGTH,
  SearchResponseSchema,
} from '../search.js';
import {
  SELLER_LISTINGS_DEFAULT_LIMIT,
  SELLER_LISTINGS_MAX_LIMIT,
  ListingSlugSchema,
  SellerIdentityResponseSchema,
  SellerListingCreateRequestSchema,
  SellerListingMutationResponseSchema,
  SellerListingUpdateRequestSchema,
  SellerListingsResponseSchema,
  SELLER_SERVICES_DEFAULT_LIMIT,
  SELLER_SERVICES_MAX_LIMIT,
  SellerOnboardingRequestSchema,
  SellerOnboardingResponseSchema,
  SellerProfileResponseSchema,
  SellerServiceCreateRequestSchema,
  SellerServiceUpdateRequestSchema,
  SellerServicesResponseSchema,
  SellerMediaAttachRequestSchema,
  SellerMediaAttachResponseSchema,
  SellerMediaUploadRequestSchema,
  SellerMediaUploadResponseSchema,
  SellerProfileUpdateRequestSchema,
  SellerProfileUpdateResponseSchema,
  SELLER_VERIFICATION_DOCUMENT_MAX_BYTES,
  SellerVerificationDocumentCountResponseSchema,
  SellerVerificationDocumentRequestSchema,
  SellerVerificationResponseSchema,
  SellerVerificationStateResponseSchema,
  SellerVerificationUploadRequestSchema,
  SellerVerificationUploadResponseSchema,
  SELLER_ANALYTICS_DEFAULT_DAYS,
  SELLER_ANALYTICS_MAX_DAYS,
  SELLER_READ_DEFAULT_LIMIT,
  SELLER_READ_MAX_LIMIT,
  SellerAnalyticsResponseSchema,
  SellerEarningsResponseSchema,
  SellerOrdersResponseSchema,
  SellerPromotionsResponseSchema,
  SellerReviewsResponseSchema,
} from '../sellers.js';
import {
  LISTING_ANALYTICS_DEFAULT_DAYS,
  LISTING_ANALYTICS_MAX_DAYS,
  ListingAnalyticsResponseSchema,
  SellerListingAnalyticsResponseSchema,
} from '../analytics.js';
import {
  SERVICES_DEFAULT_LIMIT,
  SERVICES_MAX_LIMIT,
  ServiceDetailResponseSchema,
  ServicesResponseSchema,
} from '../services.js';
import {
  ACCOUNT_DEFAULT_LIMIT,
  ACCOUNT_MAX_LIMIT,
  AddFavoriteRequestSchema,
  AddressCreatedResponseSchema,
  AddressInputSchema,
  AddressMutationResponseSchema,
  AddressesResponseSchema,
  BuyerProfileMutationResponseSchema,
  BuyerProfileResponseSchema,
  BuyerSettingsMutationResponseSchema,
  BuyerSettingsResponseSchema,
  CountriesResponseSchema,
  FavoriteMutationResponseSchema,
  FavoritesResponseSchema,
  SavedSearchCreatedResponseSchema,
  SavedSearchInputSchema,
  SavedSearchMutationResponseSchema,
  SavedSearchesResponseSchema,
  UpdateBuyerProfileRequestSchema,
  UpdateBuyerSettingsRequestSchema,
} from '../buyer-account.js';
import {
  BLOCKS_DEFAULT_LIMIT,
  BLOCKS_MAX_LIMIT,
  BlockMutationResponseSchema,
  BlockRequestSchema,
  BlocksResponseSchema,
} from '../blocks.js';
import { AdminSessionResponseSchema } from '../admin-session.js';
import {
  CreateServiceRequestSchema,
  SERVICE_REQUESTS_DEFAULT_LIMIT,
  SERVICE_REQUESTS_MAX_LIMIT,
  ServiceRequestDetailResponseSchema,
  ServiceRequestMutationResponseSchema,
  ServiceRequestStatusResponseSchema,
  ServiceRequestsResponseSchema,
  AdminServiceRequestDecisionResponseSchema,
  AdminServiceRequestDetailResponseSchema,
  AdminServiceRequestsResponseSchema,
  CreateAdminOnlyServiceRequestSchema,
  ServiceRequestPaymentInformationResponseSchema,
} from '../service-requests.js';
import {
  OpenSupportTicketResponseSchema,
  OpenSupportTicketSchema,
  PostSupportMessageSchema,
  SUPPORT_MESSAGES_DEFAULT_LIMIT,
  SUPPORT_MESSAGES_MAX_LIMIT,
  SUPPORT_TICKETS_DEFAULT_LIMIT,
  SUPPORT_TICKETS_MAX_LIMIT,
  SupportAttachmentLinkResponseSchema,
  SupportAttachmentRecordResponseSchema,
  SupportAttachmentRecordSchema,
  SupportAttachmentUploadRequestSchema,
  SupportAttachmentUploadResponseSchema,
  SupportMessageMutationResponseSchema,
  SupportMessagesResponseSchema,
  SupportTicketClosureResponseSchema,
  SupportTicketDetailResponseSchema,
  SupportTicketsResponseSchema,
} from '../support.js';
import {
  AddSupportInternalNoteSchema,
  PostSupportAgentMessageSchema,
  SUPPORT_CONSOLE_DEFAULT_LIMIT,
  SUPPORT_CONSOLE_MAX_LIMIT,
  SupportAgentDecisionRequestSchema,
  SupportAgentDecisionResponseSchema,
  SupportAssignedResponseSchema,
  SupportAssignmentResponseSchema,
  SupportConsoleAttachmentLinkResponseSchema,
  SupportConsoleMessageMutationResponseSchema,
  SupportConsoleMessagesResponseSchema,
  SupportConsoleTicketResponseSchema,
  SupportInternalNoteMutationResponseSchema,
  SupportInternalNotesResponseSchema,
  SupportQueueResponseSchema,
} from '../support-console.js';
import {
  FileReportRequestSchema,
  FileReportResponseSchema,
  REPORTS_DEFAULT_LIMIT,
  REPORTS_MAX_LIMIT,
  ReporterReportsResponseSchema,
} from '../reports.js';
import {
  ListingModerationHistoryResponseSchema,
  MODERATION_DEFAULT_LIMIT,
  MODERATION_MAX_LIMIT,
  ModerateListingRequestSchema,
  ModerateListingResponseSchema,
  ModerationActionsResponseSchema,
  ModerationListingDetailResponseSchema,
  ModerationListingQueueResponseSchema,
  ModerationReportDetailResponseSchema,
  ModerationReportQueueResponseSchema,
  ResolveReportRequestSchema,
  ResolveReportResponseSchema,
} from '../moderation.js';
import {
  ADMIN_OPS_DEFAULT_LIMIT,
  ADMIN_OPS_MAX_LIMIT,
  AdminRoleCatalogueResponseSchema,
  AdminSecurityEventsResponseSchema,
  AdminSellerDetailResponseSchema,
  AdminSellerPageResponseSchema,
  AdminUserDetailResponseSchema,
  AdminUserPageResponseSchema,
  AdminUserRolesResponseSchema,
  AuditPageResponseSchema,
  RecoveryCompletionRequestSchema,
  RecoveryCompletionResponseSchema,
  RecoveryDecisionRequestSchema,
  RecoveryDecisionResponseSchema,
  RecoveryEvidenceResponseSchema,
  RecoveryQueueResponseSchema,
  RecoveryRequestDetailResponseSchema,
  RecoveryReviewRequestSchema,
  RecoveryReviewResponseSchema,
  SellerStatusChangeRequestSchema,
  StaffGrantableRolesResponseSchema,
  StaffRoleGrantRequestSchema,
  StaffRoleRevokeRequestSchema,
  StaffRoleWriteResponseSchema,
  SellerStatusChangeResponseSchema,
} from '../admin-operations.js';
import { TrackRequestSchema, TrackResponseSchema } from '../track.js';
import {
  ModerateReviewRequestSchema,
  ModerateReviewResponseSchema,
  REVIEW_MODERATION_DEFAULT_LIMIT,
  REVIEW_MODERATION_MAX_LIMIT,
  ReviewDetailResponseSchema,
  ReviewModerationActionsResponseSchema,
  ReviewQueueResponseSchema,
} from '../review-moderation.js';
import {
  JobRunDetailResponseSchema,
  JobRunPageResponseSchema,
  OutboxResponseSchema,
  PLATFORM_OPS_DEFAULT_LIMIT,
  PLATFORM_OPS_MAX_LIMIT,
  ScheduleProblemsResponseSchema,
  ScheduledJobCatalogueResponseSchema,
} from '../platform-operations.js';
import {
  DISPUTES_DEFAULT_LIMIT,
  DISPUTES_MAX_LIMIT,
  DisputeDetailResponseSchema,
  DisputeMessagesResponseSchema,
  DisputeQueueResponseSchema,
  PostDisputeMessageRequestSchema,
  PostDisputeMessageResponseSchema,
  ResolveDisputeRequestSchema,
  ResolveDisputeResponseSchema,
  SELECTABLE_DISPUTE_STATUSES,
} from '../dispute-management.js';
import {
  VERIFICATION_QUEUE_DEFAULT_LIMIT,
  VERIFICATION_QUEUE_MAX_LIMIT,
  VerificationDecisionRequestSchema,
  VerificationDecisionResponseSchema,
  VerificationDocumentLinkResponseSchema,
  VerificationQueueResponseSchema,
  VerificationReviewResponseSchema,
} from '../verification-review.js';
import { PROBLEM_JSON_MEDIA_TYPE, ProblemDetailsSchema } from '../problem-details.js';
import { V1FoundationResponseSchema } from '../v1-foundation.js';
import { z } from '../zod.js';

const internalError = {
  description: 'Unexpected server error',
  content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
} as const;

function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  // Registered by name so the recursive category node can refer to itself by `$ref`.
  registry.register('CategoryNode', CategoryNodeSchema);

  registry.registerPath({
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    summary: 'Liveness check',
    responses: {
      200: {
        description: 'The API process is running',
        content: { 'application/json': { schema: HealthResponseSchema } },
      },
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/ready',
    operationId: 'getReadiness',
    summary: 'Readiness check',
    responses: {
      200: {
        description: 'All dependency checks passed',
        content: { 'application/json': { schema: ReadinessResponseSchema } },
      },
      503: {
        description: 'At least one dependency check failed',
        content: { 'application/json': { schema: ReadinessResponseSchema } },
      },
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/foundation',
    operationId: 'getV1Foundation',
    summary: 'Foundation probe for the /v1 boundary',
    description:
      'Requires the internal BFF credential. Carries no user context and authorizes nothing.',
    responses: {
      200: {
        description: 'The /v1 boundary is reachable by an approved internal caller',
        content: { 'application/json': { schema: V1FoundationResponseSchema } },
      },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/categories',
    operationId: 'getV1Categories',
    summary: 'The public category tree',
    description:
      'The published category tree for one locale, as nested nodes. Requires the internal BFF credential. Carries no user context: the same tree is served to a guest and to a signed-in person. There is no pagination, filter or sort, and the locale selects a representation rather than a subset.',
    request: {
      query: z.object({
        locale: PublicLocaleSchema.optional().describe(
          'Names the language of the category names. Absent or unrecognised resolves to the default locale.',
        ),
      }),
    },
    responses: {
      200: {
        description: 'The published tree. An empty array means nothing is published yet.',
        content: { 'application/json': { schema: CategoriesResponseSchema } },
      },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: {
        description: 'The catalogue could not be read',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      500: internalError,
    },
  });

  const catalogUnavailable = {
    description: 'The catalogue could not be read',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/categories/{slug}',
    operationId: 'getV1CategoryBySlug',
    summary: 'One public category',
    description:
      'The category a slug names, with its parent and its direct children. Inactive categories, and categories under a deactivated ancestor, answer 404 — identically to a slug that names nothing, so the surface cannot be used to learn that a category exists but is switched off. There is no 301: categories keep no slug history.',
    request: {
      params: z.object({ slug: z.string() }),
      query: z.object({
        locale: PublicLocaleSchema.optional().describe('Names the language of the category names and description.'),
      }),
    },
    responses: {
      200: {
        description: 'The category',
        content: { 'application/json': { schema: CategoryDetailResponseSchema } },
      },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      404: {
        description: 'No category the public may see answers to this slug',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: catalogUnavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/listings',
    operationId: 'getV1Listings',
    summary: 'One page of the public browse list',
    description:
      'Purchasable listings of publicly visible sellers, newest first. Requires the internal BFF credential and carries no user context. Phase 4-B V1 has no filters, no search and no distance; the only inputs are an opaque cursor and a page size.',
    request: {
      query: z.object({
        cursor: z
          .string()
          .optional()
          .describe('Opaque cursor from a previous response. Send it back untouched.'),
        limit: z
          .string()
          .optional()
          .describe(`Page size. Default ${LISTINGS_DEFAULT_LIMIT}, maximum ${LISTINGS_MAX_LIMIT}.`),
      }),
    },
    responses: {
      200: {
        description: 'One page. `nextCursor` is null on the last page.',
        content: { 'application/json': { schema: ListingsResponseSchema } },
      },
      400: {
        description: 'The cursor or the page size is not valid',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: catalogUnavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/listings/{slug}',
    operationId: 'getV1ListingBySlug',
    summary: 'One public listing',
    description:
      'The listing a slug names. Sold, expired and archived listings answer 200 with availability `no_longer_available`; draft, pending, rejected, suspended and deleted ones, and listings of a suspended seller, answer 404. A previous slug answers 301 with `Location` set to the current one.',
    request: {
      params: z.object({ slug: z.string() }),
      query: z.object({
        locale: PublicLocaleSchema.optional().describe(
          'Names the language of the category, attribute and tag labels.',
        ),
      }),
    },
    responses: {
      200: {
        description: 'The listing',
        content: { 'application/json': { schema: ListingDetailResponseSchema } },
      },
      301: { description: 'The slug is a previous one; `Location` names the current slug' },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      404: {
        description: 'No listing the public may see answers to this slug',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: catalogUnavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/services',
    operationId: 'getV1Services',
    summary: 'One page of the public service list',
    description:
      'Purchasable service listings of publicly visible sellers, newest first. Requires the internal BFF credential and carries no user context. Services never appear on /v1/listings, and products never appear here. Phase 4-C V1 has no filters, no search and no distance; the only inputs are an opaque cursor and a page size.',
    request: {
      query: z.object({
        cursor: z
          .string()
          .optional()
          .describe('Opaque cursor from a previous response. Send it back untouched.'),
        limit: z
          .string()
          .optional()
          .describe(`Page size. Default ${SERVICES_DEFAULT_LIMIT}, maximum ${SERVICES_MAX_LIMIT}.`),
      }),
    },
    responses: {
      200: {
        description: 'One page. `nextCursor` is null on the last page.',
        content: { 'application/json': { schema: ServicesResponseSchema } },
      },
      400: {
        description: 'The cursor or the page size is not valid',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: catalogUnavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/services/{slug}',
    operationId: 'getV1ServiceBySlug',
    summary: 'One public service',
    description:
      'The service a slug names. Sold, expired and archived services answer 200 with availability `no_longer_available`; draft, pending, rejected, suspended and deleted ones, and services of a suspended seller, answer 404. A previous slug, or a slug that names a product, answers 301 with `Location` on the surface that owns it.',
    request: {
      params: z.object({ slug: z.string() }),
      query: z.object({
        locale: PublicLocaleSchema.optional().describe(
          'Names the language of the category, attribute and tag labels.',
        ),
      }),
    },
    responses: {
      200: {
        description: 'The service',
        content: { 'application/json': { schema: ServiceDetailResponseSchema } },
      },
      301: { description: 'The slug belongs elsewhere; `Location` names the canonical URL' },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      404: {
        description: 'No service the public may see answers to this slug',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: catalogUnavailable,
      500: internalError,
    },
  });

  // -------------------------------------------------------------------------------------------------
  // The shared catalogue filters (8-D)
  // -------------------------------------------------------------------------------------------------
  // One description, used by the category feed and by search, because 0089 answers both with the same two
  // database functions. The parameters are the shape plain HTML form controls already submit: a checkbox
  // named `tag` produces `?tag=handmade&tag=rare` with no JavaScript involved.
  const catalogFilterQuery = {
    type: z
      .enum(CATALOG_LISTING_TYPES)
      .optional()
      .describe('Narrows to one surface. Absent means both, which is what a category holding both offers.'),
    tag: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'A tag slug, repeatable. Two tags are alternatives: a listing carrying either matches, because they are one dimension. A slug naming no shown tag returns **no results** rather than being ignored — a filter must never widen what it was given.',
      ),
    'attr.{key}': z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'An attribute’s chosen option values, repeatable, or `true`/`false` for a boolean attribute. Options of one attribute are alternatives; different attributes accumulate. An unknown or hidden attribute or option returns no results.',
      ),
    'attr.{key}.min': z
      .string()
      .optional()
      .describe('The inclusive lower end of a numeric attribute’s range.'),
    'attr.{key}.max': z
      .string()
      .optional()
      .describe('The inclusive upper end of a numeric attribute’s range.'),
    'price.currency': z
      .string()
      .optional()
      .describe(
        'The currency a price bound is read in. **Required with a bound**: V1 has no FX and no rate table, so a bound narrows to the listings priced in that currency and never compares one currency’s number against another’s. The codes a category offers come back in its `currency` facet.',
      ),
    'price.min': z
      .string()
      .optional()
      .describe('The inclusive lower price bound, in whole minor units as a string (the money JSON rule).'),
    'price.max': z
      .string()
      .optional()
      .describe('The inclusive upper price bound, in whole minor units as a string.'),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/categories/{slug}/listings',
    operationId: 'getV1CategoryListings',
    summary: 'The listings in one public category',
    description:
      'One page of the listings in a category **and every active category beneath it**, inside the three levels D8 allows (owner-approved rollup): a level-0 category reaches its grandchildren, a leaf reaches only itself, and a deactivated category takes its whole branch with it, so hiding one can never widen what a visitor sees. Purchasable products and services of publicly visible sellers only, in one mixed result set discriminated by `type` — a category may hold either surface or both. Narrowed by the shared catalogue filters, which can only ever narrow: every filter is applied on top of the same visibility rules the rest of the public surface resolves through. Ordering is newest-first with the id as tie-breaker — 0051’s provisional ordering, unchanged — and there is no ranking, no promotion and no distance. `facets` is the filter panel that produced this page: the values it offers ignore the active filters so a visitor can always undo their own choice, while every count is computed under exactly the filters in force. A category that does not exist, is inactive, or sits under a deactivated ancestor answers 404, identically to a slug that names nothing.',
    request: {
      params: z.object({ slug: z.string() }),
      query: z.object({
        locale: PublicLocaleSchema.optional().describe('Names the language of the facet labels.'),
        cursor: z
          .string()
          .optional()
          .describe('Opaque cursor from a previous response. Send it back untouched.'),
        limit: z
          .string()
          .optional()
          .describe(`Page size. Default ${SEARCH_DEFAULT_LIMIT}, maximum ${SEARCH_MAX_LIMIT}.`),
        ...catalogFilterQuery,
      }),
    },
    responses: {
      200: {
        description:
          'One page of results with the filter panel. An empty `items` with populated `facets` is a category whose filters currently match nothing; an empty `items` with empty `facets` is a category with nothing in it.',
        content: { 'application/json': { schema: CategoryFeedResponseSchema } },
      },
      400: {
        description: 'A filter, the cursor or the page size is malformed. A value naming nothing real is not malformed: it returns no results.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      404: {
        description: 'No category the public may see answers to this slug',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: catalogUnavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/search',
    operationId: 'getV1Search',
    summary: 'Public search',
    description:
      'Full-text search over listing titles and descriptions, in English or Arabic. Returns purchasable products and services of publicly visible sellers in one mixed result set, discriminated by `type`. Takes the same filters as a category feed — listing type, tags, attribute answers and a price range in one currency — because one database function answers both. V1 ordering is newest-first and provisional: the ranking formula and promoted-result merging are a Phase 9 decision. There is no relevance ranking and no distance.',
    request: {
      query: z.object({
        q: z
          .string()
          .describe(`The search query. Required; at least ${SEARCH_MIN_QUERY_LENGTH} characters after trimming.`),
        cursor: z
          .string()
          .optional()
          .describe('Opaque cursor from a previous response. Send it back untouched.'),
        limit: z
          .string()
          .optional()
          .describe(`Page size. Default ${SEARCH_DEFAULT_LIMIT}, maximum ${SEARCH_MAX_LIMIT}.`),
        ...catalogFilterQuery,
      }),
    },
    responses: {
      200: {
        description: 'One page of results. `nextCursor` is null on the last page.',
        content: { 'application/json': { schema: SearchResponseSchema } },
      },
      400: {
        description: 'The query, the cursor or the page size is not valid',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: catalogUnavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/{slug}',
    operationId: 'getV1SellerBySlug',
    summary: 'One public seller profile',
    description:
      'The seller a slug names. An active seller answers 200 with availability `available`; a suspended seller answers 200 with availability `unavailable`, because the profile page still exists and says so. Pending, closed and unknown sellers answer 404 identically, so the surface cannot be used to learn that a seller exists but is not approved. There is no 301: sellers keep no slug history.',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: {
        description: 'The seller profile',
        content: { 'application/json': { schema: SellerProfileResponseSchema } },
      },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      404: {
        description: 'No seller the public may see answers to this slug',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: catalogUnavailable,
      500: internalError,
    },
  });

  // Owner decision C-2. Every failure below is problem details; the three authentication outcomes share
  // one status, one code and one body, so the document itself cannot be read as an enumeration oracle.
  const authenticationFailed = {
    description:
      'Authentication failed. Deliberately identical for a wrong password, an unknown identifier and a locked account.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/login',
    operationId: 'postV1AuthLogin',
    summary: 'Password sign-in',
    description:
      'Requires the internal BFF credential. The browser never calls the authentication provider: the BFF calls this route, and the session is returned as cookies the BFF sets, never as a token in the body.',
    request: {
      body: { content: { 'application/json': { schema: LoginRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Authenticated. The session travels as Set-Cookie; the body carries no token.',
        content: { 'application/json': { schema: LoginResponseSchema } },
      },
      400: {
        description: 'The request failed validation',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      401: authenticationFailed,
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: {
        description: 'The login throttle rejected the request',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: {
        description: 'The authentication provider or its enforcement state could not be reached',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      500: internalError,
    },
  });

  const validationFailed = {
    description: 'The request failed validation',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const credentialRejected = {
    description: 'The internal BFF credential is missing, wrong or malformed',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const throttled = {
    description: 'The approved OTP-send limits rejected the request',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const unavailable = {
    description: 'The delivery provider or the enforcement state could not be reached',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  // Phase 7-A. Registration, and the contact verification the approved VERIFY FIRST decision requires
  // before a new account can sign in. Both operations follow F3's enumeration rules exactly: the start
  // response is identical whether an account was created or the address was already taken, and no refusal
  // anywhere names a field, a destination or a reason.
  registry.registerPath({
    method: 'post',
    path: '/v1/auth/register',
    operationId: 'postV1AuthRegister',
    summary: 'Register an account',
    description:
      'Requires the internal BFF credential. Creates an account with **no confirmed contact** and sends a one-time code to the phone given, over the same WhatsApp OTP path every other contact verification in this API uses. **The response is identical whether or not the email or phone already belongs to an account**: same status, same body shape, a challenge identifier either way, no destination and no reason — so registration cannot be used to discover who has an account. No session is created and no cookie is set: the approved decision is that a new account verifies its contact **before** it can sign in. The send limits and resend cooldowns are the ones the OTP lifecycle already enforces per destination and per IP; this operation defines none of its own.',
    request: {
      body: { content: { 'application/json': { schema: RegisterRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description:
          'Accepted. Identical for a new address and one that is already taken — the difference is not observable in the status, the body or the fields.',
        content: { 'application/json': { schema: RegisterResponseSchema } },
      },
      400: validationFailed,
      403: credentialRejected,
      429: throttled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/register/verify',
    operationId: 'postV1AuthRegisterVerify',
    summary: 'Verify a new account’s contact',
    description:
      'Requires the internal BFF credential. Confirms the account’s phone when the code matches, which is what allows it to sign in for the first time. **No session is created and no token is returned**: the person signs in afterwards through the existing login flow with the password they chose. A wrong code, an expired one, a spent one, a challenge issued for another purpose and a challenge that never existed are all refused identically, so nothing can be learned from the difference. A code may be sent again through the start operation, under the same cooldowns.',
    request: {
      body: { content: { 'application/json': { schema: RegisterVerifyRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The contact is confirmed. The account can now sign in.',
        content: { 'application/json': { schema: RegisterVerifyResponseSchema } },
      },
      400: validationFailed,
      401: {
        description:
          'The code was not accepted. One answer for a wrong code, an expired one, a spent one, a challenge of another purpose and one that does not exist.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: credentialRejected,
      429: throttled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/register/resend',
    operationId: 'postV1AuthRegisterResend',
    summary: 'Send a new account\u2019s verification code again',
    description:
      'Requires the internal BFF credential. Sends the verification code again for a registration that is still in progress \u2014 an account whose email and phone are both unconfirmed. **The destination is the account\u2019s own number and there is no field in which to name another**, so this cannot be used to send a message anywhere of the caller\u2019s choosing; an account that has already confirmed a contact cannot be reached through it at all. The challenge identifier comes from the BFF\u2019s own `__Host-mp_register_challenge` cookie, never from the browser. The send limits and resend cooldowns are the ones the OTP lifecycle already enforces per destination and per IP; this operation defines none of its own, so asking too soon is the same 429 a first send earns. A challenge that resolves nothing is refused exactly as a wrong code is.',
    request: {
      body: { content: { 'application/json': { schema: RegisterResendRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'A new code was sent to the number the account already holds.',
        content: { 'application/json': { schema: RegisterResendResponseSchema } },
      },
      400: validationFailed,
      401: {
        description:
          'The challenge resolved nothing. One answer for an unknown challenge, one of another purpose, one already spent and an account that has already confirmed a contact.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: credentialRejected,
      429: throttled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/recovery/start',
    operationId: 'postV1AuthRecoveryStart',
    summary: 'Start a password reset',
    description:
      'Requires the internal BFF credential. Sends a one-time code to the account\u2019s verified contact when there is one. The response is identical whether or not the account exists: same status, same body shape, no destination and no reason.',
    request: {
      body: { content: { 'application/json': { schema: RecoveryStartRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Accepted. Identical for a known and an unknown identifier.',
        content: { 'application/json': { schema: RecoveryStartResponseSchema } },
      },
      400: validationFailed,
      403: credentialRejected,
      429: throttled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/recovery/verify',
    operationId: 'postV1AuthRecoveryVerify',
    summary: 'Verify the recovery code',
    description:
      'Requires the internal BFF credential. On success a single-use reset token is issued and returned to the BFF only, which stores it in the __Host-mp_reset cookie; no session is created and the browser-visible body carries no token.',
    request: {
      body: { content: { 'application/json': { schema: RecoveryVerifyRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The code was correct. The reset token travels to the BFF, never to the browser.',
        content: { 'application/json': { schema: RecoveryVerifyResponseSchema } },
      },
      400: validationFailed,
      401: {
        description:
          'Verification failed. Deliberately identical for a wrong code, an unknown challenge, an expired challenge and one whose attempts are exhausted.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: credentialRejected,
      429: throttled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/recovery/reset',
    operationId: 'postV1AuthRecoveryReset',
    summary: 'Complete a password reset',
    description:
      'Requires the internal BFF credential and the reset token, which the BFF reads from the __Host-mp_reset cookie and presents in the x-reset-token header. The browser body carries only the new password. No session is created.',
    request: {
      headers: z.object({
        [RESET_TOKEN_HEADER]: z.string().openapi({ description: 'The reset token, supplied by the BFF from its cookie.' }),
      }),
      body: { content: { 'application/json': { schema: RecoveryResetRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The password was changed and every existing session was revoked.',
        content: { 'application/json': { schema: RecoveryResetResponseSchema } },
      },
      400: validationFailed,
      401: {
        description:
          'The reset token is missing, invalid, expired, already used or bound to another account. Deliberately identical in every case.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: credentialRejected,
      429: throttled,
      503: unavailable,
      500: internalError,
    },
  });

  const sessionHeader = {
    headers: z.object({
      [SESSION_TOKEN_HEADER]: z
        .string()
        .openapi({ description: 'The caller\u2019s access token, supplied by the BFF from its session cookie.' }),
    }),
  } as const;
  const authenticationRequired = {
    description: 'No usable session was presented, so nothing was attempted',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/refresh',
    operationId: 'postV1AuthRefresh',
    summary: 'Renew the session',
    description:
      'Requires the internal BFF credential and the caller’s refresh token, which the BFF reads from the __Host-mp_refresh cookie and presents in the x-refresh-token header. A new access and refresh token are returned to the BFF only, which replaces both cookies; the browser-visible body carries no token. Login is unaffected: this renews a session, it never creates one.',
    request: {
      headers: z.object({
        [REFRESH_TOKEN_HEADER]: z
          .string()
          .openapi({ description: 'The caller’s refresh token, supplied by the BFF from its cookie.' }),
      }),
    },
    responses: {
      200: {
        description: 'The session was renewed. Both tokens travel to the BFF, never to the browser.',
        content: { 'application/json': { schema: SessionRefreshResponseSchema } },
      },
      401: {
        description:
          'The refresh token is missing, invalid, expired or already spent. Deliberately identical in every case.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: credentialRejected,
      503: {
        description: 'The authentication provider could not be reached',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/logout',
    operationId: 'postV1AuthLogout',
    summary: 'End the caller’s own session',
    description:
      'Requires the internal BFF credential and the caller’s session. Ends that one session and no other: the account’s other sessions are untouched, and no administrative revocation is performed. Idempotent — a token the provider no longer recognises is a successful logout, not a failure.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The session is ended. The BFF clears both cookies.',
        content: { 'application/json': { schema: LogoutResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: {
        description: 'The authentication provider could not be reached',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/users/me',
    operationId: 'getV1UsersMe',
    summary: 'The caller’s own identity',
    description:
      'Requires the internal BFF credential and the caller’s session. Returns the account id and display name and nothing else: no email, no phone, no role, no verification state. The account is the caller’s own — no identifier is accepted from the request.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The caller’s identity.',
        content: { 'application/json': { schema: CurrentUserResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  const messagingCursorRefused = {
    description:
      'The cursor is malformed, altered or from a version this API no longer reads. One answer for all three: the remedy is to start again without it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me',
    operationId: 'getV1SellersMe',
    summary: 'The caller\u2019s own seller identity',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. The state of the caller\u2019s own storefront: slug, display name, status, verification status, city and country. It takes no parameter \u2014 the account comes from the session, and no seller is resolved from a slug \u2014 and it carries no identifier, contact detail, suspension reason, object path or timestamp. Unlike the public profile it does report `pending`, `suspended` and `closed`, because this is the owner asking about their own account. An account that is not a seller answers 404, identically to any other not-found.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The caller\u2019s own seller identity.',
        content: { 'application/json': { schema: SellerIdentityResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: {
        description: 'The caller has no seller profile.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  // Phase 6-C. Its own throttle description rather than the OTP one above: the number and the surface are
  // different, and a shared sentence would have to describe both.
  const sellerOnboardingThrottled = {
    description: 'The approved seller onboarding limit rejected the request',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  // Phase 6-D, for the same reason: a different surface with a different number.
  const sellerProfileUpdateThrottled = {
    description: 'The approved seller profile update limit rejected the request',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  // Phase 6-E.
  const sellerMediaThrottled = {
    description: 'The approved seller media upload limit rejected the request',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const sellerMediaNotEditable = {
    description:
      'The storefront is suspended or closed, so it receives no media authorization. One code for both, and it names no reason.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const sellerProfileMissing = {
    description: 'The caller has no seller profile.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me',
    operationId: 'postV1SellersMe',
    summary: 'Create the caller’s own seller profile',
    description:
      'Requires the internal BFF credential and the caller’s session. Creates one seller profile for the authenticated account, always `pending` and `unverified`. The body carries only the onboarding fields — there is no `userId`, `status` or `verificationStatus` to send, and the schema is strict, so any of them is a validation failure rather than a value that is quietly ignored. The slug becomes the storefront’s permanent public address and cannot be changed afterwards. Assigns no role, creates no verification record and activates nothing. An account that already has a storefront answers 409 `SELLER_PROFILE_EXISTS`; a slug somebody else holds answers 409 `SELLER_SLUG_TAKEN`, which says only that the address is unavailable. The response is the same six-field projection `GET /v1/sellers/me` returns, read back from the row that committed.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: SellerOnboardingRequestSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The storefront as stored: pending, unverified, and nothing private.',
        content: { 'application/json': { schema: SellerOnboardingResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: {
        description:
          'The caller already has a storefront, or the chosen public address is taken. One code each, and neither names an account.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerOnboardingThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/sellers/me',
    operationId: 'patchV1SellersMe',
    summary: 'Edit the caller\u2019s own seller profile',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Updates the authenticated account\u2019s own storefront. Nine fields may be edited: display name, legal name, bio, content language, country, governorate, city, contact e-mail and contact phone. A field that is absent keeps its value; a field sent as `null` is cleared, for the seven the schema allows to be empty \u2014 display name and country can be changed but never emptied. The slug, the status, the verification status, the suspension and closure fields and every timestamp are absent from the schema entirely, so none of them can be sent, and the body is strict, so any of them is a validation failure rather than a value that is quietly ignored. Editing is allowed while the storefront is `pending` or `active`; a `suspended` or `closed` one answers 409 `SELLER_PROFILE_NOT_EDITABLE`, which says that and nothing about why. The response is the same six-field projection `GET /v1/sellers/me` returns, read back from the row that committed.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: SellerProfileUpdateRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The storefront as stored after the edit.',
        content: { 'application/json': { schema: SellerProfileUpdateResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: {
        description: 'The caller has no seller profile.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      409: {
        description:
          'The storefront is suspended or closed, so it cannot be edited. One code for both, and it names no reason.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerProfileUpdateThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/media/uploads',
    operationId: 'postV1SellersMeMediaUploads',
    summary: 'Authorize one seller media upload',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Authorizes one upload of the caller\u2019s own storefront logo or banner and returns a short-lived, single-object upload URL to PUT the bytes to. The request describes the file \u2014 kind, content type, size \u2014 and never its destination: there is no `objectPath`, `bucket`, `slug` or `fileName` to send, and the body is strict, so any of them is a validation failure. The path is derived in the database from the caller\u2019s own storefront slug plus a fresh random name, so no request can choose a path, traverse out of its namespace, overwrite an earlier upload or reach another seller. The type and size limits are the bucket\u2019s own. The response carries no storage credential and no project key. A `suspended` or `closed` storefront receives no authorization and answers 409. Nothing is written to the profile by this operation.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: SellerMediaUploadRequestSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The authorized upload target.',
        content: { 'application/json': { schema: SellerMediaUploadResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerProfileMissing,
      409: sellerMediaNotEditable,
      429: sellerMediaThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/media',
    operationId: 'postV1SellersMeMedia',
    summary: 'Confirm a seller media upload',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. The confirmation step of the approved upload flow: records an object that was uploaded to an authorized path against the caller\u2019s own storefront, setting only its logo or banner path. The path must lie in the caller\u2019s own namespace and match the exact shape the authorization issues, so another seller\u2019s object, a nested path and any traversal are all refused; and the object must actually exist in storage, so a confirmation cannot record a file that was never uploaded. Answers with whether each kind is now set \u2014 not with the paths. A `suspended` or `closed` storefront answers 409, and an object that is not there answers 404 `SELLER_MEDIA_OBJECT_MISSING`.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: SellerMediaAttachRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Which media the storefront now has.',
        content: { 'application/json': { schema: SellerMediaAttachResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: {
        description:
          'The caller has no seller profile, or the object is not in storage. Distinct codes: NOT_FOUND and SELLER_MEDIA_OBJECT_MISSING.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      409: sellerMediaNotEditable,
      429: sellerMediaThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  // Phase 6-F. Two buckets, because S-8's two write kinds have two approved numbers, and a shared sentence
  // would have to describe both.
  const sellerListingDraftThrottled = {
    description: 'The approved seller listing draft limit rejected the request',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const sellerListingSubmissionThrottled = {
    description: 'The approved seller listing submission limit rejected the request',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const sellerListingMissing = {
    description:
      'The caller has no storefront, or no listing of theirs lives at that address. One answer for both, so asking cannot reveal that a listing exists.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const sellerListingSlugParam = {
    params: z.object({
      slug: ListingSlugSchema.openapi({ description: 'The listing, by its own public address.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me/listings',
    operationId: 'getV1SellersMeListings',
    summary: 'The caller’s own listings',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the listings belonging to the caller’s own storefront, newest first. It takes no seller parameter — the storefront comes from the session — and it returns no identifier of any kind: a listing is named by its slug and its category by the category’s slug. No `approvedAt`, no `publishedAt`, no `deletedAt`, no view count, no moderation record, no rejection reason and no status history. Media are reported as a count, not as paths. A deleted listing is not listed at all. An account with no storefront answers 404, identically to any other not-found.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({
            description: `How many listings to return. Defaults to ${SELLER_LISTINGS_DEFAULT_LIMIT}; a larger value is clamped to ${SELLER_LISTINGS_MAX_LIMIT}.`,
          }),
        cursor: z
          .string()
          .optional()
          .openapi({
            description:
              'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
          }),
      }),
    },
    responses: {
      200: {
        description: 'One page of the caller’s own listings, newest first.',
        content: { 'application/json': { schema: SellerListingsResponseSchema } },
      },
      400: {
        description:
          'The cursor is malformed, altered or from a version this API no longer reads. One answer for all three: the remedy is to start again without it.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerProfileMissing,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/listings',
    operationId: 'postV1SellersMeListings',
    summary: 'Create a listing draft',
    description:
      'Requires the internal BFF credential and the caller’s session. Creates one listing owned by the caller’s own storefront, always in `draft`. There is no `status` field to send — a draft is the only thing this operation can create, decided in the database by a literal — and no `sellerUserId`, `listingId` or timestamp either; the body is strict, so each of those is a validation failure rather than a value that is quietly ignored. The required fields are the listing table’s own not-null columns, which is why a draft needs **no media and no price**. The category is named by its slug and must be active and compatible with the listing type. A `suspended` or `closed` storefront receives no authorization and answers 409. An address already in use, now or historically, answers 409 `SELLER_LISTING_SLUG_TAKEN`, which says only that it is unavailable. The response is the address and the committed status.',
    request: {
      ...sessionHeader,
      body: {
        content: { 'application/json': { schema: SellerListingCreateRequestSchema } },
        required: true,
      },
    },
    responses: {
      201: {
        description: 'The draft as stored: its address and the status the database wrote.',
        content: { 'application/json': { schema: SellerListingMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerProfileMissing,
      409: {
        description:
          'The storefront is suspended or closed, or the chosen address is unavailable. One code each, and neither names a reason or an account.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerListingDraftThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/sellers/me/listings/{slug}',
    operationId: 'patchV1SellersMeListing',
    summary: 'Edit one of the caller’s own drafts',
    description:
      'Requires the internal BFF credential and the caller’s session. Edits one of the caller’s own listings while it is a `draft`. Nine fields may be edited: title, description, price, negotiability, content language, currency, country, governorate and city. A field that is absent keeps its value; a field sent as `null` is cleared, for the three the schema allows to be empty. The slug, the listing type, the category, the owner, the status and every timestamp are absent from the schema entirely, so none of them can be sent. A listing that is not a draft — including one already submitted — answers 409 `SELLER_LISTING_NOT_EDITABLE`; one that is not the caller’s answers 404, identically to one that does not exist. The response is the address and the committed status.',
    request: {
      ...sessionHeader,
      ...sellerListingSlugParam,
      body: {
        content: { 'application/json': { schema: SellerListingUpdateRequestSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'The draft as stored after the edit.',
        content: { 'application/json': { schema: SellerListingMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerListingMissing,
      409: {
        description:
          'The storefront cannot be used, or the listing is not a draft. One code for each, and neither names a moderation reason.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerListingDraftThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/listings/{slug}/submission',
    operationId: 'postV1SellersMeListingSubmission',
    summary: 'Submit one of the caller’s own drafts for review',
    description:
      'Requires the internal BFF credential and the caller’s session. Moves one of the caller’s own drafts to `pending_review` and records its submission time. Its own operation rather than a field on the edit, and it takes no body at all: a status the caller could send would be a status the caller could choose. Approves nothing, publishes nothing and touches no moderation state. It requires what approval will require — a product needs a price, a fixed-price service needs a price, a custom-priced service does not — and a listing that cannot yet meet that answers 409 `SELLER_LISTING_INCOMPLETE`. After it succeeds the listing is no longer editable as a draft, so a second submission and a later edit both answer 409 `SELLER_LISTING_NOT_EDITABLE`.',
    request: { ...sessionHeader, ...sellerListingSlugParam },
    responses: {
      200: {
        description: 'The listing as stored: submitted, and awaiting review by somebody else.',
        content: { 'application/json': { schema: SellerListingMutationResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerListingMissing,
      409: {
        description:
          'The storefront cannot be used, the listing is not a draft, or it is not yet complete enough to be reviewed. Distinct codes, and none of them names a moderation reason.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerListingSubmissionThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/listings/{slug}/archive',
    operationId: 'postV1SellersMeListingArchive',
    summary: 'Archive one of the caller’s own live listings',
    description:
      'Requires the internal BFF credential and the caller’s session. Withdraws one of the caller’s own live listings from sale, recording its archival time. It takes no body. **It deletes nothing**: there is no seller-side deletion anywhere in this API, and the listing’s public page remains reachable and reports that it is no longer available, which is the listing schema’s own behaviour for an archived listing. Only a live listing can be archived by this operation; a draft, a submission, a sold, expired, rejected, suspended or already archived listing answers 409 `SELLER_LISTING_NOT_EDITABLE`, and a seller cannot archive their way out of a moderation state. The response is the address and the committed status.',
    request: { ...sessionHeader, ...sellerListingSlugParam },
    responses: {
      200: {
        description: 'The listing as stored: archived, and no longer for sale.',
        content: { 'application/json': { schema: SellerListingMutationResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerListingMissing,
      409: {
        description:
          'The storefront cannot be used, or the listing is not live. One code for both, and it names no moderation reason.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerListingDraftThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  // Phase 6-G. A service is a listing, so its writes count against 6-F's approved listing buckets rather
  // than against numbers of their own: there is no new rate-limit policy in this increment.
  const sellerServiceMissing = {
    description:
      'The caller has no storefront, or no service of theirs lives at that address. One answer for both — and for a listing of theirs that is a product, since this surface addresses services — so asking cannot reveal that a listing exists.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const sellerServiceSlugParam = {
    params: z.object({
      slug: ListingSlugSchema.openapi({ description: 'The service, by its own public address.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me/services',
    operationId: 'getV1SellersMeServices',
    summary: 'The caller’s own services',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the service listings belonging to the caller’s own storefront, newest first, each with the five `listing_service_details` fields. It takes no seller parameter — the storefront comes from the session — and returns no identifier of any kind: a service is named by its slug and its category by the category’s slug. The five detail fields are nullable because the detail row is separate and optional: a service that has none has stated nothing about how the work is priced, which is not the same as having stated zero revisions. The currency’s own minor unit travels with the price so a client need not assume a divisor. No `approvedAt`, no `publishedAt`, no `deletedAt`, no view count, no moderation record and no rejection reason; media are a count, not paths; the caller’s products are not listed here, and a deleted service is not listed at all.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({
            description: `How many services to return. Defaults to ${SELLER_SERVICES_DEFAULT_LIMIT}; a larger value is clamped to ${SELLER_SERVICES_MAX_LIMIT}.`,
          }),
        cursor: z
          .string()
          .optional()
          .openapi({
            description:
              'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
          }),
      }),
    },
    responses: {
      200: {
        description: 'One page of the caller’s own services, newest first.',
        content: { 'application/json': { schema: SellerServicesResponseSchema } },
      },
      400: {
        description:
          'The cursor is malformed, altered or from a version this API no longer reads. One answer for all three: the remedy is to start again without it.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerProfileMissing,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/services',
    operationId: 'postV1SellersMeServices',
    summary: 'Create a service draft',
    description:
      'Requires the internal BFF credential and the caller’s session. Creates one service listing owned by the caller’s own storefront, always in `draft`, and its detail row when a pricing model is stated. There is no `listingTypeCode` field: this operation creates a service and nothing else. There is no `status` either, nor a `sellerUserId`, `listingId` or timestamp, and the body is strict, so each of those is a validation failure rather than a value quietly ignored. A draft needs no media, no price and no detail row. `pricingModel` decides whether a detail row exists at all; stating one of the other four detail fields without it is refused, because a revision count that belongs to no pricing model is not a fact about a service. A `fixed` model requires a delivery time, which is the detail table’s own rule. Every other refusal is the one the equivalent listing operation gives, because the listing half is that operation: a suspended or closed storefront answers 409, and an address already in use answers 409 `SELLER_LISTING_SLUG_TAKEN`.',
    request: {
      ...sessionHeader,
      body: {
        content: { 'application/json': { schema: SellerServiceCreateRequestSchema } },
        required: true,
      },
    },
    responses: {
      201: {
        description: 'The service draft as stored: its address and the status the database wrote.',
        content: { 'application/json': { schema: SellerListingMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerProfileMissing,
      409: {
        description:
          'The storefront is suspended or closed, or the chosen address is unavailable. One code each, and neither names a reason or an account.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerListingDraftThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/sellers/me/services/{slug}',
    operationId: 'patchV1SellersMeService',
    summary: 'Edit one of the caller’s own service drafts',
    description:
      'Requires the internal BFF credential and the caller’s session. Edits one of the caller’s own services while it is a `draft`: the nine listing fields the equivalent listing operation edits, plus the five service detail fields. A field that is absent keeps its value; `null` clears the ones their tables allow to be empty. `pricingModel: null` withdraws the detail row entirely, because the other four hang off it, and a request that withdraws it while also stating one of them is refused rather than resolved. `revisionsIncluded` and `requiresBrief` are declared `not null` with defaults, so they can be changed but never emptied. The slug, the listing type, the category, the owner, the status and every timestamp are absent from the schema, so none can be sent. A service that is not a draft answers 409 `SELLER_LISTING_NOT_EDITABLE`; one that is not the caller’s, and one of theirs that is a product, both answer 404 identically to one that does not exist.',
    request: {
      ...sessionHeader,
      ...sellerServiceSlugParam,
      body: {
        content: { 'application/json': { schema: SellerServiceUpdateRequestSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'The service draft as stored after the edit.',
        content: { 'application/json': { schema: SellerListingMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerServiceMissing,
      409: {
        description:
          'The storefront cannot be used, or the service is not a draft. One code for each, and neither names a moderation reason.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerListingDraftThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  // Phase 6-I. Submission only. No operation below reaches a decision, and none carries a status, a
  // reviewer, a review time, a decision reason or a document review note in either direction.
  //
  // Two approved buckets, and no new number: the approved `seller_verification_submission` limit of 5 per
  // account per 24 hours counts the two operations that change the attempt's own state — starting one and
  // submitting it — while the approved `seller_media_upload` limit of 20 per account per hour counts the
  // three document operations, which are uploads and their undo. Reading is not counted.
  const sellerVerificationSubmissionThrottled = {
    description: 'The approved seller verification submission limit rejected the request',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  // Two 409s with two different subjects, kept apart because they are different facts. The attempt's own
  // state is `SELLER_VERIFICATION_NOT_EDITABLE`; the storefront being unusable is the same
  // `SELLER_PROFILE_NOT_EDITABLE` every other seller write gives, because it is the same condition. Neither
  // names a reviewer, a decision or a reason.
  const sellerVerificationNotEditable = {
    description:
      'The storefront is suspended or closed, or the attempt is no longer the seller’s to change: `SELLER_PROFILE_NOT_EDITABLE` for the first and `SELLER_VERIFICATION_NOT_EDITABLE` for the second. Neither names a reviewer, a decision or a reason.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const sellerVerificationStorefrontNotEditable = {
    description:
      'The storefront is suspended or closed, so it receives no verification authorization: `SELLER_PROFILE_NOT_EDITABLE`, exactly as every other seller write answers it, and it names no reason.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const sellerVerificationMissing = {
    description:
      'The caller has no storefront, or no verification attempt of theirs is open. One answer for both, so asking cannot reveal the state of an account that is not the caller’s.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me/verification',
    operationId: 'getV1SellersMeVerification',
    summary: 'The caller’s own verification attempt',
    description:
      'Requires the internal BFF credential and the caller’s session. The caller’s current verification attempt — the open one when there is one, otherwise the most recently decided one — with its documents, or `null` when they have never applied. It takes no seller parameter: the storefront comes from the session. What it deliberately does not return: the verification’s own id, the seller’s id, the reviewer, the review time, the decision reason, the expiry, and each document’s `objectPath`, which is a capability in a private bucket and is disclosed only by the upload authorization. The two contact facts come back as booleans rather than timestamps, because a client needs to know whether the condition approval will require is met and nothing more. A document’s own review status is returned — that is a fact about the caller’s own document — but its review note is not, and there is no field for one.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description:
          'The caller’s attempt and its documents, or `null` when there is none. `null` is the ordinary starting state, not an error.',
        content: { 'application/json': { schema: SellerVerificationResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerProfileMissing,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/verification',
    operationId: 'postV1SellersMeVerification',
    summary: 'Start a verification attempt',
    description:
      'Requires the internal BFF credential and the caller’s session. Opens one verification attempt for the caller’s own storefront, always as a `draft`. It takes no body at all: there is no `status` to send, because a status the caller could send would be a status the caller could choose, and no `sellerUserId`, because the storefront comes from the session. It records no reviewer, no review time and no decision reason, and it applies no verification decision — the existing review mechanism remains the sole authority for that. A storefront that already has an open attempt answers 409 `SELLER_VERIFICATION_EXISTS` and nothing is created; the attempt it already has is readable from the same address. A storefront that is already verified answers 409 `SELLER_VERIFICATION_ALREADY_VERIFIED`, again creating nothing, and this API offers no way to verify again. A suspended or closed storefront answers 409 `SELLER_VERIFICATION_NOT_EDITABLE`.',
    request: { ...sessionHeader },
    responses: {
      201: {
        description: 'The attempt as stored: a draft, with no document yet and no decision.',
        content: { 'application/json': { schema: SellerVerificationStateResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerProfileMissing,
      409: {
        description:
          'An attempt is already open, the storefront is already verified, or the storefront cannot be used. Distinct codes, and none of them names a reviewer or a reason.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerVerificationSubmissionThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/verification/documents/uploads',
    operationId: 'postV1SellersMeVerificationDocumentUploads',
    summary: 'Authorize one verification document upload',
    description:
      `Requires the internal BFF credential and the caller’s session. Authorizes one upload into the private \`verification-documents\` bucket and answers with a short-lived URL and the path the server chose. **The client chooses no part of the path**: the bucket, the storefront’s own namespace, the document type and a fresh uuid are all the server’s, so another seller’s namespace, a nested path and any traversal are unrepresentable rather than merely refused. The path contains no identifier of any kind — not the account’s, not the attempt’s. The type and size limits are the bucket row’s own, read at the time of the call and restated in the response as \`maxByteSize\`; the enum and the ${SELLER_VERIFICATION_DOCUMENT_MAX_BYTES}-byte ceiling in the request schema exist only so a browser is refused before a round trip. This authorizes an upload and records nothing: the document exists once it is confirmed. A storefront with no open attempt answers 404, one whose attempt has reached the reviewer answers 404 as well because there is nothing open to add to, and a suspended or closed storefront answers 409.`,
    request: {
      ...sessionHeader,
      body: {
        content: { 'application/json': { schema: SellerVerificationUploadRequestSchema } },
        required: true,
      },
    },
    responses: {
      201: {
        description:
          'One authorized upload: where the bytes go, the path that was authorized, when it expires and the bucket’s own ceiling.',
        content: { 'application/json': { schema: SellerVerificationUploadResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerVerificationMissing,
      409: sellerVerificationStorefrontNotEditable,
      429: sellerMediaThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/verification/documents',
    operationId: 'postV1SellersMeVerificationDocuments',
    summary: 'Record an uploaded verification document',
    description:
      'Requires the internal BFF credential and the caller’s session. Records one document against the caller’s own open attempt, after the bytes have been uploaded to the path the previous operation authorized. The object must exist in storage, and the path must match the exact shape that operation issues, rebuilt from the caller’s own storefront and the document type they state: anything else — another seller’s namespace, another bucket, a nested path, a traversal, a name that is not a uuid, an extension the server never issues — is a validation failure, not a stored row. There is no `status` field: `pending` is the column’s default and the only value a submission can produce, and `reviewNote`, `reviewedAt` and `reviewedBy` appear in no column list, so a seller cannot write a reviewer’s field even by accident. Several documents are allowed, including several of one type, because the schema permits it and the reviewer decides what is enough. The response is the attempt’s document count — never a path. A document may be recorded while the attempt is `draft` or `submitted`, which is the verification schema’s own rule; an object already recorded answers 409 `SELLER_VERIFICATION_DOCUMENT_PATH_TAKEN`, and an object that is not in storage answers 404 `SELLER_MEDIA_OBJECT_MISSING`, which is 6-E’s own answer for confirming a file nobody uploaded.',
    request: {
      ...sessionHeader,
      body: {
        content: { 'application/json': { schema: SellerVerificationDocumentRequestSchema } },
        required: true,
      },
    },
    responses: {
      201: {
        description: 'How many documents the attempt now has.',
        content: {
          'application/json': { schema: SellerVerificationDocumentCountResponseSchema },
        },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: {
        description:
          'The caller has no storefront, no attempt of theirs is open, or the object is not in storage: `NOT_FOUND` for the first two — one answer for both — and `SELLER_MEDIA_OBJECT_MISSING` for the third, whose remedy is to upload the file and confirm again.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      409: {
        description:
          'The storefront cannot be used, or that object has already been recorded. Distinct codes, and neither names a reviewer or a reason.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: sellerMediaThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/sellers/me/verification/documents/{documentId}',
    operationId: 'deleteV1SellersMeVerificationDocument',
    summary: 'Remove one of the caller’s own verification documents',
    description:
      'Requires the internal BFF credential and the caller’s session. Removes one document the caller uploaded, but **only while their attempt is `draft` or `submitted`** (owner decision 3). Once the attempt is `under_review`, `approved`, `rejected` or `expired`, the evidence it was judged on stays put: the document is then indistinguishable from one that does not exist, and the restriction lives in the SECURITY DEFINER writer rather than in a browser-reachable policy, so it holds however the request arrives. A document that is not the caller’s answers 404 identically to one that does not exist, so asking cannot reveal that somebody else’s document is there. This is the only DELETE in the seller API: it removes a document, never an attempt — a seller withdraws no application and deletes no verification record, and the underlying table grants no such right.',
    request: {
      ...sessionHeader,
      params: z.object({
        documentId: z
          .string()
          .uuid()
          .openapi({ description: 'One of the caller’s own documents, by its own id.' }),
      }),
    },
    responses: {
      200: {
        description: 'How many documents the attempt has left.',
        content: {
          'application/json': { schema: SellerVerificationDocumentCountResponseSchema },
        },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: {
        description:
          'The caller has no storefront, or no removable document of theirs has that id — including one of their own on an attempt that has reached the reviewer. One answer for all of them.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      409: sellerVerificationStorefrontNotEditable,
      429: sellerMediaThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/sellers/me/verification/submission',
    operationId: 'postV1SellersMeVerificationSubmission',
    summary: 'Submit the caller’s own verification attempt for review',
    description:
      'Requires the internal BFF credential and the caller’s session. Moves the caller’s own `draft` attempt to `submitted` and records its submission time. Its own operation rather than a field on anything else, and it takes no body: a status the caller could send would be a status the caller could choose. **It requires no document and no particular document type** (owner decision 1): the verification schema imposes no minimum, and whether the evidence is sufficient is the reviewer’s judgement, not this API’s. It assigns no reviewer, no review time and no decision reason, so `approved` and `rejected` are not merely refused but structurally unreachable from here — the existing review mechanism remains the sole authority for a verification decision. The account’s email and phone confirmation times are read from the authentication records rather than from the request, because approval will require them of a reviewer later; an account with neither still submits successfully. Submitting reflects the storefront’s verification state as pending through the schema’s own trigger; it verifies nothing and activates nothing. A second submission, and an attempt already with the reviewer, both answer 409 `SELLER_VERIFICATION_NOT_EDITABLE`.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The attempt as stored: submitted, and awaiting review by somebody else.',
        content: { 'application/json': { schema: SellerVerificationStateResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerVerificationMissing,
      409: sellerVerificationNotEditable,
      429: sellerVerificationSubmissionThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  // Phase 6-J. Five reads and no writes: there is no request body on any of them, no status a caller could
  // send, and no rate limit — a read does not consume a seller write bucket, and none of the approved
  // Phase 6 numbers counts one.
  //
  // Each is scoped to the caller’s own storefront by the database, mirroring the RLS policy that already
  // says what an authenticated seller may read. A caller with no storefront gets the same 404 every other
  // seller surface gives; a storefront with nothing to show gets an empty list, which is a different answer.
  const sellerReadMissing = {
    description:
      'The caller has no storefront. Distinct from an empty list, which is what a storefront with nothing yet receives.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const sellerReadCursorInvalid = {
    description:
      'The cursor is malformed, altered or from a version this API no longer reads. One answer for all three: the remedy is to start again without it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me/orders',
    operationId: 'getV1SellersMeOrders',
    summary: 'The caller’s own orders',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the orders placed with the caller’s own storefront, newest first, each with the items as they were at purchase. It takes no seller parameter — the storefront comes from the session — and returns no identifier of any kind: an order is named by its own `orderNumber`, and each item by the title and slug the order snapshotted, so nothing depends on a listing that has since been edited. **Nothing about the buyer is returned**: no id, no name, no address. No commission snapshot, no cancellation-policy snapshot and no checkout reference. Amounts are minor units as decimal strings beside the currency and its own decimal places; `commissionTotalMinor` is the platform fee on the caller’s own order and `sellerNetMinor` what remains. **Strictly read-only**: this operation creates, pays for, ships, cancels and refunds nothing, and there is no operation anywhere in this API that lets a seller change an order’s status.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({
            description: `How many rows to return. Defaults to ${SELLER_READ_DEFAULT_LIMIT}; a larger value is clamped to ${SELLER_READ_MAX_LIMIT}.`,
          }),
        cursor: z
          .string()
          .optional()
          .openapi({
            description:
              'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
          }),
      }),
    },
    responses: {
      200: {
        description:
          'One page of the caller’s own orders, newest first. An empty list means this storefront has had no orders.',
        content: { 'application/json': { schema: SellerOrdersResponseSchema } },
      },
      400: sellerReadCursorInvalid,
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerReadMissing,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me/reviews',
    operationId: 'getV1SellersMeReviews',
    summary: 'The reviews on the caller’s own storefront',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the reviews left on the caller’s own storefront, newest first, each with the caller’s own reply when they have written one — and the rating summary alongside, so a page needs one request rather than two. A seller reads their own reviews in **every** state, which is the reviews table’s own rule for the owner, but never *why* a state was reached: there is no moderation reason, moderator, moderation time or auto-hidden reason in this response, and no field for one. Nothing identifies whoever wrote a review. A review is named by its order’s `orderNumber`, which identifies it because reviews are unique per order. The summary is the `seller_ratings` aggregate exactly as that view defines it, average included — in basis points, because that is the unit the view produces — and it counts published reviews only, so it is `null` rather than a row of zeros when none is published. **Strictly read-only**: this operation publishes, hides, removes, replies to and moderates nothing.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({
            description: `How many rows to return. Defaults to ${SELLER_READ_DEFAULT_LIMIT}; a larger value is clamped to ${SELLER_READ_MAX_LIMIT}.`,
          }),
        cursor: z
          .string()
          .optional()
          .openapi({
            description:
              'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
          }),
      }),
    },
    responses: {
      200: {
        description:
          'One page of reviews, newest first, with the rating summary. An empty list means nobody has reviewed this storefront.',
        content: { 'application/json': { schema: SellerReviewsResponseSchema } },
      },
      400: sellerReadCursorInvalid,
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerReadMissing,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me/earnings',
    operationId: 'getV1SellersMeEarnings',
    summary: 'The caller’s own balances',
    description:
      'Requires the internal BFF credential and the caller’s session. The caller’s own balance in each currency they have earned in: the pending, available and reserved minor amounts, as decimal strings, beside each currency and its own decimal places. There is no pagination, because the balances table holds one row per currency. **No total is computed**: what a seller is owed is a business statement no formula in this repository establishes, so the three the ledger keeps are shown as three. **Nothing from the ledger, a payout or a withdrawal is returned** — no journal, no entry, no ledger account, no provider reference, no payout destination and no bank detail — and there is no withdrawal, payout or transfer operation anywhere in this API: a balance here is a fact to read, not a button. An empty list means this storefront has earned nothing yet.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description:
          'One balance per currency. An empty list means nothing has been earned yet, which is not an error.',
        content: { 'application/json': { schema: SellerEarningsResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerReadMissing,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me/promotions',
    operationId: 'getV1SellersMePromotions',
    summary: 'The caller’s own promotions',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the caller’s own promotions, newest first, each named by the slug and title of the listing it promotes. Returns no promotion id, no package id, no package snapshot, no idempotency key, no payment method and no cancellation reason. Amounts are minor units as decimal strings beside the currency and its own decimal places. **Strictly read-only**: this operation creates, schedules, pays for, pauses, cancels and refunds nothing, and there is no promotion write operation anywhere in this API.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({
            description: `How many rows to return. Defaults to ${SELLER_READ_DEFAULT_LIMIT}; a larger value is clamped to ${SELLER_READ_MAX_LIMIT}.`,
          }),
        cursor: z
          .string()
          .optional()
          .openapi({
            description:
              'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
          }),
      }),
    },
    responses: {
      200: {
        description:
          'One page of the caller’s own promotions, newest first. An empty list means they have promoted nothing.',
        content: { 'application/json': { schema: SellerPromotionsResponseSchema } },
      },
      400: sellerReadCursorInvalid,
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerReadMissing,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me/analytics',
    operationId: 'getV1SellersMeAnalytics',
    summary: 'The caller’s own promotion performance',
    description:
      'Requires the internal BFF credential and the caller’s session. The impressions, views and clicks the `promotion_analytics` rollup has already computed for the caller’s own promotions, summed over a recent window and grouped per promotion. **Every number here is the rollup’s**, produced by a scheduled job: this operation defines no metric, computes no rate, ratio or click-through, and reads no raw events. A seller’s listing-level analytics is a **separate operation**, `GET /v1/sellers/me/listing-analytics`, added by 0102 over its own rollup; this one’s shape is unchanged by it. That operation reports **no listing-level views or impressions**, for the reason this one was first written with: counting raw listing events into "views per listing" would mean inventing what a view is and how to de-duplicate a session, and 0101 deliberately ingests neither. The impressions and views here are the promotion stream’s own, which 0025 has always collected. The totals are `bigint` sums and travel as decimal strings. An empty list means the caller has run no promotion that the rollup has covered.',
    request: {
      ...sessionHeader,
      query: z.object({
        days: z
          .string()
          .optional()
          .openapi({
            description: `How many days back to sum. Defaults to ${SELLER_ANALYTICS_DEFAULT_DAYS}; a larger value is clamped to ${SELLER_ANALYTICS_MAX_DAYS}. It selects rows and decides nothing about them.`,
          }),
      }),
    },
    responses: {
      200: {
        description:
          'The rollup’s totals per promotion over the resolved window. An empty list means no promotion of the caller’s has been rolled up.',
        content: { 'application/json': { schema: SellerAnalyticsResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerReadMissing,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/sellers/me/listing-analytics',
    operationId: 'getV1SellersMeListingAnalytics',
    summary: 'The caller\u2019s own listing performance',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. The clicks, contacts, favourites and shares the `listing_analytics` rollup has already computed for the caller\u2019s own listings, summed over a recent window and grouped per listing. **Every number here is the rollup\u2019s**, produced by a scheduled job: this operation defines no metric, computes no rate, ratio or click-through, and reads no raw event. There are no impressions and no views, because 0101 ingests neither and their definitions are a later decision; there is no unique-visitor or unique-session count, because an absent session digest is stored as a zero-length value and a distinct count would report all anonymous traffic as one visitor. `favourites` and `shares` read zero until a control on some surface fires them. The totals are `bigint` counts and travel as decimal integer strings \u2014 counts, not money, and carrying no currency. An empty list means no listing of the caller\u2019s has been rolled up yet.',
    request: {
      ...sessionHeader,
      query: z.object({
        days: z
          .string()
          .optional()
          .openapi({
            description: `How many days back to sum. Defaults to ${LISTING_ANALYTICS_DEFAULT_DAYS}; a larger value is clamped to ${LISTING_ANALYTICS_MAX_DAYS}. It selects rows and decides nothing about them.`,
          }),
      }),
    },
    responses: {
      200: {
        description:
          'The rollup\u2019s totals per listing over the resolved window. An empty list means no listing of the caller\u2019s has been rolled up.',
        content: { 'application/json': { schema: SellerListingAnalyticsResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: sellerReadMissing,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/messaging/conversations',
    operationId: 'getV1MessagingConversations',
    summary: 'The caller’s inbox',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the conversations the caller is currently a participant of, newest activity first, each with their own unread count, mute and membership state. A conversation the caller has left is not listed; it remains readable by its id. The account is the caller’s own — no identifier is accepted from the request.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({
            description: `How many conversations to return. Defaults to ${MESSAGING_INBOX_DEFAULT_LIMIT}; a larger value is clamped to ${MESSAGING_INBOX_MAX_LIMIT}.`,
          }),
        cursor: z
          .string()
          .optional()
          .openapi({
            description:
              'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
          }),
      }),
    },
    responses: {
      200: {
        description: 'One page of the inbox, ordered by last activity with undated conversations last.',
        content: { 'application/json': { schema: MessagingInboxResponseSchema } },
      },
      400: messagingCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/messaging/conversations/{conversationId}/messages',
    operationId: 'getV1MessagingConversationMessages',
    summary: 'One conversation’s messages',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of a conversation, oldest first so it renders in reading order, chosen backwards from the cursor because a chat opens at its end. A participant who has left may still read the history they were part of. A conversation the caller may not read and a conversation that does not exist produce the same refusal, so asking cannot reveal that one exists.',
    request: {
      ...sessionHeader,
      params: z.object({
        conversationId: z.string().uuid().openapi({ description: 'The conversation to read.' }),
      }),
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({
            description: `How many messages to return. Defaults to ${MESSAGING_MESSAGES_DEFAULT_LIMIT}; a larger value is clamped to ${MESSAGING_MESSAGES_MAX_LIMIT}.`,
          }),
        cursor: z
          .string()
          .optional()
          .openapi({
            description:
              'An opaque cursor from a previous response’s nextCursor, which continues into older messages.',
          }),
      }),
    },
    responses: {
      200: {
        description: 'One page of the conversation, oldest first.',
        content: { 'application/json': { schema: ConversationMessagesResponseSchema } },
      },
      400: messagingCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      404: {
        description:
          'The conversation could not be found. Deliberately identical whether it does not exist or the caller may not read it.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/messaging/unread-count',
    operationId: 'getV1MessagingUnreadCount',
    summary: 'The caller’s total unread count',
    description:
      'Requires the internal BFF credential and the caller’s session. How many messages the caller has not read across the conversations their inbox lists. Their own messages never count; a muted conversation still does, because mute is a notification preference and not a read marker.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The caller’s total unread count.',
        content: { 'application/json': { schema: UnreadCountResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });


  const conversationPath = {
    params: z.object({
      conversationId: z.string().uuid().openapi({ description: 'The conversation to act on.' }),
    }),
  } as const;
  const messagingConversationRefused = {
    description:
      'The conversation could not be found. Deliberately identical whether it does not exist or the caller may not act on it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const messagingThrottled = {
    description: 'The approved messaging rate limits rejected the request',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'post',
    path: '/v1/messaging/conversations',
    operationId: 'postV1MessagingConversations',
    summary: 'Start a conversation',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Starts a conversation about a listing or a direct one with a seller, or resolves to the open conversation that already exists \u2014 both are a success, and `outcome` says which. Refuses a seller who cannot be contacted, a blocked pair and a caller contacting themselves. The caller is the buyer: no identifier is accepted from the request.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: StartConversationRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The conversation to use, whether it was created now or already existed.',
        content: { 'application/json': { schema: StartConversationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: messagingConversationRefused,
      409: {
        description:
          'The seller cannot be contacted, or the pair is blocked. One code each, and neither names a person.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: messagingThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/messaging/conversations/{conversationId}/messages',
    operationId: 'postV1MessagingConversationMessages',
    summary: 'Send a message',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Sends one text message as the caller and returns it as stored, so a surface renders what committed rather than what it hoped for. Refuses a closed conversation, a blocked pair and a body outside 1..5000 characters. Only text: no caller can compose a system or reference message.',
    request: {
      ...sessionHeader,
      ...conversationPath,
      body: { content: { 'application/json': { schema: SendMessageRequestSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The message as stored.',
        content: { 'application/json': { schema: SendMessageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: messagingConversationRefused,
      409: {
        description: 'The conversation is closed, or the pair is blocked.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: messagingThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/messaging/conversations/{conversationId}/read',
    operationId: 'putV1MessagingConversationRead',
    summary: 'Move the caller\u2019s read marker',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Moves the caller\u2019s own read marker forward, clamped to the newest message and never backwards, so repeating a request changes nothing. Private to them: there are no read receipts, and no other participant\u2019s state is touched.',
    request: {
      ...sessionHeader,
      ...conversationPath,
      body: { content: { 'application/json': { schema: MarkReadRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Where the marker now stands, which may be lower than asked for.',
        content: { 'application/json': { schema: MarkReadResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: messagingConversationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/messaging/conversations/{conversationId}/muted',
    operationId: 'putV1MessagingConversationMuted',
    summary: 'Mute or unmute',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Sets the caller\u2019s own mute flag. Private to them, and it changes no authorization, no message visibility and no unread count.',
    request: {
      ...sessionHeader,
      ...conversationPath,
      body: { content: { 'application/json': { schema: SetMutedRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The caller\u2019s mute state.',
        content: { 'application/json': { schema: SetMutedResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: messagingConversationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/messaging/conversations/{conversationId}/membership',
    operationId: 'deleteV1MessagingConversationMembership',
    summary: 'Leave a conversation',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. The caller leaves their own membership and nobody else\u2019s. History is kept and stays readable by them; they no longer appear in an active inbox and can no longer send. Idempotent, and there is no rejoin.',
    request: { ...sessionHeader, ...conversationPath },
    responses: {
      200: {
        description: 'The caller has left.',
        content: { 'application/json': { schema: LeaveConversationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: messagingConversationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/messaging/conversations/{conversationId}/closed',
    operationId: 'putV1MessagingConversationClosed',
    summary: 'Close a conversation',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Either active participant may close. Messages are kept and stay readable; no further message may be sent. Idempotent, and there is no reopen.',
    request: { ...sessionHeader, ...conversationPath },
    responses: {
      200: {
        description: 'The conversation is closed, with the time it was closed.',
        content: { 'application/json': { schema: CloseConversationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: messagingConversationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/messaging/reports',
    operationId: 'postV1MessagingReports',
    summary: 'Report a message or a conversation',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Files a report about a message or a conversation the caller can actually read, through the platform\u2019s existing reporting. A repeat lands on the report already open and answers with the same id, so submitting twice creates one report. It is a request for a look and nothing else: the message stays readable, the conversation stays open, and no membership, mute state, read marker or moderation action changes. The reporter is the caller: no identifier is accepted from the request.',
    request: {
      ...sessionHeader,
      body: {
        content: { 'application/json': { schema: FileMessagingReportRequestSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'The report that is now open for this reporter and this subject.',
        content: { 'application/json': { schema: FileMessagingReportResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: {
        description:
          'The message or conversation cannot be reported by this caller. One code and one sentence for a subject they may not read and one that does not exist, so neither can be told from the other.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      429: messagingThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  /* ---------------------------------------------------------------------------------------------- */
  /* Conversation attachments (0104)                                                                 */
  /* ---------------------------------------------------------------------------------------------- */

  const attachmentMessageParams = {
    params: z.object({
      conversationId: z.string().uuid().openapi({ description: 'A conversation the caller is in.' }),
      messageId: z.string().uuid().openapi({ description: 'One of the caller\u2019s own messages on it.' }),
    }),
  } as const;

  const attachmentBlocked = {
    description:
      'Either party has blocked the other, so the conversation takes nothing new. A **new attachment on an existing message is new content**, which is why this refusal exists on a path that inserts no message. Attachments already there stay readable.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  const attachmentNotFound = {
    description:
      'There is no such message or attachment for this caller. One answer for a message that does not exist, one in a conversation they are not in, and one the other party sent \u2014 so asking cannot reveal which.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'post',
    path: '/v1/messaging/conversations/{conversationId}/messages/{messageId}/attachments/uploads',
    operationId: 'postV1MessagingAttachmentUpload',
    summary: 'Authorize one conversation attachment upload',
    description:
      `Requires the internal BFF credential and the caller\u2019s session. Authorizes a single upload into the **private** \`message-attachments\` bucket and returns the one object path it may go to. **The request carries no path**: the bucket, the conversation, the message and a fresh random file name are all composed in the database from rows the caller was found to own, so another conversation\u2019s namespace or a traversal is unrepresentable rather than merely refused. **Nothing is written** \u2014 a client that asks and never uploads leaves no trace, which is what stops a row ever pointing at nothing. Only the message\u2019s **sender** may attach, and only while they are still a live participant. At most ${MESSAGE_ATTACHMENT_MAX_PER_MESSAGE} attachments per message and ${MESSAGE_ATTACHMENT_MAX_BYTES} bytes each, which are technical safety limits rather than business rules; the ceiling reported is the tighter of that figure and the bucket\u2019s own. The permitted types are three image formats and PDF \u2014 **SVG is refused**, because it is XML a browser executes and serving one from a signed URL would be a stored-XSS primitive.`,
    request: {
      ...sessionHeader,
      ...attachmentMessageParams,
      body: {
        content: { 'application/json': { schema: MessageAttachmentUploadRequestSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'A short-lived upload authorization for exactly one object.',
        content: { 'application/json': { schema: MessageAttachmentUploadResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: attachmentNotFound,
      409: attachmentBlocked,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/messaging/conversations/{conversationId}/messages/{messageId}/attachments',
    operationId: 'postV1MessagingAttachments',
    summary: 'Record a conversation attachment that was uploaded',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Records the path the previous operation issued, **after** the API has confirmed with the storage provider that the object is actually there \u2014 which is why the row cannot describe a file that never arrived. The expected prefix is rebuilt in the database from the caller\u2019s own conversation and message, and the remainder must be one plain file name of the shape the authorization issues, so a path for another message, another conversation, another bucket, with a traversal in it, or with an extension that disagrees with the declared type cannot be recorded. A path already recorded is refused rather than stored twice, so a retrying client records the file once. No event, no notification and no audit row is written.',
    request: {
      ...sessionHeader,
      ...attachmentMessageParams,
      body: {
        content: { 'application/json': { schema: MessageAttachmentRecordRequestSchema } },
        required: true,
      },
    },
    responses: {
      201: {
        description: 'The attachment that now exists, and how many that message carries.',
        content: { 'application/json': { schema: MessageAttachmentRecordResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: attachmentNotFound,
      409: {
        description:
          'The message already holds as many attachments as it may, or the file has not finished uploading. Two distinct codes, because the remedies differ: send another message, or upload the bytes again. A blocked pair answers here too.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/messaging/conversations/{conversationId}/attachments/{attachmentId}/link',
    operationId: 'getV1MessagingAttachmentLink',
    summary: 'A short-lived link to one conversation attachment',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Returns a signed URL for exactly one object, for ten minutes. **The caller names an attachment; the path comes from the row**: no operation on this surface accepts a storage path for reading, and the database requires the attachment, its message\u2019s conversation and the conversation in the route to agree, so an identifier cannot be spent against another conversation. **Either participant may ask, including after a block and after leaving** \u2014 a thread that is readable stays readable, and blocking takes away the next thing sent rather than the record of the last one. The bucket stays private and this URL is the only authorization that ever reaches a browser.',
    request: {
      ...sessionHeader,
      params: z.object({
        conversationId: z.string().uuid().openapi({ description: 'A conversation the caller is in.' }),
        attachmentId: z.string().uuid().openapi({ description: 'An attachment on one of its messages.' }),
      }),
    },
    responses: {
      200: {
        description: 'A signed URL for one object, and when it stops working.',
        content: { 'application/json': { schema: MessageAttachmentLinkResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: attachmentNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/auth/totp',
    operationId: 'getV1AuthTotp',
    summary: 'Whether the caller has an authenticator',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Answers for the caller\u2019s own account and no other: there is no user identifier in the request. Two values and no detail \u2014 not how many factors, not when one was created, not an identifier. A factor that was created but never verified reads as not_enrolled, because that is what it means to the person.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'Whether there is an authenticator to challenge.',
        content: { 'application/json': { schema: TotpStatusResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/totp/enrol',
    operationId: 'postV1AuthTotpEnrol',
    summary: 'Begin enrolling an authenticator',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Creates a TOTP factor at the identity provider, which is where the secret lives \u2014 this API never stores one. **The response carries the shared secret, once.** It is returned only to the screen the person is reading, under no-store, and the surface offers no way to ask for it again; a caller who already has a verified authenticator is refused with TOTP_ALREADY_ENROLLED and reaches nothing. Enrolment is finished by the challenge and verify operations below. No session is created here and no assurance level changes.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The factor was created. The secret and the Key URI are in this body, once.',
        content: { 'application/json': { schema: TotpEnrolmentResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      409: {
        description: 'The caller already has a verified authenticator, so nothing was created.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/totp/challenge',
    operationId: 'postV1AuthTotpChallenge',
    summary: 'Raise a TOTP challenge',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Raises a challenge against the caller\u2019s own factor \u2014 a verified one when there is one, otherwise the enrolment in progress. **No factor identifier is accepted from the request**, and the factor and challenge identifiers travel only to the BFF, which holds them in an HttpOnly cookie and supplies them again on the next internal call: a page can neither choose which factor it answers for nor replay a challenge. An optional operation names the protected action a satisfied verification will authorise, and is recorded as a ten-minute single-use step-up grant at that point; omitting it raises the caller\u2019s assurance level and grants nothing in particular. A caller with no factor at all is refused with TOTP_NOT_ENROLLED.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: TotpChallengeRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'A challenge was raised. The body says only that.',
        content: { 'application/json': { schema: TotpChallengeResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: {
        description: 'The caller has no authenticator, so there is nothing to challenge.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/auth/totp/verify',
    operationId: 'postV1AuthTotpVerify',
    summary: 'Satisfy a TOTP challenge',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. The identity provider checks the code against the factor it holds and mints a new aal2 session; that session crosses one server-to-server hop to the BFF, which turns it into the staff cookies, and **the browser-visible body carries no session, no token and no account**. Verifying an unverified factor is what completes enrolment. When the challenge named an operation, a single-use ten-minute step-up grant is recorded for it. A wrong code, an expired challenge, one already spent and a factor belonging to somebody else are all refused identically.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: TotpVerifyRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The code was correct. The session travels to the BFF, never to the browser.',
        content: { 'application/json': { schema: TotpVerifyResponseSchema } },
      },
      400: validationFailed,
      401: {
        description:
          'The code was not accepted. One answer for a wrong code, an expired challenge, one already spent, and a factor that is not the caller\u2019s.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  const notificationsCursorRefused = {
    description:
      'The cursor is malformed, altered or from a version this API no longer reads. One answer for all three: the remedy is to start again without it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/notifications',
    operationId: 'getV1Notifications',
    summary: 'The caller\u2019s notifications',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. One page of the caller\u2019s own notifications, newest first, ordered by creation time with the identifier as a tie-breaker so the page boundary is total and deterministic. **The account is the caller\u2019s own \u2014 no identifier is accepted from the request**, and the reader is scoped to that account in the statement, so another person\u2019s notification is absent from the result rather than refused from it. `view` selects the inbox (unarchived) or the archived list, which is the split the schema itself draws. Each item carries the metadata migration 0029 defines \u2014 category, event type, subject and relative action path \u2014 and never the template variables, the template key, the originating staff member or the email link.',
    request: {
      ...sessionHeader,
      query: z.object({
        view: z
          .string()
          .optional()
          .openapi({
            description:
              'Which list to read: inbox (the default) for notifications that have not been archived, or archived for those that have.',
          }),
        limit: z
          .string()
          .optional()
          .openapi({
            description: `How many notifications to return. Defaults to ${NOTIFICATIONS_DEFAULT_LIMIT}; a larger value is clamped to ${NOTIFICATIONS_MAX_LIMIT}.`,
          }),
        cursor: z
          .string()
          .optional()
          .openapi({
            description:
              'An opaque cursor from a previous response\u2019s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
          }),
      }),
    },
    responses: {
      200: {
        description: 'One page of the requested list, newest first.',
        content: { 'application/json': { schema: NotificationsResponseSchema } },
      },
      400: notificationsCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/notifications/unread-count',
    operationId: 'getV1NotificationsUnreadCount',
    summary: 'The caller\u2019s unread notification count',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. How many of the caller\u2019s notifications are unread **and** not archived \u2014 the same predicate as the schema\u2019s own unread index, so the badge and the inbox never disagree. Archiving an unread notification therefore clears it from this count, which is how a person empties their inbox.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The caller\u2019s unread count.',
        content: { 'application/json': { schema: NotificationsUnreadCountResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/notifications/read',
    operationId: 'postV1NotificationsRead',
    summary: 'Mark notifications read',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Marks the named notifications read, or all of the caller\u2019s unread ones when none are named. **Idempotent**: an already-read notification is not matched, so a repeat changes nothing and still succeeds, and `changed` reports how many actually moved. An identifier belonging to somebody else matches nothing \u2014 the operation is scoped to the caller in the statement \u2014 so nothing is disclosed about it either. An archived notification is not marked read, which is the behaviour the schema has had since it was created.',
    request: {
      ...sessionHeader,
      body: {
        content: { 'application/json': { schema: MarkNotificationsReadRequestSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'How many notifications moved, and the badge as it now stands.',
        content: { 'application/json': { schema: NotificationsMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/notifications/archive',
    operationId: 'postV1NotificationsArchive',
    summary: 'Archive notifications',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Archives the named notifications, which removes them from the inbox and from the unread count while keeping them readable in the archived list. **Identifiers are required**: there is no form of this operation that archives an entire inbox. **Idempotent**: an already-archived notification is not matched, so a repeat reports zero changes, never moves the original timestamp, and still succeeds. An identifier belonging to somebody else matches nothing. Nothing is ever deleted.',
    request: {
      ...sessionHeader,
      body: {
        content: { 'application/json': { schema: ArchiveNotificationsRequestSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'How many notifications moved, and the badge as it now stands.',
        content: { 'application/json': { schema: NotificationsMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/users/me/contact/phone/start',
    operationId: 'postV1UsersMeContactPhoneStart',
    summary: 'Start a phone change',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Sends a one-time code to the new number over WhatsApp, under the approved OTP send limits. The account is the caller\u2019s own: no user identifier is accepted from the request.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: ContactPhoneStartRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'A code was sent to the new number.',
        content: { 'application/json': { schema: ContactPhoneStartResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      429: throttled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/users/me/contact/phone/verify',
    operationId: 'postV1UsersMeContactPhoneVerify',
    summary: 'Complete a phone change',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. A correct code makes the new number the account\u2019s confirmed phone through the server-side provider Admin API, records a security event and notifies the previous number. No session is created and none is revoked.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: ContactPhoneVerifyRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The phone was changed.',
        content: { 'application/json': { schema: ContactPhoneVerifyResponseSchema } },
      },
      400: validationFailed,
      401: {
        description:
          'The code was refused, or the challenge does not belong to the caller. Deliberately identical in every case.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      403: credentialRejected,
      429: throttled,
      503: unavailable,
      500: internalError,
    },
  });


  // Phase 7-E. The buyer account surfaces. Every one of them is the caller's own: no operation accepts a
  // user identifier in a path, a query or a body, and every reader and writer behind them is scoped to
  // the caller inside the statement. A row that is not theirs is therefore never matched, which is why
  // none of these declares a 403 — there is no "forbidden" to report, only absence.
  const accountCursorRefused = {
    description:
      'The cursor is malformed, altered or from a version this API no longer reads. One answer for all three: the remedy is to start again without it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const accountNotFound = {
    description:
      'There is no such row for this account. Identical to the answer for a row that belongs to somebody else, so asking cannot reveal that one exists.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const accountListQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${ACCOUNT_DEFAULT_LIMIT}; a larger value is clamped to ${ACCOUNT_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/users/me/favorites',
    operationId: 'getV1UsersMeFavorites',
    summary: 'The caller’s favorites',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the listings the caller saved, newest first, keyed on the saved time with the listing identifier as a tie-breaker so the page boundary is total and deterministic. **A favorite whose listing is no longer publicly visible is still returned**, because it is the caller’s own saved row and hiding it would remove data from their own screen: such an item reports `isAvailable: false` and carries a `null` listing, so nothing about the hidden listing crosses. A visible one carries the ordinary marketplace card, money included, exactly as the browse list defines it.',
    request: { ...sessionHeader, ...accountListQuery },
    responses: {
      200: {
        description: 'One page of the caller’s favorites, newest first.',
        content: { 'application/json': { schema: FavoritesResponseSchema } },
      },
      400: accountCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/users/me/favorites',
    operationId: 'postV1UsersMeFavorites',
    summary: 'Save a listing',
    description:
      'Requires the internal BFF credential and the caller’s session. Saves one listing to the caller’s own favorites. **Idempotent**: a listing that is already saved is not saved again, `changed` reports false, the original saved date is kept and the request still succeeds. A listing that is not publicly visible — withdrawn, or from a storefront that is not active — answers 404, identically to one that does not exist; that is the same admission test the table’s own RLS check applies, so no path can save something a browser could not.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: AddFavoriteRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Whether this request was the one that saved it.',
        content: { 'application/json': { schema: FavoriteMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: accountNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/users/me/favorites/{listingId}',
    operationId: 'deleteV1UsersMeFavorite',
    summary: 'Remove a saved listing',
    description:
      'Requires the internal BFF credential and the caller’s session. Removes one listing from the caller’s own favorites. **Idempotent**: removing one that is not there removes nothing, reports `changed: false` and still succeeds. The operation is scoped to the caller in the statement, so another person’s favorite is never matched and nothing is disclosed about it.',
    request: {
      ...sessionHeader,
      params: z.object({
        listingId: z.uuid().openapi({ description: 'The saved listing.' }),
      }),
    },
    responses: {
      200: {
        description: 'Whether this request was the one that removed it.',
        content: { 'application/json': { schema: FavoriteMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  const savedSearchParam = {
    params: z.object({
      savedSearchId: z.uuid().openapi({ description: 'One of the caller’s own saved searches.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/users/me/saved-searches',
    operationId: 'getV1UsersMeSavedSearches',
    summary: 'The caller’s saved searches',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the caller’s own saved searches, newest first. Each carries its name, the stored query parameters, whether it is set to notify, and the two matching timestamps as read-only data. **There is no matching engine in this project**: nothing here runs a search, and `lastMatchedAt` and `lastNotifiedAt` are null on everything created today.',
    request: { ...sessionHeader, ...accountListQuery },
    responses: {
      200: {
        description: 'One page of the caller’s saved searches, newest first.',
        content: { 'application/json': { schema: SavedSearchesResponseSchema } },
      },
      400: accountCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/users/me/saved-searches',
    operationId: 'postV1UsersMeSavedSearches',
    summary: 'Save a search',
    description:
      'Requires the internal BFF credential and the caller’s session. Stores one search under a name of the caller’s choosing. `notify` is a stored preference and nothing else — saving a search with it on schedules no work, sends no message and creates no notification, because no matching engine exists. A name the caller has already used answers 409 `SAVED_SEARCH_NAME_TAKEN`; the constraint is per account, so that says nothing about anybody else.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: SavedSearchInputSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The saved search, by its identifier.',
        content: { 'application/json': { schema: SavedSearchCreatedResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: {
        description: 'The caller already has a saved search by that name.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/users/me/saved-searches/{savedSearchId}',
    operationId: 'patchV1UsersMeSavedSearch',
    summary: 'Edit a saved search',
    description:
      'Requires the internal BFF credential and the caller’s session. Replaces the three fields a person owns on one of their own saved searches: its name, its query and whether it notifies. `lastMatchedAt` and `lastNotifiedAt` are absent from the schema entirely, so neither can be sent — they are a matching engine’s bookkeeping and no engine exists. A saved search that is not the caller’s answers 404, identically to one that does not exist.',
    request: {
      ...sessionHeader,
      ...savedSearchParam,
      body: { content: { 'application/json': { schema: SavedSearchInputSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Whether the edit changed anything.',
        content: { 'application/json': { schema: SavedSearchMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: accountNotFound,
      409: {
        description: 'The caller already has another saved search by that name.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/users/me/saved-searches/{savedSearchId}',
    operationId: 'deleteV1UsersMeSavedSearch',
    summary: 'Delete a saved search',
    description:
      'Requires the internal BFF credential and the caller’s session. Deletes one of the caller’s own saved searches. **Idempotent**: deleting one that is already gone deletes nothing, reports `changed: false` and still succeeds. Scoped to the caller in the statement, so another person’s saved search is never matched.',
    request: { ...sessionHeader, ...savedSearchParam },
    responses: {
      200: {
        description: 'Whether this request was the one that deleted it.',
        content: { 'application/json': { schema: SavedSearchMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  /* ---------------------------------------------------------------------------------------------- */
  /* Blocking (0103)                                                                                 */
  /* ---------------------------------------------------------------------------------------------- */

  const blocksListQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${BLOCKS_DEFAULT_LIMIT}; a larger value is clamped to ${BLOCKS_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response\u2019s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/users/me/blocks',
    operationId: 'getV1UsersMeBlocks',
    summary: 'The people the caller has blocked',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. One page of the caller\u2019s own blocks, newest first, keyed on when the block was made with the blocked row as a tie-breaker so the page boundary is total. Each row names the person by **display name and storefront slug only**, both of which may be null, and carries an opaque `reference` for the unblock. **No account identifier is returned**, here or anywhere on this surface. There is no corresponding operation for the other direction: nothing in this API answers who has blocked the caller.',
    request: { ...sessionHeader, ...blocksListQuery },
    responses: {
      200: {
        description: 'One page of the caller\u2019s blocks, newest first.',
        content: { 'application/json': { schema: BlocksResponseSchema } },
      },
      400: accountCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/users/me/blocks',
    operationId: 'postV1UsersMeBlocks',
    summary: 'Block somebody',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Blocks the person on the other side of a conversation the caller is in, or of a public storefront slug \u2014 **exactly one of the two per request**, which is why the body is a union rather than one object with optional fields. **No account identifier is accepted**: there is no field in either shape that could carry one. The effect is symmetric, because the predicate six existing operations already consult tests both directions: after this, neither person can start a conversation with the other, send a message into one they already share, make or counter an offer, open a service request or quote one. Nothing historical is touched \u2014 no conversation is deleted, closed, muted or hidden, no message is altered, and no offer or service request changes state. The blocked person is **not notified**, and the blocked seller\u2019s catalogue listings stay exactly as visible as before. **Idempotent**: blocking somebody already blocked reports `changed: false`, refreshes the stored reason and still succeeds. A conversation that does not exist, one the caller is not in, an unknown slug, a storefront that is not publicly visible and the caller themselves all answer 404 \u2014 one answer for all five, so this operation cannot be used to find out which threads or storefronts exist. No second factor is required: blocking is a safety action, and a step-up challenge in front of it would be the wrong trade.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: BlockRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Whether this request was the one that created the block.',
        content: { 'application/json': { schema: BlockMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: accountNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/users/me/blocks/{reference}',
    operationId: 'deleteV1UsersMeBlock',
    summary: 'Unblock somebody',
    description:
      'Requires the internal BFF credential and the caller\u2019s session. Removes one block, named by the opaque `reference` a previous list response carried. The reference is **not** an account identifier and must not be constructed or parsed by a client. **Idempotent, and deliberately silent about failure**: a reference this API cannot read and a reference naming somebody the caller never blocked both report `changed: false` and succeed, so trying references cannot reveal whose blocks exist. The writer is scoped to the caller in its own statement, so a reference from another person\u2019s list removes nothing. Unblocking restores contact rather than merely recording it: the operations refused while the block stood work again immediately.',
    request: {
      ...sessionHeader,
      params: z.object({
        reference: z
          .string()
          .openapi({ description: 'The opaque reference from a blocks list response.' }),
      }),
    },
    responses: {
      200: {
        description: 'Whether this request was the one that removed a block.',
        content: { 'application/json': { schema: BlockMutationResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  const addressParam = {
    params: z.object({
      addressId: z.uuid().openapi({ description: 'One of the caller’s own addresses.' }),
    }),
  } as const;
  const addressCountryRefused = {
    description:
      'An address used for shipping must sit in a marketplace-enabled country (D17). The remedy is another country, or an address kept for billing only.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/users/me/addresses',
    operationId: 'getV1UsersMeAddresses',
    summary: 'The caller’s addresses',
    description:
      'Requires the internal BFF credential and the caller’s session. Every address the caller has, defaults first. Unpaged, because an account holds a handful. Removed addresses are absent. The stored geography point is never returned — no approved surface captures or renders one. **Nothing here is connected to checkout or to an order**: shipping is Phase 8 and no operation on this surface reaches it.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The caller’s addresses, defaults first.',
        content: { 'application/json': { schema: AddressesResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/users/me/addresses',
    operationId: 'postV1UsersMeAddresses',
    summary: 'Add an address',
    description:
      'Requires the internal BFF credential and the caller’s session. Adds one address to the caller’s own account. Marking it as a default clears the previous default of that kind, because the schema’s unique partial indexes admit at most one of each. A shipping address in a country that is not marketplace-enabled answers 409 `ADDRESS_COUNTRY_NOT_SHIPPABLE` (D17); a country code that does not exist is an ordinary validation failure.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: AddressInputSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The address, by its identifier.',
        content: { 'application/json': { schema: AddressCreatedResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: addressCountryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/users/me/addresses/{addressId}',
    operationId: 'patchV1UsersMeAddress',
    summary: 'Edit an address',
    description:
      'Requires the internal BFF credential and the caller’s session. Replaces one of the caller’s own addresses with the body supplied. The same rules apply as on create, D17 included. An address that is not the caller’s answers 404, identically to one that does not exist.',
    request: {
      ...sessionHeader,
      ...addressParam,
      body: { content: { 'application/json': { schema: AddressInputSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Whether the edit changed anything.',
        content: { 'application/json': { schema: AddressMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: accountNotFound,
      409: addressCountryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/users/me/addresses/{addressId}',
    operationId: 'deleteV1UsersMeAddress',
    summary: 'Remove an address',
    description:
      'Requires the internal BFF credential and the caller’s session. Removes one of the caller’s own addresses and clears its default flags in the same statement. **Idempotent**: removing one that is already gone removes nothing, reports `changed: false` and still succeeds.',
    request: { ...sessionHeader, ...addressParam },
    responses: {
      200: {
        description: 'Whether this request was the one that removed it.',
        content: { 'application/json': { schema: AddressMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/users/me/profile',
    operationId: 'getV1UsersMeProfile',
    summary: 'The caller’s profile',
    description:
      'Requires the internal BFF credential and the caller’s session. The caller’s own profile: the display and full name, the phone number and its verification state, the locale, the timezone and the account status. Wider than the identity read a signed-in shell uses, and still narrow — no avatar path, no role, no permission and no seller record. A deleted profile returns 404, which is how a deleted account stops being able to read itself with a live token.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The caller’s own profile.',
        content: { 'application/json': { schema: BuyerProfileResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: accountNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/users/me/profile',
    operationId: 'patchV1UsersMeProfile',
    summary: 'Edit the caller’s profile',
    description:
      'Requires the internal BFF credential and the caller’s session. Writes the four fields a person owns: display name, full name, locale and timezone. **The phone number, the verification timestamps, the account status and every role and permission are absent from the schema entirely**, so none of them can be sent and nothing on this surface can change what an account is allowed to do. A number is changed through the verified contact-change flow and nowhere else. An unknown locale or timezone is an ordinary validation failure.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: UpdateBuyerProfileRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'Whether the edit changed anything.',
        content: { 'application/json': { schema: BuyerProfileMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: accountNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/users/me/settings',
    operationId: 'getV1UsersMeSettings',
    summary: 'The caller’s settings',
    description:
      'Requires the internal BFF credential and the caller’s session. The five notification switches and the digit style, which is every setting the schema defines apart from the free-form preferences object this surface does not expose. The digit style is null when the account follows its locale (D15).',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The caller’s own settings.',
        content: { 'application/json': { schema: BuyerSettingsResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/users/me/settings',
    operationId: 'putV1UsersMeSettings',
    summary: 'Write the caller’s settings',
    description:
      'Requires the internal BFF credential and the caller’s session. A whole-state write: every switch is required, so there is no merge rule and no second place the current state has to be known. **Idempotent** — writing the same values again is a success that changes nothing anybody can observe. These are the settings the notification writer already consults before it creates anything, so turning email off here is honoured by that writer and not by a rule invented on this surface.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: UpdateBuyerSettingsRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The settings were written.',
        content: { 'application/json': { schema: BuyerSettingsMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/reference/countries',
    operationId: 'getV1ReferenceCountries',
    summary: 'The country reference',
    description:
      'Requires the internal BFF credential and the caller’s session. The countries an address form offers, each with both names, the dialling code and whether it is marketplace-enabled. The list is not filtered by that flag: a billing address is not restricted by D17, so filtering here would remove a choice the schema allows. Public reference data — it takes no account and discloses nothing about anybody.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'Every country, in display order.',
        content: { 'application/json': { schema: CountriesResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });


  // Phase 7-F. The staff console session: one read, no request body, no parameter of any kind. The
  // account is the caller's own and the assurance level comes from the provider-validated token, so
  // there is nothing here a browser could assert about who it is or what it may do.
  registry.registerPath({
    method: 'get',
    path: '/v1/admin/session',
    operationId: 'getV1AdminSession',
    summary: 'The staff console session',
    description:
      'Requires the internal BFF credential and the caller’s session. Answers the three questions the admin shell asks before rendering: who the caller is, whether their session has reached `aal2`, and which permissions they effectively hold. **The permissions are already filtered** — the assurance rule is applied in the database by the same predicate `public.has_permission` uses, so staff who have not completed a second factor receive an empty array rather than a full one beside a flag. `requiresStepUp` distinguishes staff who must complete the existing TOTP challenge from everybody else, and is never true for an account that is not staff. Nothing here is writable: no role, no grant and no assurance assertion is accepted from a request, and the operation takes no parameter at all.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description:
          'The caller’s own console session. An account that is not staff receives the same shape with empty sets, which is how the shell refuses without disclosing anything.',
        content: { 'application/json': { schema: AdminSessionResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  /* -------------------------------------------------------------------------------------------- */
  /* Phase 7-G — admin seller verification review                                                  */
  /* -------------------------------------------------------------------------------------------- */

  const verificationParam = {
    params: z.object({
      verificationId: z
        .uuid()
        .openapi({ description: 'One seller verification submission.' }),
    }),
  } as const;
  const verificationDocumentParams = {
    params: z.object({
      verificationId: z
        .uuid()
        .openapi({ description: 'The submission the document belongs to.' }),
      documentId: z
        .uuid()
        .openapi({ description: 'One document attached to that submission.' }),
    }),
  } as const;
  const verificationNotFound = {
    description:
      'There is no such submission, or it is a draft, or the caller may not review. All three answer identically — a distinct refusal would confirm that a particular application exists.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/seller-verifications',
    operationId: 'getV1AdminSellerVerifications',
    summary: 'The seller verification review queue',
    description:
      'Requires the internal BFF credential and the caller’s session, and is answered only for a caller who effectively holds `sellers.verification.review` — which, because every console role is `requires_mfa`, means a staff session that has reached `aal2`. Ordered by 0009’s own queue index (`status`, `submitted_at`), oldest submission first, with the identifier breaking ties into a total order. **No priority, score, SLA or ranking is computed.** Drafts are never returned: a draft is an application its owner has not submitted. Omitting `status` means the two states awaiting a decision, `submitted` and `under_review`. A caller who may not review receives 404, identically to a route that does not exist for them.',
    request: {
      ...sessionHeader,
      query: z.object({
        status: z
          .string()
          .optional()
          .openapi({
            description:
              'One of submitted, under_review, approved, rejected or expired. Omit for the two awaiting a decision. `draft` is not accepted.',
          }),
        limit: z
          .string()
          .optional()
          .openapi({
            description: `How many rows to return. Defaults to ${VERIFICATION_QUEUE_DEFAULT_LIMIT}; a larger value is clamped to ${VERIFICATION_QUEUE_MAX_LIMIT}.`,
          }),
        cursor: z
          .string()
          .optional()
          .openapi({
            description:
              'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
          }),
      }),
    },
    responses: {
      200: {
        description: 'One page of submissions, oldest first.',
        content: { 'application/json': { schema: VerificationQueueResponseSchema } },
      },
      400: {
        description:
          'The cursor is malformed, altered or from a version this API no longer reads, or the status filter is not one this queue accepts.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: verificationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/seller-verifications/{verificationId}',
    operationId: 'getV1AdminSellerVerification',
    summary: 'One seller verification submission',
    description:
      'Requires the internal BFF credential, the caller’s session and `sellers.verification.review`. Returns the application’s own state, the existing decision fields, the storefront identity the evidence has to agree with, and the documents’ metadata. **No storage object path is in the answer** and **no account identifier is** — neither the applicant’s nor the reviewer’s.',
    request: { ...sessionHeader, ...verificationParam },
    responses: {
      200: {
        description: 'The submission, as a reviewer sees it.',
        content: { 'application/json': { schema: VerificationReviewResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: verificationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/seller-verifications/{verificationId}/decision',
    operationId: 'postV1AdminSellerVerificationDecision',
    summary: 'Approve or reject a seller verification',
    description:
      'Requires the internal BFF credential, the caller’s session and `sellers.verification.review`. Performs 0009’s own reviewer UPDATE — `status`, `reviewed_at`, `reviewed_by`, `decision_reason` — and nothing else; the existing CHECK constraints, `app_private.tg_apply_verification_decision` and the existing audit trigger then do exactly what they already do, so the storefront’s verification state and the audit record are the existing machinery’s and are not written here. **The reviewer is taken from the caller’s own session and never from the request.** A reason is required for a rejection and optional on an approval. An application that has already been decided, or has expired, answers 409 and is not changed: the database locks the row, so two reviewers deciding at once cannot both win.',
    request: {
      ...sessionHeader,
      ...verificationParam,
      body: {
        content: { 'application/json': { schema: VerificationDecisionRequestSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'The status the application now holds.',
        content: { 'application/json': { schema: VerificationDecisionResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: verificationNotFound,
      409: {
        description:
          'The application is not in a state this path decides from — already approved or rejected, or expired — or an approval was attempted before both of the applicant’s contact verifications were in place.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/seller-verifications/{verificationId}/documents/{documentId}/link',
    operationId: 'postV1AdminSellerVerificationDocumentLink',
    summary: 'Authorize one look at a verification document',
    description:
      'Requires the internal BFF credential, the caller’s session and `sellers.verification.review`. Issues a short-lived authorization to read **one** object in the private `verification-documents` bucket. **The caller names a document, never a path**: the bucket and object path are looked up from that row in the database — the same path the seller’s own submission flow composed — so there is no field through which an arbitrary object could be requested, and the document must belong to the submission named in the route. The bucket stays private and no provider credential is ever in the answer.',
    request: { ...sessionHeader, ...verificationDocumentParams },
    responses: {
      200: {
        description: 'A short-lived, single-object URL and the moment it stops working.',
        content: { 'application/json': { schema: VerificationDocumentLinkResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: verificationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  /* -------------------------------------------------------------------------------------------- */
  /* Phase 7-I — service requests and quotes, Option 1                                             */
  /* -------------------------------------------------------------------------------------------- */

  const requestParam = {
    params: z.object({
      requestId: z.uuid().openapi({ description: 'One service request the caller is a party to.' }),
    }),
  } as const;
  const serviceListQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${SERVICE_REQUESTS_DEFAULT_LIMIT}; a larger value is clamped to ${SERVICE_REQUESTS_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
    }),
  } as const;
  const serviceCursorRefused = {
    description:
      'The cursor is malformed, altered or from a version this API no longer reads. One answer for all three: the remedy is to start again without it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const serviceNotFound = {
    description:
      'There is no such request or quote for this caller. Identical to the answer for one belonging to two other people, so asking cannot reveal that it exists.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const serviceConflict = {
    description:
      'The request is closed, or the quote has already been decided (`SERVICE_REQUEST_NOT_ACTIONABLE`), or the quote’s validity window has passed (`SERVICE_QUOTE_LAPSED`). Nothing is changed either way.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/service-requests/made',
    operationId: 'getV1ServiceRequestsMade',
    summary: 'The service requests the caller has sent',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the briefs this account has sent as a buyer, newest first. Scoped to the caller inside the statement, so another account’s request is never matched. `liveQuoteCount` counts only quotes that are still standing: the scheduled sweeper is what writes `expired`, and this is how a list tells the truth in the minutes before it runs.',
    request: { ...sessionHeader, ...serviceListQuery },
    responses: {
      200: {
        description: 'One page of the caller’s own requests, newest first.',
        content: { 'application/json': { schema: ServiceRequestsResponseSchema } },
      },
      400: serviceCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/service-requests/{requestId}',
    operationId: 'getV1ServiceRequest',
    summary: 'One service request and its quotes',
    description:
      'Requires the internal BFF credential and the caller’s session. Answered for either party and for nobody else. `isBuyer` and `isSeller` are **derived in the database** from the account the API established, so a surface knows which actions to offer without a browser ever claiming a side; they can never both be true. No account identifier is in the answer.',
    request: { ...sessionHeader, ...requestParam },
    responses: {
      200: {
        description: 'The request, with every quote on it, newest first.',
        content: { 'application/json': { schema: ServiceRequestDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: serviceNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/service-requests',
    operationId: 'postV1ServiceRequests',
    summary: 'Enquire about a listing',
    description:
      'Requires the internal BFF credential and the caller’s session. Sends one enquiry about a live listing **to the office** (OD-A4): a buyer never reaches a seller, so this creates an `admin_only` request with no seller on it and the office answers. The body is unchanged from the seller-routed request this replaced — a listing, a title, a brief and optionally a budget and a date, and nothing else — and the currency still comes out of the listing row inside the database, so it cannot be supplied. A listing that is not live answers 404, identically to one that does not exist — and so does the caller’s own listing, deliberately: a distinguishable refusal there would be a way to ask who owns a listing. **The enquiry never expires** (OD-A3): nothing in the platform writes the expired status, and only the buyer or the office closes it.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateServiceRequestSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The request that was sent.',
        content: { 'application/json': { schema: ServiceRequestMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: {
        description: 'There is no such listing.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      409: {
        description:
          'The service cannot be requested (`SERVICE_REQUEST_NOT_AVAILABLE`), it is fixed-price and is bought rather than quoted (`SERVICE_REQUEST_NOT_CUSTOM`), it is the caller’s own (`SERVICE_REQUEST_OWN_LISTING`), or one party has blocked the other (`SERVICE_REQUEST_BLOCKED`).',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/service-requests/{requestId}/cancel',
    operationId: 'postV1ServiceRequestCancel',
    summary: 'Cancel your own service request',
    description:
      'Requires the internal BFF credential and the caller’s session. The buyer withdraws their own brief while it is still open or quoted. Only the buyer may cancel; to the seller it answers 404.',
    request: { ...sessionHeader, ...requestParam },
    responses: {
      200: {
        description: 'The status the request now holds.',
        content: { 'application/json': { schema: ServiceRequestStatusResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: serviceNotFound,
      409: serviceConflict,
      503: unavailable,
      500: internalError,
    },
  });

  /* -------------------------------------------------------------------------------------------- */
  /* Phase 7-J — service requests, Option 2: Admin Only                                            */
  /* -------------------------------------------------------------------------------------------- */

  const adminRequestParam = {
    params: z.object({
      requestId: z.uuid().openapi({ description: 'One Admin Only service request.' }),
    }),
  } as const;
  const adminQueueQuery = {
    query: z.object({
      status: z
        .string()
        .optional()
        .openapi({
          description:
            'One of the schema’s own request statuses, to narrow the queue. Omitted shows every Admin Only request.',
        }),
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${SERVICE_REQUESTS_DEFAULT_LIMIT}; a larger value is clamped to ${SERVICE_REQUESTS_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
    }),
  } as const;
  const adminRequestNotFound = {
    description:
      'There is no such Admin Only request for this caller. Identical to the answer for a caller who holds no permission for it, and to the answer for a seller-routed request — so asking cannot reveal either that it exists or that you may not see it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'post',
    path: '/v1/service-requests/admin-only',
    operationId: 'postV1AdminOnlyServiceRequest',
    summary: 'Send a service request for the platform to handle',
    description:
      'Requires the internal BFF credential and the caller’s session. The buyer describes what they need and how they would prefer to pay; **no seller is named and none is assigned**, no quote is created and no notification is sent to anybody. The routing mode is written by the server, not chosen by the caller, and the currency comes from the platform’s own default currency — neither is a field in the body. The two payment fields are descriptive text: they reach no provider, and they are cleared ninety days after the request closes.',
    request: {
      ...sessionHeader,
      body: {
        content: { 'application/json': { schema: CreateAdminOnlyServiceRequestSchema } },
      },
    },
    responses: {
      201: {
        description: 'The request that was created, and the status it starts in.',
        content: { 'application/json': { schema: ServiceRequestMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: {
        description:
          'The platform has no default currency, so the brief was not written (`SERVICE_REQUEST_CURRENCY_UNAVAILABLE`), or a dependency could not answer. Nothing is created either way.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/service-requests',
    operationId: 'getV1AdminServiceRequests',
    summary: 'The Admin Only service request queue',
    description:
      'Requires the internal BFF credential and a staff session holding `service_requests.request.read` in an aal2 session. One page of Admin Only requests, **oldest first**, over the partial index that exists for this order. Seller-routed requests are never in it. Neither payment field is in this document: `hasPaymentNotes` says only whether there is a note, and reading either value is a separate operation behind a separate permission.',
    request: { ...sessionHeader, ...adminQueueQuery },
    responses: {
      200: {
        description: 'One page of Admin Only requests, oldest first. Empty for a caller without the permission.',
        content: { 'application/json': { schema: AdminServiceRequestsResponseSchema } },
      },
      400: serviceCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/service-requests/{requestId}',
    operationId: 'getV1AdminServiceRequest',
    summary: 'One Admin Only service request',
    description:
      'Requires the internal BFF credential and a staff session holding `service_requests.request.read` in an aal2 session. The brief in full, with the buyer’s display name and nothing else about them. **Neither payment field is in this document**, whatever the caller holds: they are returned only by the payment-information operation, which requires its own permission.',
    request: { ...sessionHeader, ...adminRequestParam },
    responses: {
      200: {
        description: 'The request.',
        content: { 'application/json': { schema: AdminServiceRequestDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminRequestNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/service-requests/{requestId}/payment-information',
    operationId: 'getV1AdminServiceRequestPaymentInformation',
    summary: 'The descriptive payment information of one Admin Only request',
    description:
      'Requires the internal BFF credential and a staff session holding **`service_requests.payment_info.read`** in an aal2 session — the request permission alone is not enough, and a caller holding only that receives 404 here while still being able to read the request itself. The two fields are free text a buyer typed; they reach no provider, and both are null once the retention job has cleared them, which leaves the request otherwise untouched.',
    request: { ...sessionHeader, ...adminRequestParam },
    responses: {
      200: {
        description: 'The two descriptive fields, either of which may be null.',
        content: { 'application/json': { schema: ServiceRequestPaymentInformationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminRequestNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/service-requests/{requestId}/decline',
    operationId: 'postV1AdminServiceRequestDecline',
    summary: 'Close an Admin Only service request',
    description:
      'Requires the internal BFF credential and a staff session holding **`service_requests.request.manage`** in an aal2 session. The approved staff closure: `open → declined`, with the closing time recorded. On an Admin Only request `declined` means the platform closed it without fulfilment — which is a different fact from the same status on a seller-routed request, where it means the seller declined to quote, and the two are written by different functions that cannot reach each other’s rows. It creates no quote, no obligation, no payment deadline and no order, and sends no notification.',
    request: { ...sessionHeader, ...adminRequestParam },
    responses: {
      200: {
        description: 'The status the request now holds.',
        content: { 'application/json': { schema: AdminServiceRequestDecisionResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminRequestNotFound,
      409: {
        description:
          'The request is no longer open — the buyer cancelled it, or it is already declined (`SERVICE_REQUEST_NOT_ACTIONABLE`). Nothing is changed.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  /* -------------------------------------------------------------------------------------------- */
  /* Phase 7-K — support, the requester side                                                       */
  /* -------------------------------------------------------------------------------------------- */

  const ticketParam = {
    params: z.object({
      ticketId: z.uuid().openapi({ description: 'One support ticket the caller raised.' }),
    }),
  } as const;
  const ticketMessageParams = {
    params: z.object({
      ticketId: z.uuid().openapi({ description: 'One support ticket the caller raised.' }),
      messageId: z
        .uuid()
        .openapi({ description: 'One message **the caller wrote** on that ticket.' }),
    }),
  } as const;
  const ticketAttachmentParams = {
    params: z.object({
      ticketId: z.uuid().openapi({ description: 'One support ticket the caller raised.' }),
      attachmentId: z
        .uuid()
        .openapi({ description: 'One attachment on a message of that same ticket.' }),
    }),
  } as const;
  const supportTicketsQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${SUPPORT_TICKETS_DEFAULT_LIMIT}; a larger value is clamped to ${SUPPORT_TICKETS_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
    }),
  } as const;
  const supportMessagesQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many messages to return. Defaults to ${SUPPORT_MESSAGES_DEFAULT_LIMIT}; a larger value is clamped to ${SUPPORT_MESSAGES_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor, which names the page *before* the one returned: a conversation opens at its newest end and pages backwards.',
        }),
    }),
  } as const;
  const supportCursorRefused = {
    description:
      'The cursor is malformed, altered or from a version this API no longer reads (`SUPPORT_TICKETS_CURSOR_INVALID`). One answer for all three: the remedy is to start again without it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const supportNotFound = {
    description:
      'There is no such ticket, message or attachment for this caller. Identical to the answer for one belonging to somebody else, and to the answer for an agent’s message on the caller’s own ticket, so asking cannot reveal that any of them exists.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  // Owner Decision 1: three approved numbers, counted per authenticated account. A refusal names no bucket.
  const supportTicketThrottled = {
    description:
      'The approved support limit rejected the request (`THROTTLED`): five tickets per account per 24 hours. Which window was hit is not disclosed, and nothing was written.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const supportMessageThrottled = {
    description:
      'The approved support limits rejected the request (`THROTTLED`): thirty messages per account per minute and three hundred per hour. Which window was hit is not disclosed, and nothing was written.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const supportUploadThrottled = {
    description:
      'The existing storage upload allowance rejected the request (`THROTTLED`): twenty signed-upload authorizations per account per hour, shared with the seller media surface because it is the same provider operation. Nothing was signed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const supportConflict = {
    description:
      'The ticket is closed (`SUPPORT_TICKET_NOT_ACTIONABLE`), so it takes no further message, no further attachment and no second closure. Nothing is changed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/support/tickets',
    operationId: 'getV1SupportTickets',
    summary: 'The support tickets the caller raised',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of this account’s own tickets, newest first, scoped to the caller inside the statement so another account’s ticket is never matched. A row carries the reference to quote to an agent, the subject, the category, the status and the counts — and **no assigned agent, no assignment time, no priority and no first-response time**: those are the console’s and are not in the contract at all.',
    request: { ...sessionHeader, ...supportTicketsQuery },
    responses: {
      200: {
        description: 'One page of the caller’s own tickets, newest first. Empty for an account with none.',
        content: { 'application/json': { schema: SupportTicketsResponseSchema } },
      },
      400: supportCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/support/tickets',
    operationId: 'postV1SupportTickets',
    summary: 'Open a support ticket',
    description:
      'Requires the internal BFF credential and the caller’s session. **The request names a subject, one of the eight existing categories and the first message, and nothing else**: there is no priority (the schema’s `normal` default stands), no status, no assignee and no related order in the body, and a strict schema refuses each of them. The ticket is created with its first message in one transaction, which is why the status returned is `pending_agent` rather than `open`. No notification is sent: the repository defines no support notification event.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: OpenSupportTicketSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The ticket, its first message, its reference and the status it now holds.',
        content: { 'application/json': { schema: OpenSupportTicketResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      429: supportTicketThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/support/tickets/{ticketId}',
    operationId: 'getV1SupportTicket',
    summary: 'One support ticket the caller raised',
    description:
      'Requires the internal BFF credential and the caller’s session. Answered for the account that raised the ticket and for nobody else; a ticket belonging to somebody else and one that does not exist are the same 404. Internal notes are a different table and are in no shape this operation can return.',
    request: { ...sessionHeader, ...ticketParam },
    responses: {
      200: {
        description: 'The ticket.',
        content: { 'application/json': { schema: SupportTicketDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: supportNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/support/tickets/{ticketId}/messages',
    operationId: 'getV1SupportTicketMessages',
    summary: 'One support ticket’s conversation',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of the ticket’s messages, chosen newest-first from the cursor and returned **in reading order**, so a client renders what it receives without re-sorting. A message says which side wrote it and whether it is the caller’s own; it never carries an author’s account identifier. **Internal notes are never here** — they are a separate table with no requester read path. An attachment travels as its display fields and its identifier, never as a storage path.',
    request: { ...sessionHeader, ...ticketParam, ...supportMessagesQuery },
    responses: {
      200: {
        description: 'One page of the conversation, oldest first within the page.',
        content: { 'application/json': { schema: SupportMessagesResponseSchema } },
      },
      400: supportCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      404: supportNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/support/tickets/{ticketId}/messages',
    operationId: 'postV1SupportTicketMessages',
    summary: 'Reply on one’s own support ticket',
    description:
      'Requires the internal BFF credential and the caller’s session. The ticket is named in the route and the body is the message alone: there is no author field, and the author’s role is worked out from the ticket inside the database rather than trusted. A requester’s reply moves the ticket to `pending_agent`; on a `resolved` ticket it is accepted and the status is left where it is; on a closed ticket it is refused with 409.',
    request: {
      ...sessionHeader,
      ...ticketParam,
      body: { content: { 'application/json': { schema: PostSupportMessageSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The message that now exists, and the status the ticket now holds.',
        content: { 'application/json': { schema: SupportMessageMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      429: supportMessageThrottled,
      404: supportNotFound,
      409: supportConflict,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/support/tickets/{ticketId}/close',
    operationId: 'postV1SupportTicketClose',
    summary: 'Close one’s own support ticket',
    description:
      'Requires the internal BFF credential and the caller’s session. **The operation names the transition and the body is empty**: there is no status field anywhere in this request, and the database passes the literal `closed` to the existing writer, so `resolved` — the agent’s outcome — cannot be recorded here. A closed ticket takes no further message, and nothing in the repository reopens one; somebody who needs more help opens another ticket. It sends no notification and creates no obligation of any kind.',
    request: { ...sessionHeader, ...ticketParam },
    responses: {
      200: {
        description: 'The status the ticket now holds, which can only be `closed`.',
        content: { 'application/json': { schema: SupportTicketClosureResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: supportNotFound,
      409: supportConflict,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/support/tickets/{ticketId}/messages/{messageId}/attachments/uploads',
    operationId: 'postV1SupportAttachmentUpload',
    summary: 'Authorize one support attachment upload',
    description:
      'Requires the internal BFF credential and the caller’s session. Authorizes a single upload into the **private** `support-attachments` bucket and returns the one object path it may go to. **The request carries no path**: the bucket, the ticket, the message and a fresh random file name are all composed in the database from rows the caller was found to own, so a traversal or another ticket’s namespace is unrepresentable rather than merely refused. The type and size ceilings are the bucket’s own, read at call time. A message that is not the caller’s own — including an agent’s message on the caller’s own ticket — is 404. Nothing is written.',
    request: {
      ...sessionHeader,
      ...ticketMessageParams,
      body: {
        content: { 'application/json': { schema: SupportAttachmentUploadRequestSchema } },
        required: true,
      },
    },
    responses: {
      201: {
        description: 'A short-lived upload authorization for exactly one object.',
        content: { 'application/json': { schema: SupportAttachmentUploadResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      429: supportUploadThrottled,
      404: supportNotFound,
      409: supportConflict,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/support/tickets/{ticketId}/messages/{messageId}/attachments',
    operationId: 'postV1SupportAttachments',
    summary: 'Record a support attachment that was uploaded',
    description:
      'Requires the internal BFF credential and the caller’s session. Records the path the previous operation issued, after the API has confirmed with the storage provider that the object is actually there. The expected prefix is rebuilt in the database from the caller’s own ticket and message, and the remainder must be one plain file name of the shape the authorization issues, so a path for another ticket, another message, another bucket or with a traversal in it cannot be recorded. A path already recorded is refused rather than stored twice. No event and no notification is written.',
    request: {
      ...sessionHeader,
      ...ticketMessageParams,
      body: {
        content: { 'application/json': { schema: SupportAttachmentRecordSchema } },
        required: true,
      },
    },
    responses: {
      201: {
        description: 'The attachment that now exists, and how many that message carries.',
        content: { 'application/json': { schema: SupportAttachmentRecordResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: supportNotFound,
      409: supportConflict,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/support/tickets/{ticketId}/attachments/{attachmentId}/link',
    operationId: 'getV1SupportAttachmentLink',
    summary: 'A short-lived link to one support attachment',
    description:
      'Requires the internal BFF credential and the caller’s session. Returns a signed URL for exactly one object for a few minutes. **The caller names an attachment; the path comes from the row**: no operation on this surface accepts a storage path, and the database requires the attachment, its message’s ticket and the ticket in the route to agree, so an identifier cannot be spent against another ticket. The bucket stays private and the URL is the only authorization that ever reaches a browser.',
    request: { ...sessionHeader, ...ticketAttachmentParams },
    responses: {
      200: {
        description: 'The signed URL and when it stops working.',
        content: { 'application/json': { schema: SupportAttachmentLinkResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: supportNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  /* -------------------------------------------------------------------------------------------- */
  /* Phase 7-L — the support agent console                                                         */
  /* -------------------------------------------------------------------------------------------- */

  const consoleTicketParam = {
    params: z.object({
      ticketId: z
        .uuid()
        .openapi({ description: 'One support ticket the calling agent may work on: theirs, or nobody’s.' }),
    }),
  } as const;
  const consoleAttachmentParams = {
    params: z.object({
      ticketId: z.uuid().openapi({ description: 'One support ticket the calling agent may work on.' }),
      attachmentId: z.uuid().openapi({ description: 'One attachment on a message of that same ticket.' }),
    }),
  } as const;
  const consoleListQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${SUPPORT_CONSOLE_DEFAULT_LIMIT}; a larger value is clamped to ${SUPPORT_CONSOLE_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
    }),
  } as const;
  const consoleCursorRefused = {
    description:
      'The cursor is malformed, altered or from a version this API no longer reads (`SUPPORT_TICKETS_CURSOR_INVALID`). The remedy is to start again without it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const consoleNotFound = {
    description:
      'There is no such ticket, message or attachment **for this caller**. One answer for a ticket held by another agent, a ticket that does not exist, a caller without the permission the operation needs, a caller at `aal1`, and — on the four writes — a ticket nobody has claimed. Asking therefore reveals nothing about a colleague’s work.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const consoleConflict = {
    description:
      'The ticket cannot take this action (`SUPPORT_TICKET_NOT_WORKABLE`): it is closed, or resolution was asked for on a ticket already resolved. Nothing is changed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/support/queue',
    operationId: 'getV1AdminSupportQueue',
    summary: 'The shared support queue',
    description:
      'Requires the internal BFF credential and a staff session holding `support.ticket.read` in an aal2 session. One page of the tickets **assigned to nobody**, in the two statuses migration 0028’s own queue index covers, **oldest first** — the priority column is returned as a fact and is deliberately not an ordering, because it is text and ordering it expresses no severity. Queue membership is the `assigned_to` column and nothing else: there is no routing rule, no team and no priority ranking. Empty for a caller who holds nothing, so the queue itself discloses no existence. It returns the requester’s display name and **no assignee, no agent identifier and no event trail**.',
    request: { ...sessionHeader, ...consoleListQuery },
    responses: {
      200: {
        description: 'One page of unassigned tickets, oldest first. Empty for an unauthorized caller.',
        content: { 'application/json': { schema: SupportQueueResponseSchema } },
      },
      400: consoleCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/support/assigned',
    operationId: 'getV1AdminSupportAssigned',
    summary: 'The tickets assigned to the calling agent',
    description:
      'Requires the internal BFF credential and a staff session holding `support.ticket.read` in an aal2 session. One page of the tickets assigned to **the caller**, any status, newest first. A separate operation from the queue rather than a filter on it: each is scoped by a predicate fixed in the database, so there is no argument a caller could supply that would show them another agent’s work.',
    request: { ...sessionHeader, ...consoleListQuery },
    responses: {
      200: {
        description: 'One page of the caller’s own tickets, newest first.',
        content: { 'application/json': { schema: SupportAssignedResponseSchema } },
      },
      400: consoleCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/support/tickets/{ticketId}',
    operationId: 'getV1AdminSupportTicket',
    summary: 'One support ticket, for the agent working it',
    description:
      'Requires the internal BFF credential and a staff session holding `support.ticket.read` in an aal2 session. Answered only for a ticket the caller may work on — theirs or nobody’s, which is 0028’s own agent policy predicate. `isMine` and `isAssigned` are derived in the database from the account the API established, so the console knows which controls to offer without ever learning who else holds a ticket; **`assignedTo` is in no response shape on this surface**.',
    request: { ...sessionHeader, ...consoleTicketParam },
    responses: {
      200: {
        description: 'The ticket.',
        content: { 'application/json': { schema: SupportConsoleTicketResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: consoleNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/support/tickets/{ticketId}/messages',
    operationId: 'getV1AdminSupportTicketMessages',
    summary: 'One ticket’s conversation, for the agent working it',
    description:
      'Requires the internal BFF credential and a staff session holding `support.ticket.read` in an aal2 session. The same conversation the requester reads, from the other side: chosen newest-first from the cursor and returned **in reading order**. `isOwnMessage` is true for the agent’s own messages here. A message never carries an author identifier, and an attachment travels as its display fields and its identifier, never as a storage path.',
    request: { ...sessionHeader, ...consoleTicketParam, ...consoleListQuery },
    responses: {
      200: {
        description: 'One page of the conversation, oldest first within the page.',
        content: { 'application/json': { schema: SupportConsoleMessagesResponseSchema } },
      },
      400: consoleCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      404: consoleNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/support/tickets/{ticketId}/messages',
    operationId: 'postV1AdminSupportTicketMessages',
    summary: 'Reply to the requester',
    description:
      'Requires the internal BFF credential and a staff session holding **`support.ticket.manage`** in an aal2 session, **and an actual assignment**: a ticket nobody has claimed is 404, because 0028’s `can_access_support_ticket` admits only the requester and the assigned agent — which is why claiming is its own operation. The body is the message alone; the author’s role is worked out from the ticket inside the database rather than trusted. A reply moves the ticket to `pending_requester` and stamps the first response the first time an agent answers; on a `resolved` ticket it is accepted and moves nothing. No notification is sent: the repository defines no support notification event.',
    request: {
      ...sessionHeader,
      ...consoleTicketParam,
      body: { content: { 'application/json': { schema: PostSupportAgentMessageSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The message that now exists, and the status the ticket now holds.',
        content: { 'application/json': { schema: SupportConsoleMessageMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: consoleNotFound,
      409: consoleConflict,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/support/tickets/{ticketId}/notes',
    operationId: 'getV1AdminSupportTicketNotes',
    summary: 'One ticket’s internal notes',
    description:
      'Requires the internal BFF credential and a staff session holding `support.ticket.read` in an aal2 session — which is the key 0028’s own `support_internal_notes_staff_read` policy names. **This is the only operation in the API that returns an internal note.** `support_internal_notes` has no requester read path anywhere in the repository, and no requester response schema can carry one. A note reports whether it is the caller’s own; it never carries an author identifier.',
    request: { ...sessionHeader, ...consoleTicketParam, ...consoleListQuery },
    responses: {
      200: {
        description: 'One page of the ticket’s internal notes, oldest first within the page.',
        content: { 'application/json': { schema: SupportInternalNotesResponseSchema } },
      },
      400: consoleCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      404: consoleNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/support/tickets/{ticketId}/notes',
    operationId: 'postV1AdminSupportTicketNotes',
    summary: 'Write an internal note',
    description:
      'Requires the internal BFF credential, **`support.ticket.manage`** in an aal2 session and an actual assignment. The note lands in the staff-only table, which 0028 separated from the conversation precisely so that "the requester can never read this" is a table-level fact rather than a column flag. A closed ticket takes no further note. The `note_added` event is the existing writer’s; nothing is written twice.',
    request: {
      ...sessionHeader,
      ...consoleTicketParam,
      body: { content: { 'application/json': { schema: AddSupportInternalNoteSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The note that now exists, and how many the ticket carries.',
        content: { 'application/json': { schema: SupportInternalNoteMutationResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: consoleNotFound,
      409: consoleConflict,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/support/tickets/{ticketId}/claim',
    operationId: 'postV1AdminSupportTicketClaim',
    summary: 'Take a ticket from the queue',
    description:
      'Requires the internal BFF credential and **`support.ticket.manage`** in an aal2 session. Assigns **the calling agent** to a ticket that is theirs or nobody’s: there is no agent field in the request, so nobody can be assigned by anybody else, and a ticket already held by a colleague is 404 exactly as it is to every read. The body is empty. Claiming moves an `open` ticket to `pending_agent` and moves nothing otherwise; claiming again is the existing writer’s no-op rather than a second event. A closed ticket is 409.',
    request: { ...sessionHeader, ...consoleTicketParam },
    responses: {
      200: {
        description: 'Where the ticket now stands, and that it is now the caller’s.',
        content: { 'application/json': { schema: SupportAssignmentResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: consoleNotFound,
      409: consoleConflict,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/support/tickets/{ticketId}/release',
    operationId: 'postV1AdminSupportTicketRelease',
    summary: 'Return a ticket to the queue',
    description:
      'Requires the internal BFF credential and **`support.ticket.manage`** in an aal2 session, and works only on a ticket the caller actually holds. It clears the assignee and its stamp and **changes no status**: the existing writer’s null branch moves the assignee, the Realtime membership version and the `unassigned` event, and nothing else. The body is empty.',
    request: { ...sessionHeader, ...consoleTicketParam },
    responses: {
      200: {
        description: 'The status the ticket keeps, and that it is no longer the caller’s.',
        content: { 'application/json': { schema: SupportAssignmentResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: consoleNotFound,
      409: consoleConflict,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/support/tickets/{ticketId}/decision',
    operationId: 'postV1AdminSupportTicketDecision',
    summary: 'Resolve or close a ticket',
    description:
      'Requires the internal BFF credential, **`support.ticket.manage`** in an aal2 session and an actual assignment. **The body admits `resolved` or `closed` and nothing else** — the two outcomes 0028’s own `close_support_ticket` defines — and the database checks the value against those literals before calling it. `resolved` stamps the resolution time and `closed` the closing time; a resolved ticket may then be closed, which is what the table’s own constraint contemplates. Resolving an already resolved ticket and acting on a closed one are both 409. There is no reopen operation anywhere, because nothing in the repository reopens a ticket. The requester’s own closure is a different function that takes no status and can only produce `closed`.',
    request: {
      ...sessionHeader,
      ...consoleTicketParam,
      body: {
        content: { 'application/json': { schema: SupportAgentDecisionRequestSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'The status the ticket now holds.',
        content: { 'application/json': { schema: SupportAgentDecisionResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: consoleNotFound,
      409: consoleConflict,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/support/tickets/{ticketId}/attachments/{attachmentId}/link',
    operationId: 'getV1AdminSupportAttachmentLink',
    summary: 'A short-lived link to one support attachment',
    description:
      'Requires the internal BFF credential and `support.ticket.read` in an aal2 session. Returns a signed URL for exactly one object for a few minutes, from the **private** `support-attachments` bucket. **The caller names an attachment; the path comes from the row**: no operation here accepts a storage path or a bucket, and the database requires the attachment, its message’s ticket and the ticket in the route to agree *and* the ticket to be one the caller may work on. The requester’s equivalent operation is scoped to `requester_user_id` and cannot serve staff at all, which is why this exists.',
    request: { ...sessionHeader, ...consoleAttachmentParams },
    responses: {
      200: {
        description: 'The signed URL and when it stops working.',
        content: { 'application/json': { schema: SupportConsoleAttachmentLinkResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: consoleNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  /* ---------------------------------------------------------------------------------------------- */
  /* Reports — the reporter side (Phase 7-M)                                                         */
  /* ---------------------------------------------------------------------------------------------- */
  const reportsQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${REPORTS_DEFAULT_LIMIT}; a larger value is clamped to ${REPORTS_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
    }),
  } as const;

  const reportSubjectNotFound = {
    description:
      'Nothing the public can see lives at that slug. One code and one sentence for a subject that is hidden, withdrawn, a draft, belongs to a storefront that is not publicly visible, or never existed — so none of them can be told from the others.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const reportSubjectRefused = {
    description:
      'The subject cannot be reported here: either the type is not one this surface files (`REPORT_SUBJECT_NOT_REPORTABLE` — a message or a conversation is reported from the conversation it is in) or it is the caller’s own storefront (`REPORT_SUBJECT_IS_THE_REPORTER`). Nothing is filed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const reportsCursorRefused = {
    description: 'The cursor could not be read (`REPORTS_CURSOR_INVALID`). No page is returned.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const reportThrottled = {
    description: 'The approved report filing limit rejected the request',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'post',
    path: '/v1/reports',
    operationId: 'postV1Reports',
    summary: 'Report a listing or a seller',
    description:
      'Requires the internal BFF credential and the caller’s session. Files a report about a listing or a seller the caller can actually see, through the platform’s existing reporting. **The subject is named by its public slug, never by an id**: a seller report’s subject is a user id, which the public seller projection exists to withhold, so no identifier is published and none is accepted back. A repeat lands on the report already open and answers with the same id, so submitting twice creates one report — that is the reports table’s own rule, enforced by a unique index. It is a request for a look and nothing else: the listing stays listed, the storefront stays open, and no moderation action is created. The reporter is the caller: no identifier is accepted from the request.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: FileReportRequestSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The report that is now open for this reporter and this subject.',
        content: { 'application/json': { schema: FileReportResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: reportSubjectNotFound,
      409: reportSubjectRefused,
      429: reportThrottled,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/reports',
    operationId: 'getV1Reports',
    summary: 'The reports the caller filed',
    description:
      'Requires the internal BFF credential and the caller’s session. One page of this account’s own reports, newest first, scoped to the caller inside the statement so another reporter’s row is never matched. A row carries what the reporter wrote, the status in the reports table’s own vocabulary, and — only while the subject is still publicly visible — that subject’s slug and label. It carries **no subject id, no priority, no assignee, no assignment time, no resolution, no resolution note, no resolver and no duplicate-of**: those are moderation state and are not in the contract at all.',
    request: { ...sessionHeader, ...reportsQuery },
    responses: {
      200: {
        description:
          'One page of the caller’s own reports, newest first. Empty for an account that has filed none.',
        content: { 'application/json': { schema: ReporterReportsResponseSchema } },
      },
      400: reportsCursorRefused,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  /* ---------------------------------------------------------------------------------------------- */
  /* Listing moderation and report management (Phase 7-N)                                            */
  /* ---------------------------------------------------------------------------------------------- */
  const moderationQueueQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${MODERATION_DEFAULT_LIMIT}; a larger value is clamped to ${MODERATION_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response\u2019s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
      status: z
        .string()
        .optional()
        .openapi({
          description:
            'Narrows the queue to one of the reports table\u2019s five statuses. An unknown value matches nothing rather than being refused.',
        }),
    }),
  } as const;

  const moderationListingQueueQuery = {
    query: z.object({
      limit: z.string().optional().openapi({ description: 'As above.' }),
      cursor: z.string().optional().openapi({ description: 'As above.' }),
    }),
  } as const;

  const reportIdParam = {
    params: z.object({ reportId: z.string().uuid() }),
  } as const;
  const moderationListingIdParam = {
    params: z.object({ listingId: z.string().uuid() }),
  } as const;

  const moderationNotFound = {
    description:
      'Nothing here for this caller. One code and one sentence for a row that does not exist and for a caller who does not hold the key at aal2, so neither can be told from the other and there is no forbidden on this surface.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const reportResolutionRefused = {
    description:
      'The decision was not recorded. `REPORT_ALREADY_FINAL` \u2014 the report is already actioned, dismissed or a duplicate, which the writer refuses. `REPORT_IS_OWN` \u2014 the caller filed it, and nobody rules on their own report. Nothing is changed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const listingModerationRefused = {
    description:
      'The decision was not recorded. `LISTING_IS_OWN` \u2014 the caller sells it. `LISTING_MODERATION_NO_CHANGE` \u2014 the action would leave the status where it is, which the schema refuses; this is what a repeat looks like and what the loser of two colleagues acting at once receives. `LISTING_MODERATION_NOT_APPLICABLE` \u2014 the listing cannot hold that status, because it has no price or was never approved. Nothing is changed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/moderation/reports',
    operationId: 'getV1AdminModerationReports',
    summary: 'The report queue',
    description:
      'Requires the internal BFF credential and `moderation.report.read` in an aal2 session. One page of reports, **oldest first**, optionally narrowed to one of the five existing statuses. The priority is returned as a fact and is never ordered by: the column is text, so the schema\u2019s own `priority desc` index orders it lexically and expresses no severity \u2014 ranking by it would present nonsense as meaning. A row carries the subject\u2019s type and, for the two types this repository can resolve, its label; it carries **no reporter, no assignee and no resolution note**.',
    request: { ...sessionHeader, ...moderationQueueQuery },
    responses: {
      200: {
        description: 'One page of reports, oldest first. Empty when nothing matches.',
        content: { 'application/json': { schema: ModerationReportQueueResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/moderation/reports/{reportId}',
    operationId: 'getV1AdminModerationReport',
    summary: 'One report',
    description:
      'Requires the internal BFF credential and `moderation.report.read` in an aal2 session. What was reported, what the reporter wrote, the decision already recorded if there is one, and \u2014 for a reported listing \u2014 the subject\u2019s **current status**, because acting on a report about a listing that is already suspended is the stale state this surface has to be able to see. `subjectIsResolvable` is false for the six subject types with no staff read path in this repository. It returns **no reporter account and no colleague\u2019s identity**: the caller learns whether the report and the decision are their own.',
    request: { ...sessionHeader, ...reportIdParam },
    responses: {
      200: {
        description: 'The report.',
        content: { 'application/json': { schema: ModerationReportDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: moderationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/moderation/reports/{reportId}/resolution',
    operationId: 'postV1AdminModerationReportResolution',
    summary: 'Record a decision on a report',
    description:
      'Requires the internal BFF credential and `moderation.report.manage` in an aal2 session. Records one of the four statuses the existing writer accepts \u2014 `triaged`, `actioned`, `dismissed`, `duplicate` \u2014 and **not `open`**, which that writer refuses: there is no un-triage and no reopen in this repository. Every status but `triaged` requires a note, and `duplicate` requires the report it duplicates. The moderator is the caller: no identifier is accepted from the request. The row is locked by the writer, so two colleagues resolving at once are ordered rather than raced, and the second is told the report is already final.',
    request: {
      ...sessionHeader,
      ...reportIdParam,
      body: { content: { 'application/json': { schema: ResolveReportRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The status the report now holds.',
        content: { 'application/json': { schema: ResolveReportResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: moderationNotFound,
      409: reportResolutionRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/moderation/reports/{reportId}/actions',
    operationId: 'getV1AdminModerationReportActions',
    summary: 'The moderation actions citing one report',
    description:
      'Requires the internal BFF credential and `moderation.action.read` in an aal2 session \u2014 the key the existing policy gates this table on, which is **not** the report read key. Newest first. Every field is one that policy admits, except the moderator: the caller learns whether an action was their own and never which colleague recorded another.',
    request: { ...sessionHeader, ...reportIdParam },
    responses: {
      200: {
        description: 'The actions citing this report, newest first. Empty when none does.',
        content: { 'application/json': { schema: ModerationActionsResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/moderation/listings',
    operationId: 'getV1AdminModerationListings',
    summary: 'The listings awaiting review',
    description:
      'Requires the internal BFF credential and `catalog.listing.read` in an aal2 session. A work queue: listings in `pending_review`, **oldest first**. A row carries what a moderator needs to recognise the listing, whether it is their own \u2014 which the writer would refuse \u2014 and how many reports are still open against it. It names **no seller account**. Moderating one of them needs the other key, checked on the action rather than on the reading.',
    request: { ...sessionHeader, ...moderationListingQueueQuery },
    responses: {
      200: {
        description: 'One page of listings awaiting review, oldest first.',
        content: { 'application/json': { schema: ModerationListingQueueResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/moderation/listings/{listingId}',
    operationId: 'getV1AdminModerationListing',
    summary: 'One listing, for a moderation decision',
    description:
      'Requires the internal BFF credential and `catalog.listing.read` in an aal2 session. The listing\u2019s content, its current status, its storefront\u2019s public name and slug, whether it is the caller\u2019s own, whether they hold the moderate key, and how many reports are still open. It returns **no seller account and no storage path**: moderating a listing touches no storage at all.',
    request: { ...sessionHeader, ...moderationListingIdParam },
    responses: {
      200: {
        description: 'The listing.',
        content: { 'application/json': { schema: ModerationListingDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: moderationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/moderation/listings/{listingId}/actions',
    operationId: 'postV1AdminModerationListingAction',
    summary: 'Moderate a listing',
    description:
      'Requires the internal BFF credential and `catalog.listing.moderate` in an aal2 session \u2014 the same key the existing write policy requires. Records one of the five actions the existing writer defines: `approve`, `reject`, `suspend`, `reinstate` and `request_changes`, which is the one that moves no status. A reason is required, because both writers require one. The writer moves the status, writes **both** moderation trails and enqueues its own event in one transaction; nothing is written a second time anywhere above it. It is not a reversal API: reinstatement is one of the five, and no operation here sets `reverses_action_id`.',
    request: {
      ...sessionHeader,
      ...moderationListingIdParam,
      body: { content: { 'application/json': { schema: ModerateListingRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The status the listing now holds.',
        content: { 'application/json': { schema: ModerateListingResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: moderationNotFound,
      409: listingModerationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/moderation/listings/{listingId}/history',
    operationId: 'getV1AdminModerationListingHistory',
    summary: 'One listing\u2019s moderation trail',
    description:
      'Requires the internal BFF credential and `moderation.action.read` in an aal2 session. Newest first, carrying the status move each decision made \u2014 which is what this table records and the generic trail does not. It names no moderator.',
    request: { ...sessionHeader, ...moderationListingIdParam },
    responses: {
      200: {
        description: 'The listing\u2019s moderation trail, newest first.',
        content: { 'application/json': { schema: ListingModerationHistoryResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  /* ---------------------------------------------------------------------------------------------- */
  /* Seller and user reads, seller status, recovery review, the audit trail (Phase 7-O)               */
  /*                                                                                                  */
  /* Fifteen operations, eleven of them reads. There is **no operation here that assigns or removes a  */
  /* role**: `public.user_roles` is written by nothing in this repository, and by owner decision that   */
  /* writer is deferred to a dedicated security-focused increment after Phase 7. The role surface is   */
  /* GET and nothing else, and no request body below has a field through which a grant could travel.   */
  /*                                                                                                  */
  /* Seller account status IS writable, under the decided transitions — see the status operation.       */
  /* ---------------------------------------------------------------------------------------------- */
  const adminOpsPaging = {
    limit: z
      .string()
      .optional()
      .openapi({
        description: `How many rows to return. Defaults to ${ADMIN_OPS_DEFAULT_LIMIT}; a larger value is clamped to ${ADMIN_OPS_MAX_LIMIT}.`,
      }),
    cursor: z
      .string()
      .optional()
      .openapi({
        description:
          'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
      }),
  } as const;

  const adminSellerQuery = {
    query: z.object({
      ...adminOpsPaging,
      status: z.string().optional().openapi({
        description:
          'Narrows to one of the four seller account statuses. An unknown value matches nothing rather than being refused.',
      }),
      verificationStatus: z.string().optional().openapi({
        description: 'Narrows to one of the four verification statuses. Unknown values match nothing.',
      }),
    }),
  } as const;

  const adminUserQuery = {
    query: z.object({
      ...adminOpsPaging,
      status: z.string().optional().openapi({
        description: 'Narrows to one of the three account statuses. Unknown values match nothing.',
      }),
    }),
  } as const;

  const recoveryQueueQuery = {
    query: z.object({
      ...adminOpsPaging,
      status: z.string().optional().openapi({
        description:
          'Narrows to one of the recovery table’s eight statuses. `approved` is among them and matches nothing in practice: an approval moves a request to `contact_verification`.',
      }),
    }),
  } as const;

  const auditQuery = {
    query: z.object({
      ...adminOpsPaging,
      tableSchema: z.string().optional().openapi({
        description: 'Narrows to one schema. One of the two filters the audit indexes support.',
      }),
      tableName: z.string().optional().openapi({ description: 'Narrows to one table within that schema.' }),
      recordId: z.string().optional().openapi({
        description: 'Narrows to one record within that table. Requires both tableSchema and tableName.',
      }),
    }),
  } as const;

  const sellerSlugParam = { params: z.object({ slug: z.string() }) } as const;
  const adminUserIdParam = { params: z.object({ userId: z.string().uuid() }) } as const;
  const recoveryRequestIdParam = { params: z.object({ requestId: z.string().uuid() }) } as const;

  const adminOpsNotFound = {
    description:
      'Nothing here for this caller. One code and one sentence for a row that does not exist and for a caller who does not hold the required key at aal2, so neither can be told from the other and there is no forbidden on any of these surfaces.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  const sellerStatusRefused = {
    description:
      'The status was not changed. `SELLER_STATUS_NOT_ALLOWED` \u2014 the transition is not one of the seven legal pairs: every move out of `closed`, which is terminal; `active \u2192 pending`; and `pending \u2192 active`, which belongs to the verification approval. `SELLER_STATUS_NO_CHANGE` \u2014 the storefront already holds that status, which is what a repeat and the loser of two colleagues acting at once receive. `SELLER_STATUS_REASON_REQUIRED` \u2014 a suspension with no reason. `SELLER_STATUS_NOT_VERIFIED` \u2014 reinstating to `active` a storefront that is not verified. `SELLER_STATUS_ALREADY_VERIFIED` \u2014 reinstating to `pending` one that is. Nothing is changed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  const staffRoleRefused = {
    description:
      'The role was not changed, and every code names which boundary stopped it. `STAFF_ROLE_IS_SELF` \u2014 the caller is the target; granting and withdrawing are both refused, so nobody promotes or demotes themselves. `STAFF_ROLE_ABOVE_CEILING` \u2014 the role sits above the caller\u2019s own highest effective role, or they effectively hold none; the remedy is somebody more senior. `STAFF_ROLE_NOT_GRANTABLE` and `STAFF_ROLE_NOT_REVOCABLE` \u2014 `super_admin`, from either side: this console neither creates nor destroys one. `STAFF_ROLE_NOT_ASSIGNABLE` \u2014 the role table marks that role unassignable, which is reference data rather than a state. `STAFF_ROLE_ALREADY_REVOKED` \u2014 the grant was already withdrawn, which is what a repeat and the loser of two colleagues acting at once receive. `STAFF_ROLE_EXPIRY_INVALID` \u2014 an expiry that is not in the future. `STAFF_ROLE_REASON_REQUIRED` \u2014 a blank reason, which the request schema refuses first. Nothing is changed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  const recoveryRefused = {
    description:
      'The step was not recorded. `RECOVERY_IS_OWN` — it is the caller’s own account, which the writer refuses at every step. `RECOVERY_NEEDS_ANOTHER_PERSON` — the caller reviewed this request, and the approver must be somebody else; the two-person rule. `RECOVERY_NOT_REVIEWABLE`, `RECOVERY_NOT_DECIDABLE`, `RECOVERY_NOT_COMPLETABLE` — the request is not in a state for that step, which is also what a repeat and the loser of two colleagues acting at once receive. Nothing is changed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/sellers',
    operationId: 'getV1AdminSellers',
    summary: 'The storefronts',
    description:
      'Requires the internal BFF credential and `sellers.profile.read` in an aal2 session. One page of storefronts, newest first, optionally narrowed by account status or verification status. A storefront is named by its **slug**: the account behind it is not returned, and no operation on this surface accepts one. It carries no legal name and no contact details. **Read-only** — there is no operation anywhere in this API that changes a seller’s account status, because no writer for it exists in the database.',
    request: { ...sessionHeader, ...adminSellerQuery },
    responses: {
      200: {
        description: 'One page of storefronts, newest first. Empty when nothing matches.',
        content: { 'application/json': { schema: AdminSellerPageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/sellers/{slug}',
    operationId: 'getV1AdminSeller',
    summary: 'One storefront',
    description:
      'Requires the internal BFF credential and `sellers.profile.read` in an aal2 session. The storefront’s standing — status, any suspension and its reason, verification status, listing and open-report counts. It returns none of the owner’s personal or contact details, no verification document and no storage path: 7-G owns the verification review and this is not it. The caller learns whether the storefront is their own.',
    request: { ...sessionHeader, ...sellerSlugParam },
    responses: {
      200: {
        description: 'The storefront.',
        content: { 'application/json': { schema: AdminSellerDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminOpsNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/sellers/{slug}/status',
    operationId: 'postV1AdminSellerStatus',
    summary: 'Change one storefront\u2019s account status',
    description:
      'Requires the internal BFF credential and `sellers.profile.manage` in an aal2 session \u2014 a key the role catalogue gives to administrators alone, and **not** the seller read key: a moderator reads storefronts and cannot move one. The body carries a target status and, for a suspension, its reason; the legal transitions are decided in the database, which locks the row first. The seven legal pairs are `pending \u2192 suspended`, `active \u2192 suspended`, `suspended \u2192 active`, `suspended \u2192 pending`, and `closed` from any of the three. **`closed` is terminal** \u2014 nothing reopens a closed storefront \u2014 `active \u2192 pending` is refused, and **`pending \u2192 active` belongs to the verification approval**, not to this operation. Reinstatement goes to `active` when the storefront is verified and to `pending` when it is not. It sets the timestamps the schema\u2019s own constraints require, clears the suspension and its reason on reinstatement, and touches **neither verification column**. It **cascades into nothing**: no listing, service, offer, service request, order, balance or payout is read or written, because public visibility already follows seller status through the catalogue\u2019s own visibility rule. The change is recorded by the storefront table\u2019s existing audit trigger; this operation writes no audit row, no security event and no notification of its own.',
    request: {
      ...sessionHeader,
      ...sellerSlugParam,
      body: { content: { 'application/json': { schema: SellerStatusChangeRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The status was changed, with the status the storefront now holds.',
        content: { 'application/json': { schema: SellerStatusChangeResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminOpsNotFound,
      409: sellerStatusRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/users',
    operationId: 'getV1AdminUsers',
    summary: 'The accounts',
    description:
      'Requires the internal BFF credential and `users.profile.read` in an aal2 session. One page of accounts, newest first. Whether each contact channel was verified is reported as a **boolean**, never as the contact: there is no legal name, no phone number, no email address and no avatar path in this response. Deleted accounts are not listed. This is the one admin surface addressed by account id, because the account is the subject being administered and this key is precisely the permission to read it.',
    request: { ...sessionHeader, ...adminUserQuery },
    responses: {
      200: {
        description: 'One page of accounts, newest first. Empty when nothing matches.',
        content: { 'application/json': { schema: AdminUserPageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/users/{userId}',
    operationId: 'getV1AdminUser',
    summary: 'One account',
    description:
      'Requires the internal BFF credential and `users.profile.read` in an aal2 session. The same narrow projection as the list, with the timezone, the last-seen time and — when the account has a storefront — that storefront’s **slug**, so the two surfaces link without an account identifier crossing in the other direction. A deleted account answers 404, identically to one that never existed.',
    request: { ...sessionHeader, ...adminUserIdParam },
    responses: {
      200: {
        description: 'The account.',
        content: { 'application/json': { schema: AdminUserDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminOpsNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/users/{userId}/roles',
    operationId: 'getV1AdminUserRoles',
    summary: 'The roles one account holds',
    description:
      'Requires the internal BFF credential and `users.role.read` in an aal2 session — a **different key** from the account read, which is what the existing policy gates this table on, and one that neither a moderator nor a support agent holds. Each grant says whether it is currently effective under the roles table’s own rule: not revoked, not expired. It names nobody who granted or revoked it, and that is unchanged by the writers below: who acted and why is recorded on the row and reported in no response. The operations that change a grant are `POST /v1/admin/users/{userId}/roles` and `POST /v1/admin/users/{userId}/roles/revoke`, both behind `users.role.manage` rather than this key, so a colleague who may read roles can change none.',
    request: { ...sessionHeader, ...adminUserIdParam },
    responses: {
      200: {
        description: 'The account’s role grants, effective and otherwise.',
        content: { 'application/json': { schema: AdminUserRolesResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/track',
    operationId: 'postV1Track',
    summary: 'Batched listing analytics ingestion',
    description:
      'Requires the internal BFF credential, like every `/v1` route, and **no session** — a signed-out visitor browsing the catalogue is the normal case, so the account is optional and its absence simply means the events have none. A session token, when the caller has one, is the **only** source of the account: the request body has no `userId` field and the schema is strict, so a caller cannot claim to be somebody. The session digest stored with each event is computed server-side from an opaque identifier under a dedicated domain-separated key, so a caller cannot choose it either. At most fifty events per request, refused whole rather than truncated. Only four event types are ingested — `click`, `contact`, `favorite`, `share`; `impression` and `view` are refused, because the impression definition is a Phase 9 decision. A dedicated rate limit applies per address and **fails closed**: if no counter can answer, the request is refused. `accepted` is how many events the server took responsibility for, not how many rows were written — de-duplication happens downstream on the event id alone, through a database identity ledger, so a retried batch legitimately writes none whatever timestamp it carries, and a client has no use for the row count. Nothing in the response reveals whether a listing exists.',
    request: {
      body: { content: { 'application/json': { schema: TrackRequestSchema } } },
    },
    responses: {
      202: {
        description: 'The events were accepted for ingestion.',
        content: { 'application/json': { schema: TrackResponseSchema } },
      },
      400: validationFailed,
      403: credentialRejected,
      429: {
        description:
          'Over the ingestion rate limit. The limit fails closed: a request is also refused when no counter can answer, so an attacker who takes Redis down does not thereby remove the limit.',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/roles/grantable',
    operationId: 'getV1AdminGrantableRoles',
    summary: 'The roles this caller may grant',
    description:
      'Requires the internal BFF credential and `users.role.manage` in an aal2 session. **The set is computed in the database** from the caller’s own effective roles, by the same three tests the grant writer applies: the role must be assignable, it must not be `super_admin`, and its position in the role order must not be above the caller’s own highest effective role. So a console renders this list rather than filtering a catalogue — a filter in a client is a convention, and this is a privilege boundary. An empty list is also the answer for a caller who does not hold the key, so the two are indistinguishable. `admin` is the highest role this endpoint ever returns, to anybody.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The roles this caller may grant, in the platform’s own role order.',
        content: { 'application/json': { schema: StaffGrantableRolesResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/users/{userId}/roles',
    operationId: 'postV1AdminUserRole',
    summary: 'Grant a role to one account',
    description:
      'Requires the internal BFF credential and `users.role.manage` in an aal2 session. A `reason` is always required, and a value of whitespace is not one. `expiresAt` is optional and must be in the future; absent means a grant that does not expire, and a later grant of the same role is the only way to change an expiry. Granting a role the account already holds refreshes that single grant rather than adding a second, and granting one that was withdrawn reinstates it with a fresh actor, moment and reason — there is no operation anywhere that clears a withdrawal on its own. **Every boundary is applied in the database against the caller’s own effective roles**: a self-grant is refused, `super_admin` is never grantable, a role the role table marks unassignable is refused, and a role above the caller’s own highest effective role is refused. Nothing in the request body can widen any of that. A caller without the key, an account that does not exist and a role key that names no role are one indistinguishable 404.',
    request: {
      ...sessionHeader,
      ...adminUserIdParam,
      body: { content: { 'application/json': { schema: StaffRoleGrantRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The role was granted, or a withdrawn grant was reinstated.',
        content: { 'application/json': { schema: StaffRoleWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminOpsNotFound,
      409: staffRoleRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/users/{userId}/roles/revoke',
    operationId: 'postV1AdminUserRoleRevoke',
    summary: 'Withdraw a role from one account',
    description:
      'Requires the internal BFF credential and `users.role.manage` in an aal2 session, and a `reason` as the grant does. **The row is never deleted**: the withdrawal is recorded on it with who did it and why, beside the grant it withdraws, so the history of an assignment survives its removal. Reinstatement is a fresh grant through the other operation. A self-withdrawal is refused, `super_admin` cannot be withdrawn here any more than it can be granted, and a role above the caller’s own highest effective role is refused. **The withdrawal takes effect on the target’s next request**, when the permission predicates are next evaluated: nothing in this platform terminates a session, and this operation does not claim to. Withdrawing a grant that is already withdrawn is refused rather than recorded twice, which is also what the second of two colleagues acting at once receives.',
    request: {
      ...sessionHeader,
      ...adminUserIdParam,
      body: { content: { 'application/json': { schema: StaffRoleRevokeRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The role was withdrawn.',
        content: { 'application/json': { schema: StaffRoleWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminOpsNotFound,
      409: staffRoleRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/users/{userId}/security-events',
    operationId: 'getV1AdminUserSecurityEvents',
    summary: 'One account’s security timeline',
    description:
      'Requires the internal BFF credential and `users.security.read` in an aal2 session — a **third key**, which the role catalogue withholds from both moderators and support agents by decision, so holding the account read is not holding this. Newest first. `details` carries identifiers only, never credentials or message bodies, and the request address and device are not returned. It writes nothing.',
    request: { ...sessionHeader, ...adminUserIdParam },
    responses: {
      200: {
        description: 'The account’s security events, newest first.',
        content: { 'application/json': { schema: AdminSecurityEventsResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/roles',
    operationId: 'getV1AdminRoles',
    summary: 'The role catalogue',
    description:
      'Requires the internal BFF credential and `users.role.read` in an aal2 session. Reference data: each role, whether it requires MFA, whether it opens the console, whether it is assignable, how many permissions it carries and how many accounts currently hold it. It names no holder. Nothing in this API changes a role, its permissions or its MFA requirement.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'The role catalogue, in the catalogue’s own order.',
        content: { 'application/json': { schema: AdminRoleCatalogueResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/recovery/requests',
    operationId: 'getV1AdminRecoveryRequests',
    summary: 'The account recovery queue',
    description:
      'Requires the internal BFF credential and `security.recovery.review` in an aal2 session — a key a support agent holds and a moderator does not. **Oldest first**: these are people locked out of their accounts. A row reports the contact **channel** and never a contact, because the claimed and new contacts are stored as digests. `isOwnRequest` and `isTheReviewer` are returned because the writer refuses the account holder at every step and refuses the reviewer as the second approver, so a console that could not see them would offer a control the database is going to reject. No account identifier, no colleague’s identity and no request address.',
    request: { ...sessionHeader, ...recoveryQueueQuery },
    responses: {
      200: {
        description: 'One page of recovery requests, oldest first. Empty when nothing matches.',
        content: { 'application/json': { schema: RecoveryQueueResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/recovery/requests/{requestId}',
    operationId: 'getV1AdminRecoveryRequest',
    summary: 'One recovery request',
    description:
      'Requires the internal BFF credential and `security.recovery.review` in an aal2 session. The state, the review note, the rejection reason, and the effects completing a recovery recorded — sessions revoked, any MFA reset, and the hold it started on withdrawals and payout changes. Those three are **read back and never sent**: the hold is computed by the database from a site setting and no field in this API can shorten, skip or clear it. It returns no contact, no account identifier, no colleague’s identity and no OTP challenge.',
    request: { ...sessionHeader, ...recoveryRequestIdParam },
    responses: {
      200: {
        description: 'The recovery request.',
        content: { 'application/json': { schema: RecoveryRequestDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminOpsNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/recovery/requests/{requestId}/evidence',
    operationId: 'getV1AdminRecoveryEvidence',
    summary: 'What a recovery request supplied',
    description:
      'Requires the internal BFF credential and `security.recovery.review` in an aal2 session. The kind of each document, its file name, type and size, so a reviewer knows whether there is enough to judge. It returns **no object path**: the bucket is private and this operation is not a way to read the file, which would need a signing step this increment does not add.',
    request: { ...sessionHeader, ...recoveryRequestIdParam },
    responses: {
      200: {
        description: 'The documents supplied, oldest first.',
        content: { 'application/json': { schema: RecoveryEvidenceResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/recovery/requests/{requestId}/review',
    operationId: 'postV1AdminRecoveryReview',
    summary: 'Record the identity review',
    description:
      'Requires the internal BFF credential and `security.recovery.review` in an aal2 session. Delegates to the existing recovery writer, which locks the row and **fixes the caller as the reviewer** — the identity the second approver is later checked against. The reviewer is the caller: no identifier is accepted from the request. A request already past review answers 409 `RECOVERY_NOT_REVIEWABLE`, and the caller’s own account answers 409 `RECOVERY_IS_OWN`.',
    request: {
      ...sessionHeader,
      ...recoveryRequestIdParam,
      body: { content: { 'application/json': { schema: RecoveryReviewRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The review was recorded, with the state the request now holds.',
        content: { 'application/json': { schema: RecoveryReviewResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminOpsNotFound,
      409: recoveryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/recovery/requests/{requestId}/decision',
    operationId: 'postV1AdminRecoveryDecision',
    summary: 'The second approver’s decision',
    description:
      'Requires the internal BFF credential and `security.recovery.review` in an aal2 session. Carries the existing writer’s **two decisions and no third** — `approved` or `rejected` — and a rejection is always recorded with its reason. **An approval moves the request to `contact_verification`, not to `approved`**: that status exists in the table and no writer in this repository sets it. The writer refuses the reviewer and the account holder, both of which answer 409 `RECOVERY_NEEDS_ANOTHER_PERSON`: somebody else has to decide it. A request nobody has reviewed answers 409 `RECOVERY_NOT_DECIDABLE`, which is also what the second of two colleagues deciding at once receives. No approver identifier is accepted from the request.',
    request: {
      ...sessionHeader,
      ...recoveryRequestIdParam,
      body: { content: { 'application/json': { schema: RecoveryDecisionRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The decision was recorded, with the state the request now holds.',
        content: { 'application/json': { schema: RecoveryDecisionResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminOpsNotFound,
      409: recoveryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/recovery/requests/{requestId}/completion',
    operationId: 'postV1AdminRecoveryCompletion',
    summary: 'Finish a recovery',
    description:
      'Requires the internal BFF credential and `security.recovery.review` in an aal2 session. Delegates to the existing writer, which revokes the account’s sessions, records any MFA reset, starts the configured hold and writes both the security event and the outbox event — none of which this API duplicates. `mfaWasReset` records what the colleague did out of band and changes nothing about whether the recovery may complete. **The hold is returned, never sent**, and no field here can shorten it or skip the one-time-code verification of the new contact that completion depends on — that step is the requester’s, and there is no operation in this API for it. A request that is not approved, whose contact was not verified, or that matched no account answers 409 `RECOVERY_NOT_COMPLETABLE`.',
    request: {
      ...sessionHeader,
      ...recoveryRequestIdParam,
      body: { content: { 'application/json': { schema: RecoveryCompletionRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The recovery is complete, with the hold the writer started.',
        content: { 'application/json': { schema: RecoveryCompletionResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: adminOpsNotFound,
      409: recoveryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/audit',
    operationId: 'getV1AdminAudit',
    summary: 'The audit trail',
    description:
      'Requires the internal BFF credential and `audit.read` in an aal2 session — a key only an administrator holds. Newest first, over the index the audit table is built on, optionally narrowed to one table or one record within it: those are the two filters those indexes support, and there is deliberately no actor filter, because assembling one colleague’s activity is not what an audit read is for. A row reports **which columns changed and never their values**: the old and new rows are whole-row JSON redacted per calling trigger, so a projection carrying them would expose every unredacted column of every audited table to anybody holding this key. No actor identifier and no request address. **Strictly read-only**: reading the audit trail writes nothing to it, and there is no audit writer anywhere in this API.',
    request: { ...sessionHeader, ...auditQuery },
    responses: {
      200: {
        description: 'One page of the audit trail, newest first. Empty when nothing matches.',
        content: { 'application/json': { schema: AuditPageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  /* ---------------------------------------------------------------------------------------------- */
  /* Review moderation (Phase 7-P)                                                                   */
  /*                                                                                                  */
  /* Four operations: the queue, one review with its reply, that review's trail, and one decision.     */
  /* There is **no operation that moderates a review reply**: nothing in this repository writes a      */
  /* reply's status, and that gap is reported rather than invented. A reply is returned so a moderator  */
  /* can read the whole exchange, and hiding a review already hides its reply, because a reply is      */
  /* publicly readable only while its parent review is published.                                       */
  /* ---------------------------------------------------------------------------------------------- */
  const reviewQueueQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${REVIEW_MODERATION_DEFAULT_LIMIT}; a larger value is clamped to ${REVIEW_MODERATION_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
      status: z
        .string()
        .optional()
        .openapi({
          description:
            'Narrows the queue to one of the four review statuses. An unknown value matches nothing rather than being refused.',
        }),
    }),
  } as const;

  const reviewIdParam = { params: z.object({ reviewId: z.string().uuid() }) } as const;

  const reviewNotFound = {
    description:
      'Nothing here for this caller. One code and one sentence for a review that does not exist and for a caller who does not hold the key at aal2, so neither can be told from the other and there is no forbidden on this surface.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  const reviewModerationRefused = {
    description:
      'The decision was not recorded. `REVIEW_IS_PARTY` — the caller is the review’s buyer or its seller, which the writer refuses; the remedy is for a colleague to take it. `REVIEW_REASON_REQUIRED` — a decision with no reason. There is deliberately no code for an illegal transition, because the writer imposes no transition matrix. Nothing is changed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/reviews',
    operationId: 'getV1AdminReviews',
    summary: 'The review queue',
    description:
      'Requires the internal BFF credential and `reviews.review.read` in an aal2 session. One page of reviews, **newest first**, optionally narrowed to one of the four statuses. Newest first rather than oldest: a review is published immediately and `pending_moderation` is a state a moderator puts one into, not one a review arrives in, so there is no work queue to drain here — and no score, no priority and no ranking, because the schema defines none. A row carries the rating, the title, whether there is prose to read, and whether a reply exists; it carries **no buyer, no seller account, no colleague moderator and no order** — the storefront is named by its slug. `isParty` says whether the caller is the review’s buyer or seller, because the writer refuses those and a console should say so before a colleague tries.',
    request: { ...sessionHeader, ...reviewQueueQuery },
    responses: {
      200: {
        description: 'One page of reviews, newest first. Empty when nothing matches.',
        content: { 'application/json': { schema: ReviewQueueResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/reviews/{reviewId}',
    operationId: 'getV1AdminReview',
    summary: 'One review, with its reply',
    description:
      'Requires the internal BFF credential and `reviews.review.read` in an aal2 session. What was written, the state, the reason automation hid it if it did, any decision already recorded, and the seller’s reply beside it. `publicationBlock` is why the automatic reassessment would hide this review — its order was refunded, or its payment is disputed — reported so a moderator publishing one can see what they are overriding; **the order itself is not returned**. `canModerate` says whether this same session may record a decision, because the read and the write are two different keys. The reply is **read-only**: no operation in this API changes a reply’s status, because no writer for one exists.',
    request: { ...sessionHeader, ...reviewIdParam },
    responses: {
      200: {
        description: 'The review.',
        content: { 'application/json': { schema: ReviewDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: reviewNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/reviews/{reviewId}/actions',
    operationId: 'getV1AdminReviewActions',
    summary: 'The moderation actions recorded against one review',
    description:
      'Requires the internal BFF credential and `moderation.action.read` in an aal2 session — the key the existing policy gates that table on, which is **not** the review read key. Newest first. It reuses the platform’s generic moderation trail rather than creating a second history, and names no moderator: the caller learns whether an action was their own.',
    request: { ...sessionHeader, ...reviewIdParam },
    responses: {
      200: {
        description: 'The review’s moderation trail, newest first.',
        content: { 'application/json': { schema: ReviewModerationActionsResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/reviews/{reviewId}/moderation',
    operationId: 'postV1AdminReviewModeration',
    summary: 'Record a decision on one review',
    description:
      'Requires the internal BFF credential and `reviews.review.moderate` in an aal2 session — a **different key** from the one that reads the review. The body carries one of the four statuses and a reason, which is required for **every** decision and not only the ones that hide something. **There is no transition matrix**: the writer accepts any of the four from any of them, and re-recording the status a review already holds re-affirms it with a fresh reason. The writer locks the row, records who ruled and when, clears the automatic hiding reason, moves the publication time only when publishing, and enqueues its own event — none of which this API duplicates. It refuses a caller who is the review’s buyer or seller (409 `REVIEW_IS_PARTY`). Once a decision is recorded, the automatic reassessment that hides reviews on refunded or disputed orders leaves that review alone. It moderates the review and **never its reply**: no writer for a reply exists.',
    request: {
      ...sessionHeader,
      ...reviewIdParam,
      body: { content: { 'application/json': { schema: ModerateReviewRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The decision was recorded, with the status the review now holds.',
        content: { 'application/json': { schema: ModerateReviewResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: reviewNotFound,
      409: reviewModerationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  /* ---------------------------------------------------------------------------------------------- */
  /* Platform job runs and outbox health (Phase 7-Q) — five operations, all GET                      */
  /* ---------------------------------------------------------------------------------------------- */
  //
  // **There is no POST, PATCH or DELETE anywhere in this group, and that is the point of the group.** The
  // workers own every write to `job_runs` and `outbox_events`; no writer for a retry, a cancel, a requeue or
  // a dead-letter replay exists in this repository, so no operation here offers one and no request body could
  // ask for one.

  const jobRunQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${PLATFORM_OPS_DEFAULT_LIMIT}; a larger value is clamped to ${PLATFORM_OPS_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
      status: z
        .string()
        .optional()
        .openapi({
          description:
            'Narrows the list to one of the four run statuses. An unknown value matches nothing rather than being refused.',
        }),
      jobName: z
        .string()
        .optional()
        .openapi({
          description:
            'Narrows the list to one job name. An unknown name matches nothing rather than being refused.',
        }),
    }),
  } as const;

  const runIdParam = { params: z.object({ runId: z.string().uuid() }) } as const;

  const platformNotFound = {
    description:
      'Nothing here for this caller. One code and one sentence for a run that does not exist and for a caller who does not hold `platform.job.read` at aal2, so neither can be told from the other and there is no forbidden on this surface.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/platform/job-runs',
    operationId: 'getV1AdminPlatformJobRuns',
    summary: 'Job runs, newest first',
    description:
      'Requires the internal BFF credential and `platform.job.read` in an aal2 session — a key only Admin and Super Admin hold. One page of recorded job runs, newest first, optionally narrowed to one of the four statuses or to one job name. `durationMs` is computed from the run’s own timestamps and is null exactly while a run is still going. `processedCount` is null when a run recorded no count, which is a different fact from a run that processed zero. `isContracted` says whether the schedule still names this job key; a run of a key the contract has dropped stays readable and is labelled rather than hidden. **The run’s `details` object is not returned** — one of its keys is a raw PostgreSQL error message, which embeds row data — so a failure is reported by its error class here and by its error class and SQLSTATE on the detail.',
    request: { ...sessionHeader, ...jobRunQuery },
    responses: {
      200: {
        description: 'One page of job runs, newest first. Empty when nothing matches.',
        content: { 'application/json': { schema: JobRunPageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/platform/job-runs/{runId}',
    operationId: 'getV1AdminPlatformJobRun',
    summary: 'One job run',
    description:
      'Requires the internal BFF credential and `platform.job.read` in an aal2 session. One run, with the contract row it belongs to when the schedule still names its key: the cron expression, the function the job calls, and the purpose recorded for it — so a failure can be traced without opening a migration. A failure reports its error class and the five-character SQLSTATE. **The raw error message is deliberately absent**: the job runner stores it in a free-form details object, and a PostgreSQL error message quotes the row that caused it, so reading the text is a database operation rather than a console one.',
    request: { ...sessionHeader, ...runIdParam },
    responses: {
      200: {
        description: 'The job run.',
        content: { 'application/json': { schema: JobRunDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: platformNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/platform/scheduled-jobs',
    operationId: 'getV1AdminPlatformScheduledJobs',
    summary: 'The scheduled-job contract, with each job’s last run',
    description:
      'Requires the internal BFF credential and `platform.job.read` in an aal2 session. Every job the database schedules — its cron expression, the function it calls and its stated purpose — with the facts of its most recent run beside it. A contracted job that has never run reports nulls rather than zeros, because nothing having run is a different fact from something running and processing nothing. **This list contains only database-scheduled jobs.** The worker’s repeatable jobs record no run and the contract names none, so none appears here; that is a reported capability gap rather than an empty section.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'Every contracted job, ordered by key.',
        content: { 'application/json': { schema: ScheduledJobCatalogueResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/platform/schedule-problems',
    operationId: 'getV1AdminPlatformScheduleProblems',
    summary: 'Where the schedule and the contract disagree',
    description:
      'Requires the internal BFF credential and `platform.job.read` in an aal2 session. The platform’s own scheduled-job guard, projected whole and unaltered: a contracted job that is missing, misscheduled, pointed somewhere else or switched off, anything scheduled that the contract does not describe, and scheduler-privilege hygiene. An empty list means the schedule matches the contract, which is the only good answer. The wider security contract is deliberately **not** exposed here: the whole posture of policies, grants and roles is a different concern from the job schedule and has no permission of its own.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'Every disagreement between the real schedule and the contract. Empty is good.',
        content: { 'application/json': { schema: ScheduleProblemsResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/platform/outbox',
    operationId: 'getV1AdminPlatformOutbox',
    summary: 'Transactional outbox health, and what is dead-lettered',
    description:
      'Requires the internal BFF credential and `platform.job.read` in an aal2 session. The outbox as **counts and ages only**, in the four states the schema itself defines — pending (of which the due ones are those the relay would claim now), in flight, completed and dead-lettered — together with dead-letters grouped by event type and error class. **No event identifier, no aggregate identifier or type, no payload and no author crosses**: nothing on this surface acts on an event, so an identifier would enable nothing and would only widen what a console can disclose. **No threshold is applied and no verdict is reached**: the sweeper takes its staleness from its caller, so the oldest age in each state is reported as a fact for a person to judge.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'Outbox counts and ages, with the dead-letter groups.',
        content: { 'application/json': { schema: OutboxResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  /* ---------------------------------------------------------------------------------------------- */
  /* Dispute management (Phase 7-R) — five operations, three reads and two non-financial writes      */
  /* ---------------------------------------------------------------------------------------------- */
  //
  // **Nothing in this group moves money.** A resolution records a decision; issuing any refund it implies is a
  // separate, later financial operation with its own record and its own permission, and no writer for one
  // exists in this platform. No operation here creates a refund, reverses a payment, posts a ledger entry,
  // changes a balance, touches a payout or calls a provider.

  const disputeQueueQuery = {
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({
          description: `How many rows to return. Defaults to ${DISPUTES_DEFAULT_LIMIT}; a larger value is clamped to ${DISPUTES_MAX_LIMIT}.`,
        }),
      cursor: z
        .string()
        .optional()
        .openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
      status: z
        .string()
        .optional()
        .openapi({
          description: `Narrows the queue to one dispute state. Only ${SELECTABLE_DISPUTE_STATUSES.join(' and ')} are accepted, because they are the only two any writer in this platform can produce; anything else is refused.`,
        }),
    }),
  } as const;

  const disputeIdParam = { params: z.object({ disputeId: z.string().uuid() }) } as const;

  const disputeNotFound = {
    description:
      'Nothing here for this caller. One code and one sentence for a dispute that does not exist and for a caller who does not hold the key at aal2, so neither can be told from the other and there is no forbidden on this surface. It matters here because only Admin and Super Admin hold a dispute key — a Moderator holds neither, by decision.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  const disputeMessageRefused = {
    description:
      'The message was not added. `DISPUTE_THREAD_CLOSED` — the dispute is resolved or cancelled. `DISPUTE_IS_PARTY` — an internal note from a colleague who is the dispute’s buyer or seller, which the writer refuses. Nothing is changed.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  const disputeResolutionRefused = {
    description:
      'The decision was not recorded. `DISPUTE_ALREADY_RESOLVED` — somebody else ruled first, or the page is stale. `DISPUTE_IS_PARTY` — the caller is the dispute’s buyer or seller, which the writer refuses; the remedy is for a colleague to take it. `DISPUTE_REASON_REQUIRED` — a decision with no reason. `DISPUTE_AMOUNT_NOT_ALLOWED` — an amount against a resolution that is not a refund. Nothing is changed, and nothing financial was attempted in any case.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/disputes',
    operationId: 'getV1AdminDisputes',
    summary: 'The dispute queue',
    description:
      'Requires the internal BFF credential and `disputes.dispute.read` in an aal2 session — a key only Admin and Super Admin hold, and which a Moderator is deliberately not granted. One page of disputes, **oldest first**, because somebody is out of pocket while a dispute waits. A row carries the reason, the claimed amount with its currency, the order it is about and the storefront’s own handle; it carries **no buyer, no seller account, no opener and no colleague resolver** — the caller learns only whether they are a party and whether a decision was their own. Amounts are decimal strings in minor units, never JSON numbers. The status filter accepts only the two states a writer can produce.',
    request: { ...sessionHeader, ...disputeQueueQuery },
    responses: {
      200: {
        description: 'One page of disputes, oldest first. Empty when nothing matches.',
        content: { 'application/json': { schema: DisputeQueueResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/disputes/{disputeId}',
    operationId: 'getV1AdminDispute',
    summary: 'One dispute, with the order it is about',
    description:
      'Requires the internal BFF credential and `disputes.dispute.read` in an aal2 session. What is claimed and why, which order it is about and where that order stands, the status the dispute snapshotted when it opened, and any decision already recorded. The order’s total crosses so the claim can be judged against it, as a decimal string beside the one currency the dispute and the order share. Which side opened it is reported as a **side** rather than an account. `canManage` says whether this same session may post a message or record a decision, because reading and acting are two different keys. **No evidence is returned**: nothing in this platform attaches evidence to a dispute yet, so a count would imply a feature that does not exist.',
    request: { ...sessionHeader, ...disputeIdParam },
    responses: {
      200: {
        description: 'The dispute.',
        content: { 'application/json': { schema: DisputeDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: disputeNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/disputes/{disputeId}/messages',
    operationId: 'getV1AdminDisputeMessages',
    summary: 'The thread on one dispute',
    description:
      'Requires the internal BFF credential and `disputes.dispute.read` in an aal2 session. Every message, oldest first, **including the internal staff notes** a party cannot see — the same key gates the whole thread for staff, and it is the party’s own policy that hides those notes from them. A message names its author’s **role** and never the author; the caller learns only which messages are their own.',
    request: { ...sessionHeader, ...disputeIdParam },
    responses: {
      200: {
        description: 'The thread, oldest first.',
        content: { 'application/json': { schema: DisputeMessagesResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/disputes/{disputeId}/messages',
    operationId: 'postV1AdminDisputeMessage',
    summary: 'Add a staff message or an internal note',
    description:
      'Requires the internal BFF credential and `disputes.dispute.manage` in an aal2 session — a **different key** from the one that reads the dispute. The body carries the text and whether it is internal, and nothing else: the writer works the author’s role out of the dispute itself rather than trusting an argument, and records when. An internal note is visible to staff only; an ordinary message is visible to both parties, which is why `isInternal` defaults to false. The writer refuses a closed thread and refuses an internal note from a colleague who is a party to the dispute.',
    request: {
      ...sessionHeader,
      ...disputeIdParam,
      body: { content: { 'application/json': { schema: PostDisputeMessageRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The message was added.',
        content: { 'application/json': { schema: PostDisputeMessageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: disputeNotFound,
      409: disputeMessageRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/disputes/{disputeId}/resolution',
    operationId: 'postV1AdminDisputeResolution',
    summary: 'Record a decision on one dispute',
    description:
      'Requires the internal BFF credential and `disputes.dispute.manage` in an aal2 session. The body carries one of the four resolutions, a reason — required for **every** decision — and, for a refund resolution only, the decided amount as a decimal string in minor units.\n\n**THIS RECORDS A DECISION AND MOVES NO MONEY.** `refund_buyer` and `partial_refund` record that a refund is owed; **no refund is created, no payment is reversed, no ledger entry is posted, no balance changes, no payout is affected and no provider is called.** Issuing the refund is a separate, later financial operation with its own record and its own permission, and no writer for one exists in this platform yet. The response carries no refund identifier or payment reference, because none was created.\n\nThe writer locks the dispute, records who ruled and when, restores the order to the status the dispute snapshotted when it opened, and refuses a caller who is the dispute’s buyer or seller. The decided amount carries no upper bound: a claim is checked against the order when a dispute is opened, and a decision is not.',
    request: {
      ...sessionHeader,
      ...disputeIdParam,
      body: { content: { 'application/json': { schema: ResolveDisputeRequestSchema } } },
    },
    responses: {
      200: {
        description:
          'The decision was recorded. The dispute is resolved and the order is back at its snapshot status. Nothing financial happened.',
        content: { 'application/json': { schema: ResolveDisputeResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: disputeNotFound,
      409: disputeResolutionRefused,
      503: unavailable,
      500: internalError,
    },
  });

  // ---------------------------------------------------------------------------------------------------
  // CMS static pages
  // ---------------------------------------------------------------------------------------------------
  const cmsPageNotFound = {
    description:
      'No page the caller may see. A draft, a schedule, an archive, a page whose publication moment has not arrived, a published page nobody has written yet, and a slug that never existed all answer this way, and a staff caller without the read key gets it too.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const cmsPageRefused = {
    description:
      'The page exists and the change was refused: an illegal lifecycle edge, publishing a page that has not been written in any locale, or removing the last locale of a published page.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const cmsPageIdParam = {
    params: z.object({
      pageId: z.string().uuid().openapi({ description: 'The page’s identifier.' }),
    }),
  } as const;
  const cmsLocaleParams = {
    params: z.object({
      pageId: z.string().uuid().openapi({ description: 'The page’s identifier.' }),
      localeCode: z.string().openapi({ description: 'The locale to write or remove, as a seeded locale code.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/cms/pages',
    operationId: 'getV1CmsPages',
    summary: 'Every page the public may see',
    description:
      'Requires the internal BFF credential and carries no user context: a guest and a signed-in person get the same list. Ordered by the administrator’s own sort order, with the slug breaking ties. A page appears only once it is published and its publication moment has passed, and only if it has been written in at least one locale — a published page with no text at all is absent, because there would be nothing to name it with. `locale` selects a representation: an untranslated page is titled in the default locale and `resolvedLocale` says so.',
    request: {
      query: z.object({
        locale: PublicLocaleSchema.optional().openapi({
          description: 'Names the language of the titles. Absent or unrecognised resolves to the default locale.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'The published pages. An empty array means nothing is published yet.',
        content: { 'application/json': { schema: PublicCmsPagesResponseSchema } },
      },
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/cms/pages/{slug}',
    operationId: 'getV1CmsPageBySlug',
    summary: 'One public page, or the slug it moved to',
    description:
      'Requires the internal BFF credential and carries no user context. **The 200 body is a union discriminated on `outcome`.** `page` is a published page with its text in the requested locale, or in the default locale when that one is untranslated — `resolvedLocale` says which came back, which is what lets a renderer set the right language and direction on the content. `moved` means the slug is a previous address of a page that has since been renamed, and carries the current slug so the caller can issue its own redirect; the body has no content fields at all, so a renderer cannot show an empty page by forgetting to branch. The distinction is in the body rather than in the status line deliberately: a 301 here would be followed transparently by `fetch`, and the caller would receive the renamed page with a 200 and never learn to redirect the browser.',
    request: {
      params: z.object({
        slug: CmsPageSlugSchema.openapi({ description: 'The page’s address, current or previous.' }),
      }),
      query: z.object({
        locale: PublicLocaleSchema.optional().openapi({
          description: 'Names the language of the text. Absent or unrecognised resolves to the default locale.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'The page, or the slug it moved to.',
        content: { 'application/json': { schema: PublicCmsPageLookupResponseSchema } },
      },
      403: credentialRejected,
      404: cmsPageNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/cms/pages',
    operationId: 'getV1AdminCmsPages',
    summary: 'Authored pages, newest edit first',
    description:
      'Requires the internal BFF credential and `cms.page.read` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. Newest edit first, because this is an authoring list rather than a queue: somebody opening it is most often looking for what they touched last. `translatedLocales` is empty for a page nobody has written, which is also the state that cannot be published. The status filter compares a value, so an unknown status returns an empty page rather than a refusal.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z.string().optional().openapi({
          description: `How many rows to return. Defaults to ${CMS_PAGES_DEFAULT_LIMIT}; a larger value is clamped to ${CMS_PAGES_MAX_LIMIT}.`,
        }),
        cursor: z.string().optional().openapi({
          description:
            'An opaque cursor from a previous response’s nextCursor. Its contents are not part of the contract and must not be constructed or parsed by a client.',
        }),
        status: z.string().optional().openapi({
          description: 'Narrows the list to one of the four page states. An unknown value matches nothing.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'One page of authored pages, newest edit first.',
        content: { 'application/json': { schema: CmsPagePageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/cms/pages/{pageId}',
    operationId: 'getV1AdminCmsPage',
    summary: 'One authored page, with every locale it has',
    description:
      'Requires the internal BFF credential and `cms.page.read` in an aal2 session. `canManage` reports whether this caller also holds `cms.page.manage`, which is a separate seeded key: a console renders its controls from that answer rather than inferring it from a role name. `previousSlugs` lists every address the page has had, newest first; each one permanently redirects to the current slug and can never be taken by another page.',
    request: { ...sessionHeader, ...cmsPageIdParam },
    responses: {
      200: {
        description: 'The page, its previous slugs and its locales.',
        content: { 'application/json': { schema: CmsPageDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsPageNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/cms/pages',
    operationId: 'postV1AdminCmsPages',
    summary: 'Create a page',
    description:
      'Requires the internal BFF credential and `cms.page.manage` in an aal2 session. **The page is always created as a draft**, and there is no status in the request: publishing is its own call, so a page cannot go live before anybody has written it. A slug that is a previous address of another page is refused — a historical slug belongs to the page that gave it up, permanently.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateCmsPageRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The page was created as a draft.',
        content: { 'application/json': { schema: CreateCmsPageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: cmsPageRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/cms/pages/{pageId}',
    operationId: 'patchV1AdminCmsPage',
    summary: 'Change a page’s address or presentation',
    description:
      'Requires the internal BFF credential and `cms.page.manage` in an aal2 session. Every field is optional and an absent field changes nothing; `pageKey` as an empty string clears the key. **The status is deliberately not changeable here** — renaming a page or changing its template can never publish or archive it. Changing the slug keeps the old one as a permanent redirect.',
    request: {
      ...sessionHeader,
      ...cmsPageIdParam,
      body: { content: { 'application/json': { schema: UpdateCmsPageRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The page was changed.',
        content: { 'application/json': { schema: CmsPageWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsPageNotFound,
      409: cmsPageRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/cms/pages/{pageId}/cover',
    operationId: 'putV1AdminCmsPageCover',
    summary: 'Attach or remove a page’s cover image',
    description:
      'Requires the internal BFF credential and `cms.page.manage` in an aal2 session — **not** `cms.media.manage`: a page editor does not need the media library’s key to name an entry in it. `mediaId` is required and nullable, and the two cases are the two operations: a uuid attaches that library entry and an explicit `null` removes whatever is attached. Leaving a cover alone is not sending this request. There is no object path here and no upload: the entry must already exist, and whether the id names one is decided by the database’s own foreign key, which answers 409 when it does not. A route of its own rather than a field on the page patch, so that changing a page’s address cannot change what it looks like and the reverse. **Nothing on the public site renders a page cover**: this records which image belongs to the page and makes it appear nowhere.',
    request: {
      ...sessionHeader,
      ...cmsPageIdParam,
      body: { content: { 'application/json': { schema: CmsPageCoverRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The cover was attached or removed.',
        content: { 'application/json': { schema: CmsPageWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsPageNotFound,
      409: cmsPageRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/cms/pages/{pageId}/status',
    operationId: 'putV1AdminCmsPageStatus',
    summary: 'Move a page through its lifecycle',
    description:
      'Requires the internal BFF credential and `cms.page.manage` in an aal2 session. The legal transitions are the database’s: a page may go between draft, scheduled, published and archived along defined edges, and an edge that does not exist is refused. Publishing or scheduling a page that has not been written in any locale is refused too, because it would put a live address in front of the public with nothing to render. `scheduledFor` is required for `scheduled` and not allowed otherwise.',
    request: {
      ...sessionHeader,
      ...cmsPageIdParam,
      body: { content: { 'application/json': { schema: CmsPageStatusRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The page is in the requested state.',
        content: { 'application/json': { schema: CmsPageWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsPageNotFound,
      409: cmsPageRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/cms/pages/{pageId}/translations/{localeCode}',
    operationId: 'putV1AdminCmsPageTranslation',
    summary: 'Write one locale of a page',
    description:
      'Requires the internal BFF credential and `cms.page.manage` in an aal2 session. Creating and replacing are the same request. A blank excerpt, meta title or meta description is stored as absent rather than as an empty string, so a page never carries a blank meta tag. Nothing is machine translated: a locale exists because somebody wrote it.',
    request: {
      ...sessionHeader,
      ...cmsLocaleParams,
      body: { content: { 'application/json': { schema: SaveCmsPageTranslationRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The locale was written.',
        content: { 'application/json': { schema: CmsPageWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsPageNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/cms/pages/{pageId}/translations/{localeCode}',
    operationId: 'deleteV1AdminCmsPageTranslation',
    summary: 'Remove one locale of a page',
    description:
      'Requires the internal BFF credential and `cms.page.manage` in an aal2 session. Removing the last locale of a published or scheduled page is refused — the mirror of the rule that a page cannot be published before it has been written — because the page’s address would start answering 404 while the page was still live and still in the public index. A draft may be emptied completely. Removing a locale that is not there is a 404 rather than an error.',
    request: { ...sessionHeader, ...cmsLocaleParams },
    responses: {
      200: {
        description: 'The locale was removed.',
        content: { 'application/json': { schema: CmsPageWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsPageNotFound,
      409: cmsPageRefused,
      503: unavailable,
      500: internalError,
    },
  });

  // ---------------------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------------------------
  // The blog (0092)
  // ---------------------------------------------------------------------------------------------------
  // **The blog is deliberately absent from the sitemap**, which is why no sitemap entry type appears for it
  // anywhere in this document: 0086's five kinds stand unchanged, and blog inclusion is a separate increment.
  //
  // **A post's `<head>` comes from the post.** `metaTitle` and `metaDescription` are columns of its own
  // translation; `seo_metadata` does not reach a blog post, so there is no override field to document.
  const blogNotFound = {
    description:
      'No post the caller may see. A draft, a schedule, an archive, a post whose publication moment has not arrived, a published post nobody has written yet, and a slug that never existed all answer this way, and a staff caller without the read key gets it too.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const blogRefused = {
    description:
      'The post exists and the change was refused: an illegal lifecycle edge, featuring a post that is not published, publishing a post that has not been written in any locale, removing the last locale of a published post, an address that belongs to another post’s history, or a category, cover or tag that does not exist.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const blogPostIdParam = {
    params: z.object({
      postId: z.string().uuid().openapi({ description: 'The post’s identifier.' }),
    }),
  } as const;
  const blogLocaleParams = {
    params: z.object({
      postId: z.string().uuid().openapi({ description: 'The post’s identifier.' }),
      localeCode: z.string().openapi({ description: 'The locale to write or remove, as a seeded locale code.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/blog',
    operationId: 'getV1Blog',
    summary: 'The public blog index, newest published first',
    description:
      'Requires the internal BFF credential and carries no user context: a guest and a signed-in person get the same page. Ordered strictly by publication moment, newest first — `isFeatured` is reported so a surface can mark a post, and deliberately does not move it, because promoting featured posts would be a presentation rule nobody approved. A post appears only once it is published and its moment has passed, and only if it has been written in at least one locale. `category` and `tag` are filters compared as values, so a slug naming nothing or something deactivated yields an empty page rather than a refusal; `locale` selects a representation, and `resolvedLocale` says which language came back.',
    request: {
      query: z.object({
        locale: PublicLocaleSchema.optional().openapi({
          description: 'Names the language of the text. Absent or unrecognised resolves to the default locale.',
        }),
        category: BlogSlugSchema.optional().openapi({ description: 'Narrows the index to one category.' }),
        tag: BlogSlugSchema.optional().openapi({ description: 'Narrows the index to one tag.' }),
        limit: z.string().optional().openapi({ description: 'Page size. Clamped to the maximum.' }),
        cursor: z.string().optional().openapi({ description: 'An opaque position from a previous page.' }),
      }),
    },
    responses: {
      200: {
        description: 'One page of public posts. An empty array means nothing matches.',
        content: { 'application/json': { schema: PublicBlogIndexResponseSchema } },
      },
      400: validationFailed,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/blog/taxonomy',
    operationId: 'getV1BlogTaxonomy',
    summary: 'The filters the blog index offers',
    description:
      'Requires the internal BFF credential and carries no user context. Only active categories and tags appear, each with how many posts the public may actually see under it. A filter with nothing behind it reports zero rather than being omitted, so a surface decides for itself whether to show an empty one. Categories carry the administrator’s own sort order; tags have none in the schema and are ordered by slug.',
    request: {
      query: z.object({
        locale: PublicLocaleSchema.optional().openapi({
          description: 'Names the language of the labels. An absent Arabic name falls back to the English one.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'The active categories and tags with their public counts.',
        content: { 'application/json': { schema: PublicBlogTaxonomyResponseSchema } },
      },
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/blog/{slug}',
    operationId: 'getV1BlogPostBySlug',
    summary: 'One public post, or the slug it moved to',
    description:
      'Requires the internal BFF credential and carries no user context. **The 200 body is a union discriminated on `outcome`.** `post` is a published post with its text in the requested locale, or in the default locale when that one is untranslated — `resolvedLocale` says which came back, which is what lets a renderer set the right language and direction. `moved` means the slug is a previous address of a post that has since been renamed, and carries the current slug so the caller can issue its own redirect; the body has no content fields at all, so a renderer cannot show an empty post by forgetting to branch. The distinction is in the body rather than in the status line deliberately: a 301 here would be followed transparently by `fetch`, and the caller would receive the renamed post with a 200 and never learn to redirect the browser. `metaTitle` and `metaDescription` come from the post’s own translation and are the only source of its head.',
    request: {
      params: z.object({
        slug: BlogSlugSchema.openapi({ description: 'The post’s address, current or previous.' }),
      }),
      query: z.object({
        locale: PublicLocaleSchema.optional().openapi({
          description: 'Names the language of the text. Absent or unrecognised resolves to the default locale.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'The post, or the slug it moved to.',
        content: { 'application/json': { schema: PublicBlogPostLookupResponseSchema } },
      },
      403: credentialRejected,
      404: blogNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/blog',
    operationId: 'getV1AdminBlogPosts',
    summary: 'Authored posts, newest edit first',
    description:
      'Requires the internal BFF credential and `cms.blog.read` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. Newest edit first, because this is an authoring list rather than a queue. `translatedLocales` is empty for a post nobody has written, which is also the state that cannot be published. The status and category filters compare values, so an unknown one returns an empty page rather than a refusal, and `search` is matched as a literal substring of the title or the slug — never as a pattern, so nothing in it can be read as a wildcard.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z.string().optional().openapi({ description: 'Page size. Clamped to the maximum.' }),
        cursor: z.string().optional().openapi({ description: 'An opaque position from a previous page.' }),
        status: z.string().optional().openapi({ description: 'Narrows the list to one state.' }),
        search: z.string().optional().openapi({ description: 'A literal substring of the title or the slug.' }),
        categoryId: z.string().optional().openapi({ description: 'Narrows the list to one category.' }),
      }),
    },
    responses: {
      200: {
        description: 'One page of authored posts.',
        content: { 'application/json': { schema: BlogPostPageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/blog/taxonomy',
    operationId: 'getV1AdminBlogTaxonomy',
    summary: 'Blog categories and tags, active or not',
    description:
      'Requires the internal BFF credential and `cms.blog.read` in an aal2 session. Includes deactivated rows, which is the difference from the public taxonomy: a console has to be able to see and reactivate what it deactivated. `postCount` counts every post, not only the public ones — it is there to warn before a deactivation, which is a different question from what the public site shows. `canManage` reports whether this caller also holds `cms.blog.manage`, so a console renders its controls from the answer rather than from a role name.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'Every category and tag, with whether the caller may change them.',
        content: { 'application/json': { schema: BlogTaxonomyResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/blog/{postId}',
    operationId: 'getV1AdminBlogPost',
    summary: 'One authored post',
    description:
      'Requires the internal BFF credential and `cms.blog.read` in an aal2 session. Carries every locale the post has been written in, every slug it has had — each of which still redirects to the current one — the tags it carries, and `canManage`, which reports whether this caller also holds `cms.blog.manage`. A post that does not exist and a caller without the read key answer identically, so a refusal cannot be told from an absence. `authorUserId` is the byline, set to the staff member who created the post and not changeable here.',
    request: { ...sessionHeader, ...blogPostIdParam },
    responses: {
      200: {
        description: 'The post, its locales, its tags and the caller’s capability.',
        content: { 'application/json': { schema: BlogPostDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/blog',
    operationId: 'postV1AdminBlogPosts',
    summary: 'Create a post',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. **The post is always created as a draft and never featured**, and there is neither a status nor a featured flag in the request: publishing is its own call, so a post cannot go live before anybody has written it. The creating staff member becomes the byline. A slug that is a previous address of another post is refused — a historical slug belongs to the post that gave it up, permanently.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateBlogPostRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The post was created as a draft.',
        content: { 'application/json': { schema: CreateBlogPostResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/blog/{postId}',
    operationId: 'patchV1AdminBlogPost',
    summary: 'Change a post’s address or presentation',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. Every field is optional. **An absent field changes nothing and an explicit `null` clears a reference** — the two mean different things, so sending `categoryId: null` removes the category while omitting it leaves it alone. **The status is deliberately not changeable here**: renaming a post or changing its cover can never publish or archive it. Changing the slug keeps the old one as a permanent redirect. `isFeatured` is refused unless the post is published, which is the database’s own constraint.',
    request: {
      ...sessionHeader,
      ...blogPostIdParam,
      body: { content: { 'application/json': { schema: UpdateBlogPostRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The post was changed.',
        content: { 'application/json': { schema: BlogWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/blog/{postId}/status',
    operationId: 'putV1AdminBlogPostStatus',
    summary: 'Move a post through its lifecycle',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. The legal transitions are the database’s, shared with CMS pages: a post may move between draft, scheduled, published and archived along defined edges, and an edge that does not exist is refused. Publishing or scheduling a post that has not been written in any locale is refused too, because it would put a live address in front of the public with nothing to render. `scheduledFor` is required for `scheduled` and not allowed otherwise. Leaving the published state clears the featured flag, which no other state may carry.',
    request: {
      ...sessionHeader,
      ...blogPostIdParam,
      body: { content: { 'application/json': { schema: BlogPostStatusRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The post’s state was changed.',
        content: { 'application/json': { schema: BlogWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/blog/{postId}/translations/{localeCode}',
    operationId: 'putV1AdminBlogPostTranslation',
    summary: 'Write one locale of a post',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. Creating and replacing are the same request. Nothing is machine translated: a locale exists because somebody wrote it, and an untranslated locale simply has no row. `metaTitle` and `metaDescription` are written here and nowhere else — they are the only source of the post’s public head.',
    request: {
      ...sessionHeader,
      ...blogLocaleParams,
      body: { content: { 'application/json': { schema: SaveBlogPostTranslationRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The locale was written.',
        content: { 'application/json': { schema: BlogWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/blog/{postId}/translations/{localeCode}',
    operationId: 'deleteV1AdminBlogPostTranslation',
    summary: 'Remove one locale of a post',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. Removing the last locale of a published or scheduled post is refused: its address would start answering 404 while the post was still live. A locale that was never there answers 404 rather than a refusal, because the remedy is the same as for a post that does not exist.',
    request: { ...sessionHeader, ...blogLocaleParams },
    responses: {
      200: {
        description: 'The locale was removed.',
        content: { 'application/json': { schema: BlogWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/blog/{postId}/tags',
    operationId: 'putV1AdminBlogPostTags',
    summary: 'Replace a post’s tags',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. The whole set is sent rather than one addition or removal at a time, so the write cannot leave a half-applied result and a console that renders checkboxes already knows what it means. An empty array removes every tag. A tag that does not exist is refused rather than quietly dropped. A deactivated tag may be attached and is simply not served to the public, so reactivating it restores it.',
    request: {
      ...sessionHeader,
      ...blogPostIdParam,
      body: { content: { 'application/json': { schema: SaveBlogPostTagsRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The post’s tags are now exactly what was sent.',
        content: { 'application/json': { schema: BlogWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/blog/categories',
    operationId: 'postV1AdminBlogCategories',
    summary: 'Create a blog category',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. `slug` and `nameEn` are both required: English is the required language throughout and Arabic is optional, which is the schema’s own rule rather than this route’s. Blog categories are separate from the listing catalogue’s categories and share nothing with them.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: SaveBlogCategoryRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The category was created.',
        content: { 'application/json': { schema: SaveBlogTaxonomyResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/blog/categories/{categoryId}',
    operationId: 'patchV1AdminBlogCategory',
    summary: 'Change a blog category',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. Every field is optional and an absent one leaves that part of the category alone — including its sort order and whether it is active, so correcting a name cannot silently reactivate a category or move it. An empty string clears an optional Arabic name or description. Deactivating a category removes it from the public filters and from the posts it had categorised, which still appear in the index with no category name.',
    request: {
      ...sessionHeader,
      params: z.object({
        categoryId: z.string().uuid().openapi({ description: 'The category’s identifier.' }),
      }),
      body: { content: { 'application/json': { schema: SaveBlogCategoryRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The category was changed.',
        content: { 'application/json': { schema: SaveBlogTaxonomyResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/blog/tags',
    operationId: 'postV1AdminBlogTags',
    summary: 'Create a blog tag',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. `slug` and `nameEn` are both required. Blog tags are separate from the listing catalogue’s tags and share nothing with them.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: SaveBlogTagRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The tag was created.',
        content: { 'application/json': { schema: SaveBlogTaxonomyResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/blog/tags/{tagId}',
    operationId: 'patchV1AdminBlogTag',
    summary: 'Change a blog tag',
    description:
      'Requires the internal BFF credential and `cms.blog.manage` in an aal2 session. Every field is optional and an absent one leaves that part of the tag alone, including whether it is active. Deactivating a tag removes it from the public filters and from the posts carrying it, while the rows themselves are kept, so reactivating restores them.',
    request: {
      ...sessionHeader,
      params: z.object({
        tagId: z.string().uuid().openapi({ description: 'The tag’s identifier.' }),
      }),
      body: { content: { 'application/json': { schema: SaveBlogTagRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The tag was changed.',
        content: { 'application/json': { schema: SaveBlogTaxonomyResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: blogNotFound,
      409: blogRefused,
      503: unavailable,
      500: internalError,
    },
  });

  // ---------------------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------------------------
  // The homepage (0093)
  // ---------------------------------------------------------------------------------------------------
  // **A featured section is editorial.** No schema in this document carries a promotion, a package, a placement, a
  // ranking or a weight, and none can: 0025's `homepage` placement is paid and promoted merging is a Phase 9
  // decision, so neither is reachable from here.
  //
  // **`banner_strip` is one of 0030's nine types and has no configuration shape here**, because a banner is its
  // image and this platform has no media origin to address one with.
  const homepageNotFound = {
    description:
      'No section the caller may see. A section that does not exist and a caller without `cms.homepage.read` answer the same way, so a refusal cannot be told from an absence; a caller holding only the read key gets this from every write too.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const homepageRefused = {
    description:
      'The change was refused by a constraint migration 0030 owns: another section already uses that key, or a key, section type, title length or configuration is not one the column accepts.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const homepageSectionIdParam = {
    params: z.object({
      sectionId: z.string().uuid().openapi({ description: 'The section’s identifier.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/homepage',
    operationId: 'getV1Homepage',
    summary: 'The public homepage, assembled',
    description:
      'Requires the internal BFF credential and carries no user context: a guest and a signed-in person get the same homepage. The sections come back in the administrator’s own order, each already resolved to the content it shows — a curated section names rows by id and they are read live, so a sold listing, a suspended seller or a deactivated category simply drops out. **A section with nothing left to show is absent from the response entirely**, which is why no member of the union has an empty state: an empty shelf never reaches a browser. **An empty `sections` array is a real answer** rather than a 404, because a marketplace whose homepage has not been composed yet still has one. `locale` selects a representation; text with no Arabic written falls back to the English. A `banner_strip` section is never returned.',
    request: {
      query: z.object({
        locale: PublicLocaleSchema.optional().openapi({
          description: 'Names the language of the text. Absent or unrecognised resolves to the default locale.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'The homepage’s sections, resolved. An empty array means nothing has been composed yet.',
        content: { 'application/json': { schema: PublicHomepageResponseSchema } },
      },
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/homepage/sections',
    operationId: 'getV1AdminHomepageSections',
    summary: 'Every homepage section, in order',
    description:
      'Requires the internal BFF credential and `cms.homepage.read` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. Includes hidden sections and sections of a type the public homepage will not render; `isServed` marks the latter, and `isConfigured` marks a section whose stored document does not match its own type. `canManage` reports whether this caller also holds `cms.homepage.manage`, so a console renders its controls from the answer rather than from a role name.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'Every section, with whether the caller may change them.',
        content: { 'application/json': { schema: HomepageSectionsResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: homepageNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/homepage/sections/reorder',
    operationId: 'putV1AdminHomepageSectionsReorder',
    summary: 'Set the order of the homepage',
    description:
      'Requires the internal BFF credential and `cms.homepage.manage` in an aal2 session. The whole order is sent at once rather than one move at a time, so the write cannot leave a half-applied arrangement. Position comes from the array’s own ordering; a section the request leaves out keeps its place, and an id that names no section moves nothing. Positions are spaced so a later insertion between two sections needs no rewrite.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: ReorderHomepageSectionsRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The order was set.',
        content: { 'application/json': { schema: HomepageWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: homepageNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/homepage/sections/{sectionId}',
    operationId: 'getV1AdminHomepageSection',
    summary: 'One homepage section',
    description:
      'Requires the internal BFF credential and `cms.homepage.read` in an aal2 session. Carries the stored configuration as written, plus `chosenCount` and `renderableCount` — how many rows the section names and how many of those are still visible to the public. That pair is the reason a section can be skipped on the homepage and the operator can still find out why. A section that does not exist and a caller without the read key answer identically.',
    request: { ...sessionHeader, ...homepageSectionIdParam },
    responses: {
      200: {
        description: 'The section, its configuration and how much of it is still renderable.',
        content: { 'application/json': { schema: HomepageSectionDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: homepageNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/homepage/sections',
    operationId: 'postV1AdminHomepageSections',
    summary: 'Create a homepage section',
    description:
      'Requires the internal BFF credential and `cms.homepage.manage` in an aal2 session. **The section is always created hidden**, and there is no visibility field in the request: showing a section is its own call, so a half-configured one cannot reach the homepage. The `config` is validated against the `sectionType` it was sent with — each type has exactly one shape, and a shape belonging to another type is refused rather than carried along. A `banner_strip` cannot be created here.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateHomepageSectionRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The section was created, hidden.',
        content: { 'application/json': { schema: CreateHomepageSectionResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: homepageRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/homepage/sections/{sectionId}',
    operationId: 'patchV1AdminHomepageSection',
    summary: 'Change a homepage section',
    description:
      'Requires the internal BFF credential and `cms.homepage.manage` in an aal2 session. Every field is optional and an absent field changes nothing; a title sent as null clears it. **Visibility is deliberately not changeable here** — editing a section’s text, configuration or position can never put it in front of the public. A `config` must be sent together with its `sectionType`, because a configuration can only be checked against one.',
    request: {
      ...sessionHeader,
      ...homepageSectionIdParam,
      body: { content: { 'application/json': { schema: UpdateHomepageSectionRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The section was changed.',
        content: { 'application/json': { schema: HomepageWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: homepageNotFound,
      409: homepageRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/homepage/sections/{sectionId}/state',
    operationId: 'putV1AdminHomepageSectionState',
    summary: 'Show or hide a homepage section',
    description:
      'Requires the internal BFF credential and `cms.homepage.manage` in an aal2 session. The only route that can put a section in front of the public, or take it back. Showing a section whose content has all disappeared is allowed and harmless: the public homepage skips it, and the section detail reports why.',
    request: {
      ...sessionHeader,
      ...homepageSectionIdParam,
      body: { content: { 'application/json': { schema: HomepageSectionStateRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The section is now shown or hidden as asked.',
        content: { 'application/json': { schema: HomepageWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: homepageNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/homepage/sections/{sectionId}',
    operationId: 'deleteV1AdminHomepageSection',
    summary: 'Remove a homepage section',
    description:
      'Requires the internal BFF credential and `cms.homepage.manage` in an aal2 session. A real delete: a section is a composition choice rather than a record of something that happened, and 0030’s audit trigger has already recorded that it existed. The rows it referred to are untouched — a section names them and never owns them.',
    request: { ...sessionHeader, ...homepageSectionIdParam },
    responses: {
      200: {
        description: 'The section was removed.',
        content: { 'application/json': { schema: HomepageWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: homepageNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  // ---------------------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------------------------
  // Navigation (0094)
  // ---------------------------------------------------------------------------------------------------
  // **A menu entry points at a row and never copies it.** The label is the operator's own words; the address is
  // derived from the target every time it is read, so an unpublished page or a deactivated category leaves the
  // menu by itself.
  //
  // **The public response carries a slug, not an href, for a page, a post or a category.** The closed set of
  // served page addresses is the web application's route map, not a database fact, so the surface that owns the
  // route map derives the address and drops what it cannot serve.
  //
  // **Two levels, structurally.** A menu holds items and an item holds links, and a link holds nothing — so a
  // third level is unrepresentable here as well as refused by 0030's trigger.
  const navigationNotFound = {
    description:
      'No menu or item the caller may see. One that does not exist and a caller without `cms.navigation.read` answer the same way, so a refusal cannot be told from an absence; a caller holding only the read key gets this from every write too.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const navigationRefused = {
    description:
      'The change was refused by a constraint or trigger migration 0030 owns: another menu already uses that key, a label or path is not one the column accepts, the arrangement would be three levels deep or would put a child in another menu, or the page, post, category or menu named does not exist.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const navigationMenuIdParam = {
    params: z.object({
      menuId: z.string().uuid().openapi({ description: 'The menu’s identifier.' }),
    }),
  } as const;
  const navigationItemIdParam = {
    params: z.object({
      itemId: z.string().uuid().openapi({ description: 'The item’s identifier.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/navigation',
    operationId: 'getV1Navigation',
    summary: 'The public navigation menus',
    description:
      'Requires the internal BFF credential and carries no user context: a guest and a signed-in person get the same menus. `menus` names which of the three placements to return (`header`, `footer`, `mobile`) and may name several at once, so a page renders its whole chrome from one read; an unrecognised key is ignored rather than refused, and asking for none returns all three. Each entry carries the operator’s own label and its target — a slug for a page, post or category, a relative path for a path entry — and never an href: deriving one belongs to whichever surface owns the route map. **An entry whose target is no longer public is absent, and so is any entry beneath it**; a menu left with nothing is absent too, which is why no menu here is ever empty. **An empty `menus` array is a real answer** rather than a 404, because a site whose menus have not been composed yet still has navigation — the application’s own neutral chrome.',
    request: {
      query: z.object({
        menus: z.string().optional().openapi({
          description:
            'A comma-separated list of placements to return. Absent returns all three. An unrecognised key is ignored.',
          example: 'header,footer',
        }),
        locale: PublicLocaleSchema.optional().openapi({
          description: 'Names the language of the labels. Absent or unrecognised resolves to the default locale.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'The menus asked for, resolved. An empty array means nothing has been composed yet.',
        content: { 'application/json': { schema: PublicNavigationResponseSchema } },
      },
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/navigation/menus',
    operationId: 'getV1AdminNavigationMenus',
    summary: 'Every navigation menu',
    description:
      'Requires the internal BFF credential and `cms.navigation.read` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. Served placements come first. `isServed` marks a menu the public site places; `renderableItemCount` is how many of its items the public would actually be shown, which is how an operator discovers that a menu has quietly emptied. `canManage` reports whether this caller also holds `cms.navigation.manage`, so a console renders its controls from the answer rather than from a role name.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'Every menu, with whether the caller may change them.',
        content: { 'application/json': { schema: NavigationMenusResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/navigation/items/reorder',
    operationId: 'putV1AdminNavigationItemsReorder',
    summary: 'Set the order of a menu',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. The whole order is sent at once rather than one move at a time, so the write cannot leave a half-applied arrangement. Position comes from the array’s own ordering; an item the request leaves out keeps its place, and an id belonging to another menu moves nothing. Positions are spaced so a later insertion between two items needs no rewrite.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: ReorderNavigationItemsRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The order was applied.',
        content: { 'application/json': { schema: NavigationWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/navigation/items',
    operationId: 'postV1AdminNavigationItems',
    summary: 'Create a menu entry',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. The target is one coherent value: a page, a post, a category or a relative path, and exactly the field belonging to that kind. A `parentId` puts the entry under a heading — 0030 refuses a third level and a parent in another menu. There is no visibility field: showing and hiding is its own call.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateNavigationItemRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The entry was created.',
        content: { 'application/json': { schema: CreateNavigationItemResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: navigationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/navigation/items/{itemId}',
    operationId: 'patchV1AdminNavigationItem',
    summary: 'Change a menu entry',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. Every field is optional and an absent field changes nothing; an Arabic label sent as null clears it. Sending a `target` replaces it whole, so turning a page entry into a path entry clears the page in the same write. **Visibility is deliberately not changeable here**, and neither is which menu the entry belongs to. Moving an entry out from under its heading has its own route.',
    request: {
      ...sessionHeader,
      ...navigationItemIdParam,
      body: { content: { 'application/json': { schema: UpdateNavigationItemRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The entry was changed.',
        content: { 'application/json': { schema: NavigationWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      409: navigationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/navigation/items/{itemId}/promote',
    operationId: 'putV1AdminNavigationItemPromote',
    summary: 'Move a menu entry to the top level',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. A separate route because an absent `parentId` on a change has to keep meaning “leave it where it is”, so clearing one needs a way to be said. An entry already at the top level answers the same way as one that does not exist.',
    request: { ...sessionHeader, ...navigationItemIdParam },
    responses: {
      200: {
        description: 'The entry is now at the top level of its menu.',
        content: { 'application/json': { schema: NavigationWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/navigation/items/{itemId}/state',
    operationId: 'putV1AdminNavigationItemState',
    summary: 'Show or hide a menu entry',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. One of the two routes that can put something in front of the public, or take it back. Hiding a heading takes the entries beneath it off the public menu too, because an entry without its heading is not the arrangement that was made.',
    request: {
      ...sessionHeader,
      ...navigationItemIdParam,
      body: { content: { 'application/json': { schema: NavigationStateRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The entry is now shown or hidden as asked.',
        content: { 'application/json': { schema: NavigationWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/navigation/items/{itemId}',
    operationId: 'deleteV1AdminNavigationItem',
    summary: 'Remove a menu entry',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. A real delete, and 0030’s own cascade takes any entry beneath it as well. The rows it referred to are untouched — an entry names them and never owns them.',
    request: { ...sessionHeader, ...navigationItemIdParam },
    responses: {
      200: {
        description: 'The entry was removed.',
        content: { 'application/json': { schema: NavigationWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/navigation/menus',
    operationId: 'postV1AdminNavigationMenus',
    summary: 'Create a navigation menu',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. A menu may be created under any key the column accepts, but only the three the site places are ever read publicly; a menu under any other key is legal and simply unplaced. There is no visibility field: showing and hiding is its own call, and a menu with no renderable entry is skipped anyway.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateNavigationMenuRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The menu was created.',
        content: { 'application/json': { schema: CreateNavigationMenuResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: navigationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/navigation/menus/{menuId}',
    operationId: 'getV1AdminNavigationMenu',
    summary: 'One navigation menu, with its entries',
    description:
      'Requires the internal BFF credential and `cms.navigation.read` in an aal2 session. Carries every entry in tree order, including hidden ones and ones the public is not being shown: `targetState` says whether the target is public, not public or gone, and `targetSlug` and `targetTitle` let an operator recognise the row being pointed at — which is also how an entry pointing at an address this application does not serve is found. `locale` chooses which of a target’s own titles is shown and never which entries exist. A menu that does not exist and a caller without the read key answer identically.',
    request: {
      ...sessionHeader,
      ...navigationMenuIdParam,
      query: z.object({
        locale: PublicLocaleSchema.optional().openapi({
          description: 'Names the language of the targets’ own titles. It never changes which entries are listed.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'The menu and its entries.',
        content: { 'application/json': { schema: NavigationMenuDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/navigation/menus/{menuId}',
    operationId: 'patchV1AdminNavigationMenu',
    summary: 'Change a navigation menu',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. Every field is optional and an absent field changes nothing; an Arabic label sent as null clears it. Changing a menu’s key changes where the site places it — or stops placing it — and **visibility is deliberately not changeable here**.',
    request: {
      ...sessionHeader,
      ...navigationMenuIdParam,
      body: { content: { 'application/json': { schema: UpdateNavigationMenuRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The menu was changed.',
        content: { 'application/json': { schema: NavigationWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      409: navigationRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/navigation/menus/{menuId}/state',
    operationId: 'putV1AdminNavigationMenuState',
    summary: 'Show or hide a navigation menu',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. The route that takes a whole menu off every public surface at once, or puts it back. Showing a menu whose entries have all become unavailable is allowed and harmless: the public site skips it, and the menu detail reports why.',
    request: {
      ...sessionHeader,
      ...navigationMenuIdParam,
      body: { content: { 'application/json': { schema: NavigationStateRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The menu is now shown or hidden as asked.',
        content: { 'application/json': { schema: NavigationWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/navigation/menus/{menuId}',
    operationId: 'deleteV1AdminNavigationMenu',
    summary: 'Remove a navigation menu',
    description:
      'Requires the internal BFF credential and `cms.navigation.manage` in an aal2 session. A real delete, and 0030’s cascade takes its entries with it. The rows those entries referred to are untouched.',
    request: { ...sessionHeader, ...navigationMenuIdParam },
    responses: {
      200: {
        description: 'The menu was removed.',
        content: { 'application/json': { schema: NavigationWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: navigationNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  // ---------------------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------------------------
  // The help centre (0095)
  // ---------------------------------------------------------------------------------------------------
  // **A topic is a page's own `page_key`.** Which address shows which questions is that mapping and nothing else,
  // so the public read takes a topic rather than an address and the console reports, for every topic, whether a
  // publicly visible page carries it.
  //
  // **No structured data anywhere.** No schema here carries a `FAQPage` document, a JSON-LD field or anything an
  // SEO head would read, and `faqs` is not one of `seo_metadata`'s entity types.
  //
  // **An answer is plain text.** It is served as stored, blank lines and all, and the renderer splits paragraphs.
  const faqNotFound = {
    description:
      'No entry the caller may see. One that does not exist and a caller without `cms.faq.read` answer the same way, so a refusal cannot be told from an absence; a caller holding only the read key gets this from every write too.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const faqRefused = {
    description:
      'The change was refused by a constraint migration 0030 owns: the topic is not a topic, the question is longer than the column, or the answer has nothing in it.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const faqIdParam = {
    params: z.object({
      faqId: z.string().uuid().openapi({ description: 'The entry’s identifier.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/faqs',
    operationId: 'getV1Faqs',
    summary: 'The published help-centre entries of one topic',
    description:
      'Requires the internal BFF credential and carries no user context: a guest and a signed-in person get the same questions. `topic` is required and is a page’s own `page_key` — the mapping that decides which address shows which questions — so `/faq` asks for `faq` and `/help` asks for `help`; a value that is not a topic is a 400 rather than an empty answer, because a caller that sent one has a bug. The entries come back in the administrator’s own order, each question and answer in the language asked for with English as the fallback. An answer is plain text and is served exactly as stored, blank lines included, so a renderer can split paragraphs; nothing marks any part of it as markup. **An empty `entries` array is a real answer** rather than a 404, because a page whose topic has nothing published simply shows no help section.',
    request: {
      query: z.object({
        topic: FaqTopicSchema.openapi({
          description: 'The topic to read, which is a published page’s own page_key.',
          example: 'faq',
        }),
        locale: PublicLocaleSchema.optional().openapi({
          description: 'Names the language of the text. Absent or unrecognised resolves to the default locale.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'The published entries of that topic. An empty array means nothing is published under it.',
        content: { 'application/json': { schema: PublicFaqsResponseSchema } },
      },
      400: validationFailed,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/faqs/topics',
    operationId: 'getV1AdminFaqTopics',
    summary: 'Every help-centre topic in use',
    description:
      'Requires the internal BFF credential and `cms.faq.read` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. Mapped topics come first. For each one: how many entries it holds, how many of those are published, whether a publicly visible page carries it as its `page_key`, and that page’s slug. A topic no address shows is reported rather than refused — topics are free-form on purpose.',
    request: { ...sessionHeader },
    responses: {
      200: {
        description: 'Every topic entries exist under.',
        content: { 'application/json': { schema: FaqTopicsResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: faqNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/faqs/reorder',
    operationId: 'putV1AdminFaqsReorder',
    summary: 'Set the order of one topic',
    description:
      'Requires the internal BFF credential and `cms.faq.manage` in an aal2 session. The whole order of one topic is sent at once rather than one move at a time, so the write cannot leave a half-applied arrangement. Position comes from the array’s own ordering; an entry the request leaves out keeps its place, and an id belonging to another topic moves nothing. Positions are spaced so a later insertion between two entries needs no rewrite.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: ReorderFaqsRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The order was applied.',
        content: { 'application/json': { schema: FaqWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: faqNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/faqs',
    operationId: 'getV1AdminFaqs',
    summary: 'One page of help-centre entries',
    description:
      'Requires the internal BFF credential and `cms.faq.read` in an aal2 session. Entries come back in help-centre order — by topic, then by the position somebody arranged — and include the unpublished ones, each with whether a public page shows its topic. `topic` narrows the same order rather than changing it. The cursor is opaque: the client sends it back untouched and reads nothing from it, and a cursor that is not a position is a 400 rather than a silent first page.',
    request: {
      ...sessionHeader,
      query: z.object({
        topic: FaqTopicSchema.optional().openapi({ description: 'Narrows the list to one topic.' }),
        cursor: z.string().optional().openapi({ description: 'Opaque. Send back exactly what the last page returned.' }),
        limit: z
          .string()
          .optional()
          .openapi({ description: `How many entries to return. The default is ${FAQ_DEFAULT_LIMIT} and the maximum is ${FAQ_MAX_LIMIT}.` }),
      }),
    },
    responses: {
      200: {
        description: 'One page of entries, with whether the caller may change them.',
        content: { 'application/json': { schema: FaqPageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: faqNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/faqs/{faqId}',
    operationId: 'getV1AdminFaq',
    summary: 'One help-centre entry',
    description:
      'Requires the internal BFF credential and `cms.faq.read` in an aal2 session. Carries both languages as written, the position, whether the entry is published, and whether a publicly visible page shows its topic — with that page’s slug, so a console can check it against the application’s own route map. An entry that does not exist and a caller without the read key answer identically.',
    request: { ...sessionHeader, ...faqIdParam },
    responses: {
      200: {
        description: 'The entry.',
        content: { 'application/json': { schema: FaqDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: faqNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/faqs',
    operationId: 'postV1AdminFaqs',
    summary: 'Create a help-centre entry',
    description:
      'Requires the internal BFF credential and `cms.faq.manage` in an aal2 session. **The entry is always created unpublished**, and there is no publication field in the request: publishing is its own call, so a half-written answer cannot reach a public page. The English question and answer are required and the Arabic ones are optional, which is D6 and D7. The topic is free-form within the column’s format; one no address shows is legal and simply unseen.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateFaqRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The entry was created, unpublished.',
        content: { 'application/json': { schema: CreateFaqResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      409: faqRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/faqs/{faqId}',
    operationId: 'patchV1AdminFaq',
    summary: 'Change a help-centre entry',
    description:
      'Requires the internal BFF credential and `cms.faq.manage` in an aal2 session. Every field is optional and an absent field changes nothing; an Arabic wording sent as null clears it. Changing the topic moves the entry to whatever address shows that topic, with no second edit. **Publication is deliberately not changeable here** — editing an answer can never put it in front of the public.',
    request: {
      ...sessionHeader,
      ...faqIdParam,
      body: { content: { 'application/json': { schema: UpdateFaqRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The entry was changed.',
        content: { 'application/json': { schema: FaqWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: faqNotFound,
      409: faqRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/faqs/{faqId}/state',
    operationId: 'putV1AdminFaqState',
    summary: 'Publish or unpublish a help-centre entry',
    description:
      'Requires the internal BFF credential and `cms.faq.manage` in an aal2 session. The only route that can put an entry on a public page, or take it back. Publishing an entry under a topic no address shows is allowed and harmless: nothing renders it, and the console reports why.',
    request: {
      ...sessionHeader,
      ...faqIdParam,
      body: { content: { 'application/json': { schema: FaqStateRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The entry is now published or unpublished as asked.',
        content: { 'application/json': { schema: FaqWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: faqNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/faqs/{faqId}',
    operationId: 'deleteV1AdminFaq',
    summary: 'Remove a help-centre entry',
    description:
      'Requires the internal BFF credential and `cms.faq.manage` in an aal2 session. A real delete: a question and its answer are editorial content rather than a record of something that happened, and 0030 gave this table no history.',
    request: { ...sessionHeader, ...faqIdParam },
    responses: {
      200: {
        description: 'The entry was removed.',
        content: { 'application/json': { schema: FaqWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: faqNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  // ---------------------------------------------------------------------------------------------------
  // The SEO redirect map
  // ---------------------------------------------------------------------------------------------------
  const redirectNotFound = {
    description:
      'No entry the caller may see. An entry that does not exist and a caller without `seo.redirect.read` answer the same way, so a refusal cannot be told from an absence; a caller holding only the read key gets this from every write too.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const redirectRefused = {
    description:
      'The change was refused by a constraint migration 0030 owns: another entry already names that `from_path`, a path is not relative, a destination would leave the site, an entry would point at itself, or the status code is outside 301, 302, 307 and 308.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const redirectIdParam = {
    params: z.object({
      redirectId: z.string().uuid().openapi({ description: 'The entry’s identifier.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/seo/redirects/resolve',
    operationId: 'getV1SeoRedirectResolve',
    summary: 'Where the admin redirect map sends one path',
    description:
      'Requires the internal BFF credential and carries no user context: the map is the same for everybody, and nothing about the caller changes the answer. **This is asked only about a path the public site has already decided answers 404.** The approved precedence is LIVE PAGE WINS: a path that resolves to a live page or catalogue destination is rendered and this route is never consulted for it, so an active entry can never shadow a live URL. The answer is a union rather than a 404 because "the map names no redirect for this path" is the common answer and must be distinguishable from the service being unreachable. `toPath` is the end of the chain rather than the next step, `statusCode` is the code stored on the last entry followed, an inactive entry redirects nobody, the walk stops after five hops, and a chain that comes back to the path that was asked for answers `none`.',
    request: {
      query: z.object({
        path: z.string().openapi({
          description: 'The incoming path, relative and beginning with a single slash.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Where the map sends the path, or that it names no redirect for it.',
        content: { 'application/json': { schema: RedirectResolutionResponseSchema } },
      },
      400: validationFailed,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/seo/redirects',
    operationId: 'getV1AdminSeoRedirects',
    summary: 'The redirect map, newest edit first',
    description:
      'Requires the internal BFF credential and `seo.redirect.read` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. Newest edit first, because this is a maintenance list rather than a queue. `search` is a literal substring of either path, **not a pattern**: a percent sign or an underscore matches that character and nothing else, because this map supports no wildcard and no regular expression. `active` filters by state and its absence means both.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z.string().optional().openapi({
          description: `How many rows to return. Defaults to ${SEO_REDIRECTS_DEFAULT_LIMIT}; a larger value is clamped to ${SEO_REDIRECTS_MAX_LIMIT}.`,
        }),
        cursor: z.string().optional().openapi({
          description: 'An opaque position from a previous page. Never constructed by a client.',
        }),
        search: z.string().optional().openapi({
          description: 'A literal substring of either path, matched case-insensitively. Not a pattern.',
        }),
        active: z.string().optional().openapi({
          description: '`true` or `false` to filter by state. Absent means both.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'One page of the map.',
        content: { 'application/json': { schema: SeoRedirectsResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: redirectNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/seo/redirects/{redirectId}',
    operationId: 'getV1AdminSeoRedirect',
    summary: 'One entry, with where its chain ends',
    description:
      'Requires the internal BFF credential and `seo.redirect.read` in an aal2 session. `canManage` reports whether this caller also holds `seo.redirect.manage`, which is a separate seeded key: a console renders its controls from that answer rather than inferring it from a role name. `resolvedToPath` and `resolvedStatusCode` are where this entry’s chain actually ends, so an operator can see whether the destination is itself redirected onwards; both are null when the map would not redirect this path at all, which is what an entry that is switched off, or one sitting in a cycle, looks like from the outside.',
    request: { ...sessionHeader, ...redirectIdParam },
    responses: {
      200: {
        description: 'The entry.',
        content: { 'application/json': { schema: SeoRedirectDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: redirectNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/seo/redirects',
    operationId: 'postV1AdminSeoRedirects',
    summary: 'Add an entry to the redirect map',
    description:
      'Requires the internal BFF credential and `seo.redirect.manage` in an aal2 session. `statusCode` defaults to 301 and `isActive` to true, both of them the column defaults; `isActive: false` is how an entry is staged and switched on separately. Both paths must be relative and neither may be protocol-relative or external — this map cannot send anybody off the site. A `from_path` another entry already holds is refused: one address names one redirect.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateSeoRedirectRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The entry was created.',
        content: { 'application/json': { schema: CreateSeoRedirectResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: redirectNotFound,
      409: redirectRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/seo/redirects/{redirectId}',
    operationId: 'patchV1AdminSeoRedirect',
    summary: 'Change an entry’s paths, status code or note',
    description:
      'Requires the internal BFF credential and `seo.redirect.manage` in an aal2 session. Every field is optional and an absent field changes nothing; `note` as an empty string clears it. **Whether the entry is active is deliberately not changeable here** — that has its own route, so correcting a destination can never switch a redirect on, and turning one off is one unambiguous action in the audit trail.',
    request: {
      ...sessionHeader,
      ...redirectIdParam,
      body: { content: { 'application/json': { schema: UpdateSeoRedirectRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The entry was changed.',
        content: { 'application/json': { schema: SeoRedirectWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: redirectNotFound,
      409: redirectRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/seo/redirects/{redirectId}/state',
    operationId: 'putV1AdminSeoRedirectState',
    summary: 'Switch an entry on or off',
    description:
      'Requires the internal BFF credential and `seo.redirect.manage` in an aal2 session. The only route that changes whether an entry redirects anybody, so switching one off is one deliberate action and one audit row. An inactive entry is still stored and still readable; the public resolver simply does not see it.',
    request: {
      ...sessionHeader,
      ...redirectIdParam,
      body: { content: { 'application/json': { schema: SeoRedirectStateRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The entry is in the requested state.',
        content: { 'application/json': { schema: SeoRedirectWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: redirectNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/seo/redirects/{redirectId}',
    operationId: 'deleteV1AdminSeoRedirect',
    summary: 'Remove an entry from the redirect map',
    description:
      'Requires the internal BFF credential and `seo.redirect.manage` in an aal2 session. Removal is real here, where an authored page is archived instead: a page is content with a public address and a history, while a map entry is an instruction about an address, and an instruction nobody wants any more has no archived form. The audit trail records the removed row, so what the instruction said survives it. Switching the entry off is the reversible alternative.',
    request: { ...sessionHeader, ...redirectIdParam },
    responses: {
      200: {
        description: 'The entry was removed.',
        content: { 'application/json': { schema: SeoRedirectWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: redirectNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  // ---------------------------------------------------------------------------------------------------
  // Per-entity SEO metadata
  // ---------------------------------------------------------------------------------------------------
  const metadataNotFound = {
    description:
      'No entry the caller may see. An entry that does not exist and a caller without `seo.metadata.read` answer the same way, so a refusal cannot be told from an absence; a caller holding only the read key gets this from every write too.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const metadataRefused = {
    description:
      'The change was refused by a constraint migration 0030 owns: an entity kind it does not list, a path that is not relative or would leave the site, a value past a length bound, an empty or self-contradicting directive set, or a locale or share image that does not exist.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const metadataIdParam = {
    params: z.object({
      entryId: z.string().uuid().openapi({ description: 'The entry’s identifier.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/seo/metadata',
    operationId: 'getV1SeoMetadata',
    summary: 'One surface’s metadata override',
    description:
      'Requires the internal BFF credential and carries no user context: an override is as public as the thing it describes, and nothing about the caller changes the answer. Addressed by `entityType` and `slug`, or by `routePath` for a fixed landing address — **never by an identifier**, so no internal id has to cross into a public response to make this read possible. The answer is `null` rather than a 404 when nothing is stored, because that is the common answer and must be distinguishable from the service being unreachable. Metadata about anything the public cannot already see is withheld by the database. Two owner decisions are already applied to what comes back: `canonicalPath` is null for a listing, a category and a seller whatever was stored, because those keep the self-referencing canonical the specification fixes for them; and `robotsDirectives` holds restrictions only, so a stored value can never widen indexing past a platform rule. A missing locale is no override, never a fallback to the other language.',
    request: {
      query: z.object({
        entityType: z.string().optional().openapi({
          description: 'The kind of surface — `page`, `category`, `listing` or `seller`. Omitted for a route.',
        }),
        slug: z.string().optional().openapi({ description: 'The surface’s slug. Required with `entityType`.' }),
        routePath: z.string().optional().openapi({
          description: 'A fixed landing address, relative. Used instead of `entityType` and `slug`.',
        }),
        locale: z.string().optional().openapi({ description: 'Which locale’s override to read.' }),
      }),
    },
    responses: {
      200: {
        description: 'The override, or that there is none.',
        content: { 'application/json': { schema: PublicSeoMetadataResponseSchema } },
      },
      400: validationFailed,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/seo/metadata',
    operationId: 'getV1AdminSeoMetadata',
    summary: 'The metadata overrides, newest edit first',
    description:
      'Requires the internal BFF credential and `seo.metadata.read` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. Newest edit first, because this is a maintenance list rather than a queue. `targetSlug` names whatever each entry points at, so a row reads as a thing rather than as an identifier. The stored values come back **as stored**, including a canonical the public will not receive: an operator has to be able to see their own work. `canonicalIsHonoured` says whether this kind reads a canonical at all.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z.string().optional().openapi({
          description: `How many rows to return. Defaults to ${SEO_METADATA_DEFAULT_LIMIT}; a larger value is clamped to ${SEO_METADATA_MAX_LIMIT}.`,
        }),
        cursor: z.string().optional().openapi({
          description: 'An opaque position from a previous page. Never constructed by a client.',
        }),
        entityType: z.string().optional().openapi({ description: 'Narrow to one kind of surface.' }),
        locale: z.string().optional().openapi({ description: 'Narrow to one locale.' }),
      }),
    },
    responses: {
      200: {
        description: 'One page of entries.',
        content: { 'application/json': { schema: SeoMetadataEntriesResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: metadataNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/seo/metadata/{entryId}',
    operationId: 'getV1AdminSeoMetadataEntry',
    summary: 'One entry, with what the public would actually receive',
    description:
      'Requires the internal BFF credential and `seo.metadata.read` in an aal2 session. `canManage` reports whether this caller also holds `seo.metadata.manage`, which is a separate seeded key. `effectiveCanonicalPath` and `effectiveRobotsDirectives` are the database’s own answers for what a visitor’s browser will be told, beside the stored values — so an operator who has written `index` into a row can see that nothing will come of it, from the reader rather than from a sentence on a screen.',
    request: { ...sessionHeader, ...metadataIdParam },
    responses: {
      200: {
        description: 'The entry.',
        content: { 'application/json': { schema: SeoMetadataDetailResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: metadataNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/seo/metadata',
    operationId: 'putV1AdminSeoMetadata',
    summary: 'Write one surface’s metadata for one locale',
    description:
      'Requires the internal BFF credential and `seo.metadata.manage` in an aal2 session. Creating and replacing are the same request, which is why it is a `PUT` on the collection rather than a `POST`: one surface and one locale have one row, and the request *is* that row — **an absent field clears the stored value**. A route carries a path and no identifier; every other kind carries an identifier and no path. `structuredData` is not a field here: the column exists and has no reader, so nothing can send one. Both paths must be relative and neither may leave the site.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: SaveSeoMetadataRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The entry was written.',
        content: { 'application/json': { schema: SaveSeoMetadataResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: metadataNotFound,
      409: metadataRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/seo/metadata/{entryId}',
    operationId: 'deleteV1AdminSeoMetadataEntry',
    summary: 'Remove one override',
    description:
      'Requires the internal BFF credential and `seo.metadata.manage` in an aal2 session. Removing an override returns that surface to the metadata it derives from its own content, which is why removal is real here where an authored page is archived instead: an override is an instruction about a surface rather than content with an address. The audit trail records the removed row.',
    request: { ...sessionHeader, ...metadataIdParam },
    responses: {
      200: {
        description: 'The override was removed.',
        content: { 'application/json': { schema: SeoMetadataWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: metadataNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  // -------------------------------------------------------------------------------------------------
  // Site-wide SEO settings (0096)
  // -------------------------------------------------------------------------------------------------
  const seoSettingsNotFound = {
    description:
      'No settings the caller may see. A caller without `seo.settings.manage` at aal2 gets this from every route here, read or write, so a refusal cannot be told from an absence. There is no `seo.settings.read`: 0033 seeds one key for this cluster, so reading and writing it are the same capability.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const seoSettingsRefused = {
    description:
      'The change was refused by a constraint migration 0030 owns: a site name that is blank or past 120 characters, a default title past 70 or description past 320, a handle that is not `@` followed by up to fifteen word characters, an organization document that is not a JSON object, or a share image that is not a media row.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const seoSettingsLocaleParam = {
    params: z.object({
      localeCode: z.string().openapi({ description: 'The locale to write or remove, as a seeded locale code.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/seo/settings',
    operationId: 'getV1AdminSeoSettings',
    summary: 'The site-wide SEO defaults, one row per active locale',
    description:
      'Requires the internal BFF credential and `seo.settings.manage` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. **One row per active locale whether or not it has been authored**, default locale first, because the table ships empty and the first save needs somewhere to happen: `isAuthored` tells the two states apart. `robotsIsServed` is true for the default locale and only the default locale — `/robots.txt` is one document at the root of an origin, so a body authored on any other locale is stored and never served. `shareMediaObjectPath` is a relative path inside a private bucket and is never an address: the image cannot be resolved or displayed, because no media origin or signing capability exists. Everything except `robotsTxtBody` is stored and read by nothing: the site name does not feed the header or any page title, the default title and description feed no metadata resolver, the handle emits no Twitter metadata, and the organization document emits no JSON-LD.',
    request: sessionHeader,
    responses: {
      200: {
        description: 'Every active locale.',
        content: { 'application/json': { schema: SeoSettingsResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: seoSettingsNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/seo/settings/{localeCode}',
    operationId: 'putV1AdminSeoSettingsLocale',
    summary: 'Write one locale’s site-wide defaults',
    description:
      'Requires the internal BFF credential and `seo.settings.manage` in an aal2 session. Creating and replacing are the same request, which is why it is a `PUT` on the locale rather than a `POST`: one locale has one row, and the request *is* that row — **an absent field clears the stored value**, which is also how an authored crawl policy is withdrawn without deleting the locale. `siteName` is required because the column is `not null`. `robotsTxtBody` is served to crawlers **verbatim** and is never parsed here; only surrounding whitespace is removed, and a body of nothing but whitespace is stored as absent rather than as a document that silently says nothing. A locale that is not an active locale answers 404 and writes nothing.',
    request: {
      ...sessionHeader,
      ...seoSettingsLocaleParam,
      body: { content: { 'application/json': { schema: SaveSeoSettingsRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The settings were written.',
        content: { 'application/json': { schema: SeoSettingsWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: seoSettingsNotFound,
      409: seoSettingsRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/seo/settings/{localeCode}',
    operationId: 'deleteV1AdminSeoSettingsLocale',
    summary: 'Remove one locale’s site-wide defaults',
    description:
      'Requires the internal BFF credential and `seo.settings.manage` in an aal2 session. Afterwards the locale is unauthored, which for the default locale returns `/robots.txt` to the minimal document the public web already serves when nothing has been authored — the zero-row answer the reader has handled since 0086. A real delete, because these are settings rather than a record of an event; the audit trail records the removed row.',
    request: { ...sessionHeader, ...seoSettingsLocaleParam },
    responses: {
      200: {
        description: 'The settings were removed.',
        content: { 'application/json': { schema: SeoSettingsWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: seoSettingsNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  // -------------------------------------------------------------------------------------------------
  // The CMS media library (0098)
  // -------------------------------------------------------------------------------------------------
  const cmsMediaNotFound = {
    description:
      'No media the caller may see. A caller without `cms.media.manage` at aal2 gets this from every route here, read or write, so a refusal cannot be told from an absence. There is no `cms.media.read`: 0033 seeds one key for this cluster, so reading and changing the library are the same capability. A cursor that does not decode answers the same way.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const cmsMediaRefused = {
    description:
      'The operation was refused by the `cms-media` bucket or by a constraint migration 0030 owns: a content type the bucket does not allow (SVG among them), a size outside its 10 MiB limit, an object path that is not the shape the authorizer issues, an extension that disagrees with the declared type, an uploaded file that is not actually there, or an object that already has a library entry.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const cmsMediaIdParam = {
    params: z.object({
      mediaId: z.string().uuid().openapi({ description: 'The media entry’s identifier.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/cms/media',
    operationId: 'getV1AdminCmsMedia',
    summary: 'One page of the media library, newest first',
    description:
      'Requires the internal BFF credential and `cms.media.manage` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. `objectPath` is a relative path inside a **private** bucket and is never an address: an image is viewed through the per-entry preview below, which issues a short-lived signed URL. `usageCount` is how many CMS rows point at the entry, so an operator can see at a glance which entries deleting would blank.',
    request: {
      ...sessionHeader,
      query: z.object({
        limit: z.string().optional().openapi({
          description: `How many entries to return. Defaults to ${CMS_MEDIA_DEFAULT_LIMIT}; a larger value is clamped to ${CMS_MEDIA_MAX_LIMIT}.`,
        }),
        cursor: z.string().optional().openapi({
          description: 'An opaque position from a previous page. Never constructed by a client.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'One page of entries.',
        content: { 'application/json': { schema: CmsMediaPageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsMediaNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/cms/media/uploads',
    operationId: 'postV1AdminCmsMediaUpload',
    summary: 'Authorize one upload',
    description:
      `Requires the internal BFF credential and \`cms.media.manage\` in an aal2 session. Creates a signed, time-limited permission to put one object at one path, and **records nothing**: the entry exists only once the companion route confirms it. The request carries a content type and a size and **no path** — the strict schema refuses one — because every component of the path is composed server-side from a generated identifier and an extension derived from the validated type, which makes a traversal or a chosen path unexpressible rather than merely refused. The bucket is the authority on what may be stored: four raster types, SVG excluded, and at most ${CMS_MEDIA_MAX_BYTES} bytes. A signature that cannot be issued is a 503 and no upload.`,
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CmsMediaUploadRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The upload was authorized.',
        content: { 'application/json': { schema: CmsMediaUploadResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsMediaNotFound,
      409: cmsMediaRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/cms/media',
    operationId: 'postV1AdminCmsMedia',
    summary: 'Confirm an upload and record the entry',
    description:
      'Requires the internal BFF credential and `cms.media.manage` in an aal2 session. The path is the one the authorization returned; the database re-checks its whole shape, and the extension must agree with the declared content type, so no nested path, no traversal and no mislabelled file can be recorded. **Storage is asked whether the object is actually there before anything is written**, so a confirmation for a file nobody uploaded never reaches a write — a library pointing at nothing is the state that rots quietly. Confirming the same object twice is refused rather than duplicated.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CmsMediaAttachRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The entry was recorded.',
        content: { 'application/json': { schema: CmsMediaAttachResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsMediaNotFound,
      409: cmsMediaRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/cms/media/{mediaId}/usage',
    operationId: 'getV1AdminCmsMediaUsage',
    summary: 'Every CMS row that points at one entry',
    description:
      'Requires the internal BFF credential and `cms.media.manage` in an aal2 session. All six of migration 0030’s referencing columns are `on delete set null`, so deleting an entry blanks a page cover, a blog cover, a banner image or a share image. This is what a console reads **before** offering the delete, rather than leaving an operator to discover it afterwards. `entityId` is null for the SEO settings, whose key is a locale code rather than an identifier; `label` carries the recognisable part for every kind and `column` says which column points at it — a banner has two.',
    request: { ...sessionHeader, ...cmsMediaIdParam },
    responses: {
      200: {
        description: 'Every reference, which may be none.',
        content: { 'application/json': { schema: CmsMediaUsageResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsMediaNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/cms/media/{mediaId}/preview',
    operationId: 'getV1AdminCmsMediaPreview',
    summary: 'A short-lived signed URL for one stored object',
    description:
      'Requires the internal BFF credential and `cms.media.manage` in an aal2 session. The bucket is private and has no read policy, so an image is viewed through a signed URL issued per request for the one object that entry stores — the path is never composed here and never supplied by a client. The URL is a bearer credential for a few minutes and is not stored or cached anywhere. **This is a staff preview and is not how a public page shows an image**: no public media delivery exists.',
    request: { ...sessionHeader, ...cmsMediaIdParam },
    responses: {
      200: {
        description: 'The signed URL and when it expires.',
        content: { 'application/json': { schema: CmsMediaPreviewResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsMediaNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/cms/media/{mediaId}/alt-text',
    operationId: 'putV1AdminCmsMediaAltText',
    summary: 'Replace one entry’s alt text',
    description:
      'Requires the internal BFF credential and `cms.media.manage` in an aal2 session. Both the English and the Arabic alt text are replaced on every call and **neither is required**; a blank one is stored as absent, so no surface could ever carry an empty `alt` attribute. Nothing else about a stored object is editable — the path, the type, the size and the dimensions describe a file that has already been uploaded, and replacing an image means uploading another one.',
    request: {
      ...sessionHeader,
      ...cmsMediaIdParam,
      body: { content: { 'application/json': { schema: CmsMediaAltTextRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The alt text was written.',
        content: { 'application/json': { schema: CmsMediaWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsMediaNotFound,
      409: cmsMediaRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/cms/media/{mediaId}',
    operationId: 'deleteV1AdminCmsMediaEntry',
    summary: 'Remove one entry from the library',
    description:
      'Requires the internal BFF credential and `cms.media.manage` in an aal2 session. Every reference to the entry becomes null through migration 0030’s own `on delete set null` foreign keys and through nothing else: no statement anywhere updates a referencing row. The usage route above is what a console shows first. The stored object remains in the private bucket and becomes unreachable, because a signed read is only ever issued for an object an entry still points at.',
    request: { ...sessionHeader, ...cmsMediaIdParam },
    responses: {
      200: {
        description: 'The entry was removed.',
        content: { 'application/json': { schema: CmsMediaWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: cmsMediaNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  // -------------------------------------------------------------------------------------------------
  // The category tree (admin catalogue, D8)
  // -------------------------------------------------------------------------------------------------
  const categoryNotFound = {
    description:
      'No category the caller may see. A category that does not exist and a caller without `catalog.category.read` answer the same way, so a refusal cannot be told from an absence; a caller holding only the read key gets this from every write too.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const categoryRefused = {
    description:
      'The category exists and the change was refused by a rule migration 0010 owns: a fourth level, a move that would make a category its own ancestor or re-depth one that has children, a slug already in use, showing a category nobody has named, or removing the last locale of one that is shown.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const categoryIdParam = {
    params: z.object({
      categoryId: z.string().uuid().openapi({ description: 'The category’s identifier.' }),
    }),
  } as const;
  const categoryLocaleParams = {
    params: z.object({
      categoryId: z.string().uuid().openapi({ description: 'The category’s identifier.' }),
      localeCode: z.string().openapi({ description: 'The locale to write or remove, as a seeded locale code.' }),
    }),
  } as const;

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/categories',
    operationId: 'getV1AdminCategories',
    summary: 'The whole category tree',
    description:
      'Requires the internal BFF credential and `catalog.category.read` in an aal2 session — a key Admin and Super Admin hold, and both roles require MFA, so a staff session at aal1 reads nothing. The **whole** tree, including inactive categories: a console that showed only the active ones could not be used to bring one back. Ordered by depth, then sibling order, then slug, so it can be indented directly. `isVisible` is the public answer and differs from `isActive` exactly when an active category sits under a hidden ancestor. `translatedLocales` is the locale coverage, and `childCount` and `listingCount` say what hangs off each node.',
    request: sessionHeader,
    responses: {
      200: {
        description: 'The tree. An empty array means no category has been created yet.',
        content: { 'application/json': { schema: AdminCategoryTreeResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/categories/{categoryId}',
    operationId: 'getV1AdminCategory',
    summary: 'One category, with every locale it has been written in',
    description:
      'Requires the internal BFF credential and `catalog.category.read` at aal2. `canManage` says whether this caller also holds `catalog.category.manage`, and is what a console renders its controls from: deciding that from a role name would be a second, weaker copy of a rule the database already applies. `parentSlug` travels with the row so a screen needs no second read.',
    request: { ...sessionHeader, ...categoryIdParam },
    responses: {
      200: {
        description: 'The category and its translations.',
        content: { 'application/json': { schema: AdminCategoryDetailResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/categories',
    operationId: 'postV1AdminCategories',
    summary: 'Create one category',
    description:
      'Requires the internal BFF credential and `catalog.category.manage` at aal2. The slug is given here and can never be changed afterwards: it is the category’s public address, there is no category slug history and the public reader has no redirect answer. A new category is always created **hidden**, whatever the caller asks, because the public tree falls back to the slug when no translation exists and an unnamed category would otherwise appear labelled by it. `depth` is not accepted: the tree trigger derives it from the parent and refuses a fourth level.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateCategoryRequestSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The category was created, hidden.',
        content: { 'application/json': { schema: CreateCategoryResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      409: categoryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/categories/{categoryId}',
    operationId: 'patchV1AdminCategory',
    summary: 'Change a category’s parent, surface or ordering',
    description:
      'Requires the internal BFF credential and `catalog.category.manage` at aal2. `slug` and `isActive` are **not** part of this request and the body is strict, so sending either is a validation failure rather than a value quietly dropped: the slug can never change, and showing or hiding a category has its own request so that a visibility change is never a side effect of an edit. `setParent` exists because `null` is a real parent — it means a root — so without the flag "move to the root" and "leave the parent alone" would be the same request.',
    request: {
      ...sessionHeader,
      ...categoryIdParam,
      body: { content: { 'application/json': { schema: UpdateCategoryRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The change was applied.',
        content: { 'application/json': { schema: CategoryWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      409: categoryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/categories/{categoryId}/state',
    operationId: 'putV1AdminCategoryState',
    summary: 'Show or hide one category',
    description:
      'Requires the internal BFF credential and `catalog.category.manage` at aal2. Showing a category that has been written in no locale is refused, because the public tree would label it by its slug. Hiding one needs no cascade: every public reader resolves through the ancestor rule, so a hidden category takes its whole branch out of the tree, the landing pages, the search facet and the sitemap at once, while the children keep their own state and the branch can be restored exactly as it was.',
    request: {
      ...sessionHeader,
      ...categoryIdParam,
      body: { content: { 'application/json': { schema: CategoryStateRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The category was shown or hidden.',
        content: { 'application/json': { schema: CategoryWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      409: categoryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/categories/{categoryId}/translations/{localeCode}',
    operationId: 'putV1AdminCategoryTranslation',
    summary: 'Write one locale of one category',
    description:
      'Requires the internal BFF credential and `catalog.category.manage` at aal2. An upsert, so writing a locale for the first time and correcting it later are the same call. `name` is required because the column is not null; the optional fields accept an empty string, which clears them, and a blank is stored as null so an empty meta title never renders as an empty tag. The category’s own `updatedAt` moves, because an author means a translation as an edit to the category.',
    request: {
      ...sessionHeader,
      ...categoryLocaleParams,
      body: { content: { 'application/json': { schema: SaveCategoryTranslationRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The locale was written.',
        content: { 'application/json': { schema: CategoryWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      409: categoryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/categories/{categoryId}/translations/{localeCode}',
    operationId: 'deleteV1AdminCategoryTranslation',
    summary: 'Remove one locale of one category',
    description:
      'Requires the internal BFF credential and `catalog.category.manage` at aal2. A locale that is not there answers that nothing changed, rather than reporting a rule violation about something absent. The last locale of a category that is shown is refused, for the same reason it could not have been shown without one.',
    request: { ...sessionHeader, ...categoryLocaleParams },
    responses: {
      200: {
        description: 'The locale was removed, or there was none to remove.',
        content: { 'application/json': { schema: CategoryWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      409: categoryRefused,
      503: unavailable,
      500: internalError,
    },
  });

  // -------------------------------------------------------------------------------------------------
  // The attribute and tag vocabulary, and what each category asks for (8-C)
  // -------------------------------------------------------------------------------------------------
  const vocabularyNotFound = {
    description:
      'No such attribute, option or tag — or the caller may read the vocabulary but not manage it. The two are deliberately the same answer: the database refuses the second with `42501`, and a 403 would turn the console into a way to ask what exists.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const vocabularyRefused = {
    description:
      'The change was refused by a rule migrations 0010 and 0011 own: a key, option value or tag slug already in use, showing a select attribute that has no active option, giving an option to an attribute that is not a select one, or a value the column refuses.',
    content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
  } as const;
  const definitionIdParam = {
    params: z.object({
      definitionId: z.string().uuid().openapi({ description: 'The attribute definition’s identifier.' }),
    }),
  } as const;
  const optionParams = {
    params: z.object({
      definitionId: z.string().uuid().openapi({ description: 'The attribute definition’s identifier.' }),
      optionId: z.string().uuid().openapi({ description: 'The option’s identifier.' }),
    }),
  } as const;
  const tagIdParam = {
    params: z.object({ tagId: z.string().uuid().openapi({ description: 'The tag’s identifier.' }) }),
  } as const;
  const categoryAttributeParams = {
    params: z.object({
      categoryId: z.string().uuid().openapi({ description: 'The category’s identifier.' }),
      definitionId: z.string().uuid().openapi({ description: 'The attribute definition’s identifier.' }),
    }),
  } as const;

  /* ---------------------------------------------------------------------------------------------- */
  /* Listing analytics (0102)                                                                        */
  /*                                                                                                  */
  /* One operation: a page of the daily rollup. There is no write here and none anywhere in 0102 — a  */
  /* day is corrected by re-running the scheduled job for it, not by a console. `analytics.listing.read`*/
  /* has been seeded since 0033 and is consumed for the first time by this surface.                    */
  /* ---------------------------------------------------------------------------------------------- */
  registry.registerPath({
    method: 'get',
    path: '/v1/admin/analytics/listings',
    operationId: 'getV1AdminAnalyticsListings',
    summary: 'Listing analytics, by day',
    description:
      'Requires the internal BFF credential and `analytics.listing.read` in an aal2 session. One page of the `listing_analytics` rollup, newest day first, across every seller: the clicks, contacts, favourites and shares a scheduled job computed for each listing on each UTC day. **Every number is the rollup\u2019s.** This operation defines no metric, computes no rate, ratio or click-through, reads no raw event, and reports neither impressions nor views, because 0101 ingests neither and their definitions are a later decision. There is no unique-visitor or unique-session count, because an absent session digest is stored as a zero-length value and a distinct count would report all anonymous traffic as one visitor. A seller is named by their storefront\u2019s public slug and never by an account identifier; nothing derived from a session digest or a signed-in account appears anywhere in a row. The counts are `bigint` and travel as decimal integer strings \u2014 counts, not money, carrying no currency. A caller who does not hold the key at aal2 receives an empty page, which is the same answer as a window with nothing in it.',
    request: {
      ...sessionHeader,
      query: z.object({
        ...adminOpsPaging,
        days: z
          .string()
          .optional()
          .openapi({
            description: `How many days back to cover. Defaults to ${LISTING_ANALYTICS_DEFAULT_DAYS}; a larger value is clamped to ${LISTING_ANALYTICS_MAX_DAYS}.`,
          }),
      }),
    },
    responses: {
      200: {
        description:
          'One page of the rollup, newest day first. An empty page means nothing in the window, or a caller who may not read it.',
        content: { 'application/json': { schema: ListingAnalyticsResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/attributes',
    operationId: 'getV1AdminAttributes',
    summary: 'The whole attribute vocabulary',
    description:
      'Requires the internal BFF credential and `catalog.attribute.manage` in an aal2 session. There is no separate read key for this surface and none was invented: the manage key is what the table’s own RLS policy names, so the vocabulary is visible to the people who maintain it. The **whole** vocabulary, including hidden definitions, because a console that showed only the visible ones could not bring one back. Each row carries three counts that decide what a console may offer: how many options it has, how many categories ask for it, and how many sellers have already answered it.',
    request: sessionHeader,
    responses: {
      200: {
        description: 'The vocabulary. An empty array means no attribute has been defined yet.',
        content: { 'application/json': { schema: AdminAttributeDefinitionsResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/attributes/{definitionId}',
    operationId: 'getV1AdminAttribute',
    summary: 'One attribute definition, with its options',
    description:
      'Requires the internal BFF credential and `catalog.attribute.manage` at aal2. `options` is empty for a text, number or boolean attribute, which has none and can take none. Each option reports how many listings have chosen it, which is what makes hiding one an informed decision rather than a guess.',
    request: { ...sessionHeader, ...definitionIdParam },
    responses: {
      200: {
        description: 'The definition and its options.',
        content: { 'application/json': { schema: AdminAttributeDetailResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/attributes',
    operationId: 'postV1AdminAttributes',
    summary: 'Define one attribute',
    description:
      'Requires the internal BFF credential and `catalog.attribute.manage` at aal2. The key and the data type are given here and can never be changed: the key is the identity every public listing projection carries, and the data type is what every answer already stored was validated against, so changing either would silently reinterpret live data. A unit belongs to a number and to nothing else. A new definition is always created **hidden**, whatever the caller asks, because a select attribute has no options yet and would appear on sellers’ forms as a field nobody can answer.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateAttributeDefinitionRequestSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The attribute was defined, hidden.',
        content: { 'application/json': { schema: CreateAttributeDefinitionResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/attributes/{definitionId}',
    operationId: 'patchV1AdminAttribute',
    summary: 'Edit one attribute’s labels, unit, filterability and order',
    description:
      'Requires the internal BFF credential and `catalog.attribute.manage` at aal2. `key`, `dataType` and `isActive` are **not** part of this request and the body is strict, so sending any of them is a validation failure rather than a value quietly dropped. A unit on an attribute that is not a number cannot be caught by the schema — the request does not carry the data type and would have to be believed about it — so the column refuses it and the answer is 409 `ATTRIBUTE_VALUE_NOT_ALLOWED`. `isFilterable` is recorded and nothing filters by it in this increment.',
    request: {
      ...sessionHeader,
      ...definitionIdParam,
      body: { content: { 'application/json': { schema: UpdateAttributeDefinitionRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The change was applied.',
        content: { 'application/json': { schema: VocabularyWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/attributes/{definitionId}/state',
    operationId: 'putV1AdminAttributeState',
    summary: 'Show or hide one attribute',
    description:
      'Requires the internal BFF credential and `catalog.attribute.manage` at aal2. Its own request, because this is the one edit a seller and a visitor both see. Showing a select attribute that has no active option is refused with 409 `ATTRIBUTE_NOT_ANSWERABLE`: it would put a field nobody can answer on every seller’s form. Hiding one needs no cascade and destroys nothing — the public readers of 0047 already filter on the definition’s state, so the attribute leaves every listing page at once while the answers stay exactly as the sellers left them, and showing it again restores them.',
    request: {
      ...sessionHeader,
      ...definitionIdParam,
      body: { content: { 'application/json': { schema: VocabularyStateRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The attribute was shown or hidden.',
        content: { 'application/json': { schema: VocabularyWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/attributes/{definitionId}/options',
    operationId: 'postV1AdminAttributeOptions',
    summary: 'Add one option to a select attribute',
    description:
      'Requires the internal BFF credential and `catalog.attribute.manage` at aal2. Refused with 409 `ATTRIBUTE_NOT_ANSWERABLE` for a text, number or boolean attribute, which cannot carry an option. The value is the option’s machine identity and is unique within the attribute; it can never be changed, because it is what every stored answer refers to. Created active: an option exists in order to be chosen.',
    request: {
      ...sessionHeader,
      ...definitionIdParam,
      body: { content: { 'application/json': { schema: CreateAttributeOptionRequestSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The option was added.',
        content: { 'application/json': { schema: CreateAttributeOptionResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/attributes/{definitionId}/options/{optionId}',
    operationId: 'patchV1AdminAttributeOption',
    summary: 'Edit one option’s labels and order',
    description:
      'Requires the internal BFF credential and `catalog.attribute.manage` at aal2. `value` is absent from the request entirely, because it is the identity stored in every answer that has chosen this option; what an administrator edits is what the option is called.',
    request: {
      ...sessionHeader,
      ...optionParams,
      body: { content: { 'application/json': { schema: UpdateAttributeOptionRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The change was applied.',
        content: { 'application/json': { schema: VocabularyWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/attributes/{definitionId}/options/{optionId}/state',
    operationId: 'putV1AdminAttributeOptionState',
    summary: 'Show or hide one option',
    description:
      'Requires the internal BFF credential and `catalog.attribute.manage` at aal2. A hidden option can no longer be chosen and no longer appears on a public listing, while the listings that already chose it keep it: the answer is preserved and comes back if the option is shown again. Deletion is not offered on this surface at all.',
    request: {
      ...sessionHeader,
      ...optionParams,
      body: { content: { 'application/json': { schema: VocabularyStateRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The option was shown or hidden.',
        content: { 'application/json': { schema: VocabularyWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/tags',
    operationId: 'getV1AdminTags',
    summary: 'The whole tag vocabulary',
    description:
      'Requires the internal BFF credential and `catalog.tag.manage` in an aal2 session. A separate key from the attribute vocabulary, and holding one grants nothing on the other. Hidden tags are included, for the same reason hidden attributes are. `usageCount` is the number 0011’s own trigger maintains as listings are tagged and untagged, reported rather than counted again here.',
    request: sessionHeader,
    responses: {
      200: {
        description: 'The tags. An empty array means none has been created yet.',
        content: { 'application/json': { schema: AdminTagsResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/admin/tags',
    operationId: 'postV1AdminTags',
    summary: 'Create one tag',
    description:
      'Requires the internal BFF credential and `catalog.tag.manage` at aal2. The slug is the tag’s public identity, given here and never changed. Created **active**, unlike an attribute definition: there is nothing to fill in first, so a tag is usable the moment it exists.',
    request: {
      ...sessionHeader,
      body: { content: { 'application/json': { schema: CreateTagRequestSchema } }, required: true },
    },
    responses: {
      201: {
        description: 'The tag was created, active.',
        content: { 'application/json': { schema: CreateTagResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/admin/tags/{tagId}',
    operationId: 'patchV1AdminTag',
    summary: 'Rename one tag',
    description:
      'Requires the internal BFF credential and `catalog.tag.manage` at aal2. `slug` is absent from the request: it is the tag’s public identity and there is no tag slug history to redirect from.',
    request: {
      ...sessionHeader,
      ...tagIdParam,
      body: { content: { 'application/json': { schema: UpdateTagRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The change was applied.',
        content: { 'application/json': { schema: VocabularyWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/tags/{tagId}/state',
    operationId: 'putV1AdminTagState',
    summary: 'Show or hide one tag',
    description:
      'Requires the internal BFF credential and `catalog.tag.manage` at aal2. A hidden tag cannot be chosen by a seller and does not appear on a public listing, while the listings already carrying it keep it. Deletion is not offered: `listing_tags` holds a restricting foreign key, so hiding is the operation that exists.',
    request: {
      ...sessionHeader,
      ...tagIdParam,
      body: { content: { 'application/json': { schema: VocabularyStateRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The tag was shown or hidden.',
        content: { 'application/json': { schema: VocabularyWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: vocabularyNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/admin/categories/{categoryId}/attributes',
    operationId: 'getV1AdminCategoryAttributes',
    summary: 'Which attributes one category asks its sellers about',
    description:
      'Requires the internal BFF credential and `catalog.category.read` at aal2 — the **category** key, not the attribute key, because this is a property of the category. Each row carries the definition’s own `isActive`, so a console can show that an attached attribute which is hidden is asked of nobody. `isRequired` is **advisory in this increment**: a seller’s form marks the field and says so, and no writer refuses a listing for want of an answer.',
    request: { ...sessionHeader, ...categoryIdParam },
    responses: {
      200: {
        description: 'The attributes this category asks for, in the order it asks them.',
        content: { 'application/json': { schema: AdminCategoryAttributesResponseSchema } },
      },
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/admin/categories/{categoryId}/attributes',
    operationId: 'putV1AdminCategoryAttributes',
    summary: 'Ask a category for one attribute, or change how it asks',
    description:
      'Requires the internal BFF credential and `catalog.category.manage` at aal2, which is what `category_attributes`’ own write policy names: holding `catalog.attribute.manage` lets somebody define an attribute and does **not** let them decide which categories ask for it. One operation for attaching and for editing, because attaching something already attached is an edit of how it is asked rather than an error. Existing answers are never touched.',
    request: {
      ...sessionHeader,
      ...categoryIdParam,
      body: { content: { 'application/json': { schema: AttachCategoryAttributeRequestSchema } }, required: true },
    },
    responses: {
      200: {
        description: 'The category now asks for that attribute, in the stated way.',
        content: { 'application/json': { schema: VocabularyWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/categories/{categoryId}/attributes/{definitionId}',
    operationId: 'deleteV1AdminCategoryAttribute',
    summary: 'Stop a category asking for one attribute',
    description:
      'Requires the internal BFF credential and `catalog.category.manage` at aal2. The attribute is no longer asked of new listings and no longer editable on existing ones, and **the answers already given are left exactly where they are**: detaching is a decision about a form, not about data, and re-attaching the attribute brings every answer back. An attribute the category does not ask for answers that nothing changed.',
    request: { ...sessionHeader, ...categoryAttributeParams },
    responses: {
      200: {
        description: 'The attribute is no longer asked for, or was not asked for in the first place.',
        content: { 'application/json': { schema: VocabularyWriteResponseSchema } },
      },
      400: validationFailed,
      401: authenticationRequired,
      403: credentialRejected,
      404: categoryNotFound,
      409: vocabularyRefused,
      503: unavailable,
      500: internalError,
    },
  });

  // -------------------------------------------------------------------------------------------------
  // What a seller answers, on both of their own surfaces (8-C)
  // -------------------------------------------------------------------------------------------------
  // The four operations are identical on products and on services, and are registered from one place so the two
  // surfaces cannot drift: the database functions take the listing type they are being asked about, so a product
  // slug reached through the services surface answers 404 exactly as a slug that does not exist.
  const registerSellerVocabularySurface = (
    surface: 'listings' | 'services',
    noun: 'listing' | 'service',
    missingDescription: string,
    operationNoun: 'Listing' | 'Service',
  ): void => {
    const missing = {
      description: missingDescription,
      content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
    } as const;
    const slugParam = {
      params: z.object({
        slug: z
          .string()
          .openapi({ description: `The ${noun}’s slug, which must be one of the caller’s own.` }),
      }),
    } as const;
    // One 409 for both refusals, because both are the state of something outside the request: `SELLER_LISTING_
    // NOT_EDITABLE` when the storefront or the listing cannot be edited, and `LISTING_ATTRIBUTE_ANSWER_NOT_
    // ALLOWED` when 0011's validation trigger refused an answer.
    const refused = {
      description:
        'The storefront cannot be used, the listing is not a draft, or one of the answers is not one this listing can carry — a value of the wrong kind for its attribute, an option that is not that attribute’s or is hidden, more than one option on a single-select, a tag that is unknown or hidden, or an attribute this category does not ask about. 0011’s validation trigger is the single judge of the last of those. **Never raised for an unanswered required attribute:** `is_required` is advisory in this increment. No code here names a moderation reason.',
      content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
    } as const;

    registry.registerPath({
      method: 'get',
      path: `/v1/sellers/me/${surface}/{slug}/attributes`,
      operationId: `getV1SellersMe${operationNoun}Attributes`,
      summary: `The attributes one of the caller’s own ${surface} is asked about`,
      description: `Requires the internal BFF credential and the caller’s session. Which questions exist is the ${noun}’s category’s answer, not the seller’s, so this is what a form is built from: each row carries the question, its data type, whether it is marked required, the options it offers where it has any, and whatever this ${noun} already answers. Options travel as values; option identifiers are internal and never leave the API. \`isEditable\` is 0061’s own rule reported rather than restated by a screen — it is false once the ${noun} is no longer a draft.`,
      request: {
        ...sessionHeader,
        ...slugParam,
        query: z.object({
          locale: PublicLocaleSchema.optional().describe(
            'Names the language of the labels. Absent or unrecognised resolves to the default locale.',
          ),
        }),
      },
      responses: {
        200: {
          description: 'The questions, with this listing’s answers.',
          content: { 'application/json': { schema: SellerListingAttributesResponseSchema } },
        },
        400: validationFailed,
        401: authenticationRequired,
        403: credentialRejected,
        404: missing,
        503: unavailable,
        500: internalError,
      },
    });

    registry.registerPath({
      method: 'post',
      path: `/v1/sellers/me/${surface}/{slug}/attributes`,
      operationId: `postV1SellersMe${operationNoun}Attributes`,
      summary: `Answer the attributes on one of the caller’s own draft ${surface}`,
      description: `Requires the internal BFF credential and the caller’s session. Replaces the **whole** set of answers, which is how a seller clears one: the answer is left out. Each answer is shaped by its attribute’s data type, and a shape that could carry two kinds of value at once would be a shape the database refuses, so the request is a discriminated union rather than four optional fields. Draft only, and the caller’s own. **An unanswered required attribute is accepted**: \`is_required\` is advisory in this increment, the seller is told which fields are required and nothing refuses the save or the later submission for want of one.`,
      request: {
        ...sessionHeader,
        ...slugParam,
        body: {
          content: { 'application/json': { schema: SaveSellerListingAttributesRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: 'The answers were replaced.',
          content: { 'application/json': { schema: SellerListingAttributesWriteResponseSchema } },
        },
        400: validationFailed,
        401: authenticationRequired,
        403: credentialRejected,
        404: missing,
        409: refused,
        503: unavailable,
        500: internalError,
      },
    });

    registry.registerPath({
      method: 'get',
      path: `/v1/sellers/me/${surface}/{slug}/tags`,
      operationId: `getV1SellersMe${operationNoun}Tags`,
      summary: `The tags one of the caller’s own ${surface} may carry`,
      description: `Requires the internal BFF credential and the caller’s session. Every active tag, each marked with whether this ${noun} carries it, so a form is one read rather than two and a seller never sees a tag they cannot choose. A hidden tag is absent even if this ${noun} still carries it, because it can no longer be chosen and no longer appears publicly.`,
      request: {
        ...sessionHeader,
        ...slugParam,
        query: z.object({
          locale: PublicLocaleSchema.optional().describe(
            'Names the language of the tag names. Absent or unrecognised resolves to the default locale.',
          ),
        }),
      },
      responses: {
        200: {
          description: 'The tags, each with whether it is selected.',
          content: { 'application/json': { schema: SellerListingTagsResponseSchema } },
        },
        400: validationFailed,
        401: authenticationRequired,
        403: credentialRejected,
        404: missing,
        503: unavailable,
        500: internalError,
      },
    });

    registry.registerPath({
      method: 'post',
      path: `/v1/sellers/me/${surface}/{slug}/tags`,
      operationId: `postV1SellersMe${operationNoun}Tags`,
      summary: `Choose the tags on one of the caller’s own draft ${surface}`,
      description: `Requires the internal BFF credential and the caller’s session. Replaces the whole selection, by slug; an empty array removes every tag. An unknown or hidden tag makes the **whole** selection invalid rather than being quietly dropped, so a seller is never told their tags were saved when one of them was not. Draft only, and the caller’s own. \`tags.usage_count\` is maintained by 0011’s own trigger on both sides of the change.`,
      request: {
        ...sessionHeader,
        ...slugParam,
        body: {
          content: { 'application/json': { schema: SaveSellerListingTagsRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: 'The selection was replaced.',
          content: { 'application/json': { schema: SellerListingAttributesWriteResponseSchema } },
        },
        400: validationFailed,
        401: authenticationRequired,
        403: credentialRejected,
        404: missing,
        409: refused,
        503: unavailable,
        500: internalError,
      },
    });
  };

  registerSellerVocabularySurface(
    'listings',
    'listing',
    'The caller has no storefront, or no listing of theirs lives at that address. One answer for both, so asking cannot reveal that a listing exists.',
    'Listing',
  );
  registerSellerVocabularySurface(
    'services',
    'service',
    'The caller has no storefront, or no service of theirs lives at that address. One answer for both — and for a listing of theirs that is a product, since this surface addresses services — so asking cannot reveal that a listing exists.',
    'Service',
  );

  // -------------------------------------------------------------------------------------------------
  // Public SEO delivery: what robots.txt and the sitemaps are built from
  // -------------------------------------------------------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/v1/seo/robots',
    operationId: 'getV1SeoRobots',
    summary: 'The authored robots.txt body',
    description:
      'Requires the internal BFF credential and carries no user context: a crawler-facing document is the same for everyone. `body` is null when nobody has authored one, which is a state and not a failure — `seo_settings` ships with no rows, so the public web then serves a minimal correct document rather than inventing directives. `locale` says which locale answered, which is the site’s default: robots.txt is one document at the root of an origin while the setting is stored per locale. The body is served verbatim and is never parsed here.',
    responses: {
      200: {
        description: 'The authored body, or nulls when nothing is authored.',
        content: { 'application/json': { schema: RobotsSettingsResponseSchema } },
      },
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/seo/sitemap',
    operationId: 'getV1SeoSitemap',
    summary: 'How many sitemap entries each kind of address has',
    description:
      'Requires the internal BFF credential and carries no user context. What a sitemap index needs: one row per kind of address with the number of entries it would produce, so the index can name exactly the child sitemaps that exist. A kind with nothing in it reports zero rather than being absent. Entries are counted under the same rules the enumerations apply: a listing or service is counted only while it is purchasable and its seller is publicly visible, so sold, expired and archived ones are excluded even though their pages stay public; a category needs every ancestor active; a page must be published, indexable and written in at least one locale. The fixed landing routes are not counted here — they exist in the web app’s own code rather than in a table.',
    responses: {
      200: {
        description: 'One count per kind, and the page size the enumerations use.',
        content: { 'application/json': { schema: SitemapCountsResponseSchema } },
      },
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/seo/sitemap/{type}/{page}',
    operationId: 'getV1SeoSitemapPage',
    summary: 'One page of sitemap entries',
    description:
      'Requires the internal BFF credential and carries no user context. Entries are ordered by slug, which is unique on every one of these surfaces, so a numbered page is stable: an entry cannot be served twice or skipped while the page size holds. Numbered rather than cursored because a sitemap index addresses its children by number. A page past the end is an empty array rather than a 404 — the set may have shrunk since the index was read. `locales` is present only for pages, where an address can be absent in one language: every other surface resolves in both locales whatever language its content is in. An unknown type or a page number below one is a 400.',
    request: {
      params: z.object({
        type: SitemapApiEntryTypeSchema.openapi({ description: 'Which kind of address to enumerate.' }),
        page: z.string().openapi({ description: 'The 1-based page number.' }),
      }),
    },
    responses: {
      200: {
        description: 'One page of entries, with the type and page number echoed back.',
        content: { 'application/json': { schema: SitemapPageResponseSchema } },
      },
      400: validationFailed,
      403: credentialRejected,
      503: unavailable,
      500: internalError,
    },
  });

  return registry;
}

/** Builds the OpenAPI 3.1 document from the Zod contracts. */
export function generateOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const generator = new OpenApiGeneratorV31(buildRegistry().definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'API', version: '0.0.0' },
  });
}

/** Deterministic serialisation used for the committed document. */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
}
