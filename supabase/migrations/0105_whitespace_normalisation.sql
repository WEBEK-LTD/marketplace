-- 0105 — Whitespace normalisation hardening.
--
-- `btrim(x)` with no character set trims **spaces only**. Tabs, carriage returns and newlines survive it. This
-- platform used that loose form in 97 CHECK constraints and 258 places across 96 `app_private` functions, in
-- every case to decide whether a required value was present — so a value made entirely of tabs passed a check
-- whose whole purpose was to refuse an empty one. Five places used the explicit set (0096, 0100 twice, 0103
-- twice); everything else did not.
--
-- ---------------------------------------------------------------------------------------------------
-- WHY THIS IS A CORRECTIVE INCREMENT AND NOT A TIDY-UP
-- ---------------------------------------------------------------------------------------------------
--
-- Two instances were proved reachable by execution before this migration was written, and neither is theory.
--
-- **A whitespace-only category name reaches the public, unauthenticated catalogue.** Three layers all admitted
-- it: the request schema (`z.string().min(1)`, which a tab satisfies), the writer (which stored `p_name` raw),
-- and `category_translations_name_length` (`length(btrim(name)) >= 1`). `app_private.public_categories('en')`
-- then returned it, so the public navigation, the category feed, the breadcrumbs and the sitemap would each
-- render a blank name.
--
-- **A report could be closed with a whitespace-only resolution note.** `app_private.resolve_report` raises
-- *"a report is never closed without a reason"* when `length(btrim(coalesce(p_resolution_note, ''))) = 0`. Two
-- tabs passed it, `reports_resolved_has_note` passed it too, `ResolutionNoteSchema` did not trim, and the
-- report closed as `actioned` with `resolved_at` set. The invariant the function names in its own error
-- message was defeatable over HTTP.
--
-- The pattern in both is the same: the **authoritative** layer did not hold the invariant it claimed, and
-- whether any given field was exploitable depended on whether somebody had remembered `.trim()` in a schema.
-- That is the opposite of how this platform is supposed to be built, and it is why all three layers are fixed
-- here rather than only the one that happened to be reachable.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES, AND IN WHAT ORDER
-- ---------------------------------------------------------------------------------------------------
--
-- 1. **Preflight.** One count per constraint, evaluating the **new** predicate against the existing rows. If
--    any row would be rejected, the migration aborts naming every table, constraint and count. Nothing has
--    been changed at that point, so an abort leaves the database exactly as it was.
-- 2. **64 CHECK constraints** are dropped and re-added by name, with the same bounds and the same shape, and
--    `btrim(x, E' \t\r\n')` in place of `btrim(x)`.
-- 3. **92 `app_private` function definitions** are replaced, each dumped from the live catalogue rather than
--    retyped, with every loose `btrim(` given the explicit set.
-- 4. **A verification block** asserts that no constraint and no function left in scope still uses the loose
--    form, so this migration cannot half-apply and report success.
--
-- The character set is exactly `E' \t\r\n'` — space, tab, carriage return, newline — matching 0096, 0100 and
-- 0103. **Unicode whitespace is deliberately not handled**: a non-breaking space (U+00A0) or a zero-width
-- space (U+200B) still survives, and that is recorded as a separate future hardening question rather than
-- folded in here, because it needs a decision about which code points count and that decision is not this
-- increment's to make.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT TOUCHED
-- ---------------------------------------------------------------------------------------------------
--
-- **33 constraints on 27 financial tables and 4 financial functions keep the loose form**, recorded in the
-- README as a follow-up. `cancellation_policies`, `checkout_charges`, `checkout_tax_lines`, `commission_rules`,
-- `commissions`, `coupon_usage`, `coupons`, `dispute_evidence`, `dispute_messages`, `disputes`,
-- `order_cancellations`, `payment_providers`, `payout_destinations`, `payout_providers`, `payout_reversals`,
-- `promotion_packages`, `promotion_ranking_settings`, `promotion_refund_policies`, `provider_settlement_items`,
-- `provider_settlements`, `refunds`, `service_deliveries`, `shipping_profiles`, `shipping_rates`,
-- `shipping_zones`, `tax_rules` and `withdrawals`, plus `apply_coupon`, `dispute_message_post_for_staff`,
-- `dispute_resolve_for_staff` and `resolve_dispute`. Every one of those tables is **empty and unreachable**
-- while the financial freeze holds, so there is no exposure to carry; and altering a payment, payout,
-- settlement, refund or dispute table in a migration is exactly what the freeze exists to prevent, however
-- benign a text check looks. They belong to whichever increment unfreezes those paths.
--
-- No listing-analytics path, no SEO robots policy, no email, banner or settings surface, and no change to
-- 0103's blocking or 0104's attachments. No bound, field name, response shape or problem code changes. No
-- Unicode normalisation and no text canonicalisation: **interior whitespace is preserved exactly**, and the
-- only difference anywhere below is which characters count as surrounding whitespace.

-- ---------------------------------------------------------------------------------------------------
-- 1. Preflight
-- ---------------------------------------------------------------------------------------------------
-- One count per constraint, against the predicate that is about to replace it. `not (predicate)` selects
-- exactly the rows a CHECK would refuse: a predicate that evaluates to null satisfies a constraint in
-- PostgreSQL and is correctly not counted here.
--
-- This aborts rather than repairing. Rewriting somebody's data to fit a new constraint — trimming it, nulling
-- it, deleting the row — is a decision an owner makes with the rows in front of them, not something a
-- migration does silently at 3am. The diagnostic names every table, column and count so that decision can be
-- made from it.
do $$
declare
  v_problems text[] := array[]::text[];
  v_count bigint;
begin
  select count(*) into v_count from public.account_recovery_approvals where not ((note IS NULL) OR ((length(btrim(note, E' \t\r\n')) >= 1) AND (length(btrim(note, E' \t\r\n')) <= 2000)));
  if v_count > 0 then v_problems := v_problems || format('public.account_recovery_approvals (%s): %s row(s)', 'account_recovery_approvals_note_length', v_count); end if;
  select count(*) into v_count from public.account_recovery_evidence where not (length(btrim(object_path, E' \t\r\n')) > 0);
  if v_count > 0 then v_problems := v_problems || format('public.account_recovery_evidence (%s): %s row(s)', 'account_recovery_evidence_path_present', v_count); end if;
  select count(*) into v_count from public.account_recovery_requests where not ((status <> 'rejected'::text) OR (length(btrim(COALESCE(rejection_reason, ''::text), E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.account_recovery_requests (%s): %s row(s)', 'account_recovery_requests_rejected_has_reason', v_count); end if;
  select count(*) into v_count from public.addresses where not ((length(btrim(recipient_name, E' \t\r\n')) >= 1) AND (length(btrim(recipient_name, E' \t\r\n')) <= 160));
  if v_count > 0 then v_problems := v_problems || format('public.addresses (%s): %s row(s)', 'addresses_recipient_present', v_count); end if;
  select count(*) into v_count from public.addresses where not ((length(btrim(governorate, E' \t\r\n')) > 0) AND (length(btrim(city, E' \t\r\n')) > 0) AND (length(btrim(street_address, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.addresses (%s): %s row(s)', 'addresses_required_parts', v_count); end if;
  select count(*) into v_count from public.attribute_definitions where not ((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.attribute_definitions (%s): %s row(s)', 'attribute_definitions_names_present', v_count); end if;
  select count(*) into v_count from public.attribute_options where not ((length(btrim(label_en, E' \t\r\n')) > 0) AND (length(btrim(label_ar, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.attribute_options (%s): %s row(s)', 'attribute_options_labels_present', v_count); end if;
  select count(*) into v_count from public.blog_categories where not ((name_ar IS NULL) OR ((length(btrim(name_ar, E' \t\r\n')) >= 1) AND (length(btrim(name_ar, E' \t\r\n')) <= 120)));
  if v_count > 0 then v_problems := v_problems || format('public.blog_categories (%s): %s row(s)', 'blog_categories_name_ar_length', v_count); end if;
  select count(*) into v_count from public.blog_categories where not ((length(btrim(name_en, E' \t\r\n')) >= 1) AND (length(btrim(name_en, E' \t\r\n')) <= 120));
  if v_count > 0 then v_problems := v_problems || format('public.blog_categories (%s): %s row(s)', 'blog_categories_name_en_length', v_count); end if;
  select count(*) into v_count from public.blog_post_translations where not (length(btrim(body, E' \t\r\n')) > 0);
  if v_count > 0 then v_problems := v_problems || format('public.blog_post_translations (%s): %s row(s)', 'blog_post_translations_body_present', v_count); end if;
  select count(*) into v_count from public.blog_post_translations where not ((length(btrim(title, E' \t\r\n')) >= 1) AND (length(btrim(title, E' \t\r\n')) <= 200));
  if v_count > 0 then v_problems := v_problems || format('public.blog_post_translations (%s): %s row(s)', 'blog_post_translations_title_length', v_count); end if;
  select count(*) into v_count from public.blog_tags where not ((name_ar IS NULL) OR ((length(btrim(name_ar, E' \t\r\n')) >= 1) AND (length(btrim(name_ar, E' \t\r\n')) <= 60)));
  if v_count > 0 then v_problems := v_problems || format('public.blog_tags (%s): %s row(s)', 'blog_tags_name_ar_length', v_count); end if;
  select count(*) into v_count from public.blog_tags where not ((length(btrim(name_en, E' \t\r\n')) >= 1) AND (length(btrim(name_en, E' \t\r\n')) <= 60));
  if v_count > 0 then v_problems := v_problems || format('public.blog_tags (%s): %s row(s)', 'blog_tags_name_en_length', v_count); end if;
  select count(*) into v_count from public.category_translations where not ((length(btrim(name, E' \t\r\n')) >= 1) AND (length(btrim(name, E' \t\r\n')) <= 120));
  if v_count > 0 then v_problems := v_problems || format('public.category_translations (%s): %s row(s)', 'category_translations_name_length', v_count); end if;
  select count(*) into v_count from public.countries where not ((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.countries (%s): %s row(s)', 'countries_names_present', v_count); end if;
  select count(*) into v_count from public.currencies where not (length(btrim(symbol, E' \t\r\n')) > 0);
  if v_count > 0 then v_problems := v_problems || format('public.currencies (%s): %s row(s)', 'currencies_symbol_present', v_count); end if;
  select count(*) into v_count from public.currency_translations where not (length(btrim(name, E' \t\r\n')) > 0);
  if v_count > 0 then v_problems := v_problems || format('public.currency_translations (%s): %s row(s)', 'currency_translations_name_present', v_count); end if;
  select count(*) into v_count from public.email_templates where not ((length(btrim(subject, E' \t\r\n')) > 0) AND (length(btrim(body_html, E' \t\r\n')) > 0) AND (length(btrim(body_text, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.email_templates (%s): %s row(s)', 'email_templates_content_present', v_count); end if;
  select count(*) into v_count from public.faqs where not ((answer_ar IS NULL) OR (length(btrim(answer_ar, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.faqs (%s): %s row(s)', 'faqs_answer_ar_present', v_count); end if;
  select count(*) into v_count from public.faqs where not (length(btrim(answer_en, E' \t\r\n')) > 0);
  if v_count > 0 then v_problems := v_problems || format('public.faqs (%s): %s row(s)', 'faqs_answer_en_present', v_count); end if;
  select count(*) into v_count from public.faqs where not ((question_ar IS NULL) OR ((length(btrim(question_ar, E' \t\r\n')) >= 1) AND (length(btrim(question_ar, E' \t\r\n')) <= 300)));
  if v_count > 0 then v_problems := v_problems || format('public.faqs (%s): %s row(s)', 'faqs_question_ar_length', v_count); end if;
  select count(*) into v_count from public.faqs where not ((length(btrim(question_en, E' \t\r\n')) >= 1) AND (length(btrim(question_en, E' \t\r\n')) <= 300));
  if v_count > 0 then v_problems := v_problems || format('public.faqs (%s): %s row(s)', 'faqs_question_en_length', v_count); end if;
  select count(*) into v_count from public.listing_moderation_actions where not ((length(btrim(reason, E' \t\r\n')) >= 1) AND (length(btrim(reason, E' \t\r\n')) <= 500));
  if v_count > 0 then v_problems := v_problems || format('public.listing_moderation_actions (%s): %s row(s)', 'listing_moderation_actions_reason_length', v_count); end if;
  select count(*) into v_count from public.listing_types where not ((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.listing_types (%s): %s row(s)', 'listing_types_names_present', v_count); end if;
  select count(*) into v_count from public.listings where not ((length(btrim(description, E' \t\r\n')) >= 10) AND (length(btrim(description, E' \t\r\n')) <= 20000));
  if v_count > 0 then v_problems := v_problems || format('public.listings (%s): %s row(s)', 'listings_description_length', v_count); end if;
  select count(*) into v_count from public.listings where not ((length(btrim(title, E' \t\r\n')) >= 3) AND (length(btrim(title, E' \t\r\n')) <= 140));
  if v_count > 0 then v_problems := v_problems || format('public.listings (%s): %s row(s)', 'listings_title_length', v_count); end if;
  select count(*) into v_count from public.locales where not ((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_native, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.locales (%s): %s row(s)', 'locales_names_present', v_count); end if;
  select count(*) into v_count from public.message_attachments where not (length(btrim(object_path, E' \t\r\n')) > 0);
  if v_count > 0 then v_problems := v_problems || format('public.message_attachments (%s): %s row(s)', 'message_attachments_path_present', v_count); end if;
  select count(*) into v_count from public.messages where not ((message_type <> 'text'::text) OR ((length(btrim(COALESCE(body, ''::text), E' \t\r\n')) >= 1) AND (length(btrim(COALESCE(body, ''::text), E' \t\r\n')) <= 5000)));
  if v_count > 0 then v_problems := v_problems || format('public.messages (%s): %s row(s)', 'messages_text_has_body', v_count); end if;
  select count(*) into v_count from public.moderation_actions where not ((notes IS NULL) OR ((length(btrim(notes, E' \t\r\n')) >= 1) AND (length(btrim(notes, E' \t\r\n')) <= 4000)));
  if v_count > 0 then v_problems := v_problems || format('public.moderation_actions (%s): %s row(s)', 'moderation_actions_notes_length', v_count); end if;
  select count(*) into v_count from public.moderation_actions where not ((length(btrim(reason, E' \t\r\n')) >= 1) AND (length(btrim(reason, E' \t\r\n')) <= 500));
  if v_count > 0 then v_problems := v_problems || format('public.moderation_actions (%s): %s row(s)', 'moderation_actions_reason_length', v_count); end if;
  select count(*) into v_count from public.navigation_items where not ((label_ar IS NULL) OR ((length(btrim(label_ar, E' \t\r\n')) >= 1) AND (length(btrim(label_ar, E' \t\r\n')) <= 120)));
  if v_count > 0 then v_problems := v_problems || format('public.navigation_items (%s): %s row(s)', 'navigation_items_label_ar_length', v_count); end if;
  select count(*) into v_count from public.navigation_items where not ((length(btrim(label_en, E' \t\r\n')) >= 1) AND (length(btrim(label_en, E' \t\r\n')) <= 120));
  if v_count > 0 then v_problems := v_problems || format('public.navigation_items (%s): %s row(s)', 'navigation_items_label_en_length', v_count); end if;
  select count(*) into v_count from public.navigation_menus where not ((label_ar IS NULL) OR ((length(btrim(label_ar, E' \t\r\n')) >= 1) AND (length(btrim(label_ar, E' \t\r\n')) <= 120)));
  if v_count > 0 then v_problems := v_problems || format('public.navigation_menus (%s): %s row(s)', 'navigation_menus_label_ar_length', v_count); end if;
  select count(*) into v_count from public.navigation_menus where not ((length(btrim(label_en, E' \t\r\n')) >= 1) AND (length(btrim(label_en, E' \t\r\n')) <= 120));
  if v_count > 0 then v_problems := v_problems || format('public.navigation_menus (%s): %s row(s)', 'navigation_menus_label_en_length', v_count); end if;
  select count(*) into v_count from public.offer_messages where not ((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 2000));
  if v_count > 0 then v_problems := v_problems || format('public.offer_messages (%s): %s row(s)', 'offer_messages_body_length', v_count); end if;
  select count(*) into v_count from public.outbox_events where not ((length(btrim(aggregate_id, E' \t\r\n')) >= 1) AND (length(btrim(aggregate_id, E' \t\r\n')) <= 200));
  if v_count > 0 then v_problems := v_problems || format('public.outbox_events (%s): %s row(s)', 'outbox_events_aggregate_id_present', v_count); end if;
  select count(*) into v_count from public.page_translations where not (length(btrim(body, E' \t\r\n')) > 0);
  if v_count > 0 then v_problems := v_problems || format('public.page_translations (%s): %s row(s)', 'page_translations_body_present', v_count); end if;
  select count(*) into v_count from public.page_translations where not ((length(btrim(title, E' \t\r\n')) >= 1) AND (length(btrim(title, E' \t\r\n')) <= 200));
  if v_count > 0 then v_problems := v_problems || format('public.page_translations (%s): %s row(s)', 'page_translations_title_length', v_count); end if;
  select count(*) into v_count from public.permissions where not ((length(btrim(description_en, E' \t\r\n')) > 0) AND (length(btrim(description_ar, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.permissions (%s): %s row(s)', 'permissions_descriptions_present', v_count); end if;
  select count(*) into v_count from public.reports where not ((details IS NULL) OR ((length(btrim(details, E' \t\r\n')) >= 1) AND (length(btrim(details, E' \t\r\n')) <= 4000)));
  if v_count > 0 then v_problems := v_problems || format('public.reports (%s): %s row(s)', 'reports_details_length', v_count); end if;
  select count(*) into v_count from public.reports where not ((resolved_at IS NULL) OR (length(btrim(COALESCE(resolution_note, ''::text), E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.reports (%s): %s row(s)', 'reports_resolved_has_note', v_count); end if;
  select count(*) into v_count from public.review_replies where not ((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 2000));
  if v_count > 0 then v_problems := v_problems || format('public.review_replies (%s): %s row(s)', 'review_replies_body_length', v_count); end if;
  select count(*) into v_count from public.review_replies where not ((moderated_at IS NULL) OR (length(btrim(moderation_reason, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.review_replies (%s): %s row(s)', 'review_replies_moderated_has_reason', v_count); end if;
  select count(*) into v_count from public.reviews where not ((body IS NULL) OR ((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 4000)));
  if v_count > 0 then v_problems := v_problems || format('public.reviews (%s): %s row(s)', 'reviews_body_length', v_count); end if;
  select count(*) into v_count from public.reviews where not ((moderated_at IS NULL) OR (length(btrim(moderation_reason, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.reviews (%s): %s row(s)', 'reviews_moderated_has_reason', v_count); end if;
  select count(*) into v_count from public.reviews where not ((title IS NULL) OR ((length(btrim(title, E' \t\r\n')) >= 1) AND (length(btrim(title, E' \t\r\n')) <= 120)));
  if v_count > 0 then v_problems := v_problems || format('public.reviews (%s): %s row(s)', 'reviews_title_length', v_count); end if;
  select count(*) into v_count from public.roles where not ((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.roles (%s): %s row(s)', 'roles_names_present', v_count); end if;
  select count(*) into v_count from public.saved_searches where not ((length(btrim(name, E' \t\r\n')) >= 1) AND (length(btrim(name, E' \t\r\n')) <= 120));
  if v_count > 0 then v_problems := v_problems || format('public.saved_searches (%s): %s row(s)', 'saved_searches_name_length', v_count); end if;
  select count(*) into v_count from public.seller_profiles where not ((length(btrim(display_name, E' \t\r\n')) >= 2) AND (length(btrim(display_name, E' \t\r\n')) <= 80));
  if v_count > 0 then v_problems := v_problems || format('public.seller_profiles (%s): %s row(s)', 'seller_profiles_display_name_length', v_count); end if;
  select count(*) into v_count from public.seller_verification_documents where not (length(btrim(object_path, E' \t\r\n')) > 0);
  if v_count > 0 then v_problems := v_problems || format('public.seller_verification_documents (%s): %s row(s)', 'seller_verification_documents_path_present', v_count); end if;
  select count(*) into v_count from public.seller_verifications where not ((status <> 'rejected'::text) OR (length(btrim(COALESCE(decision_reason, ''::text), E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.seller_verifications (%s): %s row(s)', 'seller_verifications_rejection_has_reason', v_count); end if;
  select count(*) into v_count from public.seo_settings where not ((length(btrim(site_name, E' \t\r\n')) >= 1) AND (length(btrim(site_name, E' \t\r\n')) <= 120));
  if v_count > 0 then v_problems := v_problems || format('public.seo_settings (%s): %s row(s)', 'seo_settings_site_name_length', v_count); end if;
  select count(*) into v_count from public.service_quotes where not ((length(btrim(scope, E' \t\r\n')) >= 10) AND (length(btrim(scope, E' \t\r\n')) <= 10000));
  if v_count > 0 then v_problems := v_problems || format('public.service_quotes (%s): %s row(s)', 'service_quotes_scope_length', v_count); end if;
  select count(*) into v_count from public.service_requests where not ((length(btrim(brief, E' \t\r\n')) >= 10) AND (length(btrim(brief, E' \t\r\n')) <= 10000));
  if v_count > 0 then v_problems := v_problems || format('public.service_requests (%s): %s row(s)', 'service_requests_brief_length', v_count); end if;
  select count(*) into v_count from public.service_requests where not ((preferred_payment_method IS NULL) OR ((length(btrim(preferred_payment_method, E' \t\r\n')) >= 1) AND (length(btrim(preferred_payment_method, E' \t\r\n')) <= 120)));
  if v_count > 0 then v_problems := v_problems || format('public.service_requests (%s): %s row(s)', 'service_requests_payment_method_length', v_count); end if;
  select count(*) into v_count from public.service_requests where not ((payment_notes IS NULL) OR ((length(btrim(payment_notes, E' \t\r\n')) >= 1) AND (length(btrim(payment_notes, E' \t\r\n')) <= 2000)));
  if v_count > 0 then v_problems := v_problems || format('public.service_requests (%s): %s row(s)', 'service_requests_payment_notes_length', v_count); end if;
  select count(*) into v_count from public.service_requests where not ((length(btrim(title, E' \t\r\n')) >= 3) AND (length(btrim(title, E' \t\r\n')) <= 140));
  if v_count > 0 then v_problems := v_problems || format('public.service_requests (%s): %s row(s)', 'service_requests_title_length', v_count); end if;
  select count(*) into v_count from public.site_settings where not ((length(btrim(description_en, E' \t\r\n')) > 0) AND (length(btrim(description_ar, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.site_settings (%s): %s row(s)', 'site_settings_descriptions_present', v_count); end if;
  select count(*) into v_count from public.support_attachments where not (length(btrim(object_path, E' \t\r\n')) > 0);
  if v_count > 0 then v_problems := v_problems || format('public.support_attachments (%s): %s row(s)', 'support_attachments_path_present', v_count); end if;
  select count(*) into v_count from public.support_internal_notes where not ((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 8000));
  if v_count > 0 then v_problems := v_problems || format('public.support_internal_notes (%s): %s row(s)', 'support_internal_notes_body_length', v_count); end if;
  select count(*) into v_count from public.support_messages where not ((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 8000));
  if v_count > 0 then v_problems := v_problems || format('public.support_messages (%s): %s row(s)', 'support_messages_body_length', v_count); end if;
  select count(*) into v_count from public.support_tickets where not ((length(btrim(subject, E' \t\r\n')) >= 1) AND (length(btrim(subject, E' \t\r\n')) <= 200));
  if v_count > 0 then v_problems := v_problems || format('public.support_tickets (%s): %s row(s)', 'support_tickets_subject_length', v_count); end if;
  select count(*) into v_count from public.tags where not ((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0));
  if v_count > 0 then v_problems := v_problems || format('public.tags (%s): %s row(s)', 'tags_names_present', v_count); end if;

  if array_length(v_problems, 1) is not null then
    raise exception
      'whitespace preflight failed: % column(s) hold values that are not empty but contain only whitespace. Nothing has been changed. Decide what each should become, then re-run. Affected: %',
      array_length(v_problems, 1), array_to_string(v_problems, '; ')
      using errcode = 'check_violation';
  end if;

  raise notice 'whitespace preflight passed: no existing row violates any tightened constraint.';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- 2. The constraints
-- ---------------------------------------------------------------------------------------------------
-- Each is dropped and re-added by its own name, so no historical migration file is edited and the constraint
-- keeps the identity every existing test and error message refers to. The original definition is quoted above
-- each pair: the bounds, the null branches and the conditional shapes are carried over unchanged, and the only
-- edit is the character set.

-- account_recovery_approvals ----------------------------------------------------------------------
-- was: CHECK (((note IS NULL) OR ((length(btrim(note)) >= 1) AND (length(btrim(note)) <= 2000))))
alter table public.account_recovery_approvals drop constraint account_recovery_approvals_note_length;
alter table public.account_recovery_approvals add constraint account_recovery_approvals_note_length CHECK (((note IS NULL) OR ((length(btrim(note, E' \t\r\n')) >= 1) AND (length(btrim(note, E' \t\r\n')) <= 2000))));

-- account_recovery_evidence -----------------------------------------------------------------------
-- was: CHECK ((length(btrim(object_path)) > 0))
alter table public.account_recovery_evidence drop constraint account_recovery_evidence_path_present;
alter table public.account_recovery_evidence add constraint account_recovery_evidence_path_present CHECK ((length(btrim(object_path, E' \t\r\n')) > 0));

-- account_recovery_requests -----------------------------------------------------------------------
-- was: CHECK (((status <> 'rejected'::text) OR (length(btrim(COALESCE(rejection_reason, ''::text))) > 0)))
alter table public.account_recovery_requests drop constraint account_recovery_requests_rejected_has_reason;
alter table public.account_recovery_requests add constraint account_recovery_requests_rejected_has_reason CHECK (((status <> 'rejected'::text) OR (length(btrim(COALESCE(rejection_reason, ''::text), E' \t\r\n')) > 0)));

-- addresses ---------------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(recipient_name)) >= 1) AND (length(btrim(recipient_name)) <= 160)))
alter table public.addresses drop constraint addresses_recipient_present;
alter table public.addresses add constraint addresses_recipient_present CHECK (((length(btrim(recipient_name, E' \t\r\n')) >= 1) AND (length(btrim(recipient_name, E' \t\r\n')) <= 160)));
-- was: CHECK (((length(btrim(governorate)) > 0) AND (length(btrim(city)) > 0) AND (length(btrim(street_address)) > 0)))
alter table public.addresses drop constraint addresses_required_parts;
alter table public.addresses add constraint addresses_required_parts CHECK (((length(btrim(governorate, E' \t\r\n')) > 0) AND (length(btrim(city, E' \t\r\n')) > 0) AND (length(btrim(street_address, E' \t\r\n')) > 0)));

-- attribute_definitions ---------------------------------------------------------------------------
-- was: CHECK (((length(btrim(name_en)) > 0) AND (length(btrim(name_ar)) > 0)))
alter table public.attribute_definitions drop constraint attribute_definitions_names_present;
alter table public.attribute_definitions add constraint attribute_definitions_names_present CHECK (((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0)));

-- attribute_options -------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(label_en)) > 0) AND (length(btrim(label_ar)) > 0)))
alter table public.attribute_options drop constraint attribute_options_labels_present;
alter table public.attribute_options add constraint attribute_options_labels_present CHECK (((length(btrim(label_en, E' \t\r\n')) > 0) AND (length(btrim(label_ar, E' \t\r\n')) > 0)));

-- blog_categories ---------------------------------------------------------------------------------
-- was: CHECK (((name_ar IS NULL) OR ((length(btrim(name_ar)) >= 1) AND (length(btrim(name_ar)) <= 120))))
alter table public.blog_categories drop constraint blog_categories_name_ar_length;
alter table public.blog_categories add constraint blog_categories_name_ar_length CHECK (((name_ar IS NULL) OR ((length(btrim(name_ar, E' \t\r\n')) >= 1) AND (length(btrim(name_ar, E' \t\r\n')) <= 120))));
-- was: CHECK (((length(btrim(name_en)) >= 1) AND (length(btrim(name_en)) <= 120)))
alter table public.blog_categories drop constraint blog_categories_name_en_length;
alter table public.blog_categories add constraint blog_categories_name_en_length CHECK (((length(btrim(name_en, E' \t\r\n')) >= 1) AND (length(btrim(name_en, E' \t\r\n')) <= 120)));

-- blog_post_translations --------------------------------------------------------------------------
-- was: CHECK ((length(btrim(body)) > 0))
alter table public.blog_post_translations drop constraint blog_post_translations_body_present;
alter table public.blog_post_translations add constraint blog_post_translations_body_present CHECK ((length(btrim(body, E' \t\r\n')) > 0));
-- was: CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200)))
alter table public.blog_post_translations drop constraint blog_post_translations_title_length;
alter table public.blog_post_translations add constraint blog_post_translations_title_length CHECK (((length(btrim(title, E' \t\r\n')) >= 1) AND (length(btrim(title, E' \t\r\n')) <= 200)));

-- blog_tags ---------------------------------------------------------------------------------------
-- was: CHECK (((name_ar IS NULL) OR ((length(btrim(name_ar)) >= 1) AND (length(btrim(name_ar)) <= 60))))
alter table public.blog_tags drop constraint blog_tags_name_ar_length;
alter table public.blog_tags add constraint blog_tags_name_ar_length CHECK (((name_ar IS NULL) OR ((length(btrim(name_ar, E' \t\r\n')) >= 1) AND (length(btrim(name_ar, E' \t\r\n')) <= 60))));
-- was: CHECK (((length(btrim(name_en)) >= 1) AND (length(btrim(name_en)) <= 60)))
alter table public.blog_tags drop constraint blog_tags_name_en_length;
alter table public.blog_tags add constraint blog_tags_name_en_length CHECK (((length(btrim(name_en, E' \t\r\n')) >= 1) AND (length(btrim(name_en, E' \t\r\n')) <= 60)));

-- category_translations ---------------------------------------------------------------------------
-- was: CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120)))
alter table public.category_translations drop constraint category_translations_name_length;
alter table public.category_translations add constraint category_translations_name_length CHECK (((length(btrim(name, E' \t\r\n')) >= 1) AND (length(btrim(name, E' \t\r\n')) <= 120)));

-- countries ---------------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(name_en)) > 0) AND (length(btrim(name_ar)) > 0)))
alter table public.countries drop constraint countries_names_present;
alter table public.countries add constraint countries_names_present CHECK (((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0)));

-- currencies --------------------------------------------------------------------------------------
-- was: CHECK ((length(btrim(symbol)) > 0))
alter table public.currencies drop constraint currencies_symbol_present;
alter table public.currencies add constraint currencies_symbol_present CHECK ((length(btrim(symbol, E' \t\r\n')) > 0));

-- currency_translations ---------------------------------------------------------------------------
-- was: CHECK ((length(btrim(name)) > 0))
alter table public.currency_translations drop constraint currency_translations_name_present;
alter table public.currency_translations add constraint currency_translations_name_present CHECK ((length(btrim(name, E' \t\r\n')) > 0));

-- email_templates ---------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(subject)) > 0) AND (length(btrim(body_html)) > 0) AND (length(btrim(body_text)) > 0)))
alter table public.email_templates drop constraint email_templates_content_present;
alter table public.email_templates add constraint email_templates_content_present CHECK (((length(btrim(subject, E' \t\r\n')) > 0) AND (length(btrim(body_html, E' \t\r\n')) > 0) AND (length(btrim(body_text, E' \t\r\n')) > 0)));

-- faqs --------------------------------------------------------------------------------------------
-- was: CHECK (((answer_ar IS NULL) OR (length(btrim(answer_ar)) > 0)))
alter table public.faqs drop constraint faqs_answer_ar_present;
alter table public.faqs add constraint faqs_answer_ar_present CHECK (((answer_ar IS NULL) OR (length(btrim(answer_ar, E' \t\r\n')) > 0)));
-- was: CHECK ((length(btrim(answer_en)) > 0))
alter table public.faqs drop constraint faqs_answer_en_present;
alter table public.faqs add constraint faqs_answer_en_present CHECK ((length(btrim(answer_en, E' \t\r\n')) > 0));
-- was: CHECK (((question_ar IS NULL) OR ((length(btrim(question_ar)) >= 1) AND (length(btrim(question_ar)) <= 300))))
alter table public.faqs drop constraint faqs_question_ar_length;
alter table public.faqs add constraint faqs_question_ar_length CHECK (((question_ar IS NULL) OR ((length(btrim(question_ar, E' \t\r\n')) >= 1) AND (length(btrim(question_ar, E' \t\r\n')) <= 300))));
-- was: CHECK (((length(btrim(question_en)) >= 1) AND (length(btrim(question_en)) <= 300)))
alter table public.faqs drop constraint faqs_question_en_length;
alter table public.faqs add constraint faqs_question_en_length CHECK (((length(btrim(question_en, E' \t\r\n')) >= 1) AND (length(btrim(question_en, E' \t\r\n')) <= 300)));

-- listing_moderation_actions ----------------------------------------------------------------------
-- was: CHECK (((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 500)))
alter table public.listing_moderation_actions drop constraint listing_moderation_actions_reason_length;
alter table public.listing_moderation_actions add constraint listing_moderation_actions_reason_length CHECK (((length(btrim(reason, E' \t\r\n')) >= 1) AND (length(btrim(reason, E' \t\r\n')) <= 500)));

-- listing_types -----------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(name_en)) > 0) AND (length(btrim(name_ar)) > 0)))
alter table public.listing_types drop constraint listing_types_names_present;
alter table public.listing_types add constraint listing_types_names_present CHECK (((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0)));

-- listings ----------------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(description)) >= 10) AND (length(btrim(description)) <= 20000)))
alter table public.listings drop constraint listings_description_length;
alter table public.listings add constraint listings_description_length CHECK (((length(btrim(description, E' \t\r\n')) >= 10) AND (length(btrim(description, E' \t\r\n')) <= 20000)));
-- was: CHECK (((length(btrim(title)) >= 3) AND (length(btrim(title)) <= 140)))
alter table public.listings drop constraint listings_title_length;
alter table public.listings add constraint listings_title_length CHECK (((length(btrim(title, E' \t\r\n')) >= 3) AND (length(btrim(title, E' \t\r\n')) <= 140)));

-- locales -----------------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(name_en)) > 0) AND (length(btrim(name_native)) > 0)))
alter table public.locales drop constraint locales_names_present;
alter table public.locales add constraint locales_names_present CHECK (((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_native, E' \t\r\n')) > 0)));

-- message_attachments -----------------------------------------------------------------------------
-- was: CHECK ((length(btrim(object_path)) > 0))
alter table public.message_attachments drop constraint message_attachments_path_present;
alter table public.message_attachments add constraint message_attachments_path_present CHECK ((length(btrim(object_path, E' \t\r\n')) > 0));

-- messages ----------------------------------------------------------------------------------------
-- was: CHECK (((message_type <> 'text'::text) OR ((length(btrim(COALESCE(body, ''::text))) >= 1) AND (length(btrim(COALESCE(body, ''::text))) <= 5000))))
alter table public.messages drop constraint messages_text_has_body;
alter table public.messages add constraint messages_text_has_body CHECK (((message_type <> 'text'::text) OR ((length(btrim(COALESCE(body, ''::text), E' \t\r\n')) >= 1) AND (length(btrim(COALESCE(body, ''::text), E' \t\r\n')) <= 5000))));

-- moderation_actions ------------------------------------------------------------------------------
-- was: CHECK (((notes IS NULL) OR ((length(btrim(notes)) >= 1) AND (length(btrim(notes)) <= 4000))))
alter table public.moderation_actions drop constraint moderation_actions_notes_length;
alter table public.moderation_actions add constraint moderation_actions_notes_length CHECK (((notes IS NULL) OR ((length(btrim(notes, E' \t\r\n')) >= 1) AND (length(btrim(notes, E' \t\r\n')) <= 4000))));
-- was: CHECK (((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 500)))
alter table public.moderation_actions drop constraint moderation_actions_reason_length;
alter table public.moderation_actions add constraint moderation_actions_reason_length CHECK (((length(btrim(reason, E' \t\r\n')) >= 1) AND (length(btrim(reason, E' \t\r\n')) <= 500)));

-- navigation_items --------------------------------------------------------------------------------
-- was: CHECK (((label_ar IS NULL) OR ((length(btrim(label_ar)) >= 1) AND (length(btrim(label_ar)) <= 120))))
alter table public.navigation_items drop constraint navigation_items_label_ar_length;
alter table public.navigation_items add constraint navigation_items_label_ar_length CHECK (((label_ar IS NULL) OR ((length(btrim(label_ar, E' \t\r\n')) >= 1) AND (length(btrim(label_ar, E' \t\r\n')) <= 120))));
-- was: CHECK (((length(btrim(label_en)) >= 1) AND (length(btrim(label_en)) <= 120)))
alter table public.navigation_items drop constraint navigation_items_label_en_length;
alter table public.navigation_items add constraint navigation_items_label_en_length CHECK (((length(btrim(label_en, E' \t\r\n')) >= 1) AND (length(btrim(label_en, E' \t\r\n')) <= 120)));

-- navigation_menus --------------------------------------------------------------------------------
-- was: CHECK (((label_ar IS NULL) OR ((length(btrim(label_ar)) >= 1) AND (length(btrim(label_ar)) <= 120))))
alter table public.navigation_menus drop constraint navigation_menus_label_ar_length;
alter table public.navigation_menus add constraint navigation_menus_label_ar_length CHECK (((label_ar IS NULL) OR ((length(btrim(label_ar, E' \t\r\n')) >= 1) AND (length(btrim(label_ar, E' \t\r\n')) <= 120))));
-- was: CHECK (((length(btrim(label_en)) >= 1) AND (length(btrim(label_en)) <= 120)))
alter table public.navigation_menus drop constraint navigation_menus_label_en_length;
alter table public.navigation_menus add constraint navigation_menus_label_en_length CHECK (((length(btrim(label_en, E' \t\r\n')) >= 1) AND (length(btrim(label_en, E' \t\r\n')) <= 120)));

-- offer_messages ----------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 2000)))
alter table public.offer_messages drop constraint offer_messages_body_length;
alter table public.offer_messages add constraint offer_messages_body_length CHECK (((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 2000)));

-- outbox_events -----------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(aggregate_id)) >= 1) AND (length(btrim(aggregate_id)) <= 200)))
alter table public.outbox_events drop constraint outbox_events_aggregate_id_present;
alter table public.outbox_events add constraint outbox_events_aggregate_id_present CHECK (((length(btrim(aggregate_id, E' \t\r\n')) >= 1) AND (length(btrim(aggregate_id, E' \t\r\n')) <= 200)));

-- page_translations -------------------------------------------------------------------------------
-- was: CHECK ((length(btrim(body)) > 0))
alter table public.page_translations drop constraint page_translations_body_present;
alter table public.page_translations add constraint page_translations_body_present CHECK ((length(btrim(body, E' \t\r\n')) > 0));
-- was: CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200)))
alter table public.page_translations drop constraint page_translations_title_length;
alter table public.page_translations add constraint page_translations_title_length CHECK (((length(btrim(title, E' \t\r\n')) >= 1) AND (length(btrim(title, E' \t\r\n')) <= 200)));

-- permissions -------------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(description_en)) > 0) AND (length(btrim(description_ar)) > 0)))
alter table public.permissions drop constraint permissions_descriptions_present;
alter table public.permissions add constraint permissions_descriptions_present CHECK (((length(btrim(description_en, E' \t\r\n')) > 0) AND (length(btrim(description_ar, E' \t\r\n')) > 0)));

-- reports -----------------------------------------------------------------------------------------
-- was: CHECK (((details IS NULL) OR ((length(btrim(details)) >= 1) AND (length(btrim(details)) <= 4000))))
alter table public.reports drop constraint reports_details_length;
alter table public.reports add constraint reports_details_length CHECK (((details IS NULL) OR ((length(btrim(details, E' \t\r\n')) >= 1) AND (length(btrim(details, E' \t\r\n')) <= 4000))));
-- was: CHECK (((resolved_at IS NULL) OR (length(btrim(COALESCE(resolution_note, ''::text))) > 0)))
alter table public.reports drop constraint reports_resolved_has_note;
alter table public.reports add constraint reports_resolved_has_note CHECK (((resolved_at IS NULL) OR (length(btrim(COALESCE(resolution_note, ''::text), E' \t\r\n')) > 0)));

-- review_replies ----------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 2000)))
alter table public.review_replies drop constraint review_replies_body_length;
alter table public.review_replies add constraint review_replies_body_length CHECK (((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 2000)));
-- was: CHECK (((moderated_at IS NULL) OR (length(btrim(moderation_reason)) > 0)))
alter table public.review_replies drop constraint review_replies_moderated_has_reason;
alter table public.review_replies add constraint review_replies_moderated_has_reason CHECK (((moderated_at IS NULL) OR (length(btrim(moderation_reason, E' \t\r\n')) > 0)));

-- reviews -----------------------------------------------------------------------------------------
-- was: CHECK (((body IS NULL) OR ((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 4000))))
alter table public.reviews drop constraint reviews_body_length;
alter table public.reviews add constraint reviews_body_length CHECK (((body IS NULL) OR ((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 4000))));
-- was: CHECK (((moderated_at IS NULL) OR (length(btrim(moderation_reason)) > 0)))
alter table public.reviews drop constraint reviews_moderated_has_reason;
alter table public.reviews add constraint reviews_moderated_has_reason CHECK (((moderated_at IS NULL) OR (length(btrim(moderation_reason, E' \t\r\n')) > 0)));
-- was: CHECK (((title IS NULL) OR ((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 120))))
alter table public.reviews drop constraint reviews_title_length;
alter table public.reviews add constraint reviews_title_length CHECK (((title IS NULL) OR ((length(btrim(title, E' \t\r\n')) >= 1) AND (length(btrim(title, E' \t\r\n')) <= 120))));

-- roles -------------------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(name_en)) > 0) AND (length(btrim(name_ar)) > 0)))
alter table public.roles drop constraint roles_names_present;
alter table public.roles add constraint roles_names_present CHECK (((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0)));

-- saved_searches ----------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120)))
alter table public.saved_searches drop constraint saved_searches_name_length;
alter table public.saved_searches add constraint saved_searches_name_length CHECK (((length(btrim(name, E' \t\r\n')) >= 1) AND (length(btrim(name, E' \t\r\n')) <= 120)));

-- seller_profiles ---------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(display_name)) >= 2) AND (length(btrim(display_name)) <= 80)))
alter table public.seller_profiles drop constraint seller_profiles_display_name_length;
alter table public.seller_profiles add constraint seller_profiles_display_name_length CHECK (((length(btrim(display_name, E' \t\r\n')) >= 2) AND (length(btrim(display_name, E' \t\r\n')) <= 80)));

-- seller_verification_documents -------------------------------------------------------------------
-- was: CHECK ((length(btrim(object_path)) > 0))
alter table public.seller_verification_documents drop constraint seller_verification_documents_path_present;
alter table public.seller_verification_documents add constraint seller_verification_documents_path_present CHECK ((length(btrim(object_path, E' \t\r\n')) > 0));

-- seller_verifications ----------------------------------------------------------------------------
-- was: CHECK (((status <> 'rejected'::text) OR (length(btrim(COALESCE(decision_reason, ''::text))) > 0)))
alter table public.seller_verifications drop constraint seller_verifications_rejection_has_reason;
alter table public.seller_verifications add constraint seller_verifications_rejection_has_reason CHECK (((status <> 'rejected'::text) OR (length(btrim(COALESCE(decision_reason, ''::text), E' \t\r\n')) > 0)));

-- seo_settings ------------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(site_name)) >= 1) AND (length(btrim(site_name)) <= 120)))
alter table public.seo_settings drop constraint seo_settings_site_name_length;
alter table public.seo_settings add constraint seo_settings_site_name_length CHECK (((length(btrim(site_name, E' \t\r\n')) >= 1) AND (length(btrim(site_name, E' \t\r\n')) <= 120)));

-- service_quotes ----------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(scope)) >= 10) AND (length(btrim(scope)) <= 10000)))
alter table public.service_quotes drop constraint service_quotes_scope_length;
alter table public.service_quotes add constraint service_quotes_scope_length CHECK (((length(btrim(scope, E' \t\r\n')) >= 10) AND (length(btrim(scope, E' \t\r\n')) <= 10000)));

-- service_requests --------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(brief)) >= 10) AND (length(btrim(brief)) <= 10000)))
alter table public.service_requests drop constraint service_requests_brief_length;
alter table public.service_requests add constraint service_requests_brief_length CHECK (((length(btrim(brief, E' \t\r\n')) >= 10) AND (length(btrim(brief, E' \t\r\n')) <= 10000)));
-- was: CHECK (((preferred_payment_method IS NULL) OR ((length(btrim(preferred_payment_method)) >= 1) AND (length(btrim(preferred_payment_method)) <= 120))))
alter table public.service_requests drop constraint service_requests_payment_method_length;
alter table public.service_requests add constraint service_requests_payment_method_length CHECK (((preferred_payment_method IS NULL) OR ((length(btrim(preferred_payment_method, E' \t\r\n')) >= 1) AND (length(btrim(preferred_payment_method, E' \t\r\n')) <= 120))));
-- was: CHECK (((payment_notes IS NULL) OR ((length(btrim(payment_notes)) >= 1) AND (length(btrim(payment_notes)) <= 2000))))
alter table public.service_requests drop constraint service_requests_payment_notes_length;
alter table public.service_requests add constraint service_requests_payment_notes_length CHECK (((payment_notes IS NULL) OR ((length(btrim(payment_notes, E' \t\r\n')) >= 1) AND (length(btrim(payment_notes, E' \t\r\n')) <= 2000))));
-- was: CHECK (((length(btrim(title)) >= 3) AND (length(btrim(title)) <= 140)))
alter table public.service_requests drop constraint service_requests_title_length;
alter table public.service_requests add constraint service_requests_title_length CHECK (((length(btrim(title, E' \t\r\n')) >= 3) AND (length(btrim(title, E' \t\r\n')) <= 140)));

-- site_settings -----------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(description_en)) > 0) AND (length(btrim(description_ar)) > 0)))
alter table public.site_settings drop constraint site_settings_descriptions_present;
alter table public.site_settings add constraint site_settings_descriptions_present CHECK (((length(btrim(description_en, E' \t\r\n')) > 0) AND (length(btrim(description_ar, E' \t\r\n')) > 0)));

-- support_attachments -----------------------------------------------------------------------------
-- was: CHECK ((length(btrim(object_path)) > 0))
alter table public.support_attachments drop constraint support_attachments_path_present;
alter table public.support_attachments add constraint support_attachments_path_present CHECK ((length(btrim(object_path, E' \t\r\n')) > 0));

-- support_internal_notes --------------------------------------------------------------------------
-- was: CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 8000)))
alter table public.support_internal_notes drop constraint support_internal_notes_body_length;
alter table public.support_internal_notes add constraint support_internal_notes_body_length CHECK (((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 8000)));

-- support_messages --------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 8000)))
alter table public.support_messages drop constraint support_messages_body_length;
alter table public.support_messages add constraint support_messages_body_length CHECK (((length(btrim(body, E' \t\r\n')) >= 1) AND (length(btrim(body, E' \t\r\n')) <= 8000)));

-- support_tickets ---------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(subject)) >= 1) AND (length(btrim(subject)) <= 200)))
alter table public.support_tickets drop constraint support_tickets_subject_length;
alter table public.support_tickets add constraint support_tickets_subject_length CHECK (((length(btrim(subject, E' \t\r\n')) >= 1) AND (length(btrim(subject, E' \t\r\n')) <= 200)));

-- tags --------------------------------------------------------------------------------------------
-- was: CHECK (((length(btrim(name_en)) > 0) AND (length(btrim(name_ar)) > 0)))
alter table public.tags drop constraint tags_names_present;
alter table public.tags add constraint tags_names_present CHECK (((length(btrim(name_en, E' \t\r\n')) > 0) AND (length(btrim(name_ar, E' \t\r\n')) > 0)));

-- ---------------------------------------------------------------------------------------------------
-- 3. The functions
-- ---------------------------------------------------------------------------------------------------
-- Every definition below was dumped from the live catalogue and edited only where a `btrim(` lacked its
-- character set. **No body was retyped from memory**, which is the one way this kind of change goes wrong:
-- a reconstructed body silently drops whatever the original did that nobody remembered. `create or replace`
-- preserves each function's existing privileges, and the security contract is asserted at the end.
--
-- `pg_get_functiondef` emits `SET search_path TO 'pg_catalog', 'public'`, which `scripts/policy/migrations.mjs`
-- does not recognise as a pinned search path — it requires the `set search_path =` spelling. That one line is
-- normalised in each definition below; `proconfig` is identical either way, which the pgTAP suite asserts.

-- admin_seller_detail: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.admin_seller_detail(p_user_id uuid, p_is_aal2 boolean, p_slug text)
 RETURNS TABLE(outcome text, slug text, display_name text, bio text, content_language text, status text, suspended_at timestamp with time zone, suspension_reason text, closed_at timestamp with time zone, verification_status text, verified_at timestamp with time zone, country_code text, governorate text, city text, listing_count integer, live_listing_count integer, open_report_count integer, is_own_storefront boolean, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
begin
  if p_user_id is null or p_slug is null or btrim(p_slug, E' \t\r\n') = ''
     or not app_private.admin_can_read_sellers(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text,
                        null::timestamptz, null::text, null::timestamptz, null::text, null::timestamptz,
                        null::text, null::text, null::text, null::integer, null::integer, null::integer,
                        null::boolean, null::timestamptz;
    return;
  end if;

  return query
    select 'found'::text,
           s.slug,
           s.display_name,
           s.bio,
           s.content_language,
           s.status,
           s.suspended_at,
           s.suspension_reason,
           s.closed_at,
           s.verification_status,
           s.verified_at,
           s.country_code::text,
           s.governorate,
           s.city,
           (select count(*)::integer from public.listings l where l.seller_user_id = s.user_id),
           (select count(*)::integer from public.listings l
             where l.seller_user_id = s.user_id and public.listing_status_is_public(l.status)),
           (select count(*)::integer from public.reports r
             where r.subject_type = 'seller' and r.subject_id = s.user_id
               and r.status in ('open', 'triaged')),
           s.user_id = p_user_id,
           s.created_at
      from public.seller_profiles s
     where s.slug = p_slug;

  if not found then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text,
                        null::timestamptz, null::text, null::timestamptz, null::text, null::timestamptz,
                        null::text, null::text, null::text, null::integer, null::integer, null::integer,
                        null::boolean, null::timestamptz;
  end if;
end;
$function$;

-- admin_seller_status_set: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.admin_seller_status_set(p_user_id uuid, p_is_aal2 boolean, p_slug text, p_status text, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_current text;
  v_verification text;
  v_reason text := nullif(btrim(coalesce(p_reason, ''), E' \t\r\n'), '');
begin
  -- Absence and a missing key are one answer, as they are on every read in 0078. There is no forbidden on
  -- this surface: a distinguishable refusal would be a way to ask whether a storefront exists.
  if p_user_id is null or p_slug is null or btrim(p_slug, E' \t\r\n') = ''
     or not app_private.admin_can_manage_sellers(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- The four values 0009 allows, and nothing else. Checked before the row is read so an unusable status
  -- never becomes a lock.
  if p_status is null or p_status not in ('pending', 'active', 'suspended', 'closed') then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  select s.status, s.verification_status
    into v_current, v_verification
    from public.seller_profiles s
   where s.slug = p_slug
     for update;

  if v_current is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- **There is deliberately no refusal here for a colleague acting on their own storefront.** The seller
  -- decisions do not ask for one, and the role decisions forbid self-action explicitly — so the silence on
  -- this side is not an oversight to be filled from this file. It is reported for an owner decision, and
  -- the case that makes it worth deciding is a suspended seller who also holds the manage key reinstating
  -- themselves. 0078's reader already reports `is_own_storefront`, so a console can show it either way.

  if v_current = p_status then
    return query select 'no_change'::text, v_current;
    return;
  end if;

  -- `closed` is terminal. Stated first because it is the one refusal that is about where the storefront
  -- already is rather than about where it is going.
  if v_current = 'closed' then
    return query select 'not_allowed'::text, v_current;
    return;
  end if;

  -- The seven legal pairs, written out. A matrix rather than a rule, because the rule would have to be
  -- invented and the matrix was decided.
  if not (
       (v_current = 'pending'   and p_status = 'suspended')
    or (v_current = 'active'    and p_status = 'suspended')
    or (v_current = 'suspended' and p_status = 'active')
    or (v_current = 'suspended' and p_status = 'pending')
    or (v_current = 'pending'   and p_status = 'closed')
    or (v_current = 'active'    and p_status = 'closed')
    or (v_current = 'suspended' and p_status = 'closed')
  ) then
    -- Covers `active → pending` and `pending → active`. The second is 7-G's alone: activation follows
    -- verification approval and nothing here produces `verified`.
    return query select 'not_allowed'::text, v_current;
    return;
  end if;

  if p_status = 'suspended' and v_reason is null then
    return query select 'reason_required'::text, v_current;
    return;
  end if;

  -- The two reinstatement conditions, as strict complements. `active` additionally satisfies
  -- `seller_profiles_active_needs_verification`, so this check is the readable form of a constraint that
  -- would otherwise refuse the statement.
  if p_status = 'active' and v_verification <> 'verified' then
    return query select 'not_verified'::text, v_current;
    return;
  end if;
  if p_status = 'pending' and v_verification = 'verified' then
    return query select 'already_verified'::text, v_current;
    return;
  end if;

  -- One statement, four columns, consistent with the biconditional constraints in every branch. Nothing
  -- else in this table is touched: not the slug, not the display name, not the contact details, and
  -- neither verification column.
  update public.seller_profiles s
     set status = p_status,
         suspended_at = case when p_status = 'suspended' then now() else null end,
         suspension_reason = case when p_status = 'suspended' then v_reason else null end,
         closed_at = case when p_status = 'closed' then now() else null end
   where s.slug = p_slug;

  -- 0009's `seller_profiles_audit` trigger has now recorded the change and the columns that moved. This
  -- function writes no audit row, no security event and no outbox event.
  return query select 'updated'::text, p_status;
end;
$function$;

-- attribute_definition_create_for_staff: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.attribute_definition_create_for_staff(p_user_id uuid, p_is_aal2 boolean, p_key text, p_data_type text, p_name_en text, p_name_ar text, p_unit text DEFAULT NULL::text, p_is_filterable boolean DEFAULT true, p_sort_order integer DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  new_id uuid;
begin
  if not app_private.attribute_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing the attribute vocabulary requires catalog.attribute.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  -- Created inactive, for the same reason a category is: a select type with no options yet is one nobody can
  -- answer, and an attribute reaches a seller's form the moment it is attached to their category.
  insert into public.attribute_definitions
    (key, data_type, unit, name_en, name_ar, is_filterable, is_active, sort_order)
  values (
    p_key,
    p_data_type,
    nullif(btrim(coalesce(p_unit, ''), E' \t\r\n'), ''),
    p_name_en,
    p_name_ar,
    coalesce(p_is_filterable, true),
    false,
    coalesce(p_sort_order, 0)
  )
  returning id into new_id;

  return new_id;
end;
$function$;

-- attribute_definition_update_for_staff: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.attribute_definition_update_for_staff(p_user_id uuid, p_is_aal2 boolean, p_definition_id uuid, p_name_en text, p_name_ar text, p_unit text, p_is_filterable boolean, p_sort_order integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  changed integer;
begin
  if not app_private.attribute_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing the attribute vocabulary requires catalog.attribute.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  update public.attribute_definitions d
     set name_en = p_name_en,
         name_ar = p_name_ar,
         unit = nullif(btrim(coalesce(p_unit, ''), E' \t\r\n'), ''),
         is_filterable = coalesce(p_is_filterable, d.is_filterable),
         sort_order = coalesce(p_sort_order, d.sort_order)
   where d.id = p_definition_id;

  get diagnostics changed = row_count;
  return changed > 0;
end;
$function$;

-- blog_category_save_for_staff: 10 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.blog_category_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_category_id uuid, p_slug text, p_name_en text, p_name_ar text DEFAULT NULL::text, p_description_en text DEFAULT NULL::text, p_description_ar text DEFAULT NULL::text, p_sort_order integer DEFAULT NULL::integer, p_is_active boolean DEFAULT NULL::boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  saved_id uuid;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Create or replace, branching on whether an id was named. English is required and Arabic optional
  -- throughout (D7), which is 0030's own constraint and is left to raise there.
  if p_category_id is null then
    insert into public.blog_categories (
      slug, name_en, name_ar, description_en, description_ar, sort_order, is_active
    )
    values (
      btrim(p_slug, E' \t\r\n'),
      btrim(p_name_en, E' \t\r\n'),
      nullif(btrim(coalesce(p_name_ar, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_description_en, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_description_ar, ''), E' \t\r\n'), ''),
      coalesce(p_sort_order, 0),
      coalesce(p_is_active, true)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  update public.blog_categories c
     set slug = coalesce(nullif(btrim(p_slug, E' \t\r\n'), ''), c.slug),
         name_en = coalesce(nullif(btrim(coalesce(p_name_en, ''), E' \t\r\n'), ''), c.name_en),
         name_ar = case when p_name_ar is null then c.name_ar
                        else nullif(btrim(p_name_ar, E' \t\r\n'), '') end,
         description_en = case when p_description_en is null then c.description_en
                              else nullif(btrim(p_description_en, E' \t\r\n'), '') end,
         description_ar = case when p_description_ar is null then c.description_ar
                              else nullif(btrim(p_description_ar, E' \t\r\n'), '') end,
         sort_order = coalesce(p_sort_order, c.sort_order),
         is_active = coalesce(p_is_active, c.is_active)
   where c.id = p_category_id
  returning c.id into saved_id;

  return saved_id;
end;
$function$;

-- blog_post_create_for_staff: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.blog_post_create_for_staff(p_user_id uuid, p_is_aal2 boolean, p_slug text, p_blog_category_id uuid DEFAULT NULL::uuid, p_is_indexable boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  new_id uuid;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- A post is always born a draft, and never featured: 0030's `blog_posts_featured_is_published` would
  -- refuse a featured draft anyway, and publishing is the separate call below, so a post cannot go live
  -- before anybody has written it.
  --
  -- `author_user_id` is the staff member creating the post — the byline is the person who wrote it. Changing
  -- a byline to somebody else is not part of this increment, so no writer below touches that column.
  insert into public.blog_posts (
    slug, blog_category_id, author_user_id, is_indexable, created_by, updated_by
  )
  values (
    btrim(p_slug, E' \t\r\n'),
    p_blog_category_id,
    p_user_id,
    coalesce(p_is_indexable, true),
    p_user_id,
    p_user_id
  )
  returning id into new_id;

  return new_id;
end;
$function$;

-- blog_post_for_public: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.blog_post_for_public(p_slug text, p_locale text)
 RETURNS TABLE(kind text, post_id uuid, slug text, is_indexable boolean, is_featured boolean, published_at timestamp with time zone, updated_at timestamp with time zone, category_slug text, category_name text, cover_object_path text, resolved_locale text, title text, excerpt text, body text, meta_title text, meta_description text, tag_slugs text[], tag_names text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  post public.blog_posts;
  wanted text := coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en');
  moved_to text;
begin
  select b.* into post from public.blog_posts b where b.slug = p_slug;

  if post.id is not null and public.cms_content_is_public(post.status, post.published_at) then
    return query
      select
        'post'::text,
        post.id,
        post.slug,
        post.is_indexable,
        post.is_featured,
        post.published_at,
        post.updated_at,
        c.slug,
        -- Arabic is optional throughout the taxonomy (D6/D7), so a missing Arabic name falls back to the
        -- English one rather than to nothing.
        case when c.id is null then null
             when wanted = 'ar' then coalesce(c.name_ar, c.name_en)
             else c.name_en end,
        m.object_path,
        t.locale_code,
        t.title,
        t.excerpt,
        t.body,
        t.meta_title,
        t.meta_description,
        coalesce(tg.slugs, '{}'::text[]),
        coalesce(tg.names, '{}'::text[])
        from public.blog_post_translations t
        left join public.blog_categories c
          on c.id = post.blog_category_id and c.is_active
        left join public.cms_media m on m.id = post.cover_media_id
        left join lateral (
          select array_agg(bt.slug order by bt.slug) as slugs,
                 array_agg(
                   case when wanted = 'ar' then coalesce(bt.name_ar, bt.name_en) else bt.name_en end
                   order by bt.slug
                 ) as names
            from public.blog_post_tags pt
            join public.blog_tags bt on bt.id = pt.blog_tag_id
           where pt.blog_post_id = post.id
             and bt.is_active
        ) tg on true
       where t.blog_post_id = post.id
         -- The requested locale first, then the default. Ordering by a boolean rather than filtering is what
         -- makes the fallback one index scan instead of two statements.
         and t.locale_code in (wanted, 'en')
       order by (t.locale_code = wanted) desc
       limit 1;
    -- A published post nobody has written yet has no row above, so it falls through to absence below.
    if found then
      return;
    end if;
  end if;

  -- Not a post the public may see. It may still be a slug that moved: 0030 keeps every previous slug and
  -- forbids another post from taking it, so at most one post can own this history row.
  select b.slug into moved_to
    from public.blog_post_slug_history h
    join public.blog_posts b on b.id = h.blog_post_id
   where h.slug = p_slug
     and public.cms_content_is_public(b.status, b.published_at);

  if moved_to is not null then
    return query select 'moved'::text, null::uuid, moved_to, null::boolean, null::boolean,
      null::timestamptz, null::timestamptz, null::text, null::text, null::text, null::text, null::text,
      null::text, null::text, null::text, null::text, null::text[], null::text[];
    return;
  end if;

  return query select 'not_found'::text, null::uuid, null::text, null::boolean, null::boolean,
    null::timestamptz, null::timestamptz, null::text, null::text, null::text, null::text, null::text,
    null::text, null::text, null::text, null::text, null::text[], null::text[];
end;
$function$;

-- blog_post_translation_save_for_staff: 4 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.blog_post_translation_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_post_id uuid, p_locale_code text, p_title text, p_body text, p_excerpt text DEFAULT NULL::text, p_meta_title text DEFAULT NULL::text, p_meta_description text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.blog_posts b where b.id = p_post_id) then
    return false;
  end if;

  -- `meta_title` and `meta_description` are written here and nowhere else. Under 0092's decision B they are
  -- the single source of a post's public head, so an empty one is stored as null and the public reader falls
  -- back to the post's own title rather than serving a blank tag.
  insert into public.blog_post_translations (
    blog_post_id, locale_code, title, excerpt, body, meta_title, meta_description
  )
  values (
    p_post_id,
    p_locale_code,
    btrim(p_title, E' \t\r\n'),
    nullif(btrim(coalesce(p_excerpt, ''), E' \t\r\n'), ''),
    p_body,
    nullif(btrim(coalesce(p_meta_title, ''), E' \t\r\n'), ''),
    nullif(btrim(coalesce(p_meta_description, ''), E' \t\r\n'), '')
  )
  on conflict (blog_post_id, locale_code) do update
     set title = excluded.title,
         excerpt = excluded.excerpt,
         body = excluded.body,
         meta_title = excluded.meta_title,
         meta_description = excluded.meta_description;

  -- The post row did not change, but who last touched its content did, and `updated_at` is what the
  -- authoring list orders by. Without this a translation edit would be invisible in that list.
  update public.blog_posts set updated_by = p_user_id, updated_at = now() where id = p_post_id;
  return true;
end;
$function$;

-- blog_post_update_for_staff: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.blog_post_update_for_staff(p_user_id uuid, p_is_aal2 boolean, p_post_id uuid, p_slug text, p_blog_category_id uuid, p_clear_category boolean, p_cover_media_id uuid, p_clear_cover boolean, p_is_indexable boolean, p_is_featured boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  updated integer;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- The status is deliberately absent from this statement: changing it is the next function, so an edit to a
  -- post's address, category or cover can never publish or archive it by accident.
  --
  -- A null argument leaves a field alone. Clearing a nullable reference needs its own flag, because null
  -- already means "unchanged" — the same shape the category console uses for an optional parent.
  --
  -- Setting `is_featured` on a post that is not published raises 0030's own
  -- `blog_posts_featured_is_published`, which is left to do exactly that rather than being restated here.
  update public.blog_posts b
     set slug = coalesce(nullif(btrim(p_slug, E' \t\r\n'), ''), b.slug),
         blog_category_id = case
           when coalesce(p_clear_category, false) then null
           when p_blog_category_id is null then b.blog_category_id
           else p_blog_category_id end,
         cover_media_id = case
           when coalesce(p_clear_cover, false) then null
           when p_cover_media_id is null then b.cover_media_id
           else p_cover_media_id end,
         is_indexable = coalesce(p_is_indexable, b.is_indexable),
         is_featured = coalesce(p_is_featured, b.is_featured),
         updated_by = p_user_id
   where b.id = p_post_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$function$;

-- blog_posts_for_public: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.blog_posts_for_public(p_locale text, p_category_slug text DEFAULT NULL::text, p_tag_slug text DEFAULT NULL::text, p_limit integer DEFAULT 20, p_cursor_published_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(post_id uuid, slug text, is_featured boolean, published_at timestamp with time zone, updated_at timestamp with time zone, category_slug text, category_name text, cover_object_path text, resolved_locale text, title text, excerpt text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    b.id,
    b.slug,
    b.is_featured,
    b.published_at,
    b.updated_at,
    c.slug,
    case when c.id is null then null
         when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(c.name_ar, c.name_en)
         else c.name_en end,
    m.object_path,
    t.locale_code,
    t.title,
    t.excerpt
    from public.blog_posts b
    join lateral (
      select tr.locale_code, tr.title, tr.excerpt
        from public.blog_post_translations tr
       where tr.blog_post_id = b.id
         and tr.locale_code in (coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en'), 'en')
       order by (tr.locale_code = coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en')) desc
       limit 1
    ) t on true
    left join public.blog_categories c on c.id = b.blog_category_id and c.is_active
    left join public.cms_media m on m.id = b.cover_media_id
   where public.cms_content_is_public(b.status, b.published_at)
     -- Both filters are comparisons against an active row, so a slug that names nothing or names something
     -- deactivated yields an empty page rather than an error.
     and (
       p_category_slug is null
       or exists (
         select 1 from public.blog_categories fc
          where fc.id = b.blog_category_id and fc.is_active and fc.slug = p_category_slug
       )
     )
     and (
       p_tag_slug is null
       or exists (
         select 1
           from public.blog_post_tags pt
           join public.blog_tags ft on ft.id = pt.blog_tag_id
          where pt.blog_post_id = b.id and ft.is_active and ft.slug = p_tag_slug
       )
     )
     and (
       p_cursor_published_at is null
       or p_cursor_id is null
       or (b.published_at, b.id) < (p_cursor_published_at, p_cursor_id)
     )
   order by b.published_at desc, b.id desc
   limit greatest(coalesce(p_limit, 20), 1);
$function$;

-- blog_posts_for_staff: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.blog_posts_for_staff(p_user_id uuid, p_is_aal2 boolean, p_limit integer, p_status text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_category_id uuid DEFAULT NULL::uuid, p_cursor_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(post_id uuid, slug text, status text, blog_category_id uuid, category_slug text, is_indexable boolean, is_featured boolean, scheduled_for timestamp with time zone, published_at timestamp with time zone, archived_at timestamp with time zone, updated_at timestamp with time zone, translated_locales text[], tag_count integer, title text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    b.id,
    b.slug,
    b.status,
    b.blog_category_id,
    c.slug,
    b.is_indexable,
    b.is_featured,
    b.scheduled_for,
    b.published_at,
    b.archived_at,
    b.updated_at,
    coalesce(
      (select array_agg(t.locale_code order by t.locale_code)
         from public.blog_post_translations t where t.blog_post_id = b.id),
      '{}'::text[]
    ),
    (select count(*)::integer from public.blog_post_tags pt where pt.blog_post_id = b.id),
    (select t.title from public.blog_post_translations t
      where t.blog_post_id = b.id order by (t.locale_code = 'en') desc, t.locale_code limit 1)
    from public.blog_posts b
    left join public.blog_categories c on c.id = b.blog_category_id
   where app_private.blog_can_read(p_user_id, p_is_aal2)
     and (p_status is null or b.status = p_status)
     and (p_category_id is null or b.blog_category_id = p_category_id)
     and (
       nullif(btrim(coalesce(p_search, ''), E' \t\r\n'), '') is null
       or exists (
         select 1 from public.blog_post_translations t
          where t.blog_post_id = b.id
            and position(lower(btrim(p_search, E' \t\r\n')) in lower(t.title)) > 0
       )
       or position(lower(btrim(p_search, E' \t\r\n')) in lower(b.slug)) > 0
     )
     and (
       p_cursor_updated_at is null
       or p_cursor_id is null
       or (b.updated_at, b.id) < (p_cursor_updated_at, p_cursor_id)
     )
   order by b.updated_at desc, b.id desc
   limit greatest(coalesce(p_limit, 25), 1);
$function$;

-- blog_tag_save_for_staff: 6 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.blog_tag_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_tag_id uuid, p_slug text, p_name_en text, p_name_ar text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  saved_id uuid;
begin
  if not app_private.blog_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.blog.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_tag_id is null then
    insert into public.blog_tags (slug, name_en, name_ar, is_active)
    values (
      btrim(p_slug, E' \t\r\n'),
      btrim(p_name_en, E' \t\r\n'),
      nullif(btrim(coalesce(p_name_ar, ''), E' \t\r\n'), ''),
      coalesce(p_is_active, true)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  update public.blog_tags g
     set slug = coalesce(nullif(btrim(p_slug, E' \t\r\n'), ''), g.slug),
         name_en = coalesce(nullif(btrim(coalesce(p_name_en, ''), E' \t\r\n'), ''), g.name_en),
         name_ar = case when p_name_ar is null then g.name_ar else nullif(btrim(p_name_ar, E' \t\r\n'), '') end,
         is_active = coalesce(p_is_active, g.is_active)
   where g.id = p_tag_id
  returning g.id into saved_id;

  return saved_id;
end;
$function$;

-- blog_taxonomy_for_public: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.blog_taxonomy_for_public(p_locale text)
 RETURNS TABLE(entry_type text, entry_id uuid, slug text, name text, sort_order integer, post_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    'category'::text,
    c.id,
    c.slug,
    case when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(c.name_ar, c.name_en)
         else c.name_en end,
    c.sort_order,
    (select count(*)
       from public.blog_posts b
      where b.blog_category_id = c.id
        and public.cms_content_is_public(b.status, b.published_at)
        and exists (select 1 from public.blog_post_translations t where t.blog_post_id = b.id))
    from public.blog_categories c
   where c.is_active
  union all
  select
    'tag'::text,
    g.id,
    g.slug,
    case when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(g.name_ar, g.name_en)
         else g.name_en end,
    0,
    (select count(*)
       from public.blog_post_tags pt
       join public.blog_posts b on b.id = pt.blog_post_id
      where pt.blog_tag_id = g.id
        and public.cms_content_is_public(b.status, b.published_at)
        and exists (select 1 from public.blog_post_translations t where t.blog_post_id = b.id))
    from public.blog_tags g
   where g.is_active
   order by 1, 5, 3;
$function$;

-- buyer_address_create: 12 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.buyer_address_create(p_user_id uuid, p_label text, p_purpose text, p_recipient_name text, p_phone_e164 text, p_country_code text, p_governorate text, p_city text, p_district text, p_street_address text, p_building text, p_apartment text, p_postal_code text, p_landmark text, p_is_default_shipping boolean DEFAULT false, p_is_default_billing boolean DEFAULT false)
 RETURNS TABLE(outcome text, id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  new_id uuid;
  wants_shipping boolean := coalesce(p_is_default_shipping, false);
  wants_billing boolean := coalesce(p_is_default_billing, false);
begin
  if p_user_id is null then
    raise exception 'buyer_address_create requires an account' using errcode = '22023';
  end if;
  if not exists (select 1 from public.countries c where c.code = upper(btrim(coalesce(p_country_code, ''), E' \t\r\n'))) then
    return query select 'invalid_country'::text, null::uuid;
    return;
  end if;

  -- At most one default of each kind per account (0005's unique partial indexes).
  if wants_shipping then
    update public.addresses a set is_default_shipping = false
     where a.user_id = p_user_id and a.is_default_shipping;
  end if;
  if wants_billing then
    update public.addresses a set is_default_billing = false
     where a.user_id = p_user_id and a.is_default_billing;
  end if;

  begin
    insert into public.addresses (
      user_id, label, purpose, recipient_name, phone_e164, country_code, governorate, city,
      district, street_address, building, apartment, postal_code, landmark,
      is_default_shipping, is_default_billing
    ) values (
      p_user_id, nullif(btrim(coalesce(p_label, ''), E' \t\r\n'), ''), p_purpose, btrim(p_recipient_name, E' \t\r\n'), p_phone_e164,
      upper(btrim(p_country_code, E' \t\r\n'))::char(2), btrim(p_governorate, E' \t\r\n'), btrim(p_city, E' \t\r\n'),
      nullif(btrim(coalesce(p_district, ''), E' \t\r\n'), ''), btrim(p_street_address, E' \t\r\n'),
      nullif(btrim(coalesce(p_building, ''), E' \t\r\n'), ''), nullif(btrim(coalesce(p_apartment, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_postal_code, ''), E' \t\r\n'), ''), nullif(btrim(coalesce(p_landmark, ''), E' \t\r\n'), ''),
      wants_shipping, wants_billing
    )
    returning addresses.id into new_id;
  exception
    when restrict_violation then
      -- D17: an address used for shipping must sit in a marketplace-enabled country.
      return query select 'country_not_enabled'::text, null::uuid;
      return;
  end;

  return query select 'created'::text, new_id;
end;
$function$;

-- buyer_address_update: 12 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.buyer_address_update(p_user_id uuid, p_id uuid, p_label text, p_purpose text, p_recipient_name text, p_phone_e164 text, p_country_code text, p_governorate text, p_city text, p_district text, p_street_address text, p_building text, p_apartment text, p_postal_code text, p_landmark text, p_is_default_shipping boolean DEFAULT false, p_is_default_billing boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  updated integer;
  wants_shipping boolean := coalesce(p_is_default_shipping, false);
  wants_billing boolean := coalesce(p_is_default_billing, false);
begin
  if p_user_id is null or p_id is null then
    raise exception 'buyer_address_update requires an account and an address' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.addresses a where a.id = p_id and a.user_id = p_user_id and a.deleted_at is null
  ) then
    return 'not_found';
  end if;
  if not exists (select 1 from public.countries c where c.code = upper(btrim(coalesce(p_country_code, ''), E' \t\r\n'))) then
    return 'invalid_country';
  end if;

  if wants_shipping then
    update public.addresses a set is_default_shipping = false
     where a.user_id = p_user_id and a.is_default_shipping and a.id <> p_id;
  end if;
  if wants_billing then
    update public.addresses a set is_default_billing = false
     where a.user_id = p_user_id and a.is_default_billing and a.id <> p_id;
  end if;

  begin
    update public.addresses a
       set label = nullif(btrim(coalesce(p_label, ''), E' \t\r\n'), ''),
           purpose = p_purpose,
           recipient_name = btrim(p_recipient_name, E' \t\r\n'),
           phone_e164 = p_phone_e164,
           country_code = upper(btrim(p_country_code, E' \t\r\n'))::char(2),
           governorate = btrim(p_governorate, E' \t\r\n'),
           city = btrim(p_city, E' \t\r\n'),
           district = nullif(btrim(coalesce(p_district, ''), E' \t\r\n'), ''),
           street_address = btrim(p_street_address, E' \t\r\n'),
           building = nullif(btrim(coalesce(p_building, ''), E' \t\r\n'), ''),
           apartment = nullif(btrim(coalesce(p_apartment, ''), E' \t\r\n'), ''),
           postal_code = nullif(btrim(coalesce(p_postal_code, ''), E' \t\r\n'), ''),
           landmark = nullif(btrim(coalesce(p_landmark, ''), E' \t\r\n'), ''),
           is_default_shipping = wants_shipping,
           is_default_billing = wants_billing
     where a.id = p_id and a.user_id = p_user_id and a.deleted_at is null;
    get diagnostics updated = row_count;
  exception
    when restrict_violation then
      return 'country_not_enabled';
  end;

  return case when updated = 1 then 'updated' else 'not_found' end;
end;
$function$;

-- buyer_profile_update: 4 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.buyer_profile_update(p_user_id uuid, p_display_name text, p_full_name text, p_locale_code text, p_timezone text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  updated integer;
  locale text := nullif(btrim(coalesce(p_locale_code, ''), E' \t\r\n'), '');
  zone text := nullif(btrim(coalesce(p_timezone, ''), E' \t\r\n'), '');
begin
  if p_user_id is null then
    raise exception 'buyer_profile_update requires an account' using errcode = '22023';
  end if;
  if locale is not null and not exists (select 1 from public.locales l where l.code = locale) then
    return 'invalid_locale';
  end if;
  if zone is not null and not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = zone) then
    return 'invalid_timezone';
  end if;

  update public.profiles p
     set display_name = nullif(btrim(coalesce(p_display_name, ''), E' \t\r\n'), ''),
         full_name = nullif(btrim(coalesce(p_full_name, ''), E' \t\r\n'), ''),
         locale_code = locale,
         timezone = coalesce(zone, p.timezone)
   where p.id = p_user_id
     and p.deleted_at is null;
  get diagnostics updated = row_count;
  return case when updated = 1 then 'updated' else 'not_found' end;
end;
$function$;

-- buyer_saved_search_create: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.buyer_saved_search_create(p_user_id uuid, p_name text, p_query jsonb, p_notify boolean DEFAULT false)
 RETURNS TABLE(outcome text, id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  new_id uuid;
begin
  if p_user_id is null then
    raise exception 'buyer_saved_search_create requires an account' using errcode = '22023';
  end if;

  begin
    insert into public.saved_searches (user_id, name, query, notify)
    values (p_user_id, btrim(p_name, E' \t\r\n'), p_query, coalesce(p_notify, false))
    returning saved_searches.id into new_id;
  exception
    when unique_violation then
      return query select 'duplicate_name'::text, null::uuid;
      return;
  end;

  return query select 'created'::text, new_id;
end;
$function$;

-- buyer_saved_search_update: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.buyer_saved_search_update(p_user_id uuid, p_id uuid, p_name text, p_query jsonb, p_notify boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  updated integer;
begin
  if p_user_id is null or p_id is null then
    raise exception 'buyer_saved_search_update requires an account and a saved search' using errcode = '22023';
  end if;

  begin
    update public.saved_searches s
       set name = btrim(p_name, E' \t\r\n'),
           query = p_query,
           notify = coalesce(p_notify, false)
     where s.id = p_id and s.user_id = p_user_id;
    get diagnostics updated = row_count;
  exception
    when unique_violation then
      return 'duplicate_name';
  end;

  return case when updated = 1 then 'updated' else 'not_found' end;
end;
$function$;

-- buyer_settings_update: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.buyer_settings_update(p_user_id uuid, p_notify_email boolean, p_notify_sms boolean, p_notify_whatsapp boolean, p_notify_in_app boolean, p_marketing_opt_in boolean, p_digit_style text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  style text := nullif(btrim(coalesce(p_digit_style, ''), E' \t\r\n'), '');
begin
  if p_user_id is null then
    raise exception 'buyer_settings_update requires an account' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return false;
  end if;

  insert into public.user_settings (
    user_id, notify_email, notify_sms, notify_whatsapp, notify_in_app, marketing_opt_in, digit_style
  ) values (
    p_user_id, coalesce(p_notify_email, true), coalesce(p_notify_sms, false),
    coalesce(p_notify_whatsapp, false), coalesce(p_notify_in_app, true),
    coalesce(p_marketing_opt_in, false), style
  )
  on conflict (user_id) do update
     set notify_email = excluded.notify_email,
         notify_sms = excluded.notify_sms,
         notify_whatsapp = excluded.notify_whatsapp,
         notify_in_app = excluded.notify_in_app,
         marketing_opt_in = excluded.marketing_opt_in,
         digit_style = excluded.digit_style;
  return true;
end;
$function$;

-- category_create_for_staff: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.category_create_for_staff(p_user_id uuid, p_is_aal2 boolean, p_slug text, p_parent_id uuid DEFAULT NULL::uuid, p_listing_type_code text DEFAULT NULL::text, p_sort_order integer DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  new_id uuid;
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'category management requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.categories (parent_id, slug, listing_type_code, is_active, sort_order)
  values (p_parent_id, p_slug, nullif(btrim(coalesce(p_listing_type_code, ''), E' \t\r\n'), ''), false,
          coalesce(p_sort_order, 0))
  returning id into new_id;

  return new_id;
end;
$function$;

-- category_translation_save_for_staff: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.category_translation_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_category_id uuid, p_locale_code text, p_name text, p_description text DEFAULT NULL::text, p_meta_title text DEFAULT NULL::text, p_meta_description text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  changed integer;
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'category management requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.categories c where c.id = p_category_id) then
    return false;
  end if;

  insert into public.category_translations
    (category_id, locale_code, name, description, meta_title, meta_description)
  values (
    p_category_id,
    p_locale_code,
    p_name,
    nullif(btrim(coalesce(p_description, ''), E' \t\r\n'), ''),
    nullif(btrim(coalesce(p_meta_title, ''), E' \t\r\n'), ''),
    nullif(btrim(coalesce(p_meta_description, ''), E' \t\r\n'), '')
  )
  on conflict (category_id, locale_code) do update
     set name = excluded.name,
         description = excluded.description,
         meta_title = excluded.meta_title,
         meta_description = excluded.meta_description;

  get diagnostics changed = row_count;
  update public.categories c set updated_at = now() where c.id = p_category_id;
  return changed > 0;
end;
$function$;

-- category_update_for_staff: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.category_update_for_staff(p_user_id uuid, p_is_aal2 boolean, p_category_id uuid, p_set_parent boolean, p_parent_id uuid, p_listing_type_code text, p_sort_order integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  changed integer;
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'category management requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  update public.categories c
     set parent_id = case when p_set_parent then p_parent_id else c.parent_id end,
         listing_type_code = nullif(btrim(coalesce(p_listing_type_code, ''), E' \t\r\n'), ''),
         sort_order = coalesce(p_sort_order, c.sort_order)
   where c.id = p_category_id;

  get diagnostics changed = row_count;
  return changed > 0;
end;
$function$;

-- cms_media_alt_text_for_staff: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.cms_media_alt_text_for_staff(p_user_id uuid, p_is_aal2 boolean, p_media_id uuid, p_alt_text_en text DEFAULT NULL::text, p_alt_text_ar text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  updated integer;
begin
  if not app_private.cms_media_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.media.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Both are replaced on every call, so clearing one is sending it blank (owner decision 7); neither is required.
  update public.cms_media m
     set alt_text_en = nullif(btrim(coalesce(p_alt_text_en, ''), E' \t\r\n'), ''),
         alt_text_ar = nullif(btrim(coalesce(p_alt_text_ar, ''), E' \t\r\n'), '')
   where m.id = p_media_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$function$;

-- cms_media_attach: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.cms_media_attach(p_user_id uuid, p_is_aal2 boolean, p_object_path text, p_mime_type text, p_byte_size bigint, p_width integer DEFAULT NULL::integer, p_height integer DEFAULT NULL::integer, p_alt_text_en text DEFAULT NULL::text, p_alt_text_ar text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, media_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_bucket text := 'cms-media';
  v_limit bigint;
  v_allowed text[];
  v_extension text;
  v_tail text;
  v_new_id uuid;
begin
  if not app_private.cms_media_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if p_mime_type is null or not (p_mime_type = any (v_allowed)) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  v_extension := app_private.cms_media_extension_for(p_mime_type);
  if v_extension is null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- The prefix is the bucket's own name and nothing else. A path for another bucket, or with anything before the
  -- prefix, cannot match it.
  if p_object_path is null or left(p_object_path, length(v_bucket) + 1) <> v_bucket || '/' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- And the remainder must be one plain file name of the shape the authorizer issues: a uuid and the extension the
  -- declared type implies. No slash, so nothing can be nested below the bucket; no dot-segment, so `..` is
  -- unrepresentable; no control character, no backslash, no encoded separator. The extension is compared against
  -- the one derived from `p_mime_type`, so a PNG cannot be recorded under a `.jpg` name or the other way round.
  v_tail := substr(p_object_path, length(v_bucket) + 2);
  if v_tail <> '' and v_tail !~ ('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.'
                                 || v_extension || '$') then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if v_tail = '' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- 0030's unique index makes a second row for one object impossible; reported as an outcome rather than raised.
  if exists (select 1 from public.cms_media m where m.object_path = p_object_path) then
    return query select 'taken'::text, null::uuid;
    return;
  end if;

  -- Every remaining rule is 0030's: the dimensions must be positive or absent, the alt texts at most 300
  -- characters, and the MIME type one of its own allowed list. A blank alt text is stored as absent rather than as
  -- an empty string, so no surface could ever carry an empty `alt`.
  insert into public.cms_media (
    object_path, mime_type, width, height, byte_size, alt_text_en, alt_text_ar, uploaded_by
  )
  values (
    p_object_path,
    p_mime_type,
    p_width,
    p_height,
    p_byte_size,
    nullif(btrim(coalesce(p_alt_text_en, ''), E' \t\r\n'), ''),
    nullif(btrim(coalesce(p_alt_text_ar, ''), E' \t\r\n'), ''),
    p_user_id
  )
  returning id into v_new_id;

  return query select 'attached'::text, v_new_id;
end;
$function$;

-- cms_page_create_for_staff: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.cms_page_create_for_staff(p_user_id uuid, p_is_aal2 boolean, p_slug text, p_page_key text DEFAULT NULL::text, p_template text DEFAULT 'standard'::text, p_sort_order integer DEFAULT 0, p_is_indexable boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  new_id uuid;
begin
  if not app_private.cms_page_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.page.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- A page is always born a draft. 0030's lifecycle allows draft->published, so publishing is the separate
  -- call below and never a side effect of creation: a page cannot go live before anybody has written it.
  insert into public.pages (slug, page_key, template, sort_order, is_indexable, created_by, updated_by)
  values (
    btrim(p_slug, E' \t\r\n'),
    nullif(btrim(coalesce(p_page_key, ''), E' \t\r\n'), ''),
    coalesce(p_template, 'standard'),
    coalesce(p_sort_order, 0),
    coalesce(p_is_indexable, true),
    p_user_id,
    p_user_id
  )
  returning id into new_id;

  return new_id;
end;
$function$;

-- cms_page_for_public: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.cms_page_for_public(p_slug text, p_locale text)
 RETURNS TABLE(kind text, page_id uuid, slug text, page_key text, template text, is_indexable boolean, published_at timestamp with time zone, updated_at timestamp with time zone, resolved_locale text, title text, excerpt text, body text, meta_title text, meta_description text, cover_object_path text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  page public.pages;
  wanted text := coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en');
  moved_to text;
begin
  select p.* into page from public.pages p where p.slug = p_slug;

  if page.id is not null and public.cms_content_is_public(page.status, page.published_at) then
    return query
      select
        'page'::text,
        page.id,
        page.slug,
        page.page_key,
        page.template,
        page.is_indexable,
        page.published_at,
        page.updated_at,
        t.locale_code,
        t.title,
        t.excerpt,
        t.body,
        t.meta_title,
        t.meta_description,
        m.object_path
        from public.page_translations t
        left join public.cms_media m on m.id = page.cover_media_id
       where t.page_id = page.id
         -- The requested locale first, then the default. Ordering by a boolean rather than filtering is
         -- what makes the fallback one index scan instead of two statements.
         and t.locale_code in (wanted, 'en')
       order by (t.locale_code = wanted) desc
       limit 1;
    -- A published page nobody has written yet has no row above, so the loop below reports absence.
    if found then
      return;
    end if;
  end if;

  -- Not a page the public may see. It may still be a slug that moved: 0030 keeps every previous slug and
  -- forbids another page from taking it, so at most one page can own this history row.
  select p.slug into moved_to
    from public.page_slug_history h
    join public.pages p on p.id = h.page_id
   where h.slug = p_slug
     and public.cms_content_is_public(p.status, p.published_at);

  if moved_to is not null then
    return query select 'moved'::text, null::uuid, moved_to, null::text, null::text, null::boolean,
      null::timestamptz, null::timestamptz, null::text, null::text, null::text, null::text, null::text,
      null::text, null::text;
    return;
  end if;

  return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::boolean,
    null::timestamptz, null::timestamptz, null::text, null::text, null::text, null::text, null::text,
    null::text, null::text;
end;
$function$;

-- cms_page_translation_save_for_staff: 4 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.cms_page_translation_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_page_id uuid, p_locale_code text, p_title text, p_body text, p_excerpt text DEFAULT NULL::text, p_meta_title text DEFAULT NULL::text, p_meta_description text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
begin
  if not app_private.cms_page_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.page.manage is required' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.pages p where p.id = p_page_id) then
    return false;
  end if;

  insert into public.page_translations (
    page_id, locale_code, title, excerpt, body, meta_title, meta_description
  )
  values (
    p_page_id,
    p_locale_code,
    btrim(p_title, E' \t\r\n'),
    nullif(btrim(coalesce(p_excerpt, ''), E' \t\r\n'), ''),
    p_body,
    nullif(btrim(coalesce(p_meta_title, ''), E' \t\r\n'), ''),
    nullif(btrim(coalesce(p_meta_description, ''), E' \t\r\n'), '')
  )
  on conflict (page_id, locale_code) do update
     set title = excluded.title,
         excerpt = excluded.excerpt,
         body = excluded.body,
         meta_title = excluded.meta_title,
         meta_description = excluded.meta_description;

  -- The page itself did not change, but who last touched its content did, and `updated_at` is what the
  -- authoring list orders by. Without this a translation edit would be invisible in that list.
  update public.pages set updated_by = p_user_id, updated_at = now() where id = p_page_id;
  return true;
end;
$function$;

-- cms_page_update_for_staff: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.cms_page_update_for_staff(p_user_id uuid, p_is_aal2 boolean, p_page_id uuid, p_slug text, p_page_key text, p_template text, p_sort_order integer, p_is_indexable boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  updated integer;
begin
  if not app_private.cms_page_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.page.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- The status is deliberately absent from this statement: changing it is the next function, so an edit to
  -- a page's address or template can never publish or archive it by accident.
  update public.pages p
     set slug = coalesce(nullif(btrim(p_slug, E' \t\r\n'), ''), p.slug),
         page_key = case when p_page_key is null then p.page_key else nullif(btrim(p_page_key, E' \t\r\n'), '') end,
         template = coalesce(p_template, p.template),
         sort_order = coalesce(p_sort_order, p.sort_order),
         is_indexable = coalesce(p_is_indexable, p.is_indexable),
         updated_by = p_user_id
   where p.id = p_page_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$function$;

-- cms_pages_for_public: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.cms_pages_for_public(p_locale text)
 RETURNS TABLE(page_id uuid, slug text, page_key text, template text, is_indexable boolean, sort_order integer, published_at timestamp with time zone, updated_at timestamp with time zone, resolved_locale text, title text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    p.id,
    p.slug,
    p.page_key,
    p.template,
    p.is_indexable,
    p.sort_order,
    p.published_at,
    p.updated_at,
    t.locale_code,
    t.title
    from public.pages p
    join lateral (
      select tr.locale_code, tr.title
        from public.page_translations tr
       where tr.page_id = p.id
         and tr.locale_code in (coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en'), 'en')
       order by (tr.locale_code = coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en')) desc
       limit 1
    ) t on true
   where public.cms_content_is_public(p.status, p.published_at)
   order by p.sort_order, p.slug;
$function$;

-- consume_step_up_grant: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.consume_step_up_grant(p_grant_id uuid, p_user_id uuid, p_operation text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  consumed integer;
begin
  if p_grant_id is null or p_user_id is null then
    raise exception 'grant id and user id are required' using errcode = '22023';
  end if;
  if p_operation is null or btrim(p_operation, E' \t\r\n') = '' then
    raise exception 'operation is required' using errcode = '22023';
  end if;

  -- Grant exists, belongs to this user, covers this operation, has not expired and has not been used.
  -- All five in the predicate, so the decision and the write cannot be separated.
  update public.step_up_grants
     set consumed_at = now()
   where id = p_grant_id
     and user_id = p_user_id
     and operation = p_operation
     and consumed_at is null
     and expires_at > now();

  get diagnostics consumed = row_count;

  -- A plain boolean. Distinguishing "wrong user" from "expired" from "already used" would tell a caller
  -- things about grants that are not theirs; the authorisation answer is the only thing they need.
  return consumed = 1;
end;
$function$;

-- decide_recovery_request: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.decide_recovery_request(p_request_id uuid, p_approver_user_id uuid, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  request public.account_recovery_requests;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'a recovery decision is approved or rejected, not %', p_decision
      using errcode = 'invalid_parameter_value';
  end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_note, ''), E' \t\r\n')) = 0 then
    raise exception 'a rejection is always recorded with its reason' using errcode = 'check_violation';
  end if;

  select * into request from public.account_recovery_requests r where r.id = p_request_id for update;
  if request.id is null then
    raise exception 'recovery request % does not exist', p_request_id using errcode = 'no_data_found';
  end if;
  if request.status <> 'under_review' then
    raise exception 'recovery request % must be reviewed before it is decided', p_request_id
      using errcode = 'restrict_violation';
  end if;
  -- The rule the specification states twice: the reviewer can never approve their own review.
  if p_approver_user_id = request.reviewer_user_id then
    raise exception 'the approver must be somebody other than the reviewer' using errcode = 'insufficient_privilege';
  end if;
  if request.user_id is not null and p_approver_user_id = request.user_id then
    raise exception 'nobody approves their own recovery' using errcode = 'insufficient_privilege';
  end if;

  insert into public.account_recovery_approvals (account_recovery_request_id, approver_user_id, decision, note)
  values (p_request_id, p_approver_user_id, p_decision, p_note);

  update public.account_recovery_requests
     set status = case when p_decision = 'approved' then 'contact_verification' else 'rejected' end,
         approver_user_id = case when p_decision = 'approved' then p_approver_user_id else approver_user_id end,
         approved_at = case when p_decision = 'approved' then now() else approved_at end,
         rejection_reason = case when p_decision = 'rejected' then p_note else rejection_reason end,
         closed_at = case when p_decision = 'rejected' then now() else closed_at end
   where id = p_request_id;

  perform public.enqueue_outbox_event(
    'account_recovery', p_request_id::text, format('account_recovery.%s', p_decision),
    jsonb_build_object('account_recovery_request_id', p_request_id)
  );
  return p_decision;
end;
$function$;

-- faq_save_for_staff: 10 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.faq_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_faq_id uuid, p_topic text DEFAULT NULL::text, p_question_en text DEFAULT NULL::text, p_question_ar text DEFAULT NULL::text, p_answer_en text DEFAULT NULL::text, p_answer_ar text DEFAULT NULL::text, p_sort_order integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  saved_id uuid;
begin
  if not app_private.faq_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.faq.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_faq_id is null then
    -- `is_published` is absent on purpose (owner decision 6): 0030 defaults a new entry to unpublished, and
    -- publishing is the separate call below. `topic` is absent from the column list when none was given, so
    -- 0030's own `'general'` default stands rather than this writer inventing a different one.
    insert into public.faqs (topic, question_en, question_ar, answer_en, answer_ar, sort_order)
    values (
      coalesce(nullif(btrim(coalesce(p_topic, ''), E' \t\r\n'), ''), 'general'),
      btrim(coalesce(p_question_en, ''), E' \t\r\n'),
      nullif(btrim(coalesce(p_question_ar, ''), E' \t\r\n'), ''),
      btrim(coalesce(p_answer_en, ''), E' \t\r\n'),
      nullif(btrim(coalesce(p_answer_ar, ''), E' \t\r\n'), ''),
      coalesce(p_sort_order, 0)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  -- `is_published` is absent from this statement too, for the same reason: editing an answer can never put it in
  -- front of the public.
  update public.faqs f
     set topic = coalesce(nullif(btrim(coalesce(p_topic, ''), E' \t\r\n'), ''), f.topic),
         question_en = coalesce(nullif(btrim(coalesce(p_question_en, ''), E' \t\r\n'), ''), f.question_en),
         question_ar = case when p_question_ar is null then f.question_ar
                            else nullif(btrim(p_question_ar, E' \t\r\n'), '') end,
         answer_en = coalesce(nullif(btrim(coalesce(p_answer_en, ''), E' \t\r\n'), ''), f.answer_en),
         answer_ar = case when p_answer_ar is null then f.answer_ar else nullif(btrim(p_answer_ar, E' \t\r\n'), '') end,
         sort_order = coalesce(p_sort_order, f.sort_order)
   where f.id = p_faq_id
  returning f.id into saved_id;

  return saved_id;
end;
$function$;

-- homepage_section_save_for_staff: 10 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.homepage_section_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_section_id uuid, p_section_key text, p_section_type text, p_title_en text DEFAULT NULL::text, p_title_ar text DEFAULT NULL::text, p_subtitle_en text DEFAULT NULL::text, p_subtitle_ar text DEFAULT NULL::text, p_config jsonb DEFAULT NULL::jsonb, p_sort_order integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  saved_id uuid;
begin
  if not app_private.homepage_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.homepage.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_section_id is null then
    -- A section is always born inactive. 0030's column default says so, and it means a half-configured section
    -- can never appear on the homepage before somebody has looked at it.
    insert into public.homepage_sections (
      section_key, section_type, title_en, title_ar, subtitle_en, subtitle_ar, config, sort_order
    )
    values (
      btrim(p_section_key, E' \t\r\n'),
      p_section_type,
      nullif(btrim(coalesce(p_title_en, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_title_ar, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_subtitle_en, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_subtitle_ar, ''), E' \t\r\n'), ''),
      coalesce(p_config, '{}'::jsonb),
      coalesce(p_sort_order, 0)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  -- The type is deliberately changeable only to another legal one, which 0030's constraint enforces; and
  -- `is_active` is absent from this statement, because activating a section is its own call below. An edit to a
  -- section's text can never put it in front of the public.
  update public.homepage_sections s
     set section_key = coalesce(nullif(btrim(p_section_key, E' \t\r\n'), ''), s.section_key),
         section_type = coalesce(p_section_type, s.section_type),
         title_en = case when p_title_en is null then s.title_en else nullif(btrim(p_title_en, E' \t\r\n'), '') end,
         title_ar = case when p_title_ar is null then s.title_ar else nullif(btrim(p_title_ar, E' \t\r\n'), '') end,
         subtitle_en = case when p_subtitle_en is null then s.subtitle_en
                            else nullif(btrim(p_subtitle_en, E' \t\r\n'), '') end,
         subtitle_ar = case when p_subtitle_ar is null then s.subtitle_ar
                            else nullif(btrim(p_subtitle_ar, E' \t\r\n'), '') end,
         config = coalesce(p_config, s.config),
         sort_order = coalesce(p_sort_order, s.sort_order)
   where s.id = p_section_id
  returning s.id into saved_id;

  return saved_id;
end;
$function$;

-- issue_step_up_grant: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.issue_step_up_grant(p_challenge_id uuid, p_code_hash bytea, p_operation text)
 RETURNS TABLE(outcome text, grant_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  -- Owner decision C-16.
  c_validity constant interval := interval '10 minutes';
  v_verdict text;
  v_challenge app_private.otp_challenges%rowtype;
  v_via text;
  v_grant_id uuid;
  v_expires timestamptz;
begin
  if p_code_hash is null then
    raise exception 'code hash is required' using errcode = '22023';
  end if;
  if p_operation is null or btrim(p_operation, E' \t\r\n') = '' then
    raise exception 'operation is required' using errcode = '22023';
  end if;

  -- The only door. Anything other than 'verified' — invalid, expired, consumed, too_many_attempts or
  -- not_found — returns here and issues nothing.
  v_verdict := app_private.verify_otp_challenge(p_challenge_id, p_code_hash);
  if v_verdict <> 'verified' then
    return query select v_verdict, null::uuid, null::timestamptz;
    return;
  end if;

  select * into v_challenge from app_private.otp_challenges c where c.id = p_challenge_id;

  -- A grant names a user; `step_up_grants.user_id` is not null. A challenge sent to an address that
  -- matched no account cannot authorise anything, and the consumed challenge is not given back.
  if v_challenge.user_id is null then
    return query select 'no_user'::text, null::uuid, null::timestamptz;
    return;
  end if;

  v_via := case v_challenge.channel
             when 'whatsapp' then 'otp_whatsapp'
             when 'email' then 'otp_email'
             when 'sms' then 'otp_sms'
           end;
  if v_via is null then
    raise exception 'unknown OTP channel %', v_challenge.channel using errcode = '22023';
  end if;

  v_expires := now() + c_validity;

  insert into public.step_up_grants (user_id, operation, granted_via, challenge_id, expires_at)
  values (v_challenge.user_id, p_operation, v_via, p_challenge_id, v_expires)
  returning id into v_grant_id;

  return query select 'granted'::text, v_grant_id, v_expires;
end;
$function$;

-- issue_totp_step_up_grant: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.issue_totp_step_up_grant(p_user_id uuid, p_operation text)
 RETURNS TABLE(outcome text, grant_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  -- Owner decision C-16, fixed here for the same reason 0036 fixes it: the duration of an
  -- authorisation is a security fact, and a caller must not be able to influence it.
  c_validity constant interval := interval '10 minutes';
  v_grant_id uuid;
  v_expires timestamptz;
begin
  if p_operation is null or btrim(p_operation, E' \t\r\n') = '' then
    return query select 'invalid_operation'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- `step_up_grants.user_id` is not null and references `auth.users`; an unknown account is reported
  -- rather than left to the foreign key, so the caller gets an outcome instead of an error.
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    return query select 'no_user'::text, null::uuid, null::timestamptz;
    return;
  end if;

  v_expires := now() + c_validity;

  -- 'totp' is a literal and `challenge_id` is null: the first because no caller may name its own proof,
  -- the second because there is no challenge row to name. The 0036 partial unique index is defined on
  -- `challenge_id is not null`, so several TOTP grants coexist without colliding.
  insert into public.step_up_grants (user_id, operation, granted_via, challenge_id, expires_at)
  values (p_user_id, p_operation, 'totp', null, v_expires)
  returning id into v_grant_id;

  return query select 'granted'::text, v_grant_id, v_expires;
end;
$function$;

-- messaging_send_message: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.messaging_send_message(p_user_id uuid, p_conversation_id uuid, p_body text)
 RETURNS TABLE(outcome text, message_id uuid, seq bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_closed timestamptz;
  v_body text := btrim(coalesce(p_body, ''), E' \t\r\n');
  v_id uuid;
  v_seq bigint;
begin
  -- Not an active participant is the same answer a conversation that does not exist gets.
  if not exists (
    select 1 from public.conversation_participants p
     where p.conversation_id = p_conversation_id
       and p.user_id = p_user_id
       and p.left_at is null
  ) then
    return query select 'not_found'::text, null::uuid, null::bigint;
    return;
  end if;

  select c.closed_at into v_closed from public.conversations c where c.id = p_conversation_id;
  if v_closed is not null then
    return query select 'closed'::text, null::uuid, null::bigint;
    return;
  end if;

  -- The same 1..5000 window `messages_text_has_body` enforces, applied first so the caller gets an
  -- outcome rather than a constraint violation. The constraint remains what makes it true.
  if length(v_body) < 1 or length(v_body) > 5000 then
    return query select 'invalid_body'::text, null::uuid, null::bigint;
    return;
  end if;

  begin
    insert into public.messages (conversation_id, sender_user_id, message_type, body)
    values (p_conversation_id, p_user_id, 'text', v_body)
    returning id, messages.seq into v_id, v_seq;
  exception when insufficient_privilege then
    -- 0014's block trigger raised. It is the authority on this; the insert is rolled back with the block.
    return query select 'blocked'::text, null::uuid, null::bigint;
    return;
  end;

  -- Phase 5-G. In this transaction, after the message exists, and not inside the block above: a
  -- notification that cannot be written takes the message with it rather than being reported as a
  -- different outcome. Zero eligible recipients is not a failure — it simply creates nothing.
  perform app_private.messaging_notify_message(p_conversation_id, p_user_id, v_id);

  return query select 'sent'::text, v_id, v_seq;
end;
$function$;

-- moderate_listing: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.moderate_listing(p_listing_id uuid, p_action text, p_moderator_user_id uuid, p_reason text, p_report_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  listing public.listings;
  target_status text;
  action_id uuid;
begin
  if p_action not in ('approve', 'reject', 'suspend', 'reinstate', 'request_changes') then
    raise exception 'unknown listing moderation action %', p_action using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_reason, ''), E' \t\r\n')) = 0 then
    raise exception 'a moderation decision is always recorded with its reason' using errcode = 'check_violation';
  end if;

  select * into listing from public.listings l where l.id = p_listing_id for update;
  if listing.id is null then
    raise exception 'listing % does not exist', p_listing_id using errcode = 'no_data_found';
  end if;
  if listing.seller_user_id = p_moderator_user_id then
    raise exception 'nobody moderates their own listing' using errcode = 'insufficient_privilege';
  end if;

  target_status := case p_action
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'suspend' then 'suspended'
    when 'reinstate' then 'active'
    else listing.status -- request_changes leaves the listing where it is and asks the seller to act
  end;

  if target_status <> listing.status then
    update public.listings
       set status = target_status,
           approved_at = case when target_status = 'approved' then coalesce(approved_at, now()) else approved_at end
     where id = p_listing_id;
  end if;

  action_id := app_private.record_moderation_action(
    'listing', p_listing_id,
    case p_action
      when 'approve' then 'none'
      when 'reject' then 'remove'
      when 'suspend' then 'suspend'
      when 'reinstate' then 'reinstate'
      else 'warn'
    end,
    p_moderator_user_id, p_reason, p_report_id
  );

  insert into public.listing_moderation_actions (
    listing_id, moderation_action_id, report_id, action, from_status, to_status, reason, moderator_user_id
  )
  values (
    p_listing_id, action_id, p_report_id, p_action, listing.status, target_status, p_reason,
    p_moderator_user_id
  );

  return target_status;
end;
$function$;

-- moderate_review: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.moderate_review(p_review_id uuid, p_status text, p_moderator_user_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  review public.reviews;
begin
  if p_status not in ('published', 'pending_moderation', 'hidden', 'removed') then
    raise exception 'unknown review status %', p_status using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_reason, ''), E' \t\r\n')) = 0 then
    raise exception 'a moderation decision is always recorded with its reason' using errcode = 'check_violation';
  end if;

  select * into review from public.reviews r where r.id = p_review_id for update;
  if review.id is null then
    raise exception 'review % does not exist', p_review_id using errcode = 'no_data_found';
  end if;
  if review.buyer_user_id = p_moderator_user_id or review.seller_user_id = p_moderator_user_id then
    raise exception 'nobody moderates a review they are a party to' using errcode = 'insufficient_privilege';
  end if;

  update public.reviews
     set status = p_status,
         moderation_reason = p_reason,
         moderated_at = now(),
         moderated_by = p_moderator_user_id,
         auto_hidden_reason = null,
         published_at = case when p_status = 'published' then now() else published_at end
   where id = p_review_id;

  perform public.enqueue_outbox_event(
    'review', p_review_id::text, 'review.moderated',
    jsonb_build_object('review_id', p_review_id, 'status', p_status)
  );
  return p_status;
end;
$function$;

-- moderation_listing_moderate_for_staff: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.moderation_listing_moderate_for_staff(p_user_id uuid, p_is_aal2 boolean, p_listing_id uuid, p_action text, p_reason text, p_report_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_status text;
  v_constraint text;
begin
  if p_user_id is null or p_listing_id is null
     or not app_private.moderation_can_moderate_listings(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- 0027's own five, and no sixth.
  if p_action is null
     or p_action not in ('approve', 'reject', 'suspend', 'reinstate', 'request_changes') then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  -- The writer requires a reason and `moderation_actions_reason_length` bounds it at 500. Both answered
  -- here so neither becomes a database error.
  if p_reason is null or btrim(p_reason, E' \t\r\n') = '' or length(btrim(p_reason, E' \t\r\n')) > 500 then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  begin
    v_status := app_private.moderate_listing(p_listing_id, p_action, p_user_id, btrim(p_reason, E' \t\r\n'), p_report_id);

    -- 0048's rule, asked at the one moment it can still be answered. Its own trigger is deferred to
    -- COMMIT, which is too late for this wrapper to report anything, so the predicate it is built on is
    -- evaluated here instead — inside this block, so raising rolls the writer's work back with it. The
    -- rule itself is 0048's and is not restated.
    if not app_private.live_listing_price_is_valid(p_listing_id) then
      raise exception 'the live-price rule refuses this listing' using errcode = 'MO001';
    end if;
  exception
    when sqlstate 'MO001' then
      return query select 'not_applicable'::text, null::text;
      return;
    when no_data_found then
      return query select 'not_found'::text, null::text;
      return;
    when insufficient_privilege then
      return query select 'own_listing'::text, null::text;
      return;
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'listing_moderation_actions_status_moved' then
        -- The listing is already where this action would put it. Two colleagues pressing the same button
        -- reach here, as does one pressing it twice.
        return query select 'no_change'::text, null::text;
      elsif v_constraint = 'listings_approved_has_time' then
        return query select 'not_applicable'::text, null::text;
      else
        return query select 'invalid'::text, null::text;
      end if;
      return;
    when invalid_parameter_value or foreign_key_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  return query select 'moderated'::text, v_status;
end;
$function$;

-- navigation_item_save_for_staff: 6 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.navigation_item_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_item_id uuid, p_menu_id uuid, p_label_en text DEFAULT NULL::text, p_label_ar text DEFAULT NULL::text, p_target_kind text DEFAULT NULL::text, p_page_id uuid DEFAULT NULL::uuid, p_blog_post_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_path text DEFAULT NULL::text, p_parent_id uuid DEFAULT NULL::uuid, p_opens_in_new_tab boolean DEFAULT NULL::boolean, p_sort_order integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  saved_id uuid;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_item_id is null then
    insert into public.navigation_items (
      menu_id, parent_id, label_en, label_ar, target_kind,
      page_id, blog_post_id, category_id, path, opens_in_new_tab, sort_order
    )
    values (
      p_menu_id,
      p_parent_id,
      btrim(coalesce(p_label_en, ''), E' \t\r\n'),
      nullif(btrim(coalesce(p_label_ar, ''), E' \t\r\n'), ''),
      p_target_kind,
      case when p_target_kind = 'page' then p_page_id else null end,
      case when p_target_kind = 'blog_post' then p_blog_post_id else null end,
      case when p_target_kind = 'category' then p_category_id else null end,
      case when p_target_kind = 'path' then nullif(btrim(coalesce(p_path, ''), E' \t\r\n'), '') else null end,
      coalesce(p_opens_in_new_tab, false),
      coalesce(p_sort_order, 0)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  update public.navigation_items i
     set label_en = coalesce(nullif(btrim(coalesce(p_label_en, ''), E' \t\r\n'), ''), i.label_en),
         label_ar = case when p_label_ar is null then i.label_ar else nullif(btrim(p_label_ar, E' \t\r\n'), '') end,
         -- The parent is cleared by naming the item's own id, which the `is_not_its_own_parent` CHECK then
         -- refuses — so instead a null here means "leave it" and the console moves an item by sending the
         -- parent it should have. Promoting a child to the top level is its own edit, below.
         parent_id = coalesce(p_parent_id, i.parent_id),
         target_kind = coalesce(p_target_kind, i.target_kind),
         page_id = case
                     when p_target_kind is null then i.page_id
                     when p_target_kind = 'page' then p_page_id
                     else null
                   end,
         blog_post_id = case
                          when p_target_kind is null then i.blog_post_id
                          when p_target_kind = 'blog_post' then p_blog_post_id
                          else null
                        end,
         category_id = case
                         when p_target_kind is null then i.category_id
                         when p_target_kind = 'category' then p_category_id
                         else null
                       end,
         path = case
                  when p_target_kind is null then i.path
                  when p_target_kind = 'path' then nullif(btrim(coalesce(p_path, ''), E' \t\r\n'), '')
                  else null
                end,
         opens_in_new_tab = coalesce(p_opens_in_new_tab, i.opens_in_new_tab),
         sort_order = coalesce(p_sort_order, i.sort_order)
   where i.id = p_item_id
  returning i.id into saved_id;

  return saved_id;
end;
$function$;

-- navigation_menu_save_for_staff: 6 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.navigation_menu_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_menu_id uuid, p_menu_key text, p_label_en text DEFAULT NULL::text, p_label_ar text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  saved_id uuid;
begin
  if not app_private.navigation_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.navigation.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_menu_id is null then
    -- `is_active` is absent on purpose: 0030 defaults a navigation menu to active, and overriding that here
    -- would be inventing the opposite rule. The state writer below exists for hiding one.
    insert into public.navigation_menus (menu_key, label_en, label_ar)
    values (
      btrim(p_menu_key, E' \t\r\n'),
      btrim(coalesce(p_label_en, ''), E' \t\r\n'),
      nullif(btrim(coalesce(p_label_ar, ''), E' \t\r\n'), '')
    )
    returning id into saved_id;
    return saved_id;
  end if;

  update public.navigation_menus m
     set menu_key = coalesce(nullif(btrim(p_menu_key, E' \t\r\n'), ''), m.menu_key),
         label_en = coalesce(nullif(btrim(coalesce(p_label_en, ''), E' \t\r\n'), ''), m.label_en),
         label_ar = case when p_label_ar is null then m.label_ar else nullif(btrim(p_label_ar, E' \t\r\n'), '') end
   where m.id = p_menu_id
  returning m.id into saved_id;

  return saved_id;
end;
$function$;

-- navigation_target_state: 4 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.navigation_target_state(p_target_kind text, p_page_id uuid, p_blog_post_id uuid, p_category_id uuid, p_path text, p_locale text DEFAULT 'en'::text)
 RETURNS TABLE(state text, slug text, target_title text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    -- Each branch is a scalar subquery wrapped in `coalesce`: a subquery that matches no row yields null, not a
    -- row with null columns, so "the target was deleted" has to be read from the *absence* of a row. Testing
    -- `p.id is null` inside the subquery could never fire, and the state would come back null — which the public
    -- reader would treat as not-public, safely, while the console showed an operator nothing at all.
    case p_target_kind
      when 'page' then coalesce((
        select case when public.cms_content_is_public(p.status, p.published_at) then 'public' else 'not_public' end
          from public.pages p where p.id = p_page_id
      ), 'missing')
      when 'blog_post' then coalesce((
        select case when public.cms_content_is_public(b.status, b.published_at) then 'public' else 'not_public' end
          from public.blog_posts b where b.id = p_blog_post_id
      ), 'missing')
      when 'category' then coalesce((
        select case when app_private.public_category_visible(c.id) then 'public' else 'not_public' end
          from public.categories c where c.id = p_category_id
      ), 'missing')
      else case when nullif(btrim(coalesce(p_path, ''), E' \t\r\n'), '') is null then 'missing' else 'public' end
    end,
    case p_target_kind
      when 'page' then (select p.slug from public.pages p where p.id = p_page_id)
      when 'blog_post' then (select b.slug from public.blog_posts b where b.id = p_blog_post_id)
      when 'category' then (select c.slug from public.categories c where c.id = p_category_id)
      else null
    end,
    -- The target's own title, for the console only: it is never served to the public, because a menu entry's
    -- public words are the operator's authored label and nothing else.
    case p_target_kind
      when 'page' then (
        select coalesce(t.title, fallback.title)
          from public.pages p
          left join public.page_translations t
            on t.page_id = p.id and t.locale_code = coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en')
          left join public.page_translations fallback on fallback.page_id = p.id and fallback.locale_code = 'en'
         where p.id = p_page_id
      )
      when 'blog_post' then (
        select coalesce(t.title, fallback.title)
          from public.blog_posts b
          left join public.blog_post_translations t
            on t.blog_post_id = b.id and t.locale_code = coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en')
          left join public.blog_post_translations fallback
            on fallback.blog_post_id = b.id and fallback.locale_code = 'en'
         where b.id = p_blog_post_id
      )
      when 'category' then (
        select coalesce(t.name, fallback.name, c.slug)
          from public.categories c
          left join public.category_translations t
            on t.category_id = c.id and t.locale_code = coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en')
          left join public.category_translations fallback
            on fallback.category_id = c.id and fallback.locale_code = 'en'
         where c.id = p_category_id
      )
      else null
    end;
$function$;

-- offer_counter: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.offer_counter(p_buyer_id uuid, p_parent_offer_id uuid, p_amount_minor bigint, p_quantity integer, p_message text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, offer_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_parent public.offers;
  v_listing_status text;
  v_message text := nullif(btrim(coalesce(p_message, ''), E' \t\r\n'), '');
  v_now timestamptz := now();
  v_offer_id uuid;
begin
  if p_buyer_id is null or p_parent_offer_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if p_amount_minor is null or p_amount_minor <= 0
     or p_quantity is null or p_quantity < 1
     or (v_message is not null and length(v_message) > 2000) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  -- Locked and scoped in one statement: another buyer's offer is not refused, it is never matched.
  select * into v_parent
    from public.offers o
   where o.id = p_parent_offer_id and o.buyer_user_id = p_buyer_id
     for update;

  if v_parent.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if v_parent.status <> 'pending' then
    return query select 'conflict'::text, null::uuid, v_parent.status;
    return;
  end if;
  if v_parent.expires_at <= v_now then
    -- Lapsed. 0032's sweeper owns writing `expired`, so nothing is written here.
    return query select 'expired'::text, null::uuid, v_parent.status;
    return;
  end if;

  select l.status into v_listing_status from public.listings l where l.id = v_parent.listing_id;
  if not public.listing_status_is_purchasable(v_listing_status) then
    return query select 'not_available'::text, null::uuid, v_parent.status;
    return;
  end if;
  if public.is_blocked_between(v_parent.buyer_user_id, v_parent.seller_user_id) then
    return query select 'blocked'::text, null::uuid, v_parent.status;
    return;
  end if;

  -- The parent leaves `pending` first, so `offers_one_open_per_buyer` is satisfied when the child enters
  -- it. `offers_responded_when_decided` requires the response time, and this is that response.
  update public.offers o
     set status = 'countered', responded_at = v_now
   where o.id = v_parent.id and o.status = 'pending';

  if not found then
    -- Lost to a concurrent decision between the lock and the write.
    select o.status into v_listing_status from public.offers o where o.id = v_parent.id;
    return query select 'conflict'::text, null::uuid, v_listing_status;
    return;
  end if;

  insert into public.offers (
    listing_id, currency_code, buyer_user_id, seller_user_id, parent_offer_id,
    amount_minor, quantity, message
  )
  values (
    v_parent.listing_id, v_parent.currency_code, v_parent.buyer_user_id, v_parent.seller_user_id,
    v_parent.id, p_amount_minor, p_quantity, v_message
  )
  returning id into v_offer_id;

  return query select 'countered'::text, v_offer_id, 'pending'::text;
end;
$function$;

-- offer_create: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.offer_create(p_buyer_id uuid, p_listing_id uuid, p_amount_minor bigint, p_quantity integer, p_message text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, offer_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_seller uuid;
  v_currency char(3);
  v_listing_status text;
  v_message text := nullif(btrim(coalesce(p_message, ''), E' \t\r\n'), '');
  v_offer_id uuid;
begin
  if p_buyer_id is null or p_listing_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if p_amount_minor is null or p_amount_minor <= 0
     or p_quantity is null or p_quantity < 1
     or (v_message is not null and length(v_message) > 2000) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  select l.seller_user_id, l.currency_code, l.status
    into v_seller, v_currency, v_listing_status
    from public.listings l where l.id = p_listing_id;

  if v_seller is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's own admission test, so a listing a buyer could not buy cannot be offered on either.
  if not public.listing_status_is_purchasable(v_listing_status) then
    return query select 'not_available'::text, null::uuid, null::text;
    return;
  end if;
  -- `offers_not_self`, answered as an outcome rather than as a constraint violation.
  if v_seller = p_buyer_id then
    return query select 'own_listing'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's `offers_buyer_insert` also refuses a blocked pair; `app_system` is not bound by that policy,
  -- so the rule is applied here instead of being lost.
  if public.is_blocked_between(p_buyer_id, v_seller) then
    return query select 'blocked'::text, null::uuid, null::text;
    return;
  end if;
  -- `offers_one_open_per_buyer`: one live offer per buyer per listing. Reported so the surface can send
  -- somebody to the offer they already have instead of showing a unique-violation.
  if exists (
    select 1 from public.offers o
     where o.listing_id = p_listing_id and o.buyer_user_id = p_buyer_id and o.status = 'pending'
  ) then
    return query select 'exists'::text, null::uuid, null::text;
    return;
  end if;

  insert into public.offers (
    listing_id, currency_code, buyer_user_id, seller_user_id, amount_minor, quantity, message
  )
  values (p_listing_id, v_currency, p_buyer_id, v_seller, p_amount_minor, p_quantity, v_message)
  returning id into v_offer_id;

  return query select 'created'::text, v_offer_id, 'pending'::text;
end;
$function$;

-- public_catalog_search: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_catalog_search(p_query text, p_locale text DEFAULT NULL::text, p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 20, p_cursor_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(result_type text, id uuid, slug text, title text, city text, price_minor bigint, currency_code text, currency_minor_unit smallint, is_negotiable boolean, listing_type_code text, pricing_model text, delivery_days smallint, revisions_included smallint, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  with asked as (
    -- Arabic is the only non-default configuration the schema generates a vector for; anything else,
    -- including an unknown locale, is searched in English. A locale is a representation choice.
    select lower(btrim(coalesce(p_locale, ''), E' \t\r\n')) = 'ar' as arabic
  )
  select case when l.listing_type_code = 'service' then 'service' else 'listing' end,
         l.id,
         l.slug,
         l.title,
         l.city,
         l.price_minor,
         l.currency_code::text,
         c.decimal_places,
         case when l.listing_type_code = 'service' then null else l.is_negotiable end,
         case when l.listing_type_code = 'service' then null else l.listing_type_code end,
         case when l.listing_type_code = 'service' then d.pricing_model else null end,
         case when l.listing_type_code = 'service' then d.delivery_days else null end,
         case when l.listing_type_code = 'service' then d.revisions_included else null end,
         l.created_at
    from public.listings l
    join public.currencies c on c.code = l.currency_code
    left join public.listing_service_details d on d.listing_id = l.id
   cross join asked a
   where app_private.catalog_filters_resolve(p_filters)
     and public.listing_status_is_purchasable(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
     and case
           when a.arabic then l.search_vector_ar @@ websearch_to_tsquery('arabic'::regconfig, p_query)
           else l.search_vector_en @@ websearch_to_tsquery('english'::regconfig, p_query)
         end
     and app_private.catalog_listing_matches(l.id, p_filters)
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (l.created_at, l.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by l.created_at desc, l.id desc
   limit greatest(coalesce(p_limit, 20), 0);
$function$;

-- public_categories: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_categories(p_locale text)
 RETURNS TABLE(id uuid, parent_id uuid, slug text, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  with recursive
  -- The locale actually used: the requested one when it exists and is active, otherwise the default.
  requested as (
    select coalesce(
      (select l.code from public.locales l
        where l.code = lower(btrim(coalesce(p_locale, ''), E' \t\r\n')) and l.is_active),
      (select l.code from public.locales l where l.is_default limit 1)
    ) as code
  ),
  fallback as (
    select l.code from public.locales l where l.is_default limit 1
  ),
  -- Active roots, then active children of anything already visible. A category under a deactivated
  -- ancestor never enters the set.
  visible as (
    select c.id, c.parent_id, c.slug, c.sort_order, c.depth
      from public.categories c
     where c.parent_id is null and c.is_active
    union all
    select c.id, c.parent_id, c.slug, c.sort_order, c.depth
      from public.categories c
      join visible v on c.parent_id = v.id
     where c.is_active
  )
  select v.id,
         v.parent_id,
         v.slug,
         coalesce(t.name, d.name, v.slug) as name
    from visible v
    left join public.category_translations t
      on t.category_id = v.id and t.locale_code = (select code from requested)
    left join public.category_translations d
      on d.category_id = v.id and d.locale_code = (select code from fallback)
   -- Siblings follow the order the catalogue was given (`categories_parent` indexes exactly this);
   -- the slug breaks ties so the answer is stable rather than merely sorted.
   order by v.depth, v.sort_order, v.slug;
$function$;

-- public_category_by_slug: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_category_by_slug(p_slug text, p_locale text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, id uuid, slug text, name text, description text, meta_title text, meta_description text, parent jsonb, children jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_locale text;
  v_fallback text;
  v_id uuid;
begin
  select coalesce(
    (select l.code from public.locales l where l.code = lower(btrim(coalesce(p_locale, ''), E' \t\r\n')) and l.is_active),
    (select l.code from public.locales l where l.is_default limit 1)
  ) into v_locale;
  select l.code into v_fallback from public.locales l where l.is_default limit 1;

  select c.id into v_id
    from public.categories c
   where c.slug = p_slug and app_private.public_category_visible(c.id);

  if v_id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::text, null::jsonb, null::jsonb;
    return;
  end if;

  return query
    select 'found'::text,
           c.id,
           c.slug,
           coalesce(t.name, d.name, c.slug),
           coalesce(t.description, d.description),
           coalesce(t.meta_title, d.meta_title),
           coalesce(t.meta_description, d.meta_description),
           -- The parent, when there is one and the public may see it. A visible category's parent is
           -- always visible too — an inactive parent would have hidden this one — so this is null only
           -- at the root.
           (select jsonb_build_object(
                     'id', p.id,
                     'slug', p.slug,
                     'name', coalesce(pt.name, pd.name, p.slug))
              from public.categories p
              left join public.category_translations pt
                on pt.category_id = p.id and pt.locale_code = v_locale
              left join public.category_translations pd
                on pd.category_id = p.id and pd.locale_code = v_fallback
             where p.id = c.parent_id),
           -- Direct children only, in the catalogue's own order with the slug breaking ties.
           coalesce(
             (select jsonb_agg(jsonb_build_object(
                       'id', ch.id,
                       'slug', ch.slug,
                       'name', coalesce(cht.name, chd.name, ch.slug))
                     order by ch.sort_order, ch.slug)
                from public.categories ch
                left join public.category_translations cht
                  on cht.category_id = ch.id and cht.locale_code = v_locale
                left join public.category_translations chd
                  on chd.category_id = ch.id and chd.locale_code = v_fallback
               where ch.parent_id = c.id and ch.is_active),
             '[]'::jsonb)
      from public.categories c
      left join public.category_translations t on t.category_id = c.id and t.locale_code = v_locale
      left join public.category_translations d on d.category_id = c.id and d.locale_code = v_fallback
     where c.id = v_id;
end;
$function$;

-- public_category_facets: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_category_facets(p_slug text, p_locale text DEFAULT NULL::text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(facet_kind text, attribute_key text, attribute_label text, data_type text, unit text, attribute_sort_order integer, value text, label text, value_sort_order integer, match_count integer, number_min numeric, number_max numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  with arabic as (
    select lower(btrim(coalesce(p_locale, ''), E' \t\r\n')) = 'ar' as yes
  ), subtree as (
    select category_id from app_private.public_category_subtree(p_slug)
  ),
  -- Every listing a visitor could reach through this category, before any filter. The vocabulary a panel
  -- offers is drawn from here.
  visible as (
    select l.id, l.listing_type_code, l.currency_code::text as currency_code, l.price_minor
      from public.listings l
     where l.category_id in (select category_id from subtree)
       and public.listing_status_is_purchasable(l.status)
       and public.is_seller_publicly_visible(l.seller_user_id)
  ),
  -- And the ones the active filters leave. Counts come from here.
  matching as (
    select v.id, v.listing_type_code, v.currency_code, v.price_minor
      from visible v
     where app_private.catalog_filters_resolve(p_filters)
       and app_private.catalog_listing_matches(v.id, p_filters)
  ),
  -- The attributes this category asks about and means to be filtered by.
  filterable as (
    select distinct d.id, d.key, d.data_type, d.unit,
           case when (select yes from arabic) then d.name_ar else d.name_en end as label,
           min(ca.sort_order) over (partition by d.id) as sort_order
      from public.category_attributes ca
      join public.attribute_definitions d
        on d.id = ca.attribute_definition_id
       and d.is_active
       and d.is_filterable
     where ca.category_id in (select category_id from subtree)
       and ca.is_filterable
  )
  -- One row per option of every select attribute.
  select 'attribute'::text,
         f.key,
         f.label,
         f.data_type,
         f.unit,
         f.sort_order,
         o.value,
         case when (select yes from arabic) then o.label_ar else o.label_en end,
         o.sort_order,
         (select count(*)::integer
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id
           where o.id = any (v.option_ids)),
         null::numeric,
         null::numeric
    from filterable f
    join public.attribute_options o on o.attribute_definition_id = f.id and o.is_active
   where f.data_type in ('single_select', 'multi_select')

  union all

  -- Two rows per boolean attribute: a yes and a no are its whole domain.
  select 'attribute'::text,
         f.key,
         f.label,
         f.data_type,
         f.unit,
         f.sort_order,
         answer.value,
         answer.value,
         answer.position,
         (select count(*)::integer
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id
           where v.value_boolean = (answer.value = 'true')),
         null::numeric,
         null::numeric
    from filterable f
   cross join (values ('true', 0), ('false', 1)) as answer(value, position)
   where f.data_type = 'boolean'

  union all

  -- One row per number attribute, carrying the range the matching listings actually span. A panel needs
  -- bounds to draw two boxes; it does not need a bucket, and inventing buckets would be inventing a rule.
  select 'attribute'::text,
         f.key,
         f.label,
         f.data_type,
         f.unit,
         f.sort_order,
         null::text,
         null::text,
         0,
         (select count(*)::integer
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id
           where v.value_number is not null),
         (select min(v.value_number)
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id),
         (select max(v.value_number)
            from matching m
            join public.listing_attribute_values v
              on v.listing_id = m.id and v.attribute_definition_id = f.id)
    from filterable f
   where f.data_type = 'number'

  union all

  -- The tags some visible listing in this subtree carries.
  select 'tag'::text,
         null::text,
         null::text,
         null::text,
         null::text,
         0,
         t.slug,
         case when (select yes from arabic) then t.name_ar else t.name_en end,
         0,
         (select count(*)::integer
            from matching m
            join public.listing_tags lt on lt.listing_id = m.id and lt.tag_id = t.id),
         null::numeric,
         null::numeric
    from public.tags t
   where t.is_active
     and exists (
       select 1 from public.listing_tags lt join visible v on v.id = lt.listing_id
        where lt.tag_id = t.id
     )

  union all

  -- The listing types present, which is what makes the product/service choice meaningful in a category
  -- that holds both and absent in one that holds either.
  select 'listing_type'::text,
         null::text,
         null::text,
         null::text,
         null::text,
         0,
         present.listing_type_code,
         present.listing_type_code,
         0,
         (select count(*)::integer from matching m where m.listing_type_code = present.listing_type_code),
         null::numeric,
         null::numeric
    from (select distinct v.listing_type_code from visible v) as present

  union all

  -- The currencies the visible listings are priced in, with the span of prices among the matching ones.
  -- This is where a price filter's currency comes from: it is read from the data and from `currencies`,
  -- never named in application source.
  select 'currency'::text,
         null::text,
         null::text,
         null::text,
         null::text,
         0,
         present.currency_code,
         present.currency_code,
         c.decimal_places::integer,
         (select count(*)::integer
            from matching m
           where m.currency_code = present.currency_code and m.price_minor is not null),
         (select min(m.price_minor)::numeric
            from matching m
           where m.currency_code = present.currency_code and m.price_minor is not null),
         (select max(m.price_minor)::numeric
            from matching m
           where m.currency_code = present.currency_code and m.price_minor is not null)
    from (select distinct v.currency_code from visible v where v.price_minor is not null) as present
    join public.currencies c on c.code = present.currency_code

   order by 1, 6, 2, 9, 7;
$function$;

-- public_faqs: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_faqs(p_topic text, p_locale text DEFAULT 'en'::text)
 RETURNS TABLE(faq_id uuid, question text, answer text, sort_order integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    f.id,
    case when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(f.question_ar, f.question_en)
         else f.question_en end,
    case when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(f.answer_ar, f.answer_en)
         else f.answer_en end,
    f.sort_order
    from public.faqs f
   where f.is_published
     and f.topic = nullif(btrim(coalesce(p_topic, ''), E' \t\r\n'), '')
   order by f.sort_order, f.id;
$function$;

-- public_homepage_categories: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_homepage_categories(p_ids uuid[], p_locale text DEFAULT 'en'::text, p_limit integer DEFAULT 12)
 RETURNS TABLE(category_id uuid, slug text, name text, listing_type_code text, icon text, chosen_position integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    cat.id,
    cat.slug,
    -- The translated name, the English name, then the slug — the same most-specific-first fallback the public
    -- tree uses, so a category never appears unnamed on the homepage.
    coalesce(t.name, fallback.name, cat.slug),
    cat.listing_type_code,
    cat.icon,
    chosen.ordinality::integer
    from unnest(coalesce(p_ids, '{}'::uuid[])) with ordinality as chosen(category_id, ordinality)
    join public.categories cat on cat.id = chosen.category_id
    left join public.category_translations t
      on t.category_id = cat.id and t.locale_code = coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en')
    left join public.category_translations fallback
      on fallback.category_id = cat.id and fallback.locale_code = 'en'
   where app_private.public_category_visible(cat.id)
   order by chosen.ordinality
   limit greatest(coalesce(p_limit, 12), 0);
$function$;

-- public_homepage_posts: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_homepage_posts(p_locale text DEFAULT 'en'::text, p_limit integer DEFAULT 3)
 RETURNS TABLE(post_id uuid, slug text, resolved_locale text, title text, excerpt text, category_slug text, category_name text, published_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    b.id,
    b.slug,
    t.locale_code,
    t.title,
    t.excerpt,
    bc.slug,
    case when bc.id is null then null
         when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(bc.name_ar, bc.name_en)
         else bc.name_en end,
    b.published_at
    from public.blog_posts b
    join lateral (
      select tr.locale_code, tr.title, tr.excerpt
        from public.blog_post_translations tr
       where tr.blog_post_id = b.id
         and tr.locale_code in (coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en'), 'en')
       order by (tr.locale_code = coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en')) desc
       limit 1
    ) t on true
    left join public.blog_categories bc on bc.id = b.blog_category_id and bc.is_active
   where public.cms_content_is_public(b.status, b.published_at)
   order by b.published_at desc, b.id desc
   limit greatest(coalesce(p_limit, 3), 0);
$function$;

-- public_homepage_sections: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_homepage_sections(p_locale text)
 RETURNS TABLE(section_id uuid, section_key text, section_type text, title text, subtitle text, sort_order integer, config jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    s.id,
    s.section_key,
    s.section_type,
    case when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(s.title_ar, s.title_en)
         else s.title_en end,
    case when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(s.subtitle_ar, s.subtitle_en)
         else s.subtitle_en end,
    s.sort_order,
    s.config
    from public.homepage_sections s
   where s.is_active
     and app_private.homepage_section_type_is_served(s.section_type)
   order by s.sort_order, s.section_key;
$function$;

-- public_listing_by_slug: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_listing_by_slug(p_slug text, p_locale text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, canonical_slug text, canonical_type text, id uuid, slug text, title text, description text, content_language text, city text, price_minor bigint, currency_code text, currency_minor_unit smallint, is_negotiable boolean, listing_type_code text, created_at timestamp with time zone, availability text, category jsonb, seller jsonb, attributes jsonb, tags jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_locale text;
  v_fallback text;
  v_outcome text;
  v_canonical text;
  v_id uuid;
  v_type text;
begin
  select r.outcome, r.canonical_slug, r.listing_id, r.listing_type_code
    into v_outcome, v_canonical, v_id, v_type
    from app_private.public_listing_resolve(p_slug) r;

  if v_outcome = 'not_found' then
    return query select 'not_found'::text, null::text, null::text, null::uuid, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::smallint,
                        null::boolean, null::text, null::timestamptz, null::text, null::jsonb, null::jsonb,
                        null::jsonb, null::jsonb;
    return;
  end if;

  -- A service, or a slug this surface does not own: send the caller to the surface that does.
  if v_outcome = 'moved' or v_type = 'service' then
    return query select 'moved'::text, v_canonical, v_type, null::uuid, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::smallint,
                        null::boolean, null::text, null::timestamptz, null::text, null::jsonb, null::jsonb,
                        null::jsonb, null::jsonb;
    return;
  end if;

  select coalesce(
    (select l.code from public.locales l where l.code = lower(btrim(coalesce(p_locale, ''), E' \t\r\n')) and l.is_active),
    (select l.code from public.locales l where l.is_default limit 1)
  ) into v_locale;
  select l.code into v_fallback from public.locales l where l.is_default limit 1;

  return query
    select 'found'::text,
           l.slug,
           l.listing_type_code,
           l.id,
           l.slug,
           l.title,
           l.description,
           l.content_language,
           l.city,
           l.price_minor,
           l.currency_code::text,
           cur.decimal_places,
           l.is_negotiable,
           l.listing_type_code,
           l.created_at,
           case when public.listing_status_is_purchasable(l.status) then 'available' else 'no_longer_available' end,
           jsonb_build_object('slug', cat.slug, 'name', coalesce(ct.name, cd.name, cat.slug)),
           jsonb_build_object('slug', s.slug, 'displayName', s.display_name),
           app_private.public_listing_attributes(l.id, v_locale),
           app_private.public_listing_tags(l.id, v_locale)
      from public.listings l
      join public.currencies cur on cur.code = l.currency_code
      join public.categories cat on cat.id = l.category_id
      join public.seller_profiles s on s.user_id = l.seller_user_id
      left join public.category_translations ct on ct.category_id = cat.id and ct.locale_code = v_locale
      left join public.category_translations cd on cd.category_id = cat.id and cd.locale_code = v_fallback
     where l.id = v_id;
end;
$function$;

-- public_navigation_items: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_navigation_items(p_menu_keys text[], p_locale text DEFAULT 'en'::text)
 RETURNS TABLE(menu_key text, menu_label text, item_id uuid, parent_item_id uuid, depth integer, label text, target_kind text, target_slug text, target_path text, opens_in_new_tab boolean, sort_order integer, root_sort_order integer, root_item_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  with wanted as (
    select distinct k.key
      from unnest(coalesce(p_menu_keys, '{}'::text[])) as k(key)
     where app_private.navigation_menu_key_is_served(k.key)
  ),
  menu as (
    select m.id, m.menu_key, m.label_en, m.label_ar
      from public.navigation_menus m
      join wanted w on w.key = m.menu_key
     where m.is_active
  ),
  -- Every active item of those menus, with its target resolved once.
  candidate as (
    select
      i.id,
      i.menu_id,
      i.parent_id,
      i.label_en,
      i.label_ar,
      i.target_kind,
      i.path,
      i.opens_in_new_tab,
      i.sort_order,
      resolved.state,
      resolved.slug
      from public.navigation_items i
      join menu m on m.id = i.menu_id
      cross join lateral app_private.navigation_target_state(
        i.target_kind, i.page_id, i.blog_post_id, i.category_id, i.path, p_locale
      ) as resolved
     where i.is_active
  ),
  renderable as (
    select * from candidate c where c.state = 'public'
  )
  select
    m.menu_key,
    case when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(m.label_ar, m.label_en)
         else m.label_en end,
    r.id,
    r.parent_id,
    case when r.parent_id is null then 1 else 2 end,
    case when coalesce(nullif(btrim(p_locale, E' \t\r\n'), ''), 'en') = 'ar' then coalesce(r.label_ar, r.label_en)
         else r.label_en end,
    r.target_kind,
    r.slug,
    -- Only a `path` item carries a literal address. For the other three kinds the address is derived from the
    -- slug by the caller, which is where the route map lives.
    case when r.target_kind = 'path' then r.path else null end,
    r.opens_in_new_tab,
    r.sort_order,
    -- The ordering keys: a child sorts inside its parent, and a deterministic tiebreak follows, so two entries
    -- sharing a position never come back in whichever order the planner chose today.
    coalesce(parent.sort_order, r.sort_order),
    coalesce(parent.id, r.id)
    from renderable r
    join menu m on m.id = r.menu_id
    -- A child is kept only when its parent survived. The join is against `renderable`, not `candidate`.
    left join renderable parent on parent.id = r.parent_id
   where r.parent_id is null or parent.id is not null
   order by m.menu_key,
            coalesce(parent.sort_order, r.sort_order),
            coalesce(parent.id, r.id),
            case when r.parent_id is null then 0 else 1 end,
            r.sort_order,
            r.id;
$function$;

-- public_robots_body: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_robots_body()
 RETURNS TABLE(locale_code text, robots_txt_body text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select s.locale_code, nullif(btrim(coalesce(s.robots_txt_body, ''), E' \t\r\n'), '')
    from public.seo_settings s
    join public.locales l on l.code = s.locale_code
   where l.is_default
   limit 1;
$function$;

-- public_service_by_slug: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.public_service_by_slug(p_slug text, p_locale text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, canonical_slug text, canonical_type text, id uuid, slug text, title text, description text, content_language text, city text, price_minor bigint, currency_code text, currency_minor_unit smallint, pricing_model text, delivery_days smallint, revisions_included smallint, requires_brief boolean, scope text, availability text, category jsonb, seller jsonb, attributes jsonb, tags jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_locale text;
  v_fallback text;
  v_outcome text;
  v_canonical text;
  v_id uuid;
  v_type text;
begin
  select r.outcome, r.canonical_slug, r.listing_id, r.listing_type_code
    into v_outcome, v_canonical, v_id, v_type
    from app_private.public_listing_resolve(p_slug) r;

  if v_outcome = 'not_found' then
    return query select 'not_found'::text, null::text, null::text, null::uuid, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::smallint,
                        null::text, null::smallint, null::smallint, null::boolean, null::text, null::text,
                        null::jsonb, null::jsonb, null::jsonb, null::jsonb;
    return;
  end if;

  -- A product, or a previous slug: send the caller to the surface and slug that own it.
  if v_outcome = 'moved' or v_type <> 'service' then
    return query select 'moved'::text, v_canonical, v_type, null::uuid, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::smallint,
                        null::text, null::smallint, null::smallint, null::boolean, null::text, null::text,
                        null::jsonb, null::jsonb, null::jsonb, null::jsonb;
    return;
  end if;

  select coalesce(
    (select l.code from public.locales l where l.code = lower(btrim(coalesce(p_locale, ''), E' \t\r\n')) and l.is_active),
    (select l.code from public.locales l where l.is_default limit 1)
  ) into v_locale;
  select l.code into v_fallback from public.locales l where l.is_default limit 1;

  return query
    select 'found'::text,
           l.slug,
           l.listing_type_code,
           l.id,
           l.slug,
           l.title,
           l.description,
           l.content_language,
           l.city,
           l.price_minor,
           l.currency_code::text,
           cur.decimal_places,
           d.pricing_model,
           d.delivery_days,
           d.revisions_included,
           d.requires_brief,
           d.scope,
           case when public.listing_status_is_purchasable(l.status) then 'available' else 'no_longer_available' end,
           jsonb_build_object('slug', cat.slug, 'name', coalesce(ct.name, cd.name, cat.slug)),
           jsonb_build_object('slug', s.slug, 'displayName', s.display_name),
           app_private.public_listing_attributes(l.id, v_locale),
           app_private.public_listing_tags(l.id, v_locale)
      from public.listings l
      join public.currencies cur on cur.code = l.currency_code
      join public.categories cat on cat.id = l.category_id
      join public.seller_profiles s on s.user_id = l.seller_user_id
      left join public.listing_service_details d on d.listing_id = l.id
      left join public.category_translations ct on ct.category_id = cat.id and ct.locale_code = v_locale
      left join public.category_translations cd on cd.category_id = cat.id and cd.locale_code = v_fallback
     where l.id = v_id;
end;
$function$;

-- recovery_decide_for_staff: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.recovery_decide_for_staff(p_user_id uuid, p_is_aal2 boolean, p_request_id uuid, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_decision text;
begin
  if p_user_id is null or p_request_id is null
     or not app_private.admin_can_review_recovery(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- 0028's own two, and no third. `approved` and `rejected` are what that writer accepts; the status the
  -- request lands on is its own mapping and is not something a caller names.
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  -- A rejection is always recorded with its reason. The writer raises for this; answering here keeps it a
  -- validation failure rather than a database error.
  if p_decision = 'rejected' and btrim(coalesce(p_note, ''), E' \t\r\n') = '' then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  begin
    v_decision := app_private.decide_recovery_request(
      p_request_id, p_user_id, p_decision, nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), '')
    );
  exception
    when no_data_found then
      return query select 'not_found'::text, null::text;
      return;
    when insufficient_privilege then
      -- Either the caller reviewed it, or it is their own account. Both are 0028's refusals and both mean
      -- the same thing to a console: somebody else has to decide this one.
      return query select 'needs_another_person'::text, null::text;
      return;
    when restrict_violation then
      return query select 'not_decidable'::text, null::text;
      return;
    when invalid_parameter_value or check_violation or unique_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  -- The status the request now holds, which for an approval is `contact_verification` rather than
  -- `approved`: 0028's writer moves it on to verifying the new contact, and `approved` is a value in the
  -- table's own list that nothing sets.
  return query
    select 'decided'::text, r.status from public.account_recovery_requests r where r.id = p_request_id;
end;
$function$;

-- recovery_review_for_staff: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.recovery_review_for_staff(p_user_id uuid, p_is_aal2 boolean, p_request_id uuid, p_note text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_status text;
begin
  if p_user_id is null or p_request_id is null
     or not app_private.admin_can_review_recovery(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  begin
    v_status := app_private.review_recovery_request(p_request_id, p_user_id, nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), ''));
  exception
    when no_data_found then
      return query select 'not_found'::text, null::text;
      return;
    when insufficient_privilege then
      return query select 'own_request'::text, null::text;
      return;
    when restrict_violation then
      return query select 'not_reviewable'::text, null::text;
      return;
    when invalid_parameter_value or check_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  return query select 'reviewed'::text, v_status;
end;
$function$;

-- redirect_create_for_staff: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.redirect_create_for_staff(p_user_id uuid, p_is_aal2 boolean, p_from_path text, p_to_path text, p_status_code integer DEFAULT 301, p_note text DEFAULT NULL::text, p_is_active boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  new_id uuid;
begin
  if not app_private.redirect_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.redirect.manage is required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.redirects (from_path, to_path, status_code, note, is_active, created_by)
  values (
    btrim(p_from_path, E' \t\r\n'),
    btrim(p_to_path, E' \t\r\n'),
    -- The column's own default, restated so the request may stay small rather than so this function decides it.
    coalesce(p_status_code, 301),
    nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), ''),
    coalesce(p_is_active, true),
    p_user_id
  )
  returning id into new_id;

  return new_id;
end;
$function$;

-- redirect_update_for_staff: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.redirect_update_for_staff(p_user_id uuid, p_is_aal2 boolean, p_redirect_id uuid, p_from_path text DEFAULT NULL::text, p_to_path text DEFAULT NULL::text, p_status_code integer DEFAULT NULL::integer, p_note text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  updated integer;
begin
  if not app_private.redirect_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.redirect.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- `is_active` is deliberately absent from this statement: switching an entry on or off is the next function,
  -- so correcting a typo in a destination can never silently activate a redirect, and turning one off is one
  -- unambiguous action in the audit trail rather than a field inside an edit.
  update public.redirects r
     set from_path = coalesce(nullif(btrim(coalesce(p_from_path, ''), E' \t\r\n'), ''), r.from_path),
         to_path = coalesce(nullif(btrim(coalesce(p_to_path, ''), E' \t\r\n'), ''), r.to_path),
         status_code = coalesce(p_status_code, r.status_code),
         -- An empty note clears it, which is a different request from not sending the field at all.
         note = case when p_note is null then r.note else nullif(btrim(p_note, E' \t\r\n'), '') end
   where r.id = p_redirect_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$function$;

-- redirects_for_staff: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.redirects_for_staff(p_user_id uuid, p_is_aal2 boolean, p_limit integer, p_search text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean, p_cursor_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(redirect_id uuid, from_path text, to_path text, status_code integer, is_active boolean, note text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    r.id,
    r.from_path,
    r.to_path,
    r.status_code,
    r.is_active,
    r.note,
    r.created_at,
    r.updated_at
    from public.redirects r
   where app_private.redirect_can_read(p_user_id, p_is_aal2)
     and (p_search is null or btrim(p_search, E' \t\r\n') = '' or
          position(lower(btrim(p_search, E' \t\r\n')) in lower(r.from_path)) > 0 or
          position(lower(btrim(p_search, E' \t\r\n')) in lower(r.to_path)) > 0)
     -- A tri-state parameter: null is "both", which is what an unfiltered list means.
     and (p_is_active is null or r.is_active = p_is_active)
     and (
       p_cursor_updated_at is null
       or p_cursor_id is null
       or (r.updated_at, r.id) < (p_cursor_updated_at, p_cursor_id)
     )
   order by r.updated_at desc, r.id desc
   limit greatest(coalesce(p_limit, 25), 1);
$function$;

-- report_file_for_reporter: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.report_file_for_reporter(p_reporter_user_id uuid, p_subject_type text, p_subject_slug text, p_reason_code text, p_details text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, report_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_subject_id uuid;
  v_details text;
  v_report uuid;
begin
  if p_reporter_user_id is null or p_subject_slug is null or btrim(p_subject_slug, E' \t\r\n') = '' then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- The two subject types a public page can produce. Everything else 0027 allows belongs to a surface
  -- that either already files its own reports or does not exist; see the header.
  if p_subject_type is null or p_subject_type not in ('listing', 'seller') then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- 0027's `reports_reason_code_allowed`, checked here so an unknown reason is an answer rather than a
  -- constraint violation from the insert.
  if p_reason_code is null or p_reason_code not in (
    'prohibited_item', 'counterfeit', 'intellectual_property', 'fraud_or_scam', 'harassment',
    'adult_content', 'violence', 'spam', 'misleading', 'off_platform', 'other'
  ) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- 0027's `reports_details_length`: null or 1..4000 after trimming. An all-whitespace box is no details
  -- at all rather than a validation failure, which is what the column's nullability is for.
  v_details := nullif(btrim(coalesce(p_details, ''), E' \t\r\n'), '');
  if v_details is not null and length(v_details) > 4000 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if p_subject_type = 'listing' then
    -- 0047's resolver, which owns the public listing-state rules and accepts a previous slug.
    select r.listing_id into v_subject_id
      from app_private.public_listing_resolve(p_subject_slug) r
     where r.outcome in ('found', 'moved');
  else
    -- 0050's own visibility predicate: the set whose profile page renders.
    select s.user_id into v_subject_id
      from public.seller_profiles s
     where s.slug = p_subject_slug and s.status in ('active', 'suspended');
  end if;

  if v_subject_id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- 0027's rule, returned rather than raised. It covers `seller` and `user`; a listing is not included
  -- there and is not included here.
  if p_subject_type = 'seller' and v_subject_id = p_reporter_user_id then
    return query select 'own_subject'::text, null::uuid;
    return;
  end if;

  -- 0027's entry point, unchanged: it owns the row, the C10 early return that makes a repeat land on the
  -- report already open, the audit trigger and the `report.filed` outbox event.
  v_report := app_private.file_report(
    p_reporter_user_id, p_subject_type, v_subject_id, p_reason_code, v_details
  );

  return query select 'filed'::text, v_report;
end;
$function$;

-- resolve_report: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.resolve_report(p_report_id uuid, p_status text, p_moderator_user_id uuid, p_resolution_note text, p_duplicate_of_report_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  report public.reports;
begin
  if p_status not in ('triaged', 'actioned', 'dismissed', 'duplicate') then
    raise exception 'unknown report status %', p_status using errcode = 'invalid_parameter_value';
  end if;
  if p_status <> 'triaged' and length(btrim(coalesce(p_resolution_note, ''), E' \t\r\n')) = 0 then
    raise exception 'a report is never closed without a reason' using errcode = 'check_violation';
  end if;

  select * into report from public.reports r where r.id = p_report_id for update;
  if report.id is null then
    raise exception 'report % does not exist', p_report_id using errcode = 'no_data_found';
  end if;
  if report.reporter_user_id = p_moderator_user_id then
    raise exception 'nobody rules on their own report' using errcode = 'insufficient_privilege';
  end if;
  if report.status in ('actioned', 'dismissed', 'duplicate') then
    raise exception 'report % is already %', p_report_id, report.status using errcode = 'restrict_violation';
  end if;

  update public.reports
     set status = p_status,
         resolution = case when p_status = 'triaged' then null else p_status end,
         resolution_note = case when p_status = 'triaged' then resolution_note else p_resolution_note end,
         resolved_at = case when p_status = 'triaged' then null else now() end,
         resolved_by = case when p_status = 'triaged' then resolved_by else p_moderator_user_id end,
         duplicate_of_report_id = case when p_status = 'duplicate' then p_duplicate_of_report_id else null end
   where id = p_report_id;

  return p_status;
end;
$function$;

-- review_moderate_for_staff: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.review_moderate_for_staff(p_user_id uuid, p_is_aal2 boolean, p_review_id uuid, p_status text, p_reason text)
 RETURNS TABLE(outcome text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_status text;
begin
  if p_user_id is null or p_review_id is null
     or not app_private.review_can_moderate(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- 0026's own four, and nothing else. Checked before the writer so an unusable status is a validation
  -- failure rather than a database error.
  if p_status is null or p_status not in ('published', 'pending_moderation', 'hidden', 'removed') then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  -- A decision is always recorded with its reason. The writer raises for this; answering here keeps it a
  -- validation failure.
  if btrim(coalesce(p_reason, ''), E' \t\r\n') = '' then
    return query select 'reason_required'::text, null::text;
    return;
  end if;

  begin
    v_status := app_private.moderate_review(p_review_id, p_status, p_user_id, btrim(p_reason, E' \t\r\n'));
  exception
    when no_data_found then
      return query select 'not_found'::text, null::text;
      return;
    when insufficient_privilege then
      -- The caller is the buyer or the seller. 0026's refusal, and it discloses nothing: the only accounts
      -- it concerns are the caller's own relationship to the review.
      return query select 'is_party'::text, null::text;
      return;
    when invalid_parameter_value or check_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  -- 0026's trigger has recorded the change in `audit.audit_logs` and its writer has enqueued the outbox
  -- event. This function writes no audit row, no security event and no second outbox event.
  return query select 'moderated'::text, v_status;
end;
$function$;

-- review_queue_for_staff: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.review_queue_for_staff(p_user_id uuid, p_is_aal2 boolean, p_limit integer, p_status text DEFAULT NULL::text, p_cursor_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, rating smallint, title text, status text, has_body boolean, auto_hidden_reason text, is_moderated boolean, moderated_by_me boolean, is_party boolean, seller_slug text, seller_display_name text, has_reply boolean, reply_status text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select v.id,
         v.rating,
         v.title,
         v.status,
         -- Whether there is prose to read, so a queue row can say so without carrying four thousand
         -- characters of it. The body itself is on the detail.
         v.body is not null and btrim(v.body, E' \t\r\n') <> '',
         v.auto_hidden_reason,
         v.moderated_at is not null,
         v.moderated_by is not null and v.moderated_by = p_user_id,
         -- 0026 refuses a moderator who is the buyer or the seller. Reported so a console can say so before
         -- a colleague tries, rather than after the writer refuses them.
         v.buyer_user_id = p_user_id or v.seller_user_id = p_user_id,
         s.slug,
         s.display_name,
         p.id is not null,
         p.status,
         v.created_at
    from public.reviews v
    join public.seller_profiles s on s.user_id = v.seller_user_id
    left join public.review_replies p on p.review_id = v.id
   where p_user_id is not null
     and app_private.review_can_read(p_user_id, p_is_aal2)
     and (p_status is null or v.status = p_status)
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (v.created_at, v.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by v.created_at desc, v.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$function$;

-- seller_create_profile: 7 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_create_profile(p_user_id uuid, p_slug text, p_display_name text, p_legal_name text, p_bio text, p_content_language text, p_country_code text, p_governorate text, p_city text, p_contact_email text, p_contact_phone_e164 text)
 RETURNS TABLE(outcome text, slug text, display_name text, status text, verification_status text, city text, country_code character)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  -- Every value the function returns lives in a local first, so the final SELECT reads no table and the
  -- OUT parameter names above can never be mistaken for columns.
  v_outcome text;
  v_slug text;
  v_display_name text;
  v_status text;
  v_verification text;
  v_city text;
  v_country char(2);
  v_legal_name text;
  v_bio text;
  v_governorate text;
  v_email text;
  v_phone text;
  v_constraint text;
begin
  -- No session, no storefront. Nothing below would be meaningful without an owner.
  if p_user_id is null then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- Optional free text is trimmed, and an empty field is an absent one: a form submits '' for a box the
  -- person left alone, and storing that as an empty string would make "no legal name" and "a legal name
  -- of nothing" two different states. The slug is deliberately *not* normalised — see below.
  v_legal_name := nullif(btrim(coalesce(p_legal_name, ''), E' \t\r\n'), '');
  v_bio := nullif(btrim(coalesce(p_bio, ''), E' \t\r\n'), '');
  v_governorate := nullif(btrim(coalesce(p_governorate, ''), E' \t\r\n'), '');
  v_city := nullif(btrim(coalesce(p_city, ''), E' \t\r\n'), '');
  v_email := nullif(btrim(coalesce(p_contact_email, ''), E' \t\r\n'), '');
  v_phone := nullif(btrim(coalesce(p_contact_phone_e164, ''), E' \t\r\n'), '');
  v_display_name := btrim(coalesce(p_display_name, ''), E' \t\r\n');

  -- Already a seller. Checked here so the ordinary repeat answers without attempting a write; the same
  -- condition is caught again below, because a pre-check on its own is a race.
  if exists (select 1 from public.seller_profiles s where s.user_id = p_user_id) then
    return query select 'exists'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- The slug is 0009's own `seller_profiles_slug_format`, character for character: lower case only, 3..50
  -- characters, no leading or trailing hyphen. It is matched as given and never case-folded or trimmed
  -- into shape. A slug becomes a permanent public URL, so `Good-Shop` is refused rather than quietly
  -- turned into something the person did not type — the address they confirm is the address they get.
  if coalesce(p_slug, '') !~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$' then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;
  v_slug := p_slug;

  -- `seller_profiles_display_name_length`: 2..80 on the trimmed value.
  if length(v_display_name) < 2 or length(v_display_name) > 80 then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- `seller_profiles_bio_length`.
  if v_bio is not null and length(v_bio) > 2000 then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- `content_language` is a foreign key onto `public.locales`; existence is the constraint, so existence
  -- is what is checked. Nothing here decides which locales a seller may write in.
  if p_content_language is not null
     and not exists (select 1 from public.locales l where l.code = p_content_language) then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- D17, as 0009's trigger states it: a seller must sit in a country that exists *and* is enabled for the
  -- marketplace. Answered as an outcome rather than left to the trigger's `restrict_violation`, so the
  -- person sees a field to correct instead of a failure. The code is matched exactly — `char(2)` pads and
  -- compares, but it does not case-fold, and inventing a case rule for a foreign key would be inventing.
  if p_country_code is null or length(p_country_code) <> 2 then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;
  if not exists (
    select 1 from public.countries c
     where c.code = p_country_code::char(2) and c.is_marketplace_enabled
  ) then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;
  v_country := p_country_code::char(2);

  -- The floor beneath the API's strict contract: 0009 constrains this column's type and nothing else.
  if v_email is not null
     and (length(v_email) > 320 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- `seller_profiles_phone_format`.
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- The state is written as literals. There is no parameter for either column, and no expression below
  -- reads one — which is what makes "the caller cannot create an active or verified storefront" a
  -- property of the function rather than a rule somebody has to remember to check.
  begin
    insert into public.seller_profiles as s (
      user_id, slug, display_name, legal_name, bio, content_language,
      country_code, governorate, city, contact_email, contact_phone_e164,
      status, verification_status
    ) values (
      p_user_id, v_slug, v_display_name, v_legal_name, v_bio, p_content_language,
      v_country, v_governorate, v_city, v_email::extensions.citext, v_phone,
      'pending', 'unverified'
    )
    returning s.status, s.verification_status, s.slug, s.display_name, s.city, s.country_code
      into v_status, v_verification, v_slug, v_display_name, v_city, v_country;
  exception
    when unique_violation then
      -- Which uniqueness, decided from the diagnostic rather than guessed: the primary key is a second
      -- storefront for this account, the slug index is an address somebody else holds. The constraint
      -- name is read here and never returned.
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'seller_profiles_slug' then
        v_outcome := 'slug_taken';
      elsif v_constraint = 'seller_profiles_pkey' then
        v_outcome := 'exists';
      else
        v_outcome := 'invalid';
      end if;
      return query select v_outcome, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    when check_violation or foreign_key_violation or restrict_violation or invalid_text_representation then
      -- The constraints are still the authority. Anything they refuse that the checks above let through
      -- is a gap in those checks, and it answers as an ordinary validation failure rather than a 500.
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
  end;

  -- What committed, read back from the row itself.
  return query select 'created'::text, v_slug, v_display_name, v_status, v_verification, v_city, v_country;
end;
$function$;

-- seller_listing_attribute_options: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_listing_attribute_options(p_user_id uuid, p_slug text, p_expected_type text, p_locale text)
 RETURNS TABLE(definition_id uuid, option_id uuid, value text, label text, sort_order integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  with wanted as (
    select coalesce(
      (select l.code from public.locales l
        where l.code = lower(btrim(coalesce(p_locale, ''), E' \t\r\n')) and l.is_active),
      (select l.code from public.locales l where l.is_default limit 1)
    ) as code
  ), target as (
    select l.category_id
      from public.listings l
     where l.slug = p_slug
       and l.seller_user_id = p_user_id
       and l.deleted_at is null
       and (p_expected_type is null or l.listing_type_code = p_expected_type)
  )
  select
    o.attribute_definition_id,
    o.id,
    o.value,
    case when (select code from wanted) = 'ar' then o.label_ar else o.label_en end,
    o.sort_order
    from target t
    join public.category_attributes ca on ca.category_id = t.category_id
    join public.attribute_definitions d on d.id = ca.attribute_definition_id and d.is_active
    join public.attribute_options o on o.attribute_definition_id = d.id and o.is_active
   order by o.attribute_definition_id, o.sort_order, o.value;
$function$;

-- seller_listing_attributes: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_listing_attributes(p_user_id uuid, p_slug text, p_expected_type text, p_locale text)
 RETURNS TABLE(outcome text, definition_id uuid, key text, data_type text, unit text, label text, is_required boolean, sort_order integer, value_text text, value_number numeric, value_boolean boolean, option_ids uuid[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  with wanted as (
    select coalesce(
      (select l.code from public.locales l
        where l.code = lower(btrim(coalesce(p_locale, ''), E' \t\r\n')) and l.is_active),
      (select l.code from public.locales l where l.is_default limit 1)
    ) as code
  ), target as (
    select l.id, l.category_id
      from public.listings l
     where l.slug = p_slug
       and l.seller_user_id = p_user_id
       and l.deleted_at is null
       and (p_expected_type is null or l.listing_type_code = p_expected_type)
  )
  select
    'found'::text,
    d.id,
    d.key,
    d.data_type,
    d.unit,
    case when (select code from wanted) = 'ar' then d.name_ar else d.name_en end,
    ca.is_required,
    ca.sort_order,
    v.value_text,
    v.value_number,
    v.value_boolean,
    coalesce(v.option_ids, array[]::uuid[])
    from target t
    join public.category_attributes ca on ca.category_id = t.category_id
    join public.attribute_definitions d on d.id = ca.attribute_definition_id and d.is_active
    left join public.listing_attribute_values v
      on v.listing_id = t.id and v.attribute_definition_id = d.id
   order by ca.sort_order, d.key;
$function$;

-- seller_listing_attributes_save: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_listing_attributes_save(p_user_id uuid, p_slug text, p_expected_type text, p_answers jsonb)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_seller_status text;
  v_listing_id uuid;
  v_listing_status text;
  v_category_id uuid;
  v_answer jsonb;
  v_definition public.attribute_definitions;
  v_option_ids uuid[];
  v_answered uuid[] := array[]::uuid[];
begin
  if p_user_id is null then
    return query select 'not_found'::text;
    return;
  end if;

  select s.status into v_seller_status from public.seller_profiles s where s.user_id = p_user_id;
  if v_seller_status is null then
    return query select 'not_found'::text;
    return;
  end if;
  -- 0061's own rule, read from the same column.
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text;
    return;
  end if;

  select l.id, l.status, l.category_id into v_listing_id, v_listing_status, v_category_id
    from public.listings l
   where l.slug = p_slug
     and l.seller_user_id = p_user_id
     and l.deleted_at is null
     and (p_expected_type is null or l.listing_type_code = p_expected_type);

  if v_listing_id is null then
    return query select 'not_found'::text;
    return;
  end if;
  if v_listing_status <> 'draft' then
    return query select 'not_editable'::text;
    return;
  end if;

  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    return query select 'invalid'::text;
    return;
  end if;

  -- Every answer is applied inside one nested block, for two reasons. The first is that a refusal must leave
  -- the listing exactly as it was rather than half re-answered: the block is a subtransaction, so an abort
  -- anywhere undoes the answers already written in this call. The second is that **0011's trigger is the only
  -- judge of a type rule**, and it judges by raising: a wrong type and a bad option set arrive here as
  -- check_violation, an attribute the trigger does not know as foreign_key_violation, and a number or boolean
  -- that is not one as 22P02 from the cast. None of them is restated above, and all of them mean the one thing
  -- a seller needs to be told — the answer was not acceptable.
  begin
  for v_answer in select * from jsonb_array_elements(p_answers) loop
    if jsonb_typeof(v_answer) <> 'object' then
      raise exception 'an answer must be an object' using errcode = 'data_exception';
    end if;

    -- The attribute must be one this category actually asks for, and still active. Anything else is a request
    -- to answer a question nobody asked.
    select d.* into v_definition
      from public.category_attributes ca
      join public.attribute_definitions d on d.id = ca.attribute_definition_id and d.is_active
     where ca.category_id = v_category_id
       and d.key = (v_answer ->> 'key');

    if v_definition.id is null then
      raise exception 'this category does not ask for %', v_answer ->> 'key' using errcode = 'data_exception';
    end if;

    -- Options arrive as values, which is what a form holds, and are resolved to ids here. An inactive option
    -- cannot be chosen; an unknown one makes the whole save invalid rather than being dropped silently.
    v_option_ids := array[]::uuid[];
    if v_definition.data_type in ('single_select', 'multi_select') then
      if jsonb_typeof(v_answer -> 'options') <> 'array' then
        raise exception 'a select answer carries an array of option values' using errcode = 'data_exception';
      end if;
      select coalesce(array_agg(o.id order by o.sort_order, o.value), array[]::uuid[])
        into v_option_ids
        from jsonb_array_elements_text(v_answer -> 'options') as chosen(value)
        join public.attribute_options o
          on o.attribute_definition_id = v_definition.id and o.value = chosen.value and o.is_active;

      if cardinality(v_option_ids)
         <> (select count(*) from jsonb_array_elements_text(v_answer -> 'options')) then
        raise exception 'an option is unknown, inactive or not this attribute''s'
          using errcode = 'data_exception';
      end if;
    end if;

    insert into public.listing_attribute_values
      (listing_id, attribute_definition_id, value_text, value_number, value_boolean, option_ids)
    values (
      v_listing_id,
      v_definition.id,
      case when v_definition.data_type = 'text' then nullif(btrim(coalesce(v_answer ->> 'text', ''), E' \t\r\n'), '') end,
      case when v_definition.data_type = 'number' then (v_answer ->> 'number')::numeric end,
      case when v_definition.data_type = 'boolean' then (v_answer ->> 'boolean')::boolean end,
      v_option_ids
    )
    on conflict (listing_id, attribute_definition_id) do update
       set value_text = excluded.value_text,
           value_number = excluded.value_number,
           value_boolean = excluded.value_boolean,
           option_ids = excluded.option_ids;

    v_answered := v_answered || v_definition.id;
  end loop;

  -- Whatever was not answered this time is no longer answered. This is how a seller clears a field.
  delete from public.listing_attribute_values v
   where v.listing_id = v_listing_id
     and not (v.attribute_definition_id = any(v_answered));

  update public.listings l set updated_at = now() where l.id = v_listing_id;
  exception
    when check_violation or foreign_key_violation or data_exception then
      return query select 'invalid'::text;
      return;
  end;

  return query select 'saved'::text;
end;
$function$;

-- seller_listing_create_draft: 4 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_listing_create_draft(p_user_id uuid, p_slug text, p_title text, p_description text, p_listing_type_code text, p_category_slug text, p_content_language text, p_currency_code text, p_country_code text, p_price_minor bigint, p_is_negotiable boolean, p_governorate text, p_city text)
 RETURNS TABLE(outcome text, slug text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_seller_status text;
  v_category_id uuid;
  v_category_type text;
  v_title text;
  v_description text;
  v_governorate text;
  v_city text;
  v_slug text;
  v_status text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  -- The caller's own storefront and its state, read first so a suspended seller gets the same answer
  -- whatever they sent.
  select s.status into v_seller_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  -- 0011's own limits, restated nowhere else: the slug format, the trimmed title 3..140 and the trimmed
  -- description 10..20000.
  if coalesce(p_slug, '') !~ '^[a-z0-9](?:[a-z0-9-]{1,118}[a-z0-9])$' then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  v_title := btrim(coalesce(p_title, ''), E' \t\r\n');
  if length(v_title) < 3 or length(v_title) > 140 then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  v_description := btrim(coalesce(p_description, ''), E' \t\r\n');
  if length(v_description) < 10 or length(v_description) > 20000 then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if p_price_minor is not null and p_price_minor < 0 then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  -- The reference vocabularies, each checked against its own table rather than against a list kept here.
  if p_listing_type_code is null
     or not exists (select 1 from public.listing_types t where t.code = p_listing_type_code and t.is_active) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if p_content_language is null
     or not exists (select 1 from public.locales l where l.code = p_content_language) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if p_currency_code is null or length(p_currency_code) <> 3
     or not exists (
       select 1 from public.currencies c
        where c.code = p_currency_code::char(3) and c.is_enabled and c.is_pricing_enabled
     ) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if p_country_code is null or length(p_country_code) <> 2
     or not exists (
       select 1 from public.countries c where c.code = p_country_code::char(2) and c.is_marketplace_enabled
     ) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  -- The category, by its public slug. It must be active, and a category scoped to one listing type may not
  -- hold the other — which is the categories table's own `listing_type_code`, not a rule invented here.
  select c.id, c.listing_type_code into v_category_id, v_category_type
    from public.categories c
   where c.slug = p_category_slug and c.is_active;

  if v_category_id is null then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if v_category_type is not null and v_category_type <> p_listing_type_code then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  v_governorate := nullif(btrim(coalesce(p_governorate, ''), E' \t\r\n'), '');
  v_city := nullif(btrim(coalesce(p_city, ''), E' \t\r\n'), '');

  -- `status` is a literal. There is no parameter for it, so a caller cannot create anything but a draft,
  -- and `seller_user_id` is the caller's own id and nothing else. None of 0011's timestamps is assigned:
  -- `created_at` and `updated_at` are the table's defaults, and every state-bearing timestamp stays null.
  begin
    insert into public.listings (
      seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
      currency_code, price_minor, is_negotiable, status, country_code, governorate, city
    ) values (
      p_user_id, p_listing_type_code, v_category_id, p_slug, v_title, v_description, p_content_language,
      p_currency_code::char(3), p_price_minor, coalesce(p_is_negotiable, false), 'draft',
      p_country_code::char(2), v_governorate, v_city
    )
    returning listings.slug, listings.status into v_slug, v_status;
  exception
    when unique_violation then
      -- Either the slug is live on another listing or 0011's slug-history trigger refused it because it is
      -- permanently redirected. Both mean the same thing to the caller: choose another address. Which one
      -- it was is not disclosed, because that would say whether a listing had ever existed at that address.
      return query select 'slug_taken'::text, null::text, null::text;
      return;
    when check_violation or foreign_key_violation or restrict_violation or invalid_text_representation
      or not_null_violation then
      return query select 'invalid'::text, null::text, null::text;
      return;
  end;

  return query select 'created'::text, v_slug, v_status;
end;
$function$;

-- seller_listing_tag_choices: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_listing_tag_choices(p_user_id uuid, p_slug text, p_expected_type text, p_locale text)
 RETURNS TABLE(slug text, label text, is_selected boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  with wanted as (
    select coalesce(
      (select l.code from public.locales l
        where l.code = lower(btrim(coalesce(p_locale, ''), E' \t\r\n')) and l.is_active),
      (select l.code from public.locales l where l.is_default limit 1)
    ) as code
  ), target as (
    select l.id
      from public.listings l
     where l.slug = p_slug
       and l.seller_user_id = p_user_id
       and l.deleted_at is null
       and (p_expected_type is null or l.listing_type_code = p_expected_type)
  )
  select
    t.slug,
    case when (select code from wanted) = 'ar' then t.name_ar else t.name_en end,
    exists (select 1 from public.listing_tags lt, target g where lt.tag_id = t.id and lt.listing_id = g.id)
    from public.tags t
   where t.is_active
     and exists (select 1 from target)
   order by t.slug;
$function$;

-- seller_listing_tags_save: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_listing_tags_save(p_user_id uuid, p_slug text, p_expected_type text, p_tag_slugs text[])
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_seller_status text;
  v_listing_id uuid;
  v_listing_status text;
  v_tag_ids uuid[];
begin
  if p_user_id is null then
    return query select 'not_found'::text;
    return;
  end if;

  select s.status into v_seller_status from public.seller_profiles s where s.user_id = p_user_id;
  if v_seller_status is null then
    return query select 'not_found'::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text;
    return;
  end if;

  select l.id, l.status into v_listing_id, v_listing_status
    from public.listings l
   where l.slug = p_slug
     and l.seller_user_id = p_user_id
     and l.deleted_at is null
     and (p_expected_type is null or l.listing_type_code = p_expected_type);

  if v_listing_id is null then
    return query select 'not_found'::text;
    return;
  end if;
  if v_listing_status <> 'draft' then
    return query select 'not_editable'::text;
    return;
  end if;

  select coalesce(array_agg(distinct t.id), array[]::uuid[]) into v_tag_ids
    from unnest(coalesce(p_tag_slugs, array[]::text[])) as s(slug)
    join public.tags t on t.slug = btrim(s.slug, E' \t\r\n') and t.is_active;

  -- An unknown or hidden tag makes the whole selection invalid rather than being dropped, so a seller is never
  -- told their tags were saved when one of them was not.
  if cardinality(v_tag_ids) <> (
       select count(distinct btrim(s.slug, E' \t\r\n'))
         from unnest(coalesce(p_tag_slugs, array[]::text[])) as s(slug)
        where btrim(s.slug, E' \t\r\n') <> ''
     ) then
    return query select 'invalid'::text;
    return;
  end if;
  -- Replace the set. `tg_listing_tags_usage` keeps `tags.usage_count` right on both sides of this.
  delete from public.listing_tags lt
   where lt.listing_id = v_listing_id
     and not (lt.tag_id = any(v_tag_ids));

  insert into public.listing_tags (listing_id, tag_id)
  select v_listing_id, id from unnest(v_tag_ids) as chosen(id)
  on conflict (listing_id, tag_id) do nothing;

  update public.listings l set updated_at = now() where l.id = v_listing_id;
  return query select 'saved'::text;
end;
$function$;

-- seller_listing_update_draft: 4 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_listing_update_draft(p_user_id uuid, p_slug text, p_set_title boolean, p_title text, p_set_description boolean, p_description text, p_set_price_minor boolean, p_price_minor bigint, p_set_is_negotiable boolean, p_is_negotiable boolean, p_set_content_language boolean, p_content_language text, p_set_currency_code boolean, p_currency_code text, p_set_country_code boolean, p_country_code text, p_set_governorate boolean, p_governorate text, p_set_city boolean, p_city text)
 RETURNS TABLE(outcome text, slug text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_seller_status text;
  v_listing_status text;
  v_new_title text;
  v_new_description text;
  v_new_currency char(3);
  v_new_country char(2);
  v_new_governorate text;
  v_new_city text;
  v_slug text;
  v_status text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select s.status into v_seller_status from public.seller_profiles s where s.user_id = p_user_id;
  if v_seller_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  -- The caller's own listing, by slug. A slug owned by somebody else does not match this predicate, so it
  -- answers exactly as one that does not exist.
  select l.status into v_listing_status
    from public.listings l
   where l.slug = p_slug and l.seller_user_id = p_user_id;

  if v_listing_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_listing_status <> 'draft' then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  if p_set_title then
    if p_title is null then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
    v_new_title := btrim(p_title, E' \t\r\n');
    if length(v_new_title) < 3 or length(v_new_title) > 140 then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
  end if;

  if p_set_description then
    if p_description is null then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
    v_new_description := btrim(p_description, E' \t\r\n');
    if length(v_new_description) < 10 or length(v_new_description) > 20000 then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
  end if;

  if p_set_price_minor and p_price_minor is not null and p_price_minor < 0 then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  if p_set_is_negotiable and p_is_negotiable is null then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  if p_set_content_language then
    if p_content_language is null
       or not exists (select 1 from public.locales l where l.code = p_content_language) then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
  end if;

  if p_set_currency_code then
    if p_currency_code is null or length(p_currency_code) <> 3
       or not exists (
         select 1 from public.currencies c
          where c.code = p_currency_code::char(3) and c.is_enabled and c.is_pricing_enabled
       ) then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
    v_new_currency := p_currency_code::char(3);
  end if;

  if p_set_country_code then
    if p_country_code is null or length(p_country_code) <> 2
       or not exists (
         select 1 from public.countries c where c.code = p_country_code::char(2) and c.is_marketplace_enabled
       ) then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
    v_new_country := p_country_code::char(2);
  end if;

  if p_set_governorate then
    v_new_governorate := nullif(btrim(coalesce(p_governorate, ''), E' \t\r\n'), '');
  end if;
  if p_set_city then
    v_new_city := nullif(btrim(coalesce(p_city, ''), E' \t\r\n'), '');
  end if;

  -- Nine columns may be assigned. `slug`, `status`, `seller_user_id`, `listing_type_code`, `category_id`,
  -- `submitted_at`, `approved_at`, `published_at`, `sold_at`, `expires_at`, `archived_at`, `deleted_at`,
  -- `view_count` and `created_at` appear in no assignment and have no parameter. `updated_at` is 0011's
  -- own trigger's, as it is for every write to this table.
  begin
    update public.listings as l
       set title = case when p_set_title then v_new_title else l.title end,
           description = case when p_set_description then v_new_description else l.description end,
           price_minor = case when p_set_price_minor then p_price_minor else l.price_minor end,
           is_negotiable = case when p_set_is_negotiable then p_is_negotiable else l.is_negotiable end,
           content_language = case
             when p_set_content_language then p_content_language else l.content_language
           end,
           currency_code = case when p_set_currency_code then v_new_currency else l.currency_code end,
           country_code = case when p_set_country_code then v_new_country else l.country_code end,
           governorate = case when p_set_governorate then v_new_governorate else l.governorate end,
           city = case when p_set_city then v_new_city else l.city end
     where l.slug = p_slug and l.seller_user_id = p_user_id and l.status = 'draft'
    returning l.slug, l.status into v_slug, v_status;
  exception
    when check_violation or foreign_key_violation or restrict_violation or invalid_text_representation
      or not_null_violation or unique_violation then
      return query select 'invalid'::text, null::text, null::text;
      return;
  end;

  if v_slug is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  return query select 'updated'::text, v_slug, v_status;
end;
$function$;

-- seller_service_create_draft: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_service_create_draft(p_user_id uuid, p_slug text, p_title text, p_description text, p_category_slug text, p_content_language text, p_currency_code text, p_country_code text, p_price_minor bigint, p_is_negotiable boolean, p_governorate text, p_city text, p_pricing_model text, p_delivery_days integer, p_revisions_included integer, p_requires_brief boolean, p_scope text)
 RETURNS TABLE(outcome text, slug text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_outcome text;
  v_slug text;
  v_status text;
  v_listing_id uuid;
begin
  -- The detail fields are validated **before** anything is written. The listing insert happens inside
  -- 6-F's function and is not undone by returning a string, so a detail value that could not be stored has
  -- to be refused while there is still nothing to leave behind.
  if app_private.seller_service_details_problem(
       p_pricing_model, p_delivery_days, p_revisions_included, p_requires_brief, p_scope) then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  -- 6-F's creator, called rather than copied. Every rule it applies — the slug format, the title and
  -- description bounds, the reference vocabularies, the category's type scope, the seller-status gate and
  -- the ownership of the row it writes — is applied here by being the same code.
  select r.outcome, r.slug, r.status
    into v_outcome, v_slug, v_status
    from app_private.seller_listing_create_draft(
      p_user_id, p_slug, p_title, p_description, 'service', p_category_slug, p_content_language,
      p_currency_code, p_country_code, p_price_minor, p_is_negotiable, p_governorate, p_city
    ) r;

  if v_outcome <> 'created' then
    return query select v_outcome, null::text, null::text;
    return;
  end if;

  -- Null model means the seller stated nothing about pricing, so there is no row to write. A service in
  -- that state is exactly what 6-F alone produces, and 0048 will require a price of it to go live.
  if p_pricing_model is not null then
    select l.id into v_listing_id
      from public.listings l
     where l.slug = v_slug and l.seller_user_id = p_user_id;

    insert into public.listing_service_details (
      listing_id, pricing_model, delivery_days, revisions_included, requires_brief, scope
    ) values (
      v_listing_id,
      p_pricing_model,
      p_delivery_days,
      coalesce(p_revisions_included, 0),
      coalesce(p_requires_brief, false),
      nullif(btrim(coalesce(p_scope, ''), E' \t\r\n'), '')
    );
  end if;

  return query select 'created'::text, v_slug, v_status;
end;
$function$;

-- seller_service_details_problem: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_service_details_problem(p_pricing_model text, p_delivery_days integer, p_revisions_included integer, p_requires_brief boolean, p_scope text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    case
      when p_pricing_model is null then
        -- Nothing may be stated without the model it belongs to.
        p_delivery_days is not null
        or p_revisions_included is not null
        or p_requires_brief is not null
        or nullif(btrim(coalesce(p_scope, ''), E' \t\r\n'), '') is not null
      when p_pricing_model not in ('fixed', 'custom') then true
      when p_delivery_days is not null and (p_delivery_days < 1 or p_delivery_days > 365) then true
      -- `listing_service_details_fixed_needs_delivery`, restated as an outcome rather than an exception.
      when p_pricing_model = 'fixed' and p_delivery_days is null then true
      when p_revisions_included is not null and p_revisions_included < 0 then true
      when length(coalesce(p_scope, '')) > 5000 then true
      else false
    end;
$function$;

-- seller_service_update_draft: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_service_update_draft(p_user_id uuid, p_slug text, p_set_title boolean, p_title text, p_set_description boolean, p_description text, p_set_price_minor boolean, p_price_minor bigint, p_set_is_negotiable boolean, p_is_negotiable boolean, p_set_content_language boolean, p_content_language text, p_set_currency_code boolean, p_currency_code text, p_set_country_code boolean, p_country_code text, p_set_governorate boolean, p_governorate text, p_set_city boolean, p_city text, p_set_pricing_model boolean, p_pricing_model text, p_set_delivery_days boolean, p_delivery_days integer, p_set_revisions_included boolean, p_revisions_included integer, p_set_requires_brief boolean, p_requires_brief boolean, p_set_scope boolean, p_scope text)
 RETURNS TABLE(outcome text, slug text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_seller_status text;
  v_listing_id uuid;
  v_listing_status text;
  v_has_details boolean;
  v_pricing_model text;
  v_delivery_days integer;
  v_revisions_included integer;
  v_requires_brief boolean;
  v_scope text;
  v_outcome text;
  v_slug text;
  v_status text;
  v_touches_details boolean;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select s.status into v_seller_status from public.seller_profiles s where s.user_id = p_user_id;
  if v_seller_status is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  -- The caller's own service, by slug. A product, another seller's listing and a slug that does not exist
  -- are one answer, so asking cannot tell them apart.
  select l.id, l.status into v_listing_id, v_listing_status
    from public.listings l
   where l.slug = p_slug
     and l.seller_user_id = p_user_id
     and l.listing_type_code = 'service';

  if v_listing_id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;
  if v_listing_status <> 'draft' then
    return query select 'not_editable'::text, null::text, null::text;
    return;
  end if;

  v_touches_details := coalesce(p_set_pricing_model, false)
    or coalesce(p_set_delivery_days, false)
    or coalesce(p_set_revisions_included, false)
    or coalesce(p_set_requires_brief, false)
    or coalesce(p_set_scope, false);

  if v_touches_details then
    -- The stored row, so the effective values can be computed and checked as a whole: the
    -- `fixed_needs_delivery` constraint is about the pair, not about either field on its own.
    select true, d.pricing_model, d.delivery_days, d.revisions_included, d.requires_brief, d.scope
      into v_has_details, v_pricing_model, v_delivery_days, v_revisions_included, v_requires_brief, v_scope
      from public.listing_service_details d
     where d.listing_id = v_listing_id;
    v_has_details := coalesce(v_has_details, false);

    if p_set_pricing_model then v_pricing_model := p_pricing_model; end if;
    if p_set_delivery_days then v_delivery_days := p_delivery_days; end if;
    if p_set_revisions_included then v_revisions_included := p_revisions_included; end if;
    if p_set_requires_brief then v_requires_brief := p_requires_brief; end if;
    if p_set_scope then v_scope := nullif(btrim(coalesce(p_scope, ''), E' \t\r\n'), ''); end if;

    -- Withdrawing the pricing model withdraws everything that hung off it, because the row itself goes.
    -- The stored delivery time and revision count are *not* carried into the check here: they are about to
    -- cease to exist, and treating them as things the caller is still asserting would refuse a legitimate
    -- withdrawal. A request that withdraws the model while also stating one of those fields is
    -- contradictory, though, and is refused rather than resolved in either direction.
    if p_set_pricing_model and p_pricing_model is null then
      if (coalesce(p_set_delivery_days, false) and p_delivery_days is not null)
         or (coalesce(p_set_revisions_included, false) and p_revisions_included is not null)
         or (coalesce(p_set_requires_brief, false) and p_requires_brief is not null)
         or (coalesce(p_set_scope, false) and nullif(btrim(coalesce(p_scope, ''), E' \t\r\n'), '') is not null) then
        return query select 'invalid'::text, null::text, null::text;
        return;
      end if;
      v_delivery_days := null;
      v_revisions_included := null;
      v_requires_brief := null;
      v_scope := null;
    end if;

    if app_private.seller_service_details_problem(
         v_pricing_model, v_delivery_days, v_revisions_included, v_requires_brief, v_scope) then
      return query select 'invalid'::text, null::text, null::text;
      return;
    end if;
  end if;

  -- 6-F's editor, called rather than copied, for the nine listing columns. It repeats the gates above,
  -- which is deliberate: it stays the authority on them, and this function cannot drift from it.
  select r.outcome, r.slug, r.status
    into v_outcome, v_slug, v_status
    from app_private.seller_listing_update_draft(
      p_user_id, p_slug,
      p_set_title, p_title,
      p_set_description, p_description,
      p_set_price_minor, p_price_minor,
      p_set_is_negotiable, p_is_negotiable,
      p_set_content_language, p_content_language,
      p_set_currency_code, p_currency_code,
      p_set_country_code, p_country_code,
      p_set_governorate, p_governorate,
      p_set_city, p_city
    ) r;

  if v_outcome <> 'updated' then
    return query select v_outcome, null::text, null::text;
    return;
  end if;

  if v_touches_details then
    if v_pricing_model is null then
      -- Every stated fact has been withdrawn. The row says nothing, so it should not exist — and its
      -- absence is a state the schema already has a meaning for.
      delete from public.listing_service_details d where d.listing_id = v_listing_id;
    elsif v_has_details then
      update public.listing_service_details as d
         set pricing_model = v_pricing_model,
             delivery_days = v_delivery_days,
             revisions_included = coalesce(v_revisions_included, 0),
             requires_brief = coalesce(v_requires_brief, false),
             scope = v_scope
       where d.listing_id = v_listing_id;
    else
      insert into public.listing_service_details (
        listing_id, pricing_model, delivery_days, revisions_included, requires_brief, scope
      ) values (
        v_listing_id, v_pricing_model, v_delivery_days, coalesce(v_revisions_included, 0),
        coalesce(v_requires_brief, false), v_scope
      );
    end if;
  end if;

  return query select 'updated'::text, v_slug, v_status;
end;
$function$;

-- seller_update_profile: 7 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_update_profile(p_user_id uuid, p_set_display_name boolean, p_display_name text, p_set_legal_name boolean, p_legal_name text, p_set_bio boolean, p_bio text, p_set_content_language boolean, p_content_language text, p_set_country_code boolean, p_country_code text, p_set_governorate boolean, p_governorate text, p_set_city boolean, p_city text, p_set_contact_email boolean, p_contact_email text, p_set_contact_phone_e164 boolean, p_contact_phone_e164 text)
 RETURNS TABLE(outcome text, slug text, display_name text, status text, verification_status text, city text, country_code character)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  -- Everything the function returns lives in a local first, so the final SELECT reads no table and the OUT
  -- parameter names above can never be mistaken for columns.
  v_outcome text;
  v_slug text;
  v_display_name text;
  v_status text;
  v_verification text;
  v_city text;
  v_country char(2);
  v_current_status text;
  -- The normalised values, computed once, used only where their `p_set_*` flag is true.
  v_new_display_name text;
  v_new_legal_name text;
  v_new_bio text;
  v_new_governorate text;
  v_new_city text;
  v_new_email text;
  v_new_phone text;
  v_new_country char(2);
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- The caller's own storefront, and the gate on its state. Read before anything is validated so that a
  -- suspended seller gets the same answer whatever they sent: a refusal that depended on the body would
  -- tell them which of their fields the system considered acceptable.
  select s.status into v_current_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_current_status is null then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  if v_current_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  -- Validation. Each block runs only when its field is actually being set, so a request that touches one
  -- field is never refused because of another it did not mention.
  if p_set_display_name then
    -- `not null` in the table: it can be changed, never cleared.
    if p_display_name is null then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
    v_new_display_name := btrim(p_display_name, E' \t\r\n');
    -- `seller_profiles_display_name_length`: 2..80 on the trimmed value.
    if length(v_new_display_name) < 2 or length(v_new_display_name) > 80 then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  if p_set_legal_name then
    v_new_legal_name := nullif(btrim(coalesce(p_legal_name, ''), E' \t\r\n'), '');
  end if;

  if p_set_bio then
    v_new_bio := nullif(btrim(coalesce(p_bio, ''), E' \t\r\n'), '');
    -- `seller_profiles_bio_length`.
    if v_new_bio is not null and length(v_new_bio) > 2000 then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  if p_set_content_language then
    -- A foreign key onto `public.locales`; existence is the constraint, so existence is what is checked.
    if p_content_language is not null
       and not exists (select 1 from public.locales l where l.code = p_content_language) then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  if p_set_country_code then
    -- `not null` in the table, and D17: it must exist and be marketplace-enabled. Answered as an outcome
    -- rather than left to 0009's trigger, which raises on UPDATE exactly as it does on INSERT.
    if p_country_code is null or length(p_country_code) <> 2 then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
    if not exists (
      select 1 from public.countries c
       where c.code = p_country_code::char(2) and c.is_marketplace_enabled
    ) then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
    v_new_country := p_country_code::char(2);
  end if;

  if p_set_governorate then
    v_new_governorate := nullif(btrim(coalesce(p_governorate, ''), E' \t\r\n'), '');
  end if;

  if p_set_city then
    v_new_city := nullif(btrim(coalesce(p_city, ''), E' \t\r\n'), '');
  end if;

  if p_set_contact_email then
    v_new_email := nullif(btrim(coalesce(p_contact_email, ''), E' \t\r\n'), '');
    -- 0058's floor beneath the API's strict contract: 0009 constrains this column's type and nothing else.
    if v_new_email is not null
       and (length(v_new_email) > 320 or v_new_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  if p_set_contact_phone_e164 then
    v_new_phone := nullif(btrim(coalesce(p_contact_phone_e164, ''), E' \t\r\n'), '');
    -- `seller_profiles_phone_format`.
    if v_new_phone is not null and v_new_phone !~ '^\+[1-9][0-9]{6,14}$' then
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
    end if;
  end if;

  -- The write. Nine columns may be assigned and no others appear: `slug`, `status`, `verification_status`,
  -- the suspension and closure columns, the verification timestamp and `created_at` are absent from this
  -- statement entirely, and `user_id` appears only in the `where` clause that scopes the row to its owner.
  begin
    update public.seller_profiles as s
       set display_name = case when p_set_display_name then v_new_display_name else s.display_name end,
           legal_name = case when p_set_legal_name then v_new_legal_name else s.legal_name end,
           bio = case when p_set_bio then v_new_bio else s.bio end,
           content_language = case when p_set_content_language then p_content_language else s.content_language end,
           country_code = case when p_set_country_code then v_new_country else s.country_code end,
           governorate = case when p_set_governorate then v_new_governorate else s.governorate end,
           city = case when p_set_city then v_new_city else s.city end,
           contact_email = case
             when p_set_contact_email then v_new_email::extensions.citext
             else s.contact_email
           end,
           contact_phone_e164 = case
             when p_set_contact_phone_e164 then v_new_phone
             else s.contact_phone_e164
           end
     where s.user_id = p_user_id
    returning s.slug, s.display_name, s.status, s.verification_status, s.city, s.country_code
      into v_slug, v_display_name, v_status, v_verification, v_city, v_country;
  exception
    when check_violation or foreign_key_violation or restrict_violation or invalid_text_representation
      or unique_violation then
      -- The constraints are still the authority. Anything they refuse that the checks above let through is
      -- a gap in those checks, and it answers as an ordinary validation failure rather than a 500.
      return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
      return;
  end;

  if v_slug is null then
    -- The row disappeared between the status read and the write. Not an error: the same `not_found` the
    -- caller would have got a moment earlier.
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text, null::char(2);
    return;
  end if;

  v_outcome := 'updated';
  return query select v_outcome, v_slug, v_display_name, v_status, v_verification, v_city, v_country;
end;
$function$;

-- seller_verification_document_attach: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seller_verification_document_attach(p_user_id uuid, p_document_type text, p_object_path text, p_original_filename text, p_content_type text, p_byte_size bigint)
 RETURNS TABLE(outcome text, document_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_slug text;
  v_seller_status text;
  v_verification_id uuid;
  v_bucket text := 'verification-documents';
  v_limit bigint;
  v_allowed text[];
  v_expected_prefix text;
  v_tail text;
begin
  if p_user_id is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;

  select s.slug, s.status into v_slug, v_seller_status
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_slug is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text, null::integer;
    return;
  end if;

  select v.id into v_verification_id
    from public.seller_verifications v
   where v.seller_user_id = p_user_id
     and v.status in ('draft', 'submitted');

  if v_verification_id is null then
    return query select 'not_found'::text, null::integer;
    return;
  end if;

  if p_document_type is null or p_document_type not in
     ('national_id', 'passport', 'commercial_register', 'tax_card', 'bank_statement', 'other') then
    return query select 'invalid'::text, null::integer;
    return;
  end if;

  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    return query select 'invalid'::text, null::integer;
    return;
  end if;
  if p_content_type is null or not (p_content_type = any (v_allowed)) then
    return query select 'invalid'::text, null::integer;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::integer;
    return;
  end if;

  -- The prefix is rebuilt from the caller's own slug and the validated type. A path for another seller, for
  -- another type, for another bucket, or with anything before the prefix, cannot match it.
  v_expected_prefix := v_bucket || '/' || v_slug || '/' || p_document_type || '/';
  if p_object_path is null or left(p_object_path, length(v_expected_prefix)) <> v_expected_prefix then
    return query select 'invalid'::text, null::integer;
    return;
  end if;

  -- And the remainder must be one plain file name of the shape the target issues: a uuid and one of the three
  -- extensions. No slash, so nothing can be nested below the namespace; no dot-segment, so `..` is
  -- unrepresentable; no control character, no backslash, no encoded separator.
  v_tail := substr(p_object_path, length(v_expected_prefix) + 1);
  if v_tail !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$' then
    return query select 'invalid'::text, null::integer;
    return;
  end if;

  -- `status` is not assigned: the row takes 0009's own default of `pending`, and there is no parameter for
  -- it. `review_note`, `reviewed_at` and `reviewed_by` appear in no column list here, so a seller cannot
  -- write a reviewer's field even by accident.
  begin
    insert into public.seller_verification_documents (
      verification_id, document_type, object_path, original_filename, content_type, byte_size
    ) values (
      v_verification_id,
      p_document_type,
      p_object_path,
      nullif(btrim(coalesce(p_original_filename, ''), E' \t\r\n'), ''),
      p_content_type,
      p_byte_size
    );
  exception
    when unique_violation then
      -- `seller_verification_documents_path` is unique across the table: that object is already recorded.
      -- Which attempt it belongs to is not disclosed.
      return query select 'path_taken'::text, null::integer;
      return;
    when check_violation or foreign_key_violation or restrict_violation then
      return query select 'invalid'::text, null::integer;
      return;
  end;

  return query select 'attached'::text,
    (select count(*)::integer from public.seller_verification_documents d
      where d.verification_id = v_verification_id);
end;
$function$;

-- seo_metadata_save_for_staff: 11 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seo_metadata_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_entity_type text, p_entity_id uuid, p_route_path text, p_locale_code text, p_meta_title text DEFAULT NULL::text, p_meta_description text DEFAULT NULL::text, p_canonical_path text DEFAULT NULL::text, p_robots_directives text[] DEFAULT NULL::text[], p_og_title text DEFAULT NULL::text, p_og_description text DEFAULT NULL::text, p_share_media_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  saved_id uuid;
  directives text[] := coalesce(p_robots_directives, array['index', 'follow']);
begin
  if not app_private.seo_metadata_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.metadata.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Writing one locale of one entity is one request whether or not a row is there already: an operator editing a
  -- description does not care which, and two endpoints would mean a console having to find out first.
  --
  -- The conflict target is chosen by kind rather than guessed, because 0030 has two partial unique indexes and
  -- they cover disjoint sets of rows: `(route_path, locale_code)` for a route and
  -- `(entity_type, entity_id, locale_code)` for everything else.
  if p_entity_type = 'route' then
    insert into public.seo_metadata (
      entity_type, entity_id, route_path, locale_code, meta_title, meta_description, canonical_path,
      robots_directives, og_title, og_description, share_media_id, updated_by
    )
    values (
      'route', null, btrim(p_route_path, E' \t\r\n'), p_locale_code,
      nullif(btrim(coalesce(p_meta_title, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_meta_description, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_canonical_path, ''), E' \t\r\n'), ''),
      directives,
      nullif(btrim(coalesce(p_og_title, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_og_description, ''), E' \t\r\n'), ''),
      p_share_media_id,
      p_user_id
    )
    on conflict (route_path, locale_code) where route_path is not null do update
      set meta_title = excluded.meta_title,
          meta_description = excluded.meta_description,
          canonical_path = excluded.canonical_path,
          robots_directives = excluded.robots_directives,
          og_title = excluded.og_title,
          og_description = excluded.og_description,
          share_media_id = excluded.share_media_id,
          updated_by = excluded.updated_by
      returning id into saved_id;
  else
    insert into public.seo_metadata (
      entity_type, entity_id, route_path, locale_code, meta_title, meta_description, canonical_path,
      robots_directives, og_title, og_description, share_media_id, updated_by
    )
    values (
      p_entity_type, p_entity_id, null, p_locale_code,
      nullif(btrim(coalesce(p_meta_title, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_meta_description, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_canonical_path, ''), E' \t\r\n'), ''),
      directives,
      nullif(btrim(coalesce(p_og_title, ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(p_og_description, ''), E' \t\r\n'), ''),
      p_share_media_id,
      p_user_id
    )
    on conflict (entity_type, entity_id, locale_code) where entity_id is not null do update
      set meta_title = excluded.meta_title,
          meta_description = excluded.meta_description,
          canonical_path = excluded.canonical_path,
          robots_directives = excluded.robots_directives,
          og_title = excluded.og_title,
          og_description = excluded.og_description,
          share_media_id = excluded.share_media_id,
          updated_by = excluded.updated_by
      returning id into saved_id;
  end if;

  return saved_id;
end;
$function$;

-- seo_settings_delete_for_staff: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seo_settings_delete_for_staff(p_user_id uuid, p_is_aal2 boolean, p_locale_code text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  deleted integer;
begin
  if not app_private.seo_settings_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.settings.manage is required' using errcode = 'insufficient_privilege';
  end if;

  delete from public.seo_settings s
   where s.locale_code = nullif(btrim(coalesce(p_locale_code, ''), E' \t\r\n'), '');

  get diagnostics deleted = row_count;
  return deleted = 1;
end;
$function$;

-- seo_settings_save_for_staff: 5 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.seo_settings_save_for_staff(p_user_id uuid, p_is_aal2 boolean, p_locale_code text, p_site_name text, p_default_meta_title text DEFAULT NULL::text, p_default_meta_description text DEFAULT NULL::text, p_default_share_media_id uuid DEFAULT NULL::uuid, p_twitter_site text DEFAULT NULL::text, p_robots_txt_body text DEFAULT NULL::text, p_organization_structured_data jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  target_locale text;
begin
  if not app_private.seo_settings_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.settings.manage is required' using errcode = 'insufficient_privilege';
  end if;

  select l.code into target_locale
    from public.locales l
   where l.code = nullif(btrim(coalesce(p_locale_code, ''), E' \t\r\n'), '')
     and l.is_active;

  if target_locale is null then
    return false;
  end if;

  insert into public.seo_settings (
    locale_code, site_name, default_meta_title, default_meta_description, default_share_media_id,
    twitter_site, robots_txt_body, organization_structured_data, updated_by
  )
  values (
    target_locale,
    -- Required, because 0030 declares the column `not null`. A blank one is refused by 0030's own
    -- `seo_settings_site_name_length`, which is where that rule lives.
    btrim(coalesce(p_site_name, ''), E' \t\r\n'),
    nullif(btrim(coalesce(p_default_meta_title, ''), E' \t\r\n'), ''),
    nullif(btrim(coalesce(p_default_meta_description, ''), E' \t\r\n'), ''),
    p_default_share_media_id,
    nullif(btrim(coalesce(p_twitter_site, ''), E' \t\r\n'), ''),
    -- The one field whose interior is never touched: it is served to crawlers verbatim. Surrounding whitespace
    -- is removed and a body that is nothing but whitespace is stored as absent, so an accidental blank document
    -- is "nothing authored" rather than a crawl policy that says nothing. Interior newlines are the author's.
    case when btrim(coalesce(p_robots_txt_body, ''), E' \t\r\n') = '' then null
         else btrim(p_robots_txt_body, E' \t\r\n') end,
    coalesce(p_organization_structured_data, '{}'::jsonb),
    p_user_id
  )
  on conflict (locale_code) do update
    set site_name = excluded.site_name,
        default_meta_title = excluded.default_meta_title,
        default_meta_description = excluded.default_meta_description,
        default_share_media_id = excluded.default_share_media_id,
        twitter_site = excluded.twitter_site,
        robots_txt_body = excluded.robots_txt_body,
        organization_structured_data = excluded.organization_structured_data,
        updated_by = excluded.updated_by;

  return true;
end;
$function$;

-- service_quote_create: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.service_quote_create(p_seller_id uuid, p_request_id uuid, p_amount_minor bigint, p_delivery_days smallint, p_revisions_included smallint, p_scope text, p_valid_for_days smallint)
 RETURNS TABLE(outcome text, quote_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_row public.service_requests;
  v_scope text := nullif(btrim(coalesce(p_scope, ''), E' \t\r\n'), '');
  v_quote_id uuid;
begin
  if p_seller_id is null or p_request_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's own column rules, answered as outcomes. The validity window shares `delivery_days`'s bound.
  if p_amount_minor is null or p_amount_minor <= 0
     or p_delivery_days is null or p_delivery_days < 1 or p_delivery_days > 365
     or p_revisions_included is null or p_revisions_included < 0
     or v_scope is null or length(v_scope) < 10 or length(v_scope) > 10000
     or p_valid_for_days is null or p_valid_for_days < 1 or p_valid_for_days > 365 then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  -- Locked and scoped in one statement: another storefront's request is never matched.
  select * into v_row
    from public.service_requests r
   where r.id = p_request_id and r.seller_user_id = p_seller_id
     for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- The same window 0015's trigger enforces, reported rather than raised.
  if v_row.status not in ('open', 'quoted') then
    return query select 'conflict'::text, null::uuid, v_row.status;
    return;
  end if;
  if public.is_blocked_between(v_row.buyer_user_id, v_row.seller_user_id) then
    return query select 'blocked'::text, null::uuid, v_row.status;
    return;
  end if;

  insert into public.service_quotes (
    service_request_id, currency_code, seller_user_id, amount_minor, delivery_days,
    revisions_included, scope, expires_at
  )
  values (
    v_row.id, v_row.currency_code, p_seller_id, p_amount_minor, p_delivery_days,
    p_revisions_included, v_scope, now() + make_interval(days => p_valid_for_days)
  )
  returning id into v_quote_id;

  return query select 'created'::text, v_quote_id, 'sent'::text;
end;
$function$;

-- service_request_create: 2 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.service_request_create(p_buyer_id uuid, p_listing_id uuid, p_title text, p_brief text, p_budget_minor bigint DEFAULT NULL::bigint, p_needed_by date DEFAULT NULL::date)
 RETURNS TABLE(outcome text, request_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_seller uuid;
  v_currency char(3);
  v_listing_status text;
  v_pricing text;
  v_title text := nullif(btrim(coalesce(p_title, ''), E' \t\r\n'), '');
  v_brief text := nullif(btrim(coalesce(p_brief, ''), E' \t\r\n'), '');
  v_request_id uuid;
begin
  if p_buyer_id is null or p_listing_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's own length and budget rules, answered as an outcome rather than as a constraint violation.
  if v_title is null or length(v_title) < 3 or length(v_title) > 140
     or v_brief is null or length(v_brief) < 10 or length(v_brief) > 10000
     or (p_budget_minor is not null and p_budget_minor <= 0) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  select l.seller_user_id, l.currency_code, l.status
    into v_seller, v_currency, v_listing_status
    from public.listings l where l.id = p_listing_id;

  if v_seller is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if not public.listing_status_is_purchasable(v_listing_status) then
    return query select 'not_available'::text, null::uuid, null::text;
    return;
  end if;

  -- v5.2: fixed-price services go through the cart; only a custom service runs request → quote.
  select d.pricing_model into v_pricing
    from public.listing_service_details d where d.listing_id = p_listing_id;
  if v_pricing is distinct from 'custom' then
    return query select 'not_custom'::text, null::uuid, null::text;
    return;
  end if;

  -- `service_requests_not_self`, as an outcome.
  if v_seller = p_buyer_id then
    return query select 'own_listing'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's `service_requests_buyer_insert` also refuses a blocked pair; `app_system` is not bound by that
  -- policy, so the rule is applied here instead of being lost.
  if public.is_blocked_between(p_buyer_id, v_seller) then
    return query select 'blocked'::text, null::uuid, null::text;
    return;
  end if;

  insert into public.service_requests (
    currency_code, listing_id, buyer_user_id, seller_user_id, title, brief, budget_minor, needed_by
  )
  values (v_currency, p_listing_id, p_buyer_id, v_seller, v_title, v_brief, p_budget_minor, p_needed_by)
  returning id into v_request_id;

  return query select 'created'::text, v_request_id, 'open'::text;
end;
$function$;

-- service_request_create_admin_only: 4 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.service_request_create_admin_only(p_buyer_id uuid, p_title text, p_brief text, p_preferred_payment_method text, p_payment_notes text DEFAULT NULL::text, p_budget_minor bigint DEFAULT NULL::bigint, p_needed_by date DEFAULT NULL::date)
 RETURNS TABLE(outcome text, request_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_currency char(3);
  v_title text := nullif(btrim(coalesce(p_title, ''), E' \t\r\n'), '');
  v_brief text := nullif(btrim(coalesce(p_brief, ''), E' \t\r\n'), '');
  v_method text := nullif(btrim(coalesce(p_preferred_payment_method, ''), E' \t\r\n'), '');
  v_notes text := nullif(btrim(coalesce(p_payment_notes, ''), E' \t\r\n'), '');
  v_request_id uuid;
begin
  if p_buyer_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  -- 0015's own length and budget rules, plus D7-09's two bounds, answered as an outcome rather than as a
  -- constraint violation. The payment method is required here because the table cannot require it: the
  -- retention job clears it.
  if v_title is null or length(v_title) < 3 or length(v_title) > 140
     or v_brief is null or length(v_brief) < 10 or length(v_brief) > 10000
     or v_method is null or length(v_method) > 120
     or (v_notes is not null and length(v_notes) > 2000)
     or (p_budget_minor is not null and p_budget_minor <= 0) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  -- The existing authoritative default. Never a parameter, never a literal.
  select c.code into v_currency from public.currencies c where c.is_default;
  if v_currency is null then
    return query select 'no_currency'::text, null::uuid, null::text;
    return;
  end if;

  insert into public.service_requests (
    currency_code, listing_id, buyer_user_id, seller_user_id, routing_mode,
    title, brief, budget_minor, needed_by, preferred_payment_method, payment_notes
  )
  values (
    v_currency, null, p_buyer_id, null, 'admin_only',
    v_title, v_brief, p_budget_minor, p_needed_by, v_method, v_notes
  )
  returning id into v_request_id;

  return query select 'created'::text, v_request_id, 'open'::text;
end;
$function$;

-- support_attachment_attach_for_requester: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.support_attachment_attach_for_requester(p_user_id uuid, p_ticket_id uuid, p_message_id uuid, p_object_path text, p_original_filename text, p_content_type text, p_byte_size bigint)
 RETURNS TABLE(outcome text, attachment_id uuid, attachment_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_bucket text := 'support-attachments';
  v_status text;
  v_limit bigint;
  v_allowed text[];
  v_expected_prefix text;
  v_tail text;
  v_attachment_id uuid;
begin
  if p_user_id is null or p_ticket_id is null or p_message_id is null then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;

  select t.status into v_status
    from public.support_messages m
    join public.support_tickets t on t.id = m.support_ticket_id
   where m.id = p_message_id
     and m.support_ticket_id = p_ticket_id
     and t.requester_user_id = p_user_id
     and m.author_user_id = p_user_id
     and m.author_role = 'requester'
   for update of t;

  if v_status is null then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  if v_status = 'closed' then
    return query select 'conflict'::text, null::uuid, null::integer;
    return;
  end if;

  select b.file_size_limit, b.allowed_mime_types into v_limit, v_allowed
    from storage.buckets b
   where b.id = v_bucket;

  if v_limit is null or v_allowed is null then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  if p_content_type is null or not (p_content_type = any (v_allowed)) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_limit then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  v_expected_prefix := v_bucket || '/' || p_ticket_id::text || '/' || p_message_id::text || '/';
  if p_object_path is null or left(p_object_path, length(v_expected_prefix)) <> v_expected_prefix then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  v_tail := substr(p_object_path, length(v_expected_prefix) + 1);
  if v_tail !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$' then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  -- One object, one row. `support_attachments` carries **no unique index on `object_path`** — 0028 defined
  -- none, and adding one would be a change to an existing table rather than an addition to the boundary —
  -- so the rule is applied here instead: a confirmation that arrives twice records the file once. The
  -- ticket is already locked above, so the two attempts of a retrying client serialize and the second one
  -- sees the first one's row.
  if exists (select 1 from public.support_attachments a where a.object_path = p_object_path) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  begin
    insert into public.support_attachments (
      support_message_id, object_path, original_filename, content_type, byte_size
    ) values (
      p_message_id,
      p_object_path,
      nullif(btrim(coalesce(p_original_filename, ''), E' \t\r\n'), ''),
      p_content_type,
      p_byte_size
    )
    returning id into v_attachment_id;
  exception
    when unique_violation or check_violation or foreign_key_violation or restrict_violation then
      return query select 'invalid'::text, null::uuid, null::integer;
      return;
  end;

  return query select 'attached'::text,
                      v_attachment_id,
                      (select count(*)::integer from public.support_attachments a
                        where a.support_message_id = p_message_id);
end;
$function$;

-- support_message_post_for_agent: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.support_message_post_for_agent(p_user_id uuid, p_is_aal2 boolean, p_ticket_id uuid, p_body text)
 RETURNS TABLE(outcome text, message_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  ticket public.support_tickets;
  v_message_id uuid;
  v_status text;
begin
  if p_user_id is null or p_ticket_id is null
     or not app_private.support_staff_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- `support_messages_body_length`.
  if p_body is null or length(btrim(p_body, E' \t\r\n')) < 1 or length(btrim(p_body, E' \t\r\n')) > 8000 then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.assigned_to = p_user_id
   for update;

  if ticket.id is null then
    -- Not theirs, nobody's, or nothing at all. The console's remedy for the middle case is to claim it,
    -- which it knows from the ticket read rather than from a distinct refusal here.
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if ticket.status = 'closed' then
    return query select 'conflict'::text, null::uuid, null::text;
    return;
  end if;

  begin
    v_message_id := app_private.post_support_message(p_ticket_id, p_user_id, btrim(p_body, E' \t\r\n'));
  exception
    when insufficient_privilege or check_violation or restrict_violation or foreign_key_violation then
      return query select 'invalid'::text, null::uuid, null::text;
      return;
  end;

  select t.status into v_status from public.support_tickets t where t.id = p_ticket_id;
  return query select 'posted'::text, v_message_id, v_status;
end;
$function$;

-- support_message_post_for_requester: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.support_message_post_for_requester(p_user_id uuid, p_ticket_id uuid, p_body text)
 RETURNS TABLE(outcome text, message_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  ticket public.support_tickets;
  v_message_id uuid;
  v_status text;
begin
  if p_user_id is null or p_ticket_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if p_body is null or length(btrim(p_body, E' \t\r\n')) < 1 or length(btrim(p_body, E' \t\r\n')) > 8000 then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  -- Locked, so two replies and a staff closure serialize rather than interleave.
  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.requester_user_id = p_user_id
   for update;

  if ticket.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if ticket.status = 'closed' then
    return query select 'conflict'::text, null::uuid, null::text;
    return;
  end if;

  begin
    v_message_id := app_private.post_support_message(p_ticket_id, p_user_id, btrim(p_body, E' \t\r\n'));
  exception
    when check_violation or restrict_violation or foreign_key_violation then
      return query select 'invalid'::text, null::uuid, null::text;
      return;
  end;

  select t.status into v_status from public.support_tickets t where t.id = p_ticket_id;
  return query select 'posted'::text, v_message_id, v_status;
end;
$function$;

-- support_note_add_for_agent: 3 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.support_note_add_for_agent(p_user_id uuid, p_is_aal2 boolean, p_ticket_id uuid, p_body text)
 RETURNS TABLE(outcome text, note_id uuid, note_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  ticket public.support_tickets;
  v_note_id uuid;
begin
  if p_user_id is null or p_ticket_id is null
     or not app_private.support_staff_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  -- `support_internal_notes_body_length`.
  if p_body is null or length(btrim(p_body, E' \t\r\n')) < 1 or length(btrim(p_body, E' \t\r\n')) > 8000 then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  select * into ticket
    from public.support_tickets t
   where t.id = p_ticket_id
     and t.assigned_to = p_user_id
   for update;

  if ticket.id is null then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  -- A closed ticket takes no further note, for the same reason it takes no further message: nothing is
  -- being worked on any more. 0028 does not refuse this itself, so it is refused here rather than allowed
  -- to accumulate notes on finished work.
  if ticket.status = 'closed' then
    return query select 'conflict'::text, null::uuid, null::integer;
    return;
  end if;

  begin
    v_note_id := app_private.add_support_internal_note(p_ticket_id, p_user_id, btrim(p_body, E' \t\r\n'));
  exception
    when insufficient_privilege or check_violation or restrict_violation or foreign_key_violation then
      return query select 'invalid'::text, null::uuid, null::integer;
      return;
  end;

  return query select 'added'::text,
                      v_note_id,
                      (select count(*)::integer from public.support_internal_notes n
                        where n.support_ticket_id = p_ticket_id);
end;
$function$;

-- support_ticket_open_for_requester: 6 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.support_ticket_open_for_requester(p_user_id uuid, p_subject text, p_category text, p_body text)
 RETURNS TABLE(outcome text, ticket_id uuid, message_id uuid, reference text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_ticket_id uuid;
  v_message_id uuid;
  v_reference text;
  v_status text;
begin
  if p_user_id is null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  -- `support_tickets_subject_length`, restated as a refusal rather than left to become an exception.
  if p_subject is null or length(btrim(p_subject, E' \t\r\n')) < 1 or length(btrim(p_subject, E' \t\r\n')) > 200 then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  -- `support_messages_body_length`.
  if p_body is null or length(btrim(p_body, E' \t\r\n')) < 1 or length(btrim(p_body, E' \t\r\n')) > 8000 then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  -- `support_tickets_category_allowed`, written out so this function refuses exactly what the table
  -- refuses. A ninth value is not creatable here or there.
  if p_category is null or p_category not in (
    'account', 'orders', 'payments', 'payouts', 'listings', 'verification', 'technical', 'other'
  ) then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;

  begin
    -- 0028's writer, unchanged, with its own defaults for priority and the related order.
    v_ticket_id := app_private.open_support_ticket(p_user_id, btrim(p_subject, E' \t\r\n'), p_category, btrim(p_body, E' \t\r\n'));
  exception
    when check_violation or foreign_key_violation or restrict_violation or invalid_parameter_value then
      return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text;
      return;
  end;

  -- Read back what that writer created, rather than assuming it: the status is whatever
  -- `post_support_message` left the row at, and the reference is the generator's.
  select t.reference, t.status into v_reference, v_status
    from public.support_tickets t where t.id = v_ticket_id;

  -- The one message the writer posted, so an attachment can be recorded against it without a second
  -- round trip that would have to find it by guessing.
  select m.id into v_message_id
    from public.support_messages m
   where m.support_ticket_id = v_ticket_id
   order by m.created_at, m.id
   limit 1;

  return query select 'created'::text, v_ticket_id, v_message_id, v_reference, v_status;
end;
$function$;

-- tg_sync_profile_from_auth: 5 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.tg_sync_profile_from_auth()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
begin
  if tg_op = 'INSERT' then
    insert into public.profiles (id, display_name, full_name, phone_e164, email_verified_at, phone_verified_at)
    values (
      new.id,
      nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''), E' \t\r\n'), ''),
      nullif(btrim(coalesce(new.phone, ''), E' \t\r\n'), ''),
      new.email_confirmed_at,
      new.phone_confirmed_at
    )
    on conflict (id) do nothing;
    insert into public.user_settings (user_id) values (new.id) on conflict (user_id) do nothing;
    return new;
  end if;

  update public.profiles p
     set phone_e164 = nullif(btrim(coalesce(new.phone, ''), E' \t\r\n'), ''),
         email_verified_at = new.email_confirmed_at,
         phone_verified_at = new.phone_confirmed_at
   where p.id = new.id
     and (p.phone_e164 is distinct from nullif(btrim(coalesce(new.phone, ''), E' \t\r\n'), '')
       or p.email_verified_at is distinct from new.email_confirmed_at
       or p.phone_verified_at is distinct from new.phone_confirmed_at);
  return new;
end;
$function$;

-- verification_review_decide: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.verification_review_decide(p_reviewer_id uuid, p_is_aal2 boolean, p_verification_id uuid, p_decision text, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_row public.seller_verifications;
  v_reason text := nullif(btrim(coalesce(p_reason, ''), E' \t\r\n'), '');
begin
  if p_verification_id is null
     or not app_private.verification_reviewer_can_review(p_reviewer_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- Only the two decisions the reviewer surface makes. No other status is reachable from this function:
  -- `draft` and `submitted` belong to the seller (0063), `under_review` is not claimed here, and
  -- `expired` is nobody's to set from a review screen.
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  select * into v_row from public.seller_verifications v where v.id = p_verification_id for update;

  if v_row.id is null or v_row.status = 'draft' then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- Already decided, or expired: the existing model has no transition out of those from a review screen.
  if v_row.status not in ('submitted', 'under_review') then
    return query select 'conflict'::text, v_row.status;
    return;
  end if;

  -- 0009's `seller_verifications_rejection_has_reason`, answered as an outcome rather than as a failed
  -- statement so the surface can ask for the field instead of showing an error.
  if p_decision = 'rejected' and v_reason is null then
    return query select 'reason_required'::text, v_row.status;
    return;
  end if;

  -- 0009's `seller_verifications_approval_needs_contacts`, for the same reason.
  if p_decision = 'approved'
     and (v_row.email_verified_at is null or v_row.phone_verified_at is null) then
    return query select 'contacts_unverified'::text, v_row.status;
    return;
  end if;

  update public.seller_verifications v
     set status = p_decision,
         reviewed_at = now(),
         reviewed_by = p_reviewer_id,
         decision_reason = v_reason
   where v.id = p_verification_id
     and v.status in ('submitted', 'under_review');

  if not found then
    -- Lost to a concurrent decision between the lock and the write. Report what the row now says.
    select * into v_row from public.seller_verifications v where v.id = p_verification_id;
    return query select 'conflict'::text, v_row.status;
    return;
  end if;

  return query select 'decided'::text, p_decision;
end;
$function$;

-- verify_contact_change_otp: 1 loose btrim call(s)
CREATE OR REPLACE FUNCTION app_private.verify_contact_change_otp(p_challenge_id uuid, p_code_hash bytea, p_user_id uuid)
 RETURNS TABLE(outcome text, new_phone_e164 text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_purpose text;
  v_owner uuid;
  v_destination bytea;
  v_outcome text;
  v_phone text;
begin
  if p_code_hash is null then
    raise exception 'code hash is required' using errcode = '22023';
  end if;
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;

  select c.purpose, c.user_id, c.destination_hash
    into v_purpose, v_owner, v_destination
    from app_private.otp_challenges c
   where c.id = p_challenge_id;

  -- A challenge of another purpose, or belonging to someone else, is reported as not found. Saying
  -- "wrong account" would confirm that a challenge exists under that id for somebody.
  if v_purpose is distinct from 'phone_verify' or v_owner is distinct from p_user_id then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- 0035 owns the comparison, the attempt count and the single consumption, under its own row lock.
  v_outcome := app_private.verify_otp_challenge(p_challenge_id, p_code_hash);
  if v_outcome <> 'verified' then
    return query select v_outcome, null::text;
    return;
  end if;

  -- The number the code was actually sent to, read back from the outbox row that carried it. Matching
  -- by digest means this function trusts the challenge, not the caller: a caller cannot name a different
  -- number than the one it proved control of.
  select w.to_phone_e164
    into v_phone
    from public.whatsapp_outbox w
   where w.recipient_user_id = p_user_id
     and sha256(convert_to(lower(btrim(w.to_phone_e164, E' \t\r\n')), 'UTF8')) = v_destination
   order by w.created_at desc
   limit 1;

  if v_phone is null then
    -- The code was correct and is now spent, but the destination cannot be resolved, so the caller must
    -- not change anything. A fresh request starts a new challenge.
    return query select 'destination_unavailable'::text, null::text;
    return;
  end if;

  return query select 'verified'::text, v_phone;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 4. The detector, and the verification that uses it
-- ---------------------------------------------------------------------------------------------------
-- A regular expression cannot answer this question. `btrim\([^,)]*\)` looks like it finds a loose call and
-- does not: the commonest shape in this codebase is `btrim(coalesce(x, ''))`, whose inner comma and parens
-- defeat it. The first draft of this migration used exactly that pattern, and its verification block passed
-- while two financial constraints and one function were still loose — a check reporting success for work it had
-- not inspected, which is worse than no check at all.
--
-- So the detector counts instead: how many `btrim(` calls are in the text, less how many times the character
-- set appears. The set has two spellings — the ten characters a migration types and the four control
-- characters the catalogue stores — and both are subtracted, so one function answers for `prosrc` and for
-- `pg_get_constraintdef` alike. A non-zero answer means some call has no character set.
--
-- The needle lengths are measured rather than written down. They were written down in the first draft and one
-- of them was wrong by one, which made every strict call look loose.
create or replace function app_private.loose_btrim_count(p_text text) returns integer
language sql
immutable
as $fn$
  with needles as (
    select 'E'' \t\r\n''' as typed,
           E' \t\r\n' as stored
  )
  select greatest(
    0,
    -- `\m` is a word boundary, so a function somebody later calls `safe_btrim(` is not counted as this one.
    -- A gate that refuses a legitimate migration is as much a defect as one that admits a bad migration.
    regexp_count(coalesce(p_text, ''), '\mbtrim[[:space:]]*\(', 1)
    - (length(coalesce(p_text, '')) - length(replace(coalesce(p_text, ''), n.typed, ''))) / length(n.typed)
    - (length(coalesce(p_text, '')) - length(replace(coalesce(p_text, ''), n.stored, ''))) / length(n.stored)
  )
  from needles n;
$fn$;
comment on function app_private.loose_btrim_count(text) is
  'How many btrim() calls in a piece of SQL have no explicit character set (0105). Counts calls and subtracts character sets in both spellings, because a regular expression cannot see past the comma in a coalesce. Zero means every call names its set.';

revoke execute on function app_private.loose_btrim_count(text) from public, app_worker;

-- The structural, durable check (owner decision 6), written as a function rather than a script so it holds
-- whatever a later increment is written in. It names every constraint and every function that still trims
-- spaces only, excluding the financial tables and functions the freeze defers — and that exclusion is an
-- explicit list, so adding to it is a visible edit in a migration rather than a pattern quietly matching one
-- more thing.
create or replace function app_private.whitespace_contract_problems()
returns table (kind text, name text, loose_calls integer)
language sql
stable
security definer
set search_path = pg_catalog, public
as $fn$
  with deferred_tables as (
    select unnest(array[
      'cancellation_policies','checkout_charges','checkout_tax_lines','commission_rules','commissions',
      'coupon_usage','coupons','dispute_evidence','dispute_messages','disputes','order_cancellations',
      'payment_providers','payout_destinations','payout_providers','payout_reversals','promotion_packages',
      'promotion_ranking_settings','promotion_refund_policies','provider_settlement_items',
      'provider_settlements','refunds','service_deliveries','shipping_profiles','shipping_rates',
      'shipping_zones','tax_rules','withdrawals']) as relname
  ),
  deferred_functions as (
    select unnest(array[
      'apply_coupon','dispute_message_post_for_staff','dispute_resolve_for_staff','resolve_dispute',
      'loose_btrim_count','whitespace_contract_problems']) as proname
  )
  select 'constraint'::text, t.relname || '.' || c.conname,
         app_private.loose_btrim_count(pg_get_constraintdef(c.oid))
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and c.contype = 'c'
     and app_private.loose_btrim_count(pg_get_constraintdef(c.oid)) > 0
     and t.relname not in (select relname from deferred_tables)
  union all
  select 'function'::text, f.proname, app_private.loose_btrim_count(f.prosrc)
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname = 'app_private'
     and app_private.loose_btrim_count(f.prosrc) > 0
     and f.proname not in (select proname from deferred_functions)
   order by 1, 2;
$fn$;
comment on function app_private.whitespace_contract_problems() is
  'Every constraint and app_private function still trimming spaces only (0105). Empty is the contract; the pgTAP suite and the migration itself both assert it. The two detector functions exclude themselves because they name the character set as data rather than calling btrim with it.';

revoke execute on function app_private.whitespace_contract_problems() from public, app_worker;
grant execute on function app_private.whitespace_contract_problems() to app_system;

-- A migration that silently fixed half of this would be worse than one that failed, so the end of it proves
-- its own work.
do $$
declare
  v_problems text[];
begin
  select coalesce(array_agg(p.kind || ' ' || p.name || ' (' || p.loose_calls || ')' order by p.kind, p.name),
                  array[]::text[])
    into v_problems
    from app_private.whitespace_contract_problems() p;

  if array_length(v_problems, 1) is not null then
    raise exception 'whitespace hardening incomplete: %', array_to_string(v_problems, ', ')
      using errcode = 'check_violation';
  end if;

  raise notice 'whitespace hardening verified: every constraint and function in scope names its character set.';
end $$;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
