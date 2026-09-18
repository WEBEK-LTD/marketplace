// GENERATED FILE — do not edit.
// Produced by scripts/db/generate-types.mjs from the schema in supabase/migrations/.
// Regenerate with `pnpm run db:types`; CI fails when this file and the migrations disagree.

import type { ColumnType } from 'kysely';

/** A column the database fills in: optional on insert, not updatable by default. */
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;

/** A column PostgreSQL computes (GENERATED ALWAYS AS ... STORED): readable, never written. */
export type GeneratedAlways<T> = ColumnType<T, never, never>;

/** `timestamptz`/`timestamp`/`date`: read as Date, written as Date or ISO string. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

/** `json`/`jsonb`. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };


export interface AppPrivateAccountLockouts {
  "user_id": string;
  "locked_at": Generated<Timestamp>;
  "locked_until": Timestamp | null;
  "reason": string;
  "failed_attempts": Generated<number>;
  "released_at": Timestamp | null;
  "released_by": string | null;
}

export interface AppPrivateCurrencyDependencies {
  "dependency_key": string;
  "table_schema": string;
  "table_name": string;
  "column_name": string;
  "condition_sql": Generated<string>;
  "description": string;
  "registered_at": Generated<Timestamp>;
}

export interface AppPrivateLoginAttempts {
  "id": Generated<string>;
  "user_id": string | null;
  "identifier_hash": Buffer;
  "succeeded": boolean;
  "failure_reason": string | null;
  "request_ip": string | null;
  "user_agent_hash": Buffer | null;
  "created_at": Generated<Timestamp>;
}

export interface AppPrivateOtpChallenges {
  "id": Generated<string>;
  "user_id": string | null;
  "purpose": string;
  "channel": string;
  "destination_hash": Buffer;
  "code_hash": Buffer;
  "attempts": Generated<number>;
  "max_attempts": Generated<number>;
  "expires_at": Timestamp;
  "consumed_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "request_ip": string | null;
}

export interface AppPrivatePasswordResetTokens {
  "id": Generated<string>;
  "user_id": string;
  "token_hash": Buffer;
  "expires_at": Timestamp;
  "consumed_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "request_ip": string | null;
}

export interface AppPrivateRateLimits {
  "bucket": string;
  "subject_hash": Buffer;
  "window_start": Timestamp;
  "hits": Generated<number>;
  "updated_at": Generated<Timestamp>;
}

export interface AuditAuditLogs {
  "id": Generated<string>;
  "occurred_at": Generated<Timestamp>;
  "actor_id": string | null;
  "actor_type": Generated<string>;
  "action": string;
  "table_schema": string | null;
  "table_name": string | null;
  "record_id": string | null;
  "changed_columns": string[] | null;
  "old_values": Json | null;
  "new_values": Json | null;
  "request_id": string | null;
  "request_ip": string | null;
  "details": Generated<Json>;
}

export interface PublicAddresses {
  "id": Generated<string>;
  "user_id": string;
  "label": string | null;
  "purpose": Generated<string>;
  "recipient_name": string;
  "phone_e164": string;
  "country_code": string;
  "governorate": string;
  "city": string;
  "district": string | null;
  "street_address": string;
  "building": string | null;
  "apartment": string | null;
  "postal_code": string | null;
  "landmark": string | null;
  "location": string | null;
  "is_default_shipping": Generated<boolean>;
  "is_default_billing": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
  "deleted_at": Timestamp | null;
}

export interface PublicAttributeDefinitions {
  "id": Generated<string>;
  "key": string;
  "data_type": string;
  "unit": string | null;
  "name_en": string;
  "name_ar": string;
  "is_filterable": Generated<boolean>;
  "is_active": Generated<boolean>;
  "sort_order": Generated<number>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicAttributeOptions {
  "id": Generated<string>;
  "attribute_definition_id": string;
  "value": string;
  "label_en": string;
  "label_ar": string;
  "sort_order": Generated<number>;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCategories {
  "id": Generated<string>;
  "parent_id": string | null;
  "depth": Generated<number>;
  "slug": string;
  "listing_type_code": string | null;
  "icon": string | null;
  "image_object_path": string | null;
  "is_active": Generated<boolean>;
  "sort_order": Generated<number>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCategoryAttributes {
  "category_id": string;
  "attribute_definition_id": string;
  "is_required": Generated<boolean>;
  "is_filterable": Generated<boolean>;
  "sort_order": Generated<number>;
  "created_at": Generated<Timestamp>;
}

export interface PublicCategoryTranslations {
  "category_id": string;
  "locale_code": string;
  "name": string;
  "description": string | null;
  "meta_title": string | null;
  "meta_description": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCountries {
  "code": string;
  "iso3": string;
  "numeric_code": string;
  "name_en": string;
  "name_ar": string;
  "phone_code": string;
  "default_currency_code": string | null;
  "is_marketplace_enabled": Generated<boolean>;
  "is_phone_allowed": Generated<boolean>;
  "sort_order": Generated<number>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCurrencies {
  "code": string;
  "numeric_code": string;
  "symbol": string;
  "decimal_places": number;
  "is_enabled": Generated<boolean>;
  "is_default": Generated<boolean>;
  "is_pricing_enabled": Generated<boolean>;
  "is_checkout_enabled": Generated<boolean>;
  "first_enabled_at": Timestamp | null;
  "retired_at": Timestamp | null;
  "sort_order": Generated<number>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCurrencyTranslations {
  "currency_code": string;
  "locale_code": string;
  "name": string;
  "symbol_override": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicEmailOutbox {
  "id": Generated<string>;
  "recipient_user_id": string | null;
  "to_address": string;
  "template_key": string | null;
  "locale_code": string | null;
  "subject": string;
  "body_html": string;
  "body_text": string;
  "status": Generated<string>;
  "attempts": Generated<number>;
  "available_at": Generated<Timestamp>;
  "sent_at": Timestamp | null;
  "failed_at": Timestamp | null;
  "last_error_type": string | null;
  "provider_message_id": string | null;
  "dedupe_key": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicEmailTemplates {
  "key": string;
  "locale_code": string;
  "subject": string;
  "body_html": string;
  "body_text": string;
  "is_active": Generated<boolean>;
  "updated_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicIdempotencyKeys {
  "scope": string;
  "idempotency_key": string;
  "user_id": string | null;
  "request_hash": Buffer;
  "status": Generated<string>;
  "response_status": number | null;
  "response_body": Json | null;
  "resource_type": string | null;
  "resource_id": string | null;
  "created_at": Generated<Timestamp>;
  "completed_at": Timestamp | null;
  "expires_at": Timestamp;
}

export interface PublicJobRuns {
  "id": Generated<string>;
  "job_name": string;
  "scheduled_for": Timestamp | null;
  "started_at": Generated<Timestamp>;
  "finished_at": Timestamp | null;
  "status": Generated<string>;
  "error_type": string | null;
  "processed_count": number | null;
  "details": Generated<Json>;
}

export interface PublicKnownDevices {
  "id": Generated<string>;
  "user_id": string;
  "device_hash": Buffer;
  "label": string | null;
  "platform": string | null;
  "first_seen_at": Generated<Timestamp>;
  "last_seen_at": Generated<Timestamp>;
  "last_ip": string | null;
  "trusted_at": Timestamp | null;
  "revoked_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicListingAttributeValues {
  "listing_id": string;
  "attribute_definition_id": string;
  "value_text": string | null;
  "value_number": string | null;
  "value_boolean": boolean | null;
  "option_ids": Generated<string[]>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicListingMedia {
  "id": Generated<string>;
  "listing_id": string;
  "kind": Generated<string>;
  "original_object_path": string | null;
  "video_url": string | null;
  "status": Generated<string>;
  "position": Generated<number>;
  "is_primary": Generated<boolean>;
  "content_type": string | null;
  "byte_size": string | null;
  "width": number | null;
  "height": number | null;
  "checksum": Buffer | null;
  "validation_error_type": string | null;
  "metadata_stripped_at": Timestamp | null;
  "published_at": Timestamp | null;
  "withdrawn_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicListingProductDetails {
  "listing_id": string;
  "condition": string;
  "quantity": Generated<number>;
  "brand": string | null;
  "model": string | null;
  "sku": string | null;
  "weight_grams": number | null;
  "length_mm": number | null;
  "width_mm": number | null;
  "height_mm": number | null;
  "warranty_months": number | null;
  "shipping_profile_id": string | null;
  "is_pickup_available": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicListingSlugHistory {
  "id": Generated<string>;
  "listing_id": string;
  "slug": string;
  "replaced_at": Generated<Timestamp>;
}

export interface PublicListingStatusHistory {
  "id": Generated<string>;
  "listing_id": string;
  "from_status": string | null;
  "to_status": string;
  "changed_by": string | null;
  "reason": string | null;
  "changed_at": Generated<Timestamp>;
}

export interface PublicListingTags {
  "listing_id": string;
  "tag_id": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicListingTypes {
  "code": string;
  "name_en": string;
  "name_ar": string;
  "is_active": Generated<boolean>;
  "sort_order": Generated<number>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicListings {
  "id": Generated<string>;
  "seller_user_id": string;
  "listing_type_code": string;
  "category_id": string;
  "slug": string;
  "title": string;
  "description": string;
  "content_language": string;
  "currency_code": string;
  "price_minor": string | null;
  "is_negotiable": Generated<boolean>;
  "status": Generated<string>;
  "country_code": string;
  "governorate": string | null;
  "city": string | null;
  "location": string | null;
  "submitted_at": Timestamp | null;
  "approved_at": Timestamp | null;
  "published_at": Timestamp | null;
  "sold_at": Timestamp | null;
  "expires_at": Timestamp | null;
  "archived_at": Timestamp | null;
  "deleted_at": Timestamp | null;
  "view_count": Generated<string>;
  "search_vector_en": GeneratedAlways<string | null>;
  "search_vector_ar": GeneratedAlways<string | null>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicLocales {
  "code": string;
  "name_en": string;
  "name_native": string;
  "direction": string;
  "digit_style": Generated<string>;
  "is_active": Generated<boolean>;
  "is_default": Generated<boolean>;
  "sort_order": Generated<number>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicMediaVariants {
  "id": Generated<string>;
  "listing_media_id": string;
  "variant_key": string;
  "format": string;
  "object_path": string;
  "width": number;
  "height": number;
  "byte_size": string;
  "is_public": Generated<boolean>;
  "published_at": Timestamp | null;
  "removed_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicOutboxEvents {
  "id": Generated<string>;
  "aggregate_type": string;
  "aggregate_id": string;
  "event_type": string;
  "payload": Generated<Json>;
  "occurred_at": Generated<Timestamp>;
  "available_at": Generated<Timestamp>;
  "published_at": Timestamp | null;
  "completed_at": Timestamp | null;
  "dead_lettered_at": Timestamp | null;
  "attempts": Generated<number>;
  "last_error_type": string | null;
  "created_by": string | null;
}

export interface PublicPermissions {
  "key": string;
  "module": string;
  "description_en": string;
  "description_ar": string;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicProfiles {
  "id": string;
  "display_name": string | null;
  "full_name": string | null;
  "phone_e164": string | null;
  "locale_code": string | null;
  "timezone": Generated<string>;
  "avatar_object_path": string | null;
  "status": Generated<string>;
  "email_verified_at": Timestamp | null;
  "phone_verified_at": Timestamp | null;
  "last_seen_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
  "deleted_at": Timestamp | null;
}

export interface PublicRolePermissions {
  "role_key": string;
  "permission_key": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicRoles {
  "key": string;
  "name_en": string;
  "name_ar": string;
  "description_en": string | null;
  "description_ar": string | null;
  "requires_mfa": Generated<boolean>;
  "is_admin_console": Generated<boolean>;
  "is_assignable": Generated<boolean>;
  "sort_order": Generated<number>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicSecurityEvents {
  "id": Generated<string>;
  "user_id": string | null;
  "event_type": string;
  "occurred_at": Generated<Timestamp>;
  "device_id": string | null;
  "request_ip": string | null;
  "details": Generated<Json>;
}

export interface PublicSellerProfiles {
  "user_id": string;
  "slug": string;
  "display_name": string;
  "legal_name": string | null;
  "bio": string | null;
  "content_language": string | null;
  "logo_object_path": string | null;
  "banner_object_path": string | null;
  "country_code": string;
  "governorate": string | null;
  "city": string | null;
  "contact_email": string | null;
  "contact_phone_e164": string | null;
  "status": Generated<string>;
  "suspended_at": Timestamp | null;
  "suspension_reason": string | null;
  "closed_at": Timestamp | null;
  "verification_status": Generated<string>;
  "verified_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicSellerVerificationDocuments {
  "id": Generated<string>;
  "verification_id": string;
  "document_type": string;
  "object_path": string;
  "original_filename": string | null;
  "content_type": string | null;
  "byte_size": string | null;
  "status": Generated<string>;
  "review_note": string | null;
  "uploaded_at": Generated<Timestamp>;
  "reviewed_at": Timestamp | null;
  "reviewed_by": string | null;
}

export interface PublicSellerVerifications {
  "id": Generated<string>;
  "seller_user_id": string;
  "status": Generated<string>;
  "email_verified_at": Timestamp | null;
  "phone_verified_at": Timestamp | null;
  "submitted_at": Timestamp | null;
  "reviewed_at": Timestamp | null;
  "reviewed_by": string | null;
  "decision_reason": string | null;
  "expires_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicShippingProfiles {
  "id": Generated<string>;
  "seller_user_id": string;
  "name": string;
  "currency_code": string;
  "handling_time_days": Generated<number>;
  "is_default": Generated<boolean>;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicShippingRates {
  "id": Generated<string>;
  "shipping_zone_id": string;
  "currency_code": string;
  "method": string;
  "name": string;
  "base_amount_minor": string;
  "per_item_amount_minor": Generated<string>;
  "per_kg_amount_minor": Generated<string>;
  "free_over_amount_minor": string | null;
  "min_delivery_days": number | null;
  "max_delivery_days": number | null;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicShippingZones {
  "id": Generated<string>;
  "shipping_profile_id": string;
  "currency_code": string;
  "name": string;
  "country_code": string;
  "governorates": Generated<string[]>;
  "sort_order": Generated<number>;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicSiteSettings {
  "key": string;
  "category": string;
  "value": Json;
  "value_type": string;
  "is_public": Generated<boolean>;
  "description_en": string;
  "description_ar": string;
  "updated_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicStepUpGrants {
  "id": Generated<string>;
  "user_id": string;
  "operation": string;
  "granted_via": string;
  "challenge_id": string | null;
  "granted_at": Generated<Timestamp>;
  "expires_at": Timestamp;
  "consumed_at": Timestamp | null;
}

export interface PublicTags {
  "id": Generated<string>;
  "slug": string;
  "name_en": string;
  "name_ar": string;
  "is_active": Generated<boolean>;
  "usage_count": Generated<number>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicUserBlocks {
  "blocker_id": string;
  "blocked_id": string;
  "reason": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicUserRoles {
  "user_id": string;
  "role_key": string;
  "granted_by": string | null;
  "granted_at": Generated<Timestamp>;
  "expires_at": Timestamp | null;
  "revoked_at": Timestamp | null;
  "revoked_by": string | null;
  "reason": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicUserSettings {
  "user_id": string;
  "notify_email": Generated<boolean>;
  "notify_sms": Generated<boolean>;
  "notify_whatsapp": Generated<boolean>;
  "notify_in_app": Generated<boolean>;
  "marketing_opt_in": Generated<boolean>;
  "digit_style": string | null;
  "preferences": Generated<Json>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicWhatsappOutbox {
  "id": Generated<string>;
  "recipient_user_id": string | null;
  "to_phone_e164": string;
  "purpose": Generated<string>;
  "template_name": string;
  "template_locale": string;
  "variables": Generated<Json>;
  "status": Generated<string>;
  "attempts": Generated<number>;
  "available_at": Generated<Timestamp>;
  "sent_at": Timestamp | null;
  "failed_at": Timestamp | null;
  "last_error_type": string | null;
  "provider_message_id": string | null;
  "dedupe_key": string | null;
  "created_at": Generated<Timestamp>;
}

export interface Database {
  "app_private.account_lockouts": AppPrivateAccountLockouts;
  "app_private.currency_dependencies": AppPrivateCurrencyDependencies;
  "app_private.login_attempts": AppPrivateLoginAttempts;
  "app_private.otp_challenges": AppPrivateOtpChallenges;
  "app_private.password_reset_tokens": AppPrivatePasswordResetTokens;
  "app_private.rate_limits": AppPrivateRateLimits;
  "audit.audit_logs": AuditAuditLogs;
  "public.addresses": PublicAddresses;
  "public.attribute_definitions": PublicAttributeDefinitions;
  "public.attribute_options": PublicAttributeOptions;
  "public.categories": PublicCategories;
  "public.category_attributes": PublicCategoryAttributes;
  "public.category_translations": PublicCategoryTranslations;
  "public.countries": PublicCountries;
  "public.currencies": PublicCurrencies;
  "public.currency_translations": PublicCurrencyTranslations;
  "public.email_outbox": PublicEmailOutbox;
  "public.email_templates": PublicEmailTemplates;
  "public.idempotency_keys": PublicIdempotencyKeys;
  "public.job_runs": PublicJobRuns;
  "public.known_devices": PublicKnownDevices;
  "public.listing_attribute_values": PublicListingAttributeValues;
  "public.listing_media": PublicListingMedia;
  "public.listing_product_details": PublicListingProductDetails;
  "public.listing_slug_history": PublicListingSlugHistory;
  "public.listing_status_history": PublicListingStatusHistory;
  "public.listing_tags": PublicListingTags;
  "public.listing_types": PublicListingTypes;
  "public.listings": PublicListings;
  "public.locales": PublicLocales;
  "public.media_variants": PublicMediaVariants;
  "public.outbox_events": PublicOutboxEvents;
  "public.permissions": PublicPermissions;
  "public.profiles": PublicProfiles;
  "public.role_permissions": PublicRolePermissions;
  "public.roles": PublicRoles;
  "public.security_events": PublicSecurityEvents;
  "public.seller_profiles": PublicSellerProfiles;
  "public.seller_verification_documents": PublicSellerVerificationDocuments;
  "public.seller_verifications": PublicSellerVerifications;
  "public.shipping_profiles": PublicShippingProfiles;
  "public.shipping_rates": PublicShippingRates;
  "public.shipping_zones": PublicShippingZones;
  "public.site_settings": PublicSiteSettings;
  "public.step_up_grants": PublicStepUpGrants;
  "public.tags": PublicTags;
  "public.user_blocks": PublicUserBlocks;
  "public.user_roles": PublicUserRoles;
  "public.user_settings": PublicUserSettings;
  "public.whatsapp_outbox": PublicWhatsappOutbox;
}
