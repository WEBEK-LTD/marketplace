// GENERATED FILE — do not edit.
// Produced by scripts/db/generate-types.mjs from the schema in supabase/migrations/.
// Regenerate with `pnpm run db:types`; CI fails when this file and the migrations disagree.

import type { ColumnType } from 'kysely';

/** A column the database fills in: optional on insert, not updatable by default. */
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;

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

export interface PublicListingTypes {
  "code": string;
  "name_en": string;
  "name_ar": string;
  "is_active": Generated<boolean>;
  "sort_order": Generated<number>;
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

export interface Database {
  "app_private.account_lockouts": AppPrivateAccountLockouts;
  "app_private.currency_dependencies": AppPrivateCurrencyDependencies;
  "app_private.login_attempts": AppPrivateLoginAttempts;
  "app_private.otp_challenges": AppPrivateOtpChallenges;
  "app_private.password_reset_tokens": AppPrivatePasswordResetTokens;
  "app_private.rate_limits": AppPrivateRateLimits;
  "audit.audit_logs": AuditAuditLogs;
  "public.addresses": PublicAddresses;
  "public.countries": PublicCountries;
  "public.currencies": PublicCurrencies;
  "public.currency_translations": PublicCurrencyTranslations;
  "public.idempotency_keys": PublicIdempotencyKeys;
  "public.job_runs": PublicJobRuns;
  "public.known_devices": PublicKnownDevices;
  "public.listing_types": PublicListingTypes;
  "public.locales": PublicLocales;
  "public.outbox_events": PublicOutboxEvents;
  "public.permissions": PublicPermissions;
  "public.profiles": PublicProfiles;
  "public.role_permissions": PublicRolePermissions;
  "public.roles": PublicRoles;
  "public.security_events": PublicSecurityEvents;
  "public.step_up_grants": PublicStepUpGrants;
  "public.user_blocks": PublicUserBlocks;
  "public.user_roles": PublicUserRoles;
  "public.user_settings": PublicUserSettings;
}
