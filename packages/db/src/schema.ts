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

export interface AppPrivateAppendOnlyContract {
  "table_schema": string;
  "table_name": string;
  "updatable_columns": Generated<string[]>;
  "reason": string;
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
  "send_count": Generated<number>;
  "last_sent_at": Generated<Timestamp>;
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

export interface AppPrivateReferenceSequences {
  "prefix": string;
  "year": number;
  "next_value": string;
}

export interface AppPrivateScheduledJobContract {
  "job_key": string;
  "cron_schedule": string;
  "target_signature": string;
  "purpose": string;
}

export interface AppPrivateStorageBucketContract {
  "bucket_id": string;
  "must_be_public": boolean;
  "purpose": string;
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

export interface PublicAccountRecoveryApprovals {
  "id": Generated<string>;
  "account_recovery_request_id": string;
  "approver_user_id": string;
  "decision": string;
  "note": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicAccountRecoveryEvidence {
  "id": Generated<string>;
  "account_recovery_request_id": string;
  "evidence_type": string;
  "object_path": string;
  "original_filename": string | null;
  "content_type": string | null;
  "byte_size": string | null;
  "uploaded_at": Generated<Timestamp>;
}

export interface PublicAccountRecoveryRequests {
  "id": Generated<string>;
  "user_id": string | null;
  "claimed_contact_channel": string;
  "claimed_contact_hash": Buffer;
  "status": Generated<string>;
  "reviewer_user_id": string | null;
  "reviewed_at": Timestamp | null;
  "review_note": string | null;
  "approver_user_id": string | null;
  "approved_at": Timestamp | null;
  "rejection_reason": string | null;
  "new_contact_channel": string | null;
  "new_contact_hash": Buffer | null;
  "otp_challenge_id": string | null;
  "contact_verified_at": Timestamp | null;
  "sessions_revoked_at": Timestamp | null;
  "mfa_reset_at": Timestamp | null;
  "hold_until": Timestamp | null;
  "completed_at": Timestamp | null;
  "closed_at": Timestamp | null;
  "request_ip": string | null;
  "expires_at": Generated<Timestamp>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
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

export interface PublicBanners {
  "id": Generated<string>;
  "banner_key": string;
  "placement": string;
  "media_id": string | null;
  "media_ar_id": string | null;
  "headline_en": string | null;
  "headline_ar": string | null;
  "link_path": string | null;
  "starts_at": Timestamp | null;
  "ends_at": Timestamp | null;
  "sort_order": Generated<number>;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicBlogCategories {
  "id": Generated<string>;
  "slug": string;
  "name_en": string;
  "name_ar": string | null;
  "description_en": string | null;
  "description_ar": string | null;
  "sort_order": Generated<number>;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicBlogPostSlugHistory {
  "id": Generated<string>;
  "blog_post_id": string;
  "slug": string;
  "replaced_at": Generated<Timestamp>;
}

export interface PublicBlogPostTags {
  "blog_post_id": string;
  "blog_tag_id": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicBlogPostTranslations {
  "blog_post_id": string;
  "locale_code": string;
  "title": string;
  "excerpt": string | null;
  "body": string;
  "meta_title": string | null;
  "meta_description": string | null;
  "search_vector": GeneratedAlways<string | null>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicBlogPosts {
  "id": Generated<string>;
  "slug": string;
  "blog_category_id": string | null;
  "author_user_id": string | null;
  "status": Generated<string>;
  "is_indexable": Generated<boolean>;
  "is_featured": Generated<boolean>;
  "cover_media_id": string | null;
  "scheduled_for": Timestamp | null;
  "published_at": Timestamp | null;
  "archived_at": Timestamp | null;
  "created_by": string | null;
  "updated_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicBlogTags {
  "id": Generated<string>;
  "slug": string;
  "name_en": string;
  "name_ar": string | null;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCancellationPolicies {
  "id": Generated<string>;
  "name": string;
  "listing_type_code": string | null;
  "category_id": string | null;
  "buyer_window_hours": number;
  "refund_percentage_basis_points": number;
  "allows_seller_cancellation": Generated<boolean>;
  "is_default": Generated<boolean>;
  "priority": Generated<number>;
  "effective_from": Generated<Timestamp>;
  "effective_to": Timestamp | null;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCartItems {
  "id": Generated<string>;
  "cart_id": string;
  "currency_code": string;
  "listing_id": string;
  "seller_user_id": string;
  "quantity": Generated<number>;
  "unit_price_minor": string;
  "added_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCarts {
  "id": Generated<string>;
  "currency_code": string;
  "user_id": string | null;
  "guest_token_hash": Buffer | null;
  "status": Generated<string>;
  "expires_at": Timestamp | null;
  "merged_into_cart_id": string | null;
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

export interface PublicCheckoutCharges {
  "id": Generated<string>;
  "checkout_id": string;
  "currency_code": string;
  "charge_type": string;
  "seller_user_id": string | null;
  "label": string;
  "amount_minor": string;
  "shipping_rate_id": string | null;
  "source_type": string | null;
  "source_id": string | null;
  "funding_source": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicCheckoutItems {
  "id": Generated<string>;
  "checkout_id": string;
  "currency_code": string;
  "listing_id": string;
  "seller_user_id": string;
  "listing_type_code": string;
  "listing_title_snapshot": string;
  "listing_slug_snapshot": string;
  "quantity": number;
  "unit_price_minor": string;
  "line_subtotal_minor": string;
  "discount_minor": Generated<string>;
  "tax_minor": Generated<string>;
  "line_total_minor": string;
  "cancellation_policy_snapshot": Json | null;
  "created_at": Generated<Timestamp>;
  "commission_minor": Generated<string>;
  "commission_base_minor": Generated<string>;
  "commission_snapshot": Json | null;
}

export interface PublicCheckoutTaxLines {
  "id": Generated<string>;
  "checkout_id": string;
  "currency_code": string;
  "checkout_item_id": string | null;
  "tax_rule_id": string | null;
  "name": string;
  "rate_basis_points": number;
  "taxable_amount_minor": string;
  "tax_amount_minor": string;
  "is_price_inclusive": Generated<boolean>;
  "created_at": Generated<Timestamp>;
}

export interface PublicCheckouts {
  "id": Generated<string>;
  "reference": string | null;
  "currency_code": string;
  "buyer_user_id": string;
  "cart_id": string | null;
  "status": Generated<string>;
  "subtotal_minor": Generated<string>;
  "shipping_total_minor": Generated<string>;
  "tax_total_minor": Generated<string>;
  "discount_total_minor": Generated<string>;
  "buyer_fee_total_minor": Generated<string>;
  "grand_total_minor": Generated<string>;
  "shipping_address_snapshot": Json | null;
  "billing_address_snapshot": Json | null;
  "commission_snapshot": Json | null;
  "fee_policy_snapshot": Json | null;
  "cancellation_policy_snapshot": Json | null;
  "commission_refund_policy_snapshot": Json | null;
  "fulfilled_attempt_id": string | null;
  "reserved_until": Timestamp | null;
  "expires_at": Timestamp | null;
  "fulfilled_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCmsMedia {
  "id": Generated<string>;
  "object_path": string;
  "mime_type": string;
  "width": number | null;
  "height": number | null;
  "byte_size": string;
  "alt_text_en": string | null;
  "alt_text_ar": string | null;
  "uploaded_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCommissionRuleAmounts {
  "commission_rule_id": string;
  "currency_code": string;
  "amount_minor": string;
  "min_amount_minor": string | null;
  "max_amount_minor": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCommissionRules {
  "id": Generated<string>;
  "name": string;
  "scope": string;
  "category_id": string | null;
  "seller_user_id": string | null;
  "listing_type_code": string | null;
  "component_type": string;
  "percentage_basis_points": number | null;
  "priority": Generated<number>;
  "effective_from": Generated<Timestamp>;
  "effective_to": Timestamp | null;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCommissions {
  "id": Generated<string>;
  "currency_code": string;
  "order_id": string;
  "order_item_id": string | null;
  "seller_user_id": string;
  "base_minor": string;
  "amount_minor": string;
  "rule_snapshot": Generated<Json>;
  "is_skipped": Generated<boolean>;
  "skip_reason": string | null;
  "reverses_commission_id": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicConversationParticipants {
  "conversation_id": string;
  "user_id": string;
  "role": Generated<string>;
  "joined_at": Generated<Timestamp>;
  "left_at": Timestamp | null;
  "last_read_seq": string | null;
  "is_muted": Generated<boolean>;
}

export interface PublicConversations {
  "id": Generated<string>;
  "subject_type": Generated<string>;
  "listing_id": string | null;
  "listing_title_snapshot": string | null;
  "membership_version": Generated<number>;
  "created_by": string;
  "last_message_at": Timestamp | null;
  "message_count": Generated<number>;
  "closed_at": Timestamp | null;
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

export interface PublicCouponAmounts {
  "coupon_id": string;
  "currency_code": string;
  "amount_minor": string | null;
  "min_order_amount_minor": string | null;
  "max_discount_amount_minor": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicCouponUsage {
  "id": Generated<string>;
  "coupon_id": string;
  "currency_code": string;
  "user_id": string;
  "checkout_id": string;
  "order_id": string | null;
  "discount_minor": string;
  "funding_source": string;
  "funded_by_seller_user_id": string | null;
  "reverses_usage_id": string | null;
  "release_reason": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicCoupons {
  "id": Generated<string>;
  "code": string;
  "name": string;
  "discount_type": string;
  "percentage_basis_points": number | null;
  "funding_source": string;
  "funded_by_seller_user_id": string | null;
  "scope": Generated<string>;
  "category_id": string | null;
  "listing_id": string | null;
  "listing_type_code": string | null;
  "starts_at": Generated<Timestamp>;
  "ends_at": Timestamp | null;
  "max_redemptions": number | null;
  "max_redemptions_per_user": number | null;
  "redemption_count": Generated<number>;
  "is_active": Generated<boolean>;
  "created_by": string | null;
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

export interface PublicDisputeEvidence {
  "id": Generated<string>;
  "dispute_id": string;
  "uploaded_by": string;
  "object_path": string;
  "original_filename": string | null;
  "content_type": string | null;
  "byte_size": string | null;
  "description": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicDisputeMessages {
  "id": Generated<string>;
  "dispute_id": string;
  "author_user_id": string;
  "author_role": string;
  "body": string;
  "is_internal": Generated<boolean>;
  "created_at": Generated<Timestamp>;
}

export interface PublicDisputes {
  "id": Generated<string>;
  "order_id": string;
  "currency_code": string;
  "buyer_user_id": string;
  "seller_user_id": string;
  "opened_by": string;
  "reason_code": string;
  "details": string | null;
  "claim_amount_minor": string | null;
  "status": Generated<string>;
  "order_status_before": string;
  "resolution": string | null;
  "resolution_amount_minor": string | null;
  "resolution_note": string | null;
  "assigned_to": string | null;
  "due_at": Timestamp | null;
  "resolved_at": Timestamp | null;
  "resolved_by": string | null;
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

export interface PublicFaqs {
  "id": Generated<string>;
  "topic": Generated<string>;
  "question_en": string;
  "question_ar": string | null;
  "answer_en": string;
  "answer_ar": string | null;
  "sort_order": Generated<number>;
  "is_published": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicFavorites {
  "user_id": string;
  "listing_id": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicHomepageSections {
  "id": Generated<string>;
  "section_key": string;
  "section_type": string;
  "title_en": string | null;
  "title_ar": string | null;
  "subtitle_en": string | null;
  "subtitle_ar": string | null;
  "config": Generated<Json>;
  "sort_order": Generated<number>;
  "is_active": Generated<boolean>;
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

export interface PublicInventoryReservations {
  "id": Generated<string>;
  "checkout_id": string;
  "listing_id": string;
  "quantity": number;
  "expires_at": Timestamp;
  "released_at": Timestamp | null;
  "consumed_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
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

export interface PublicLedgerAccounts {
  "id": Generated<string>;
  "account_type": string;
  "currency_code": string;
  "seller_user_id": string | null;
  "normal_balance": GeneratedAlways<string | null>;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicLedgerEntries {
  "id": Generated<string>;
  "journal_id": string;
  "currency_code": string;
  "ledger_account_id": string;
  "account_type": string;
  "seller_user_id": string | null;
  "direction": string;
  "amount_minor": string;
  "order_id": string | null;
  "payment_id": string | null;
  "withdrawal_id": string | null;
  "memo": string | null;
  "occurred_at": Generated<Timestamp>;
  "created_at": Generated<Timestamp>;
}

export interface PublicLedgerJournals {
  "id": Generated<string>;
  "currency_code": string;
  "journal_type": string;
  "description": string | null;
  "source_type": string | null;
  "source_id": string | null;
  "idempotency_key": string | null;
  "reverses_journal_id": string | null;
  "posted_by": string | null;
  "posted_at": Generated<Timestamp>;
  "created_at": Generated<Timestamp>;
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

export interface PublicListingEvents {
  "id": Generated<string>;
  "event_id": string;
  "listing_id": string;
  "seller_user_id": string | null;
  "event_type": string;
  "occurred_at": Generated<Timestamp>;
  "user_id": string | null;
  "session_hash": Buffer | null;
  "source": string | null;
  "referrer_host": string | null;
  "promotion_id": string | null;
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

export interface PublicListingModerationActions {
  "id": Generated<string>;
  "listing_id": string;
  "moderation_action_id": string | null;
  "report_id": string | null;
  "action": string;
  "from_status": string;
  "to_status": string;
  "reason": string;
  "moderator_user_id": string;
  "created_at": Generated<Timestamp>;
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

export interface PublicListingServiceDetails {
  "listing_id": string;
  "pricing_model": Generated<string>;
  "delivery_days": number | null;
  "revisions_included": Generated<number>;
  "requires_brief": Generated<boolean>;
  "scope": string | null;
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

export interface PublicMessageAttachments {
  "id": Generated<string>;
  "message_id": string;
  "object_path": string;
  "content_type": string;
  "byte_size": string;
  "width": number | null;
  "height": number | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicMessages {
  "id": Generated<string>;
  "seq": Generated<string>;
  "conversation_id": string;
  "sender_user_id": string | null;
  "message_type": Generated<string>;
  "body": string | null;
  "reference_type": string | null;
  "reference_id": string | null;
  "created_at": Generated<Timestamp>;
  "edited_at": Timestamp | null;
  "deleted_at": Timestamp | null;
}

export interface PublicModerationActions {
  "id": Generated<string>;
  "report_id": string | null;
  "subject_type": string;
  "subject_id": string;
  "action": string;
  "reason": string;
  "notes": string | null;
  "moderator_user_id": string;
  "expires_at": Timestamp | null;
  "reverses_action_id": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicNavigationItems {
  "id": Generated<string>;
  "menu_id": string;
  "parent_id": string | null;
  "label_en": string;
  "label_ar": string | null;
  "target_kind": string;
  "page_id": string | null;
  "blog_post_id": string | null;
  "category_id": string | null;
  "path": string | null;
  "opens_in_new_tab": Generated<boolean>;
  "sort_order": Generated<number>;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicNavigationMenus {
  "id": Generated<string>;
  "menu_key": string;
  "label_en": string;
  "label_ar": string | null;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicNotifications {
  "id": Generated<string>;
  "user_id": string;
  "category": string;
  "event_type": string;
  "origin": Generated<string>;
  "actor_user_id": string | null;
  "template_key": string;
  "variables": Generated<Json>;
  "subject_type": string | null;
  "subject_id": string | null;
  "action_path": string | null;
  "is_marketing": Generated<boolean>;
  "dedupe_key": string | null;
  "email_outbox_id": string | null;
  "published_at": Timestamp | null;
  "read_at": Timestamp | null;
  "archived_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicOfferMessages {
  "id": Generated<string>;
  "offer_id": string;
  "sender_user_id": string;
  "body": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicOffers {
  "id": Generated<string>;
  "listing_id": string;
  "currency_code": string;
  "buyer_user_id": string;
  "seller_user_id": string;
  "parent_offer_id": string | null;
  "amount_minor": string;
  "quantity": Generated<number>;
  "message": string | null;
  "status": Generated<string>;
  "expires_at": Timestamp | null;
  "responded_at": Timestamp | null;
  "accepted_at": Timestamp | null;
  "accepted_terms": Json | null;
  "payment_due_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicOrderCancellations {
  "id": Generated<string>;
  "order_id": string;
  "currency_code": string;
  "order_item_id": string | null;
  "requested_by": string | null;
  "requester_role": string;
  "reason": string;
  "status": Generated<string>;
  "quantity": number | null;
  "refund_percentage_basis_points": number;
  "refund_amount_minor": Generated<string>;
  "policy_snapshot": Json;
  "decided_at": Timestamp | null;
  "decided_by": string | null;
  "decision_note": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicOrderItems {
  "id": Generated<string>;
  "order_id": string;
  "currency_code": string;
  "listing_id": string;
  "listing_type_code": string;
  "listing_title_snapshot": string;
  "listing_slug_snapshot": string;
  "quantity": number;
  "cancelled_quantity": Generated<number>;
  "unit_price_minor": string;
  "line_subtotal_minor": string;
  "discount_minor": Generated<string>;
  "tax_minor": Generated<string>;
  "line_total_minor": string;
  "commission_minor": Generated<string>;
  "created_at": Generated<Timestamp>;
}

export interface PublicOrderShipments {
  "id": Generated<string>;
  "order_id": string;
  "carrier": string | null;
  "tracking_number": string | null;
  "tracking_url": string | null;
  "status": Generated<string>;
  "shipped_at": Timestamp | null;
  "delivered_at": Timestamp | null;
  "notes": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicOrderStatusHistory {
  "id": Generated<string>;
  "order_id": string;
  "from_status": string | null;
  "to_status": string;
  "changed_by": string | null;
  "reason": string | null;
  "changed_at": Generated<Timestamp>;
}

export interface PublicOrders {
  "id": Generated<string>;
  "order_number": string | null;
  "currency_code": string;
  "checkout_id": string;
  "seller_user_id": string;
  "buyer_user_id": string;
  "order_type": string;
  "status": Generated<string>;
  "subtotal_minor": Generated<string>;
  "shipping_total_minor": Generated<string>;
  "tax_total_minor": Generated<string>;
  "discount_total_minor": Generated<string>;
  "commission_total_minor": Generated<string>;
  "grand_total_minor": Generated<string>;
  "seller_net_minor": Generated<string>;
  "cancellation_policy_snapshot": Json | null;
  "commission_snapshot": Json | null;
  "placed_at": Generated<Timestamp>;
  "paid_at": Timestamp | null;
  "shipped_at": Timestamp | null;
  "delivered_at": Timestamp | null;
  "completed_at": Timestamp | null;
  "cancelled_at": Timestamp | null;
  "auto_complete_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
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

export interface PublicPageSlugHistory {
  "id": Generated<string>;
  "page_id": string;
  "slug": string;
  "replaced_at": Generated<Timestamp>;
}

export interface PublicPageTranslations {
  "page_id": string;
  "locale_code": string;
  "title": string;
  "excerpt": string | null;
  "body": string;
  "meta_title": string | null;
  "meta_description": string | null;
  "search_vector": GeneratedAlways<string | null>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPages {
  "id": Generated<string>;
  "slug": string;
  "page_key": string | null;
  "status": Generated<string>;
  "is_indexable": Generated<boolean>;
  "template": Generated<string>;
  "sort_order": Generated<number>;
  "cover_media_id": string | null;
  "scheduled_for": Timestamp | null;
  "published_at": Timestamp | null;
  "archived_at": Timestamp | null;
  "created_by": string | null;
  "updated_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPaymentAttempts {
  "id": Generated<string>;
  "currency_code": string;
  "payment_id": string;
  "payment_provider_id": string;
  "attempt_number": number;
  "amount_minor": string;
  "status": Generated<string>;
  "next_action": Generated<string>;
  "provider_payment_ref": string | null;
  "idempotency_key": string;
  "method_code": string | null;
  "expires_at": Timestamp | null;
  "succeeded_at": Timestamp | null;
  "failed_at": Timestamp | null;
  "failure_code": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPaymentDisputes {
  "id": Generated<string>;
  "currency_code": string;
  "payment_id": string;
  "payment_provider_id": string | null;
  "provider_reference": string | null;
  "kind": Generated<string>;
  "status": Generated<string>;
  "amount_minor": string;
  "funds_frozen": Generated<boolean>;
  "reason_code": string | null;
  "opened_at": Generated<Timestamp>;
  "evidence_due_at": Timestamp | null;
  "evidence_submitted_at": Timestamp | null;
  "resolved_at": Timestamp | null;
  "outcome": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPaymentEvents {
  "id": Generated<string>;
  "payment_provider_id": string;
  "event_key": string;
  "event_type": string;
  "payload_digest": Buffer;
  "payment_id": string | null;
  "payment_attempt_id": string | null;
  "received_at": Generated<Timestamp>;
  "processed_at": Timestamp | null;
  "processing_error_type": string | null;
}

export interface PublicPaymentExceptionActions {
  "id": Generated<string>;
  "payment_exception_case_id": string;
  "action_type": string;
  "performed_by": string | null;
  "performed_at": Generated<Timestamp>;
  "details": Generated<Json>;
  "outcome": string | null;
}

export interface PublicPaymentExceptionCases {
  "id": Generated<string>;
  "case_type": string;
  "status": Generated<string>;
  "payment_provider_id": string | null;
  "payment_id": string | null;
  "payment_attempt_id": string | null;
  "payment_event_id": string | null;
  "checkout_id": string | null;
  "provider_reference": string | null;
  "currency_code": string | null;
  "observed_amount_minor": string | null;
  "expected_amount_minor": string | null;
  "observed_currency_code": string | null;
  "policy_id": string | null;
  "resolution": string | null;
  "opened_at": Generated<Timestamp>;
  "resolved_at": Timestamp | null;
  "resolved_by": string | null;
  "notes": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPaymentExceptionPolicies {
  "id": Generated<string>;
  "case_type": string;
  "resolution": string;
  "requires_manual_approval": Generated<boolean>;
  "priority": Generated<number>;
  "notes": string | null;
  "effective_from": Generated<Timestamp>;
  "effective_to": Timestamp | null;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPaymentFeeAllocations {
  "id": Generated<string>;
  "currency_code": string;
  "payment_id": string;
  "payment_attempt_id": string | null;
  "order_id": string | null;
  "seller_user_id": string | null;
  "fee_type": string;
  "allocated_to": Generated<string>;
  "amount_minor": string;
  "allocation_group_id": string | null;
  "policy_snapshot": Json | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicPaymentProviderCapabilities {
  "payment_provider_id": string;
  "currency_code": string;
  "supports_charge": Generated<boolean>;
  "supports_refund": Generated<boolean>;
  "supports_partial_refund": Generated<boolean>;
  "supports_cancel": Generated<boolean>;
  "supports_status_lookup": Generated<boolean>;
  "supports_provider_idempotency": Generated<boolean>;
  "supports_webhooks": Generated<boolean>;
  "amount_format": Generated<string>;
  "amount_decimal_places": number | null;
  "min_amount_minor": string | null;
  "max_amount_minor": string | null;
  "evidence_url": string;
  "recorded_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPaymentProviderTransactions {
  "id": Generated<string>;
  "currency_code": string;
  "payment_provider_id": string;
  "payment_attempt_id": string | null;
  "payment_id": string | null;
  "kind": string;
  "provider_reference": string;
  "amount_minor": string;
  "normalized_status": string;
  "provider_status": string | null;
  "occurred_at": Generated<Timestamp>;
  "recorded_at": Generated<Timestamp>;
}

export interface PublicPaymentProviders {
  "id": Generated<string>;
  "key": string;
  "display_name": string;
  "is_enabled": Generated<boolean>;
  "is_default": Generated<boolean>;
  "priority": Generated<number>;
  "documentation_url": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPayments {
  "id": Generated<string>;
  "currency_code": string;
  "checkout_id": string;
  "buyer_user_id": string;
  "payment_provider_id": string | null;
  "amount_minor": string;
  "refunded_amount_minor": Generated<string>;
  "status": Generated<string>;
  "paid_at": Timestamp | null;
  "cancelled_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPayoutDestinations {
  "id": Generated<string>;
  "seller_user_id": string;
  "payout_provider_id": string;
  "currency_code": string;
  "country_code": string | null;
  "destination_kind": string;
  "label": string | null;
  "masked_value": string;
  "vault_secret_id": string | null;
  "provider_token": string | null;
  "verification_status": Generated<string>;
  "verified_at": Timestamp | null;
  "rejection_reason": string | null;
  "is_default": Generated<boolean>;
  "status": Generated<string>;
  "last_changed_at": Generated<Timestamp>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPayoutEvents {
  "id": Generated<string>;
  "payout_provider_id": string;
  "event_key": string;
  "event_type": string;
  "payload_digest": Buffer;
  "payout_id": string | null;
  "received_at": Generated<Timestamp>;
  "processed_at": Timestamp | null;
  "processing_error_type": string | null;
}

export interface PublicPayoutProviderCapabilities {
  "payout_provider_id": string;
  "currency_code": string;
  "supports_payout": Generated<boolean>;
  "supports_destination_validation": Generated<boolean>;
  "supports_destination_registration": Generated<boolean>;
  "supports_cancel": Generated<boolean>;
  "supports_reverse": Generated<boolean>;
  "supports_status_lookup": Generated<boolean>;
  "supports_provider_idempotency": Generated<boolean>;
  "supports_webhooks": Generated<boolean>;
  "destination_kinds": Generated<string[]>;
  "amount_format": Generated<string>;
  "amount_decimal_places": number | null;
  "min_amount_minor": string | null;
  "max_amount_minor": string | null;
  "evidence_url": string;
  "recorded_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPayoutProviders {
  "id": Generated<string>;
  "key": string;
  "display_name": string;
  "is_enabled": Generated<boolean>;
  "is_default": Generated<boolean>;
  "priority": Generated<number>;
  "documentation_url": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPayoutReversals {
  "id": Generated<string>;
  "currency_code": string;
  "payout_id": string;
  "amount_minor": string;
  "reason": string;
  "status": Generated<string>;
  "idempotency_key": string;
  "provider_reference": string | null;
  "ledger_journal_id": string | null;
  "created_by": string | null;
  "created_at": Generated<Timestamp>;
  "succeeded_at": Timestamp | null;
  "failed_at": Timestamp | null;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPayoutTransactions {
  "id": Generated<string>;
  "currency_code": string;
  "payout_provider_id": string;
  "payout_id": string | null;
  "kind": string;
  "provider_reference": string;
  "amount_minor": string;
  "normalized_status": string;
  "provider_status": string | null;
  "occurred_at": Generated<Timestamp>;
  "recorded_at": Generated<Timestamp>;
}

export interface PublicPayouts {
  "id": Generated<string>;
  "currency_code": string;
  "seller_user_id": string;
  "withdrawal_id": string;
  "payout_provider_id": string;
  "payout_destination_id": string;
  "amount_minor": string;
  "status": Generated<string>;
  "idempotency_key": string;
  "provider_payout_ref": string | null;
  "destination_masked_snapshot": string;
  "failure_code": string | null;
  "ledger_journal_id": string | null;
  "created_at": Generated<Timestamp>;
  "processing_at": Timestamp | null;
  "paid_at": Timestamp | null;
  "failed_at": Timestamp | null;
  "cancelled_at": Timestamp | null;
  "reversed_at": Timestamp | null;
  "updated_at": Generated<Timestamp>;
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

export interface PublicPromotionAnalytics {
  "promotion_id": string;
  "day": Timestamp;
  "impressions": Generated<string>;
  "views": Generated<string>;
  "clicks": Generated<string>;
  "computed_at": Generated<Timestamp>;
}

export interface PublicPromotionEvents {
  "id": Generated<string>;
  "event_id": string;
  "promotion_id": string;
  "listing_id": string;
  "seller_user_id": string | null;
  "event_type": string;
  "placement": string | null;
  "occurred_at": Generated<Timestamp>;
  "user_id": string | null;
  "session_hash": Buffer | null;
}

export interface PublicPromotionPackageCategories {
  "promotion_package_id": string;
  "category_id": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicPromotionPackagePlacements {
  "promotion_package_id": string;
  "placement": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicPromotionPackagePrices {
  "promotion_package_id": string;
  "currency_code": string;
  "price_minor": string;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPromotionPackages {
  "id": Generated<string>;
  "key": string;
  "name_en": string;
  "name_ar": string;
  "description_en": string | null;
  "description_ar": string | null;
  "billing_model": Generated<string>;
  "duration_days": number;
  "priority": Generated<number>;
  "max_active_per_seller": number | null;
  "max_active_total": number | null;
  "sort_order": Generated<number>;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPromotionRankingSettings {
  "key": string;
  "weight_basis_points": number;
  "description_en": string;
  "description_ar": string;
  "is_active": Generated<boolean>;
  "updated_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPromotionRefundPolicies {
  "id": Generated<string>;
  "name": string;
  "applies_to": string;
  "refund_percentage_basis_points": number;
  "is_prorated": Generated<boolean>;
  "priority": Generated<number>;
  "effective_from": Generated<Timestamp>;
  "effective_to": Timestamp | null;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicPromotionStatusHistory {
  "id": Generated<string>;
  "promotion_id": string;
  "from_status": string | null;
  "to_status": string;
  "reason": string | null;
  "changed_by": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicPromotionTransactions {
  "id": Generated<string>;
  "promotion_id": string;
  "currency_code": string;
  "kind": string;
  "payment_method": string;
  "amount_minor": string;
  "ledger_journal_id": string | null;
  "payment_id": string | null;
  "idempotency_key": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicPromotions {
  "id": Generated<string>;
  "currency_code": string;
  "seller_user_id": string;
  "listing_id": string;
  "promotion_package_id": string;
  "status": Generated<string>;
  "payment_method": string | null;
  "price_minor": string;
  "priority": Generated<number>;
  "duration_days": number;
  "package_snapshot": Generated<Json>;
  "idempotency_key": string | null;
  "starts_at": Timestamp | null;
  "ends_at": Timestamp | null;
  "paid_at": Timestamp | null;
  "activated_at": Timestamp | null;
  "paused_at": Timestamp | null;
  "expired_at": Timestamp | null;
  "cancelled_at": Timestamp | null;
  "refunded_at": Timestamp | null;
  "refunded_amount_minor": Generated<string>;
  "cancellation_reason": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicProviderSettlementItems {
  "id": Generated<string>;
  "provider_settlement_id": string;
  "settlement_kind": string;
  "currency_code": string;
  "item_kind": string;
  "direction": string;
  "provider_reference": string;
  "amount_minor": string;
  "fee_minor": Generated<string>;
  "payment_id": string | null;
  "payment_attempt_id": string | null;
  "refund_id": string | null;
  "payment_dispute_id": string | null;
  "payout_id": string | null;
  "payout_reversal_id": string | null;
  "match_status": Generated<string>;
  "mismatch_reason": string | null;
  "matched_at": Timestamp | null;
  "occurred_at": Generated<Timestamp>;
  "recorded_at": Generated<Timestamp>;
}

export interface PublicProviderSettlements {
  "id": Generated<string>;
  "settlement_kind": string;
  "currency_code": string;
  "payment_provider_id": string | null;
  "payout_provider_id": string | null;
  "statement_reference": string;
  "period_start": Timestamp;
  "period_end": Timestamp;
  "reported_gross_minor": Generated<string>;
  "reported_fee_minor": Generated<string>;
  "reported_net_minor": Generated<string>;
  "computed_net_minor": Generated<string>;
  "variance_minor": Generated<string>;
  "unmatched_amount_minor": Generated<string>;
  "status": Generated<string>;
  "source_digest": Buffer | null;
  "ledger_journal_id": string | null;
  "posting_blocked_reason": string | null;
  "imported_at": Generated<Timestamp>;
  "matched_at": Timestamp | null;
  "reconciled_at": Timestamp | null;
  "reconciled_by": string | null;
  "closed_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicRedirects {
  "id": Generated<string>;
  "from_path": string;
  "to_path": string;
  "status_code": Generated<number>;
  "is_active": Generated<boolean>;
  "note": string | null;
  "created_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicRefundItems {
  "id": Generated<string>;
  "refund_id": string;
  "order_item_id": string;
  "quantity": number | null;
  "amount_minor": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicRefunds {
  "id": Generated<string>;
  "currency_code": string;
  "payment_id": string;
  "order_id": string | null;
  "amount_minor": string;
  "reason": string;
  "status": Generated<string>;
  "payment_provider_id": string | null;
  "provider_reference": string | null;
  "idempotency_key": string;
  "requested_by": string | null;
  "approved_by": string | null;
  "requested_at": Generated<Timestamp>;
  "processed_at": Timestamp | null;
  "failure_code": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicReports {
  "id": Generated<string>;
  "reporter_user_id": string;
  "subject_type": string;
  "subject_id": string;
  "reason_code": string;
  "details": string | null;
  "status": Generated<string>;
  "priority": Generated<string>;
  "assigned_to": string | null;
  "assigned_at": Timestamp | null;
  "duplicate_of_report_id": string | null;
  "resolution": string | null;
  "resolution_note": string | null;
  "resolved_at": Timestamp | null;
  "resolved_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicReviewReplies {
  "id": Generated<string>;
  "review_id": string;
  "seller_user_id": string;
  "body": string;
  "status": Generated<string>;
  "moderation_reason": string | null;
  "moderated_at": Timestamp | null;
  "moderated_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicReviews {
  "id": Generated<string>;
  "order_id": string;
  "seller_user_id": string;
  "buyer_user_id": string;
  "rating": number;
  "title": string | null;
  "body": string | null;
  "status": Generated<string>;
  "auto_hidden_reason": string | null;
  "moderation_reason": string | null;
  "moderated_at": Timestamp | null;
  "moderated_by": string | null;
  "published_at": Generated<Timestamp>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
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

export interface PublicSavedSearches {
  "id": Generated<string>;
  "user_id": string;
  "name": string;
  "query": Json;
  "notify": Generated<boolean>;
  "last_notified_at": Timestamp | null;
  "last_matched_at": Timestamp | null;
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

export interface PublicSellerBalances {
  "seller_user_id": string;
  "currency_code": string;
  "pending_minor": Generated<string>;
  "available_minor": Generated<string>;
  "reserved_minor": Generated<string>;
  "updated_at": Generated<Timestamp>;
  "created_at": Generated<Timestamp>;
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

export interface PublicSellerRatings {
  "seller_user_id": string | null;
  "review_count": string | null;
  "average_rating_basis_points": number | null;
  "five_star_count": string | null;
  "four_star_count": string | null;
  "three_star_count": string | null;
  "two_star_count": string | null;
  "one_star_count": string | null;
  "latest_review_at": Timestamp | null;
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

export interface PublicSeoMetadata {
  "id": Generated<string>;
  "entity_type": string;
  "entity_id": string | null;
  "route_path": string | null;
  "locale_code": string;
  "meta_title": string | null;
  "meta_description": string | null;
  "canonical_path": string | null;
  "robots_directives": Generated<string[]>;
  "og_title": string | null;
  "og_description": string | null;
  "share_media_id": string | null;
  "structured_data": Generated<Json>;
  "updated_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicSeoSettings {
  "locale_code": string;
  "site_name": string;
  "default_meta_title": string | null;
  "default_meta_description": string | null;
  "default_share_media_id": string | null;
  "twitter_site": string | null;
  "robots_txt_body": string | null;
  "organization_structured_data": Generated<Json>;
  "updated_by": string | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicServiceDeliveries {
  "id": Generated<string>;
  "order_id": string;
  "revision_round": Generated<number>;
  "delivered_by": string;
  "delivery_note": string;
  "attachment_paths": Generated<string[]>;
  "delivered_at": Generated<Timestamp>;
  "accepted_at": Timestamp | null;
  "revision_requested_at": Timestamp | null;
  "revision_note": string | null;
}

export interface PublicServiceQuotes {
  "id": Generated<string>;
  "service_request_id": string;
  "currency_code": string;
  "seller_user_id": string;
  "amount_minor": string;
  "delivery_days": number;
  "revisions_included": Generated<number>;
  "scope": string;
  "status": Generated<string>;
  "expires_at": Timestamp;
  "responded_at": Timestamp | null;
  "accepted_at": Timestamp | null;
  "accepted_terms": Json | null;
  "payment_due_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicServiceRequests {
  "id": Generated<string>;
  "currency_code": string;
  "listing_id": string | null;
  "buyer_user_id": string;
  "seller_user_id": string;
  "title": string;
  "brief": string;
  "budget_minor": string | null;
  "needed_by": Timestamp | null;
  "status": Generated<string>;
  "closed_at": Timestamp | null;
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

export interface PublicSupportAttachments {
  "id": Generated<string>;
  "support_message_id": string;
  "object_path": string;
  "original_filename": string | null;
  "content_type": string | null;
  "byte_size": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicSupportInternalNotes {
  "id": Generated<string>;
  "support_ticket_id": string;
  "author_user_id": string;
  "body": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicSupportMessages {
  "id": Generated<string>;
  "support_ticket_id": string;
  "author_user_id": string;
  "author_role": string;
  "body": string;
  "created_at": Generated<Timestamp>;
}

export interface PublicSupportTicketEvents {
  "id": Generated<string>;
  "support_ticket_id": string;
  "event_type": string;
  "from_value": string | null;
  "to_value": string | null;
  "actor_user_id": string | null;
  "created_at": Generated<Timestamp>;
}

export interface PublicSupportTickets {
  "id": Generated<string>;
  "reference": string | null;
  "requester_user_id": string;
  "subject": string;
  "category": string;
  "priority": Generated<string>;
  "status": Generated<string>;
  "assigned_to": string | null;
  "assigned_at": Timestamp | null;
  "order_id": string | null;
  "membership_version": Generated<number>;
  "message_count": Generated<number>;
  "last_message_at": Timestamp | null;
  "first_response_at": Timestamp | null;
  "resolved_at": Timestamp | null;
  "closed_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
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

export interface PublicTaxRules {
  "id": Generated<string>;
  "name": string;
  "country_code": string;
  "governorate": string | null;
  "category_id": string | null;
  "listing_type_code": string | null;
  "rate_basis_points": number;
  "is_price_inclusive": Generated<boolean>;
  "priority": Generated<number>;
  "effective_from": Generated<Timestamp>;
  "effective_to": Timestamp | null;
  "is_active": Generated<boolean>;
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

export interface PublicWalletTransactions {
  "entry_id": string | null;
  "journal_id": string | null;
  "seller_user_id": string | null;
  "currency_code": string | null;
  "account_type": string | null;
  "direction": string | null;
  "amount_minor": string | null;
  "signed_minor": string | null;
  "journal_type": string | null;
  "description": string | null;
  "memo": string | null;
  "order_id": string | null;
  "payment_id": string | null;
  "withdrawal_id": string | null;
  "occurred_at": Timestamp | null;
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

export interface PublicWithdrawalLimits {
  "currency_code": string;
  "min_amount_minor": string;
  "max_amount_minor": string | null;
  "max_open_requests": number | null;
  "daily_limit_minor": string | null;
  "is_active": Generated<boolean>;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface PublicWithdrawals {
  "id": Generated<string>;
  "currency_code": string;
  "seller_user_id": string;
  "amount_minor": string;
  "status": Generated<string>;
  "idempotency_key": string | null;
  "reserve_journal_id": string | null;
  "settlement_journal_id": string | null;
  "reviewed_by": string | null;
  "approved_by": string | null;
  "rejection_reason": string | null;
  "failure_code": string | null;
  "requested_at": Generated<Timestamp>;
  "reviewed_at": Timestamp | null;
  "approved_at": Timestamp | null;
  "processing_at": Timestamp | null;
  "paid_at": Timestamp | null;
  "rejected_at": Timestamp | null;
  "failed_at": Timestamp | null;
  "cancelled_at": Timestamp | null;
  "created_at": Generated<Timestamp>;
  "updated_at": Generated<Timestamp>;
}

export interface Database {
  "app_private.account_lockouts": AppPrivateAccountLockouts;
  "app_private.append_only_contract": AppPrivateAppendOnlyContract;
  "app_private.currency_dependencies": AppPrivateCurrencyDependencies;
  "app_private.login_attempts": AppPrivateLoginAttempts;
  "app_private.otp_challenges": AppPrivateOtpChallenges;
  "app_private.password_reset_tokens": AppPrivatePasswordResetTokens;
  "app_private.rate_limits": AppPrivateRateLimits;
  "app_private.reference_sequences": AppPrivateReferenceSequences;
  "app_private.scheduled_job_contract": AppPrivateScheduledJobContract;
  "app_private.storage_bucket_contract": AppPrivateStorageBucketContract;
  "audit.audit_logs": AuditAuditLogs;
  "public.account_recovery_approvals": PublicAccountRecoveryApprovals;
  "public.account_recovery_evidence": PublicAccountRecoveryEvidence;
  "public.account_recovery_requests": PublicAccountRecoveryRequests;
  "public.addresses": PublicAddresses;
  "public.attribute_definitions": PublicAttributeDefinitions;
  "public.attribute_options": PublicAttributeOptions;
  "public.banners": PublicBanners;
  "public.blog_categories": PublicBlogCategories;
  "public.blog_post_slug_history": PublicBlogPostSlugHistory;
  "public.blog_post_tags": PublicBlogPostTags;
  "public.blog_post_translations": PublicBlogPostTranslations;
  "public.blog_posts": PublicBlogPosts;
  "public.blog_tags": PublicBlogTags;
  "public.cancellation_policies": PublicCancellationPolicies;
  "public.cart_items": PublicCartItems;
  "public.carts": PublicCarts;
  "public.categories": PublicCategories;
  "public.category_attributes": PublicCategoryAttributes;
  "public.category_translations": PublicCategoryTranslations;
  "public.checkout_charges": PublicCheckoutCharges;
  "public.checkout_items": PublicCheckoutItems;
  "public.checkout_tax_lines": PublicCheckoutTaxLines;
  "public.checkouts": PublicCheckouts;
  "public.cms_media": PublicCmsMedia;
  "public.commission_rule_amounts": PublicCommissionRuleAmounts;
  "public.commission_rules": PublicCommissionRules;
  "public.commissions": PublicCommissions;
  "public.conversation_participants": PublicConversationParticipants;
  "public.conversations": PublicConversations;
  "public.countries": PublicCountries;
  "public.coupon_amounts": PublicCouponAmounts;
  "public.coupon_usage": PublicCouponUsage;
  "public.coupons": PublicCoupons;
  "public.currencies": PublicCurrencies;
  "public.currency_translations": PublicCurrencyTranslations;
  "public.dispute_evidence": PublicDisputeEvidence;
  "public.dispute_messages": PublicDisputeMessages;
  "public.disputes": PublicDisputes;
  "public.email_outbox": PublicEmailOutbox;
  "public.email_templates": PublicEmailTemplates;
  "public.faqs": PublicFaqs;
  "public.favorites": PublicFavorites;
  "public.homepage_sections": PublicHomepageSections;
  "public.idempotency_keys": PublicIdempotencyKeys;
  "public.inventory_reservations": PublicInventoryReservations;
  "public.job_runs": PublicJobRuns;
  "public.known_devices": PublicKnownDevices;
  "public.ledger_accounts": PublicLedgerAccounts;
  "public.ledger_entries": PublicLedgerEntries;
  "public.ledger_journals": PublicLedgerJournals;
  "public.listing_attribute_values": PublicListingAttributeValues;
  "public.listing_events": PublicListingEvents;
  "public.listing_media": PublicListingMedia;
  "public.listing_moderation_actions": PublicListingModerationActions;
  "public.listing_product_details": PublicListingProductDetails;
  "public.listing_service_details": PublicListingServiceDetails;
  "public.listing_slug_history": PublicListingSlugHistory;
  "public.listing_status_history": PublicListingStatusHistory;
  "public.listing_tags": PublicListingTags;
  "public.listing_types": PublicListingTypes;
  "public.listings": PublicListings;
  "public.locales": PublicLocales;
  "public.media_variants": PublicMediaVariants;
  "public.message_attachments": PublicMessageAttachments;
  "public.messages": PublicMessages;
  "public.moderation_actions": PublicModerationActions;
  "public.navigation_items": PublicNavigationItems;
  "public.navigation_menus": PublicNavigationMenus;
  "public.notifications": PublicNotifications;
  "public.offer_messages": PublicOfferMessages;
  "public.offers": PublicOffers;
  "public.order_cancellations": PublicOrderCancellations;
  "public.order_items": PublicOrderItems;
  "public.order_shipments": PublicOrderShipments;
  "public.order_status_history": PublicOrderStatusHistory;
  "public.orders": PublicOrders;
  "public.outbox_events": PublicOutboxEvents;
  "public.page_slug_history": PublicPageSlugHistory;
  "public.page_translations": PublicPageTranslations;
  "public.pages": PublicPages;
  "public.payment_attempts": PublicPaymentAttempts;
  "public.payment_disputes": PublicPaymentDisputes;
  "public.payment_events": PublicPaymentEvents;
  "public.payment_exception_actions": PublicPaymentExceptionActions;
  "public.payment_exception_cases": PublicPaymentExceptionCases;
  "public.payment_exception_policies": PublicPaymentExceptionPolicies;
  "public.payment_fee_allocations": PublicPaymentFeeAllocations;
  "public.payment_provider_capabilities": PublicPaymentProviderCapabilities;
  "public.payment_provider_transactions": PublicPaymentProviderTransactions;
  "public.payment_providers": PublicPaymentProviders;
  "public.payments": PublicPayments;
  "public.payout_destinations": PublicPayoutDestinations;
  "public.payout_events": PublicPayoutEvents;
  "public.payout_provider_capabilities": PublicPayoutProviderCapabilities;
  "public.payout_providers": PublicPayoutProviders;
  "public.payout_reversals": PublicPayoutReversals;
  "public.payout_transactions": PublicPayoutTransactions;
  "public.payouts": PublicPayouts;
  "public.permissions": PublicPermissions;
  "public.profiles": PublicProfiles;
  "public.promotion_analytics": PublicPromotionAnalytics;
  "public.promotion_events": PublicPromotionEvents;
  "public.promotion_package_categories": PublicPromotionPackageCategories;
  "public.promotion_package_placements": PublicPromotionPackagePlacements;
  "public.promotion_package_prices": PublicPromotionPackagePrices;
  "public.promotion_packages": PublicPromotionPackages;
  "public.promotion_ranking_settings": PublicPromotionRankingSettings;
  "public.promotion_refund_policies": PublicPromotionRefundPolicies;
  "public.promotion_status_history": PublicPromotionStatusHistory;
  "public.promotion_transactions": PublicPromotionTransactions;
  "public.promotions": PublicPromotions;
  "public.provider_settlement_items": PublicProviderSettlementItems;
  "public.provider_settlements": PublicProviderSettlements;
  "public.redirects": PublicRedirects;
  "public.refund_items": PublicRefundItems;
  "public.refunds": PublicRefunds;
  "public.reports": PublicReports;
  "public.review_replies": PublicReviewReplies;
  "public.reviews": PublicReviews;
  "public.role_permissions": PublicRolePermissions;
  "public.roles": PublicRoles;
  "public.saved_searches": PublicSavedSearches;
  "public.security_events": PublicSecurityEvents;
  "public.seller_balances": PublicSellerBalances;
  "public.seller_profiles": PublicSellerProfiles;
  "public.seller_ratings": PublicSellerRatings;
  "public.seller_verification_documents": PublicSellerVerificationDocuments;
  "public.seller_verifications": PublicSellerVerifications;
  "public.seo_metadata": PublicSeoMetadata;
  "public.seo_settings": PublicSeoSettings;
  "public.service_deliveries": PublicServiceDeliveries;
  "public.service_quotes": PublicServiceQuotes;
  "public.service_requests": PublicServiceRequests;
  "public.shipping_profiles": PublicShippingProfiles;
  "public.shipping_rates": PublicShippingRates;
  "public.shipping_zones": PublicShippingZones;
  "public.site_settings": PublicSiteSettings;
  "public.step_up_grants": PublicStepUpGrants;
  "public.support_attachments": PublicSupportAttachments;
  "public.support_internal_notes": PublicSupportInternalNotes;
  "public.support_messages": PublicSupportMessages;
  "public.support_ticket_events": PublicSupportTicketEvents;
  "public.support_tickets": PublicSupportTickets;
  "public.tags": PublicTags;
  "public.tax_rules": PublicTaxRules;
  "public.user_blocks": PublicUserBlocks;
  "public.user_roles": PublicUserRoles;
  "public.user_settings": PublicUserSettings;
  "public.wallet_transactions": PublicWalletTransactions;
  "public.whatsapp_outbox": PublicWhatsappOutbox;
  "public.withdrawal_limits": PublicWithdrawalLimits;
  "public.withdrawals": PublicWithdrawals;
}
