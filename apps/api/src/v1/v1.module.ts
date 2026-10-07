import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { TrackController } from './track.controller.js';
import { ListingAnalyticsController } from './listing-analytics.controller.js';
import type { ApiEnv } from '../config/env.js';
import { CategoriesService } from '../catalog/categories.service.js';
import { ListingsService } from '../catalog/listings.service.js';
import { SearchService } from '../catalog/search.service.js';
import { SellersService } from '../catalog/sellers.service.js';
import { SellerIdentityService } from '../sellers/seller-identity.service.js';
import { ServicesService } from '../catalog/services.service.js';
import { AuthLoginController } from './auth-login.controller.js';
import { AuthRecoveryController } from './auth-recovery.controller.js';
import { AuthRegisterController } from './auth-register.controller.js';
import { AuthSessionController } from './auth-session.controller.js';
import { AuthTotpController } from './auth-totp.controller.js';
import { CurrentUserController } from './current-user.controller.js';
import { MessagingController } from './messaging.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { BuyerAccountController } from './buyer-account.controller.js';
import { AdminSessionController } from './admin-session.controller.js';
import { VerificationReviewController } from './verification-review.controller.js';
import { OffersController } from './offers.controller.js';
import { ServiceRequestsController } from './service-requests.controller.js';
import { AdminServiceRequestsController } from './service-requests-admin.controller.js';
import { SupportController } from './support.controller.js';
import { SupportConsoleController } from './support-console.controller.js';
import { ReportsController } from './reports.controller.js';
import { ModerationController } from './moderation.controller.js';
import { AdminOperationsController } from './admin-operations.controller.js';
import { ReviewModerationController } from './review-moderation.controller.js';
import { PlatformOperationsController } from './platform-operations.controller.js';
import { CmsPagesAdminController } from './cms-pages-admin.controller.js';
import { CmsPagesController } from './cms-pages.controller.js';
import { BlogAdminController } from './blog-admin.controller.js';
import { BlogController } from './blog.controller.js';
import { HomepageAdminController } from './homepage-admin.controller.js';
import { HomepageController } from './homepage.controller.js';
import { NavigationAdminController } from './navigation-admin.controller.js';
import { NavigationController } from './navigation.controller.js';
import { FaqsAdminController } from './faqs-admin.controller.js';
import { FaqsController } from './faqs.controller.js';
import { SeoController } from './seo.controller.js';
import { SeoRedirectsAdminController } from './seo-redirects-admin.controller.js';
import { SeoMetadataAdminController } from './seo-metadata-admin.controller.js';
import { SeoSettingsAdminController } from './seo-settings-admin.controller.js';
import { CmsMediaAdminController } from './cms-media-admin.controller.js';
import { CategoriesAdminController } from './categories-admin.controller.js';
import { AttributesAdminController } from './attributes-admin.controller.js';
import { CategoryAttributesAdminController } from './category-attributes-admin.controller.js';
import { TagsAdminController } from './tags-admin.controller.js';
import { SellerVocabularyController } from './seller-vocabulary.controller.js';
import { DisputeManagementController } from './dispute-management.controller.js';
import { CategoriesController } from './categories.controller.js';
import { ContactChangeController } from './contact-change.controller.js';
import { ListingsController } from './listings.controller.js';
import { SearchController } from './search.controller.js';
import { SellerIdentityController } from './seller-identity.controller.js';
import { SellerListingsController } from './seller-listings.controller.js';
import { SellerServicesController } from './seller-services.controller.js';
import { SellerVerificationController } from './seller-verification.controller.js';
import { SellerReadController } from './seller-read.controller.js';
import { SellerMediaController } from './seller-media.controller.js';
import { SellersController } from './sellers.controller.js';
import { ServicesController } from './services.controller.js';
import { FoundationController } from './foundation.controller.js';
import { InternalCredentialGuard } from './internal-credential.guard.js';

/**
 * The `/v1` boundary.
 *
 * The credential guard is registered with `APP_GUARD` rather than on the controller, so it covers every
 * `/v1` route by construction — including routes added later by someone who forgets to decorate them.
 * It decides by path, so `/health` and `/ready`, which live outside `/v1`, pass straight through.
 *
 * `/v1/auth/login` is behind the same guard as everything else here. The login controller therefore
 * never checks the internal credential itself: one guard, one place to get it right.
 */
@Module({})
export class V1Module {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: V1Module,
      imports: [AuthModule.forRoot(env)],
      controllers: [
        FoundationController,
        AuthLoginController,
        AuthRecoveryController,
        AuthRegisterController,
        AuthSessionController,
        AuthTotpController,
        CurrentUserController,
        ContactChangeController,
        MessagingController,
        NotificationsController,
        BuyerAccountController,
        AdminSessionController,
        VerificationReviewController,
        OffersController,
        ServiceRequestsController,
        AdminServiceRequestsController,
        SupportController,
        SupportConsoleController,
        ReportsController,
        ModerationController,
        AdminOperationsController,
        ReviewModerationController,
        PlatformOperationsController,
        DisputeManagementController,
        CmsPagesAdminController,
        CmsPagesController,
        BlogAdminController,
        BlogController,
        HomepageAdminController,
        HomepageController,
        NavigationAdminController,
        NavigationController,
        FaqsAdminController,
        FaqsController,
        SeoController,
        SeoRedirectsAdminController,
        SeoMetadataAdminController,
        SeoSettingsAdminController,
        CmsMediaAdminController,
        CategoriesAdminController,
        // Phase 8-C. Three console surfaces and one seller surface; 0087's controller is untouched.
        AttributesAdminController,
        TagsAdminController,
        CategoryAttributesAdminController,
        SellerVocabularyController,
        CategoriesController,
        ListingsController,
        ServicesController,
        // `sellers/me` before `sellers/:slug`. Fastify's router prefers a static segment over a
        // parametric one whatever the order, and a test proves it; declaring it first says so anyway.
        SellerIdentityController,
        // Phase 6-E. Static `me/media` paths: they cannot collide with `me` or with the parametric `:slug`.
        SellerMediaController,
        SellerListingsController,
        SellerServicesController,
        SellerVerificationController,
        SellerReadController,
        SellersController,
        SearchController,
        TrackController,
        ListingAnalyticsController,
      ],
      providers: [
        { provide: APP_GUARD, useFactory: () => new InternalCredentialGuard(env.internalBffCredentials) },
        CategoriesService,
        ListingsService,
        ServicesService,
        SellersService,
        SellerIdentityService,
        SearchService,
      ],
    };
  }
}
