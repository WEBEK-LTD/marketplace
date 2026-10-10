-- pgTAP — migration 0105: whitespace normalisation hardening (corrective).
--
-- `btrim(x)` with no character set trims **spaces only**. A value made entirely of tabs is not empty, so every
-- `length(btrim(x)) >= 1` in this platform was a presence check that a tab defeated. 0105 gives the explicit
-- set `E' \t\r\n'` to 64 CHECK constraints, 92 `app_private` functions and six request schemas, and adds a
-- structural check so the loose form cannot come back.
--
-- What this file proves, in order:
--
--   * **the detector counts, it does not guess** — `app_private.loose_btrim_count` is exercised against the
--     shapes that defeated three earlier regex attempts, including `btrim(coalesce(x, ''))`;
--   * **the contract checker is empty, and it is not empty by accident** — one loose constraint is restored
--     inside a savepoint and the checker names it, so "zero rows" is a measurement rather than a tautology;
--   * **the two proven cases are closed**: a whitespace-only public category name, and a report closed on a
--     whitespace-only resolution note. Both were reachable over HTTP before this migration;
--   * **spaces, tabs, carriage returns, newlines and mixtures of them are all refused** on each constraint
--     shape in use — plain, two-column, `NULL OR`, `COALESCE`, and conditional-on-another-column;
--   * **interior whitespace is untouched**. This increment refuses an empty value, it does not reformat text,
--     and a name with a tab in the middle of it is stored and returned exactly as given;
--   * **the five places that were already strict still are**, including `seo_settings_save_for_staff`, which
--     0105 *did* rewrite — its two 0096 robots-body calls had to survive a replacement of the whole body;
--   * **the deferred financial inventory is stated here as data**, so the exemption is an assertion rather
--     than a sentence in a comment: 33 constraints on 27 tables and 4 functions keep the loose form, and the
--     checker ignores exactly those and nothing else;
--   * **the preflight refuses to migrate a database that holds violating rows**, with the diagnostic naming
--     the table, the constraint and the count, having changed nothing;
--   * **Unicode whitespace deliberately still passes**. That is asserted rather than left implicit, so the
--     day somebody decides to handle U+00A0 this assertion fails and tells them where the decision was made.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(159);

-- ---------------------------------------------------------------------------------------------------
-- The character set, named once
-- ---------------------------------------------------------------------------------------------------
-- The set has two spellings in this repository and they are easy to confuse: ten characters as a migration
-- types it (`E' \t\r\n'`) and four as the catalogue stores it. Everything below uses the catalogue's.
create or replace function pg_temp.ws() returns text language sql immutable as $$ select E' \t\r\n' $$;

select is(length(pg_temp.ws()), 4, 'the character set is four characters: space, tab, CR, LF');
select is(pg_temp.ws(), ' ' || chr(9) || chr(13) || chr(10), 'and those four, in that order');

-- The five whitespace-only values every refusal below is tested with. "mixed" is all four at once.
create or replace function pg_temp.blanks() returns table (label text, value text) language sql immutable as $$
  select 'spaces', '   '
  union all select 'tab', E'\t'
  union all select 'tabs', E'\t\t'
  union all select 'newline', E'\n'
  union all select 'mixed', E' \t\r\n \t'
$$;

select is((select count(*)::int from pg_temp.blanks()), 5, 'five whitespace-only probes');
select ok((select bool_and(btrim(b.value, pg_temp.ws()) = '') from pg_temp.blanks() b),
  'all five are empty under the strict set');
select is((select count(*)::int from pg_temp.blanks() b where btrim(b.value) <> ''), 4,
  'and four of the five survive the loose set, which is the entire defect');

-- ---------------------------------------------------------------------------------------------------
-- 1. The detector
-- ---------------------------------------------------------------------------------------------------
-- Three earlier attempts at this check were wrong in three different ways: a regex that missed
-- `btrim(coalesce(x, ''))`, a counter that hardcoded a needle length of 11 for a ten-character string, and a
-- version that counted the typed and stored spellings as separate calls. Each is a case below.
select has_function('app_private', 'loose_btrim_count', array['text'], 'the detector exists');
select has_function('app_private', 'whitespace_contract_problems', 'the contract checker exists');

select is(app_private.loose_btrim_count('length(btrim(name)) >= 1'), 1,
  'a bare loose call is one problem');
select is(app_private.loose_btrim_count('length(btrim(name, E'' \t\r\n'')) >= 1'), 0,
  'the typed spelling is not a problem');
select is(app_private.loose_btrim_count('length(btrim(name, ' || quote_literal(pg_temp.ws()) || ')) >= 1'), 0,
  'and neither is the stored spelling');
select is(app_private.loose_btrim_count('nullif(btrim(coalesce(p_a, '''')), '''')'), 1,
  'a loose call wrapping coalesce is counted: this is the shape the first regex missed');
select is(app_private.loose_btrim_count('nullif(btrim(coalesce(p_a, ''''), E'' \t\r\n''), '''')'), 0,
  'and the strict form of the same shape is not');
select is(app_private.loose_btrim_count('btrim(a) and btrim(b, E'' \t\r\n'') and btrim(c)'), 2,
  'a mixture counts only the loose ones');
select is(app_private.loose_btrim_count('select 1'), 0, 'text with no call at all is clean');
select is(app_private.loose_btrim_count(''), 0, 'so is empty text');
select is(app_private.loose_btrim_count(null), 0, 'and null, which the catalogue can return');
select is(app_private.loose_btrim_count('-- btrim(x) is wrong, see 0105'), 1,
  'a call inside a comment still counts: the check is deliberately not clever about context');

-- Two ways a substring search gets this wrong, both fixed before this migration was finished. The first
-- reported a function nobody wrote as loose; the second let a real loose call through.
select is(app_private.loose_btrim_count('my_btrim(a)'), 0,
  'an identifier that merely ends in btrim is a different function and is not counted');
select is(app_private.loose_btrim_count('rtrim(a) || ltrim(b)'), 0, 'nor are rtrim and ltrim');
select is(app_private.loose_btrim_count('btrim (a)'), 1,
  'and whitespace before the parenthesis does not hide a call, which PostgreSQL permits');
select is(app_private.loose_btrim_count('btrim (a, E'' \t\r\n'')'), 0, 'in either direction');

-- ---------------------------------------------------------------------------------------------------
-- 2. The contract is empty, and the checker can tell
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.whitespace_contract_problems()), 0,
  'no constraint and no function in scope still trims spaces only');

select is((select count(*)::int from public.security_contract_problems()), 0,
  'and 0105 left the security contract intact');

-- An empty result from a checker proves nothing unless the checker would have spoken. So put the defect back.
savepoint regressed;
alter table public.blog_tags drop constraint blog_tags_name_en_length;
alter table public.blog_tags add constraint blog_tags_name_en_length
  check (length(btrim(name_en)) >= 1 and length(btrim(name_en)) <= 60);

select is((select count(*)::int from app_private.whitespace_contract_problems()), 1,
  'restoring one loose constraint makes the checker report exactly one problem');
select is(
  (select kind || ' ' || name || ' x' || loose_calls from app_private.whitespace_contract_problems()),
  'constraint blog_tags.blog_tags_name_en_length x2',
  'and it names the table, the constraint and how many loose calls it found');

rollback to savepoint regressed;
select is((select count(*)::int from app_private.whitespace_contract_problems()), 0,
  'and the checker is quiet again once the strict version is back');

-- The same demonstration for a function, because the checker reads two catalogues.
savepoint regressed_fn;
create or replace function app_private.ws_probe_0105(p_a text) returns text
language sql immutable as $probe$ select nullif(btrim(coalesce(p_a, '')), '') $probe$;

select is((select count(*)::int from app_private.whitespace_contract_problems() where kind = 'function'), 1,
  'a loose app_private function is reported too');
select is((select name from app_private.whitespace_contract_problems() where kind = 'function'),
  'ws_probe_0105', 'by name');
rollback to savepoint regressed_fn;

select is((select count(*)::int from app_private.whitespace_contract_problems()), 0,
  'and dropping it clears the contract');

-- ---------------------------------------------------------------------------------------------------
-- 3. The 64 constraints
-- ---------------------------------------------------------------------------------------------------
-- Asserted as a property of the catalogue rather than as a list, so a constraint added later to a table in
-- scope is covered by the same assertion.
create or replace function pg_temp.deferred_tables() returns table (relname text) language sql immutable as $$
  select unnest(array[
    'cancellation_policies','checkout_charges','checkout_tax_lines','commission_rules','commissions',
    'coupon_usage','coupons','dispute_evidence','dispute_messages','disputes','order_cancellations',
    'payment_providers','payout_destinations','payout_providers','payout_reversals','promotion_packages',
    'promotion_ranking_settings','promotion_refund_policies','provider_settlement_items',
    'provider_settlements','refunds','service_deliveries','shipping_profiles','shipping_rates',
    'shipping_zones','tax_rules','withdrawals'])
$$;

-- Every public CHECK constraint that mentions btrim at all, split by whether it names the set.
create or replace function pg_temp.checks() returns table (relname text, conname text, def text, loose integer)
language sql stable as $$
  select t.relname::text, c.conname::text, pg_get_constraintdef(c.oid),
         app_private.loose_btrim_count(pg_get_constraintdef(c.oid))
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%btrim%'
$$;

-- 64 when 0105 closed; 66 since 0109 added `office_receipts`'s two text bounds, both naming the set. The
-- number is kept rather than turned into a floor: a count that only ever goes up stops detecting the thing
-- it was written for, which is a constraint quietly added with the loose form.
select is((select count(*)::int from pg_temp.checks() c
            where c.loose = 0 and c.relname not in (select relname from pg_temp.deferred_tables())),
  66, 'exactly 66 constraints outside the financial tables name the character set');

select is((select count(*)::int from pg_temp.checks() c
            where c.loose > 0 and c.relname not in (select relname from pg_temp.deferred_tables())),
  0, 'and none outside them is still loose');

-- The bounds came across unchanged. A strict constraint with the wrong ceiling would be a worse outcome than
-- a loose one, so three of the four shapes are read back from the catalogue and compared against 0010/0027.
select matches(
  (select def from pg_temp.checks() where conname = 'category_translations_name_length'),
  '>= 1\)? AND .*<= 120', 'the category name still runs 1..120');
select matches(
  (select def from pg_temp.checks() where conname = 'reports_details_length'),
  'details IS NULL', 'report details are still nullable');
select matches(
  (select def from pg_temp.checks() where conname = 'reports_details_length'),
  '>= 1\)? AND .*<= 4000', 'and still run 1..4000 when present');
select matches(
  (select def from pg_temp.checks() where conname = 'messages_text_has_body'),
  'message_type <> ''text''', '0014''s message rule is still conditional on the message type');
select matches(
  (select def from pg_temp.checks() where conname = 'messages_text_has_body'),
  'COALESCE\(body', 'and still coalesces a null body rather than admitting one');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An admin who may manage the catalogue and rule on reports, a seller with a listing to report, and a
-- reporter. The whitespace assertions need a real writer at each layer, not a bare INSERT.
insert into auth.users (id, email) values
  ('05000000-0000-4000-8000-000000000001', 'ws-admin@test.invalid'),
  ('05000000-0000-4000-8000-000000000002', 'ws-seller@test.invalid'),
  ('05000000-0000-4000-8000-000000000003', 'ws-reporter@test.invalid');

insert into public.user_roles (user_id, role_key) values
  ('05000000-0000-4000-8000-000000000001', 'admin');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, verification_status, verified_at)
values
  ('05000000-0000-4000-8000-000000000002', 'ws-shop', 'Whitespace Shop', 'Whitespace Shop LLC',
   'ws@test.invalid', '+201000000051', 'EG', 'active', 'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c5000000-0000-4000-8000-000000000001', null, 'ws-garden', true, 51);

insert into public.listings (
  id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
  currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
) values (
  '15000000-0000-4000-8000-000000000001', '05000000-0000-4000-8000-000000000002', 'product',
  'c5000000-0000-4000-8000-000000000001', 'ws-bench', 'Garden bench',
  'A description long enough to satisfy the length constraint.', 'en',
  'EGP', 150000, true, 'active', 'EG', 'Cairo', now() - interval '10 days', now() - interval '9 days'
);

-- ---------------------------------------------------------------------------------------------------
-- 4. Proven case one — a whitespace-only category name reached the public catalogue
-- ---------------------------------------------------------------------------------------------------
-- Before 0105 all three layers admitted a tab: `z.string().min(1)` in the request schema, a writer that stored
-- `p_name` raw, and `length(btrim(name)) >= 1` in the constraint. `public_categories` then returned it, so the
-- navigation, the category feed, the breadcrumbs and the sitemap each rendered a blank name.

-- Layer three, the authority. Asserted with a plain INSERT so no function can be credited for the refusal.
create or replace function pg_temp.insert_category_name(p_name text) returns text
language plpgsql as $$
begin
  insert into public.category_translations (category_id, locale_code, name)
  values ('c5000000-0000-4000-8000-000000000001', 'ar', p_name);
  return 'accepted';
exception when check_violation then
  return 'refused';
end $$;

select is(pg_temp.insert_category_name(b.value), 'refused',
  format('the constraint refuses a category name of %s', b.label))
  from pg_temp.blanks() b;

select is(pg_temp.insert_category_name('Garden'), 'accepted', 'and accepts a real one');
delete from public.category_translations
 where category_id = 'c5000000-0000-4000-8000-000000000001' and locale_code = 'ar';

-- Layer two, the writer, which is the layer a request actually reaches.
create or replace function pg_temp.save_category_name(p_name text) returns text
language plpgsql as $$
begin
  perform app_private.category_translation_save_for_staff(
    '05000000-0000-4000-8000-000000000001', true, 'c5000000-0000-4000-8000-000000000001', 'en', p_name);
  return 'accepted';
exception
  when check_violation then return 'refused';
  when raise_exception then return 'refused';
end $$;

select is(pg_temp.save_category_name(b.value), 'refused',
  format('and the writer refuses a category name of %s', b.label))
  from pg_temp.blanks() b;

select is((select count(*)::int from public.category_translations
            where category_id = 'c5000000-0000-4000-8000-000000000001'), 0,
  'none of the five refusals left a row behind');

-- Interior whitespace is a different thing entirely, and this increment must not touch it.
--
-- Nor does it touch the *edges*, and that is worth being exact about, because it is the one place where
-- "hardening" could easily have become a silent change of behaviour. This writer checks a trimmed copy and
-- stores the value it was given — it always did, and owner decision 1 forbids changing business semantics —
-- so the trim that reaches the stored value is the request schema's `.trim()`, asserted in the Vitest suite
-- for `SaveCategoryTranslationRequestSchema`. The database's job here is to refuse a blank, not to reformat.
select is(pg_temp.save_category_name(E'\t Garden  Furniture \n'), 'accepted',
  'a name with leading, interior and trailing whitespace is accepted');

select is(
  (select name from public.category_translations
    where category_id = 'c5000000-0000-4000-8000-000000000001' and locale_code = 'en'),
  E'\t Garden  Furniture \n',
  'and is stored exactly as given: the constraint checks a trimmed copy, it does not store one');

select is(
  (select btrim(c.name, pg_temp.ws()) from app_private.public_categories('en') c where c.slug = 'ws-garden'),
  'Garden  Furniture',
  'the public reader returns a name with text in it, so the surface that rendered a blank renders a name');

select ok(
  (select bool_and(btrim(c.name, pg_temp.ws()) <> '') from app_private.public_categories('en') c),
  'no category the public reader returns has a blank name');

-- ---------------------------------------------------------------------------------------------------
-- 5. Proven case two — a report closed on a whitespace-only resolution note
-- ---------------------------------------------------------------------------------------------------
-- `resolve_report` raises *"a report is never closed without a reason"*, and two tabs passed it. The
-- constraint passed too, and the schema did not trim, so the invariant the function names in its own error
-- message was defeatable over HTTP. The report closed as `actioned` with `resolved_at` set.
create temporary table ws_ids (name text primary key, id uuid not null);

insert into ws_ids select 'report', r.report_id
  from app_private.report_file_for_reporter(
    '05000000-0000-4000-8000-000000000003', 'listing', 'ws-bench', 'misleading',
    'The photographs are of a different bench.') r;

select isnt((select id from ws_ids where name = 'report'), null, 'a report is filed');
select is((select status from public.reports where id = (select id from ws_ids where name = 'report')),
  'open', 'and it starts open');

create or replace function pg_temp.resolve(p_note text) returns text
language plpgsql as $$
declare v_out text;
begin
  select app_private.resolve_report(
    (select id from ws_ids where name = 'report'), 'actioned',
    '05000000-0000-4000-8000-000000000001', p_note) into v_out;
  return v_out;
exception
  when check_violation then return 'refused';
  when raise_exception then return 'refused';
end $$;

select is(pg_temp.resolve(b.value), 'refused',
  format('a report is not closed on a resolution note of %s', b.label))
  from pg_temp.blanks() b;

select is((select status from public.reports where id = (select id from ws_ids where name = 'report')),
  'open', 'the report is still open after all five attempts');
select is((select resolved_at from public.reports where id = (select id from ws_ids where name = 'report')),
  null, 'and nothing was resolved');

select is(pg_temp.resolve(E'\tCounterfeit  confirmed by the brand. \n'), 'actioned',
  'a real note closes it');
select is(
  (select resolution_note from public.reports where id = (select id from ws_ids where name = 'report')),
  E'\tCounterfeit  confirmed by the brand. \n',
  'and the note is stored verbatim — the same division of labour as the category writer above');
select isnt((select resolved_at from public.reports where id = (select id from ws_ids where name = 'report')),
  null, 'with resolved_at set, which is what the constraint guards');

-- The filing wrapper does trim what it stores, and its answer to a blank box is different again: a
-- whitespace-only details box is *no details at all* rather than a refusal, because the column is nullable and
-- that is what its nullability is for. So the three writers in this section each do something different with
-- the same kind of input, and 0105 preserved all three — it hardened the emptiness test, nothing else.
--
-- Two statements, not one. The filing call inserts a row, and a single statement that both calls it and reads
-- `public.reports` does not see the new row: the outer scan uses the snapshot taken before the volatile call.
-- The same trap as 0104's `generate_series` InitPlan, in a different disguise.
create or replace function pg_temp.file_with_details(p_details text) returns text
language plpgsql as $$
declare v_id uuid; v_details text;
begin
  select f.report_id into v_id from app_private.report_file_for_reporter(
    '05000000-0000-4000-8000-000000000003', 'seller', 'ws-shop', 'spam', p_details) f;
  if v_id is null then return 'no row'; end if;
  select r.details into v_details from public.reports r where r.id = v_id;
  return coalesce(v_details, 'null');
end $$;

select is(pg_temp.file_with_details(E'\t\t'), 'null',
  'a whitespace-only details box is filed as no details, not as a tab');

delete from public.reports where subject_type = 'seller';

select is(pg_temp.file_with_details(E'\tReal  detail. \n'), 'Real  detail.',
  'and a real one is kept, trimmed at the ends by the writer and unchanged in the middle');

-- ---------------------------------------------------------------------------------------------------
-- 6. Every constraint shape in use
-- ---------------------------------------------------------------------------------------------------
-- Four shapes carry all 64: a plain presence check, a two-column one, `NULL OR …`, and a condition on
-- another column. One table each, with all five whitespace probes and a positive case.

-- Shape one: plain, with bounds. `faqs_question_en_length`.
create or replace function pg_temp.insert_faq(p_q text) returns text language plpgsql as $$
begin
  insert into public.faqs (question_en, answer_en) values (p_q, 'An answer.');
  return 'accepted';
exception when check_violation then return 'refused';
end $$;

select is(pg_temp.insert_faq(b.value), 'refused', format('a FAQ question of %s is refused', b.label))
  from pg_temp.blanks() b;
select is(pg_temp.insert_faq(E'Does  it work?\n'), 'accepted', 'and a real question is accepted');
select is((select question_en from public.faqs where answer_en = 'An answer.'), E'Does  it work?\n',
  'stored verbatim: the constraint checks a trimmed value, it does not store one');

-- Shape two: two columns, one constraint. `tags_names_present` — either side blank refuses the row.
create or replace function pg_temp.insert_tag(p_en text, p_ar text) returns text language plpgsql as $$
begin
  insert into public.tags (slug, name_en, name_ar) values ('ws-tag-' || md5(p_en || p_ar), p_en, p_ar);
  return 'accepted';
exception when check_violation then return 'refused';
end $$;

select is(pg_temp.insert_tag(b.value, 'عربي'), 'refused',
  format('a tag whose English name is %s is refused', b.label))
  from pg_temp.blanks() b;
select is(pg_temp.insert_tag('English', b.value), 'refused',
  format('and so is one whose Arabic name is %s', b.label))
  from pg_temp.blanks() b;
select is(pg_temp.insert_tag('English', 'عربي'), 'accepted', 'both present is accepted');

-- Shape three: `NULL OR …`. `blog_tags_name_ar_length` — absent is fine, blank is not.
create or replace function pg_temp.insert_blog_tag(p_ar text) returns text language plpgsql as $$
begin
  insert into public.blog_tags (slug, name_en, name_ar)
  values ('ws-bt-' || md5(coalesce(p_ar, 'null')), 'Guides', p_ar);
  return 'accepted';
exception when check_violation then return 'refused';
end $$;

select is(pg_temp.insert_blog_tag(null), 'accepted', 'a null Arabic blog-tag name is allowed');
select is(pg_temp.insert_blog_tag(b.value), 'refused',
  format('but %s is not: a nullable column still distinguishes absent from blank', b.label))
  from pg_temp.blanks() b;
select is(pg_temp.insert_blog_tag('أدلة'), 'accepted', 'and a real one is allowed');

-- Shape four: conditional on another column, over a `COALESCE`. `seller_verifications_rejection_has_reason`
-- carries both halves, and the condition is what makes this the subtlest of the four — the column may be blank
-- right up until the moment the other column takes the value that requires it.
--
-- (`reviews_moderated_has_reason` and `review_replies_moderated_has_reason` are the same shape and are covered
-- by the catalogue-wide assertions in section 3. They are not exercised by insertion here because a review
-- requires an order, and nothing in this increment goes near the order tables.)
-- Every other column this table's five sibling constraints require is supplied, so the *only* thing left that
-- can refuse the row is the reason. Without `submitted_at` and `reviewed_by` the five probes below were all
-- refused by `seller_verifications_reviewer_recorded` instead, and passed while proving nothing.
create or replace function pg_temp.reject_verification(p_reason text) returns text language plpgsql as $$
begin
  delete from public.seller_verifications where seller_user_id = '05000000-0000-4000-8000-000000000002';
  insert into public.seller_verifications
    (seller_user_id, status, submitted_at, reviewed_at, reviewed_by, decision_reason)
  values ('05000000-0000-4000-8000-000000000002', 'rejected', now() - interval '2 days', now(),
          '05000000-0000-4000-8000-000000000001', p_reason);
  return 'accepted';
exception when check_violation then return 'refused';
end $$;

-- Proved rather than asserted: with a real reason the row goes in, so the five refusals below are the
-- whitespace constraint's and nothing else's.
select is(pg_temp.reject_verification('A real reason.'), 'accepted',
  'the fixture satisfies every sibling constraint, so only the reason can refuse the row');

select is(pg_temp.reject_verification(b.value), 'refused',
  format('a rejected verification whose reason is %s is refused', b.label))
  from pg_temp.blanks() b;
select is(pg_temp.reject_verification(null), 'refused', 'and a null reason is refused, via the COALESCE');
select is(pg_temp.reject_verification('Documents did not match.'), 'accepted',
  'a real reason is accepted');

delete from public.seller_verifications where seller_user_id = '05000000-0000-4000-8000-000000000002';
select lives_ok(
  $$insert into public.seller_verifications (seller_user_id, status) values
    ('05000000-0000-4000-8000-000000000002', 'draft')$$,
  'and a draft needs no reason at all, which is the point of the condition');
delete from public.seller_verifications where seller_user_id = '05000000-0000-4000-8000-000000000002';

-- 0014's message rule, which 0104 depends on and 0105 must not loosen: a message still has a body, and now a
-- tab is not one. An attachment-only message remains impossible.
create or replace function pg_temp.insert_message_body(p_body text) returns text language plpgsql as $$
declare v_conv uuid;
begin
  select conversation_id into v_conv from app_private.messaging_start_conversation(
    '05000000-0000-4000-8000-000000000003', 'listing', '15000000-0000-4000-8000-000000000001', null);
  insert into public.messages (conversation_id, sender_user_id, message_type, body)
  values (v_conv, '05000000-0000-4000-8000-000000000003', 'text', p_body);
  return 'accepted';
exception when check_violation then return 'refused';
end $$;

select is(pg_temp.insert_message_body(b.value), 'refused',
  format('a text message whose body is %s is refused by messages_text_has_body', b.label))
  from pg_temp.blanks() b;
select is(pg_temp.insert_message_body(null), 'refused', 'and a null body still is, as in 0014');
select is(pg_temp.insert_message_body('Is it still available?'), 'accepted', 'a real body is accepted');

-- And through the writer, which is where a request arrives.
create or replace function pg_temp.send(p_body text) returns text language plpgsql as $$
declare v_conv uuid; v_out text;
begin
  select conversation_id into v_conv from app_private.messaging_start_conversation(
    '05000000-0000-4000-8000-000000000003', 'listing', '15000000-0000-4000-8000-000000000001', null);
  select outcome into v_out
    from app_private.messaging_send_message('05000000-0000-4000-8000-000000000003', v_conv, p_body);
  return v_out;
exception
  when check_violation then return 'refused';
  when raise_exception then return 'refused';
end $$;

select isnt(pg_temp.send(b.value), 'sent', format('the send writer does not send a body of %s', b.label))
  from pg_temp.blanks() b;
select is(pg_temp.send('A real question.'), 'sent', 'and sends a real one');

-- ---------------------------------------------------------------------------------------------------
-- 7. The 92 functions
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc like '%btrim(%'
      and app_private.loose_btrim_count(p.prosrc) > 0),
  4, 'exactly four app_private functions still hold a loose call, all of them financial');

select set_eq(
  $$select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and app_private.loose_btrim_count(p.prosrc) > 0$$,
  $$values ('apply_coupon'), ('dispute_message_post_for_staff'), ('dispute_resolve_for_staff'),
           ('resolve_dispute')$$,
  'and they are exactly the four named in the deferred inventory');

-- A replacement that dropped `search_path` would be a privilege-escalation hole opened by a hygiene fix, so
-- every definer function in app_private is asserted pinned rather than only the ones 0105 touched.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosecdef
      and not (p.proconfig @> array['search_path=pg_catalog, public'])),
  0, 'every security definer function in app_private still pins search_path to pg_catalog, public');

-- Nor may a replacement have widened execution. `CREATE OR REPLACE` keeps the existing ACL, so the contract to
-- assert is the one S8 actually states: nothing in `app_private` is reachable by `public`. (`app_worker` does
-- hold execute on a named subset by design, which is what `role_boundary_problems()` at the end of this file
-- measures, and asserting zero there would have been asserting something false.)
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and has_function_privilege('public', p.oid, 'execute')),
  0, 'and nothing in app_private is executable by public');

select ok(has_function_privilege('app_system', 'app_private.whitespace_contract_problems()', 'execute'),
  'app_system may run the new checker');
select ok(not has_function_privilege('app_worker', 'app_private.whitespace_contract_problems()', 'execute'),
  'app_worker may not');

-- The five places that were already strict. Four were left alone; the fifth was rewritten, and its two 0096
-- calls had to come through the rewrite intact — which is the one case here where "unchanged in behaviour"
-- required the body to be re-read rather than assumed.
create or replace function pg_temp.src(p_name text) returns text language sql stable as $$
  select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = p_name
$$;

select is(app_private.loose_btrim_count(pg_temp.src(f)), 0,
  format('%s, strict before 0105, is strict after it', f))
  from unnest(array['seo_settings_save_for_staff', 'staff_role_grant', 'staff_role_revoke',
                    'block_target', 'buyer_block_add']) f;

-- Seven calls: the two 0096 wrote strict, and five 0105 made strict. All seven name the set, asserted above.
select is(
  (select count(*)::int from regexp_matches(
     pg_temp.src('seo_settings_save_for_staff'), 'btrim\(', 'g')),
  7, 'seo_settings_save_for_staff holds seven calls — its own two, and five this migration corrected');

-- `strpos`, not `like`: in a LIKE pattern a backslash is the escape character, so `\t` there means a literal
-- `t` and the pattern would have been looking for `E' trn'`. It matched nothing and said so.
select ok(strpos(pg_temp.src('seo_settings_save_for_staff'),
                 'case when btrim(coalesce(p_robots_txt_body, ''''), E'' \t\r\n'') = '''' then null') > 0,
  'and the robots-body branch came through the replacement verbatim');

-- 0103's two, asserted through behaviour rather than text, because that is what the owner decision protects.
select is(
  (select app_private.block_target('05000000-0000-4000-8000-000000000003', null, E'\t')),
  null, '0103''s block_target still rejects a whitespace-only seller slug');
select isnt(
  (select app_private.block_target('05000000-0000-4000-8000-000000000003', null, 'ws-shop')),
  null, 'and still resolves a real one');

-- ---------------------------------------------------------------------------------------------------
-- 8. The deferred financial inventory, as data
-- ---------------------------------------------------------------------------------------------------
-- Stated as assertions so the exemption is measured rather than described. If a financial table is hardened
-- later these counts change and this file says so, which is the point.
select is((select count(*)::int from pg_temp.deferred_tables()), 27,
  '27 financial tables are deferred');

select is(
  (select count(*)::int from pg_temp.checks() c
    where c.loose > 0 and c.relname in (select relname from pg_temp.deferred_tables())),
  33, 'carrying 33 still-loose constraints between them');

select is(
  (select count(*)::int from pg_temp.checks() c
    where c.loose > 0 and c.relname not in (select relname from pg_temp.deferred_tables())),
  0, 'and every loose constraint left in the database is on one of those tables');

-- The checker must ignore the deferred set and nothing beyond it, which is a different claim from the counts
-- above: it is a claim about the exclusion list being neither short nor generous.
select is(
  (select count(*)::int from app_private.whitespace_contract_problems()), 0,
  'the checker is silent about the deferred set');

savepoint deferred_probe;
alter table public.offer_messages drop constraint offer_messages_body_length;
alter table public.offer_messages add constraint offer_messages_body_length
  check (length(btrim(body)) >= 1 and length(btrim(body)) <= 2000);
select is((select count(*)::int from app_private.whitespace_contract_problems()), 1,
  'but not about a non-financial table, so the exclusion list is not a blanket');
rollback to savepoint deferred_probe;

-- The two detector functions exclude themselves. They name the character set as data rather than calling
-- btrim with it, so without the exemption the checker would report itself forever.
select ok(app_private.loose_btrim_count(pg_temp.src('loose_btrim_count')) = 0,
  'the detector itself holds no loose call');
select is((select count(*)::int from app_private.whitespace_contract_problems()
            where name in ('loose_btrim_count', 'whitespace_contract_problems')),
  0, 'and neither detector reports itself');

-- ---------------------------------------------------------------------------------------------------
-- 9. The preflight
-- ---------------------------------------------------------------------------------------------------
-- Owner decision 2: existing rows that violate the tightened invariant must stop the migration with a
-- diagnostic, and nothing may be mutated. The migration's preflight is 64 statement pairs of one shape; the
-- pair for `category_translations_name_length` is reproduced verbatim below, with the migration's own raise,
-- so what is tested is the mechanism and the message rather than a paraphrase of them.
create or replace function pg_temp.preflight() returns text language plpgsql as $$
declare
  v_problems text[] := array[]::text[];
  v_count bigint;
begin
  select count(*) into v_count from public.category_translations where not ((length(btrim(name, E' \t\r\n')) >= 1) AND (length(btrim(name, E' \t\r\n')) <= 120));
  if v_count > 0 then v_problems := v_problems || format('public.category_translations (%s): %s row(s)', 'category_translations_name_length', v_count); end if;

  if array_length(v_problems, 1) is not null then
    raise exception
      'whitespace preflight failed: % column(s) hold values that are not empty but contain only whitespace. Nothing has been changed. Decide what each should become, then re-run. Affected: %',
      array_length(v_problems, 1), array_to_string(v_problems, '; ')
      using errcode = 'check_violation';
  end if;
  return 'passed';
end $$;

select is(pg_temp.preflight(), 'passed', 'the preflight passes against a database that holds no blank name');

-- Now make the database look like one that was never hardened, and give it the row 0105 refuses to guess at.
savepoint unhardened;
alter table public.category_translations drop constraint category_translations_name_length;
alter table public.category_translations add constraint category_translations_name_length
  check (length(btrim(name)) >= 1 and length(btrim(name)) <= 120);

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c5000000-0000-4000-8000-000000000002', null, 'ws-preflight-probe', true, 52);
insert into public.category_translations (category_id, locale_code, name) values
  ('c5000000-0000-4000-8000-000000000002', 'en', E'\t\t');

select is((select count(*)::int from public.category_translations where btrim(name, pg_temp.ws()) = ''), 1,
  'the loose constraint admits a tab-only name, which is how such a row gets there');

select throws_ok('select pg_temp.preflight()', '23514', null,
  'and the preflight then aborts with check_violation');

select throws_like('select pg_temp.preflight()',
  '%whitespace preflight failed: 1 column(s) hold values that are not empty but contain only whitespace.%',
  'naming the count of affected columns');
select throws_like('select pg_temp.preflight()', '%Nothing has been changed.%',
  'stating that nothing was changed');
select throws_like('select pg_temp.preflight()',
  '%Affected: public.category_translations (category_translations_name_length): 1 row(s)%',
  'and naming the table, the constraint and the row count');

-- The abort may not have touched anything. The offending row is still there, unmodified, for somebody to
-- decide about — which is the whole of owner decision 2.
select is((select name from public.category_translations
            where category_id = 'c5000000-0000-4000-8000-000000000002'), E'\t\t',
  'the offending row is untouched: not deleted, not nulled, not rewritten');

select is((select count(*)::int from app_private.whitespace_contract_problems()), 1,
  'and the constraint is still the loose one, so an aborted migration leaves the database as it was');

rollback to savepoint unhardened;

select is((select count(*)::int from app_private.whitespace_contract_problems()), 0,
  'the hardened state is back');
select is((select count(*)::int from public.category_translations
            where btrim(name, pg_temp.ws()) = ''), 0, 'with no blank name anywhere');

-- ---------------------------------------------------------------------------------------------------
-- 10. What 0105 deliberately does not do
-- ---------------------------------------------------------------------------------------------------
-- Owner decision 4: exactly `E' \t\r\n'`, and no Unicode whitespace handling. That is asserted rather than
-- described, so the next person to widen the set finds this file telling them where the decision was recorded.
select isnt(btrim(E' ', pg_temp.ws()), '',
  'a non-breaking space is NOT trimmed: U+00A0 is deliberately out of scope (decision 4)');
select isnt(btrim(E'​', pg_temp.ws()), '',
  'nor is a zero-width space: U+200B is the same deferred question');
select is(pg_temp.insert_category_name(E' '), 'accepted',
  'so a category name of one non-breaking space is still accepted, and that is recorded as future work');
delete from public.category_translations
 where category_id = 'c5000000-0000-4000-8000-000000000001' and locale_code = 'ar';

select is(btrim(E'\u000b', pg_temp.ws()), E'\u000b',
  'a vertical tab is out of scope too: the set is four characters, not "whitespace"');

-- Nothing in 0105 touched a form feed either, and the four-character set is asserted above rather than
-- inferred. What follows is the remaining structural contract, unchanged.
select is((select count(*)::int from public.rls_problems()), 0, 'RLS is unchanged');
select is((select count(*)::int from public.grant_problems()), 0, 'grants are unchanged');
select is((select count(*)::int from public.definer_problems()), 0, 'definer hygiene is unchanged');
select is((select count(*)::int from public.role_boundary_problems()), 0, 'role boundaries are unchanged');
select is((select count(*)::int from public.anon_privilege_problems()), 0, 'anon holds nothing new');
select is((select count(*)::int from public.append_only_problems()), 0, 'append-only tables are unchanged');
select is((select count(*)::int from public.view_security_problems()), 0, 'view security is unchanged');
select is((select count(*)::int from public.storage_bucket_problems()), 0, 'storage buckets are unchanged');
select is((select count(*)::int from public.audit_attribution_problems()), 0, 'audit attribution is unchanged');
select is((select count(*)::int from public.cron_job_problems()), 0, 'cron jobs are unchanged');

select * from finish();
rollback;
