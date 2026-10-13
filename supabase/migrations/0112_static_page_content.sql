-- 0112 — The static pages' first content, in both languages.
--
-- Twenty-two addresses have existed in the route map since Phase 4 and every one of them has been answering
-- "this page has not been written yet". The pages are authored in the console and read from the database, so
-- the only way to stop that is to put content in the database — which is what this migration does, exactly as
-- 0033 seeds the locales and 0111 seeds the catalogue.
--
-- WHAT THIS IS, AND WHAT IT IS NOT
--
-- It is a first draft the owner edits in `/admin/cms/pages`. It is published rather than left in draft,
-- because a published page the owner will revise is worth more to a visitor than an empty one, and because a
-- draft nobody can see is indistinguishable from the state we are leaving.
--
-- Every sentence describes what this platform actually does, and the source for that is the owner's own
-- amendment rather than a template: the office handles the whole transaction and the buyer never deals with
-- the owner (OD-A4), the full amount is paid at the office and the admin records it (OD-A1, OD-A2), the
-- commission is computed at that moment (OD-A7), an enquiry never expires (OD-A3), there are no seller
-- balances or withdrawals (OD-A5), refunds are settled at the office outside the system (OD-A6), and the
-- catalogue is property only (OD-A9).
--
-- **Where a fact belongs to the owner, the text carries a bracketed placeholder in both languages** — the
-- registered company name, the office address and telephone, the commission rates, the governing law, the
-- retention period. Those are not ours to invent. A placeholder a reader can see is a prompt to fill it in; a
-- plausible invention is a lie that survives into production. There are no invented rates, no invented
-- addresses and no invented guarantees anywhere in this file.
--
-- WHAT IT DOES NOT TOUCH
--
-- No schema. No column, constraint, index, trigger, policy or function is created or altered here; this
-- migration inserts rows into `public.pages` and `public.page_translations` and nothing else. `created_by` and
-- `updated_by` are null because a seed has no author, which those columns already allow.
--
-- `on conflict do nothing` throughout, so a slug the owner has already authored is left exactly as they left
-- it. Re-running this migration against a site whose pages have been edited changes nothing.
--
-- The body is read as plain text with blank lines separating paragraphs — see `cms-page-view.tsx`, which
-- states why the column is not interpreted as markup — so there is no markup in any body below and none is
-- implied by one.

-- ---------------------------------------------------------------------------------------------------
-- The pages
-- ---------------------------------------------------------------------------------------------------

-- about
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('about', 'about', 'standard', 10, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'About us', 'A property office that handles the whole transaction, from the first enquiry to the handover of the keys.', 'We are a property office. Everything listed on this site is handled by our own team: we take the enquiry, we arrange the viewing, we negotiate on your behalf, and we complete the paperwork and the payment at our office.

That is the difference between this site and a listings board. On a listings board you are given a telephone number and left to it. Here you deal with one team, you get one answer, and nobody is passing you between five people with five versions of the same price.

What we list. Apartments, duplexes, penthouses, villas, chalets, whole buildings, land, shops, offices and warehouses, for sale and to rent, across Egypt.

How a sale closes. When you and the owner have agreed, you come to the office and pay the full amount there. We record the payment against the file, the owner takes their share at the office, and the paperwork is signed in front of both of you. No money moves through this website and no card details are taken on it.

Who we are. [the office to complete]

Where we are. [the office to complete]', 'A property office that handles the whole transaction, from the first enquiry to the handover of the keys.'),
  ('ar', 'من نحن', 'مكتب عقارات بيمسك الصفقة من أول استفسار لحد تسليم المفاتيح.', 'إحنا مكتب عقارات. كل اللي معروض على الموقع ده بيتعامل فيه فريقنا بنفسه: إحنا اللي بناخد الاستفسار، وبنرتّب المعاينة، وبنتفاوض نيابة عنك، وبنخلّص الورق والدفع في المكتب.

ودي الفرق بين الموقع ده وبين لوحة إعلانات. لوحة الإعلانات بتديك رقم تليفون وتسيبك. هنا بتتعامل مع فريق واحد، وبتاخد إجابة واحدة، ومحدش بيلفّك على خمس ناس بخمس أسعار مختلفة لنفس الوحدة.

اللي بنعرضه: شقق ودوبلكس وبنتهاوس وفلل وشاليهات وعمارات كاملة وأراضي ومحلات ومكاتب ومخازن، للبيع وللإيجار، في محافظات مصر.

إزاي بتتقفل الصفقة: لما تتفق إنت والمالك، بتيجي المكتب وبتدفع المبلغ كامل هناك. إحنا بنسجّل الدفعة على الملف، والمالك بياخد نصيبه في المكتب، والورق بيتوقّع قدام الطرفين. مفيش فلوس بتعدّي من خلال الموقع ومفيش بيانات كروت بتتاخد عليه.

مين إحنا: [يستكملها المكتب]

مكان المكتب: [يستكملها المكتب]', 'مكتب عقارات بيمسك الصفقة من أول استفسار لحد تسليم المفاتيح.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- accessibility
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('accessibility', 'accessibility', 'help', 280, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Accessibility', 'What we have done to make this site usable, and how to tell us when it is not.', 'This site is built to be used with a keyboard, with a screen reader, and at a text size you have chosen.

What that means in practice. Every control can be reached and operated with the keyboard alone, and the element you are on is always visibly marked. The page works in Arabic right-to-left and in English left-to-right as a matter of layout rather than of mirroring. Nothing moves, flashes or animates on its own, and what little motion there is stops if your system asks for reduced motion. Colour is never the only way something is said; a state that matters is also written.

Where we know we fall short. A photograph of a property can only be described so far in words. If a listing''s photographs matter to your decision and the description is not enough, call the office and we will describe the property to you properly.

If something here does not work for you. Tell the office. Say which page and what happened, and we will fix it — and in the meantime we will give you the same information another way.', 'What we have done to make this site usable, and how to tell us when it is not.'),
  ('ar', 'إتاحة الوصول', 'عملنا إيه عشان الموقع يكون قابل للاستخدام، وتقول لنا إزاي لما ميكونش.', 'الموقع ده متعمول عشان يتستخدم بالكيبورد، وبقارئ الشاشة، وبحجم خط إنت اللي بتختاره.

ده معناه إيه عمليًا: كل عنصر تحكّم ينفع توصله وتشغّله بالكيبورد لوحده، والعنصر اللي إنت واقف عليه دايمًا معلّم بشكل واضح. والصفحة بتشتغل بالعربي من اليمين للشمال وبالإنجليزي من الشمال لليمين كتخطيط حقيقي مش مجرد انعكاس. ومفيش حاجة بتتحرك أو بتلمع أو بتتحرك لوحدها، والقليل الموجود بيقف لو نظامك طالب تقليل الحركة. واللون عمره ما بيكون الطريقة الوحيدة لتوصيل معلومة؛ أي حالة مهمة مكتوبة كمان.

إحنا عارفين بنقصّر فين: صورة العقار ممكن تتوصف بالكلام لحد معيّن بس. لو صور الإعلان مهمة لقرارك والوصف مش كفاية، كلّم المكتب وإحنا نوصف لك العقار بشكل كامل.

ولو حاجة هنا مش شغالة معاك: قول للمكتب. قول أنهي صفحة وحصل إيه، وإحنا نصلّحها — ولحد ما نصلّحها هنوصّل لك نفس المعلومة بطريقة تانية.', 'عملنا إيه عشان الموقع يكون قابل للاستخدام، وتقول لنا إزاي لما ميكونش.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- buyer-terms
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('buyer-terms', 'buyer_terms', 'legal', 110, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Buyer terms', 'What you can expect from the office, and what we expect from you.', 'These terms apply when you enquire about a property through this site. They sit alongside the terms of use and under the written agreement you sign at the office.

What you can expect from us. One team handling your enquiry from start to finish. A viewing arranged by us. The asking price, the measurements and the ownership position as we have them. Any commission or fee stated to you in writing before you commit. A written record of any payment you make at the office.

What we expect from you. Accurate information about what you are looking for and what you can pay, so that nobody''s time is spent on a property that was never possible. Reasonable notice if you cannot attend a viewing. Payment at the office and nowhere else.

Negotiation. We negotiate on your behalf with the owner. We will tell you what has been offered and what has been refused. We will not accept anything on your behalf without your instruction.

Payment. The full amount is paid at our office, in person, once you and the owner have agreed. We record it on your file at the moment it is received and the owner takes their share there.

Withdrawing. You may withdraw at any point before the agreement is signed at the office. Tell us as soon as you know.

Refunds. If money has been paid and something has to be returned, it is settled at the office under the agreement you signed. It is not processed through this website.

Complaints. Tell the office. [the office to complete]', 'What you can expect from the office, and what we expect from you.'),
  ('ar', 'شروط المشتري', 'تتوقع إيه من المكتب، وإحنا بنتوقع إيه منك.', 'الشروط دي بتنطبق لما تستفسر عن عقار من خلال الموقع. وهي جنب شروط الاستخدام وتحت الاتفاق المكتوب اللي بتوقّعه في المكتب.

تتوقع إيه مننا: فريق واحد ماسك استفسارك من الأول للآخر. معاينة إحنا بنرتّبها. سعر الطلب والمساحات وموقف الملكية زي ما هي عندنا. أي عمولة أو رسوم بتتقال لك مكتوبة قبل ما تلتزم. سجل مكتوب لأي دفعة بتدفعها في المكتب.

بنتوقع إيه منك: معلومات صحيحة عن اللي بتدوّر عليه واللي تقدر تدفعه، عشان محدش يضيّع وقته على عقار أصلًا مكانش ممكن. وإخطار معقول لو مش هتقدر تحضر معاينة. والدفع في المكتب ومكانش تاني.

التفاوض: إحنا بنتفاوض نيابة عنك مع المالك. وهنقول لك اتعرض إيه واترفض إيه. ومش هنقبل أي حاجة نيابة عنك من غير تعليمات منك.

الدفع: المبلغ كامل بيتدفع في مكتبنا، شخصيًا، بعد ما تتفق إنت والمالك. بنسجّله على ملفك لحظة استلامه والمالك بياخد نصيبه هناك.

الانسحاب: تقدر تنسحب في أي وقت قبل توقيع الاتفاق في المكتب. قول لنا أول ما تعرف.

الاسترداد: لو اتدفعت فلوس ولازم حاجة ترجع، بتتسوّى في المكتب حسب الاتفاق اللي وقّعته. ومبتتمش من خلال الموقع.

الشكاوى: كلّم المكتب. [يستكملها المكتب]', 'تتوقع إيه من المكتب، وإحنا بنتوقع إيه منك.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- cancellation-policy
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('cancellation-policy', 'cancellation_policy', 'legal', 230, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Cancellation', 'Stopping an enquiry, a viewing, or a transaction.', 'An enquiry. You can close it whenever you like, and so can we — but only after telling you why. An enquiry is never closed automatically and never expires: property conversations run for weeks, and a question that is still open is still open.

A viewing. Tell us as early as you can. An owner has usually arranged their day around it, and in many cases a tenant has as well.

A transaction before signing. Nothing on this site and nothing said in a conversation binds you. Up to the moment the agreement is signed at the office, either side may stop, and the only cost is the time spent.

A transaction after signing. The agreement you signed says what happens, including any deposit position. Read it before you sign it and ask us anything you are unsure about — that is part of what you are paying us for.

A listing, if you are the owner. Tell us and we will take it down. Ending the agency arrangement itself is covered by your agency agreement.', 'Stopping an enquiry, a viewing, or a transaction.'),
  ('ar', 'الإلغاء', 'إيقاف استفسار أو معاينة أو صفقة.', 'الاستفسار: تقدر تقفله في أي وقت، وإحنا كمان — بس بعد ما نقول لك السبب. الاستفسار عمره ما بيتقفل تلقائيًا ولا بينتهي: الكلام في العقارات بياخد أسابيع، والسؤال اللي لسه مفتوح يبقى مفتوح.

المعاينة: قول لنا بأبكر وقت ممكن. المالك غالبًا رتّب يومه عليها، وفي حالات كتير المستأجر كمان.

الصفقة قبل التوقيع: مفيش حاجة على الموقع ولا حاجة اتقالت في كلام بتلزمك. ولحد لحظة توقيع الاتفاق في المكتب، أي طرف يقدر يقف، والتكلفة الوحيدة هي الوقت اللي اتصرف.

الصفقة بعد التوقيع: الاتفاق اللي وقّعته هو اللي بيقول بيحصل إيه، بما في ذلك موقف العربون. اقراه قبل ما توقّعه واسألنا في أي حاجة مش واضحة — ده جزء من اللي بتدفع لنا عشانه.

الإعلان، لو إنت المالك: قول لنا وهننزّله. وإنهاء الوكالة نفسها بيحكمه اتفاق الوكالة بتاعك.', 'إيقاف استفسار أو معاينة أو صفقة.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- commission
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('commission', 'commission', 'standard', 50, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Our commission', 'What the office charges, and when.', 'We are paid a commission on a completed transaction. Nothing is charged for an enquiry, a viewing, a valuation or a conversation that goes nowhere.

When it is calculated. At the moment the money is paid at the office. Not when a listing goes up, not when you enquire, and not when a price is agreed — at payment, against the amount actually received.

How it is calculated. The rate that applies to your transaction is stated to you in writing before you commit, and it is recorded on the file at the moment of payment together with the amount it was calculated on. You can ask for that record at any time.

The current rates. [the office to complete]

Who pays it. [the office to complete]

What is not included. Government fees, registration costs, taxes and any third-party charge are separate and are not ours. We will tell you what they are before you commit.', 'What the office charges, and when.'),
  ('ar', 'العمولة', 'المكتب بياخد كام، وإمتى.', 'إحنا بناخد عمولة على الصفقة اللي بتتم. مفيش أي رسوم على استفسار ولا معاينة ولا تقييم ولا كلام ميوصلش لحاجة.

بتتحسب إمتى: في لحظة دفع الفلوس في المكتب. مش لما الإعلان يتنشر، ولا لما تستفسر، ولا لما السعر يتفق عليه — وقت الدفع، وعلى المبلغ اللي اتقبض فعلًا.

بتتحسب إزاي: النسبة اللي بتنطبق على صفقتك بتتقال لك مكتوبة قبل ما تلتزم، وبتتسجّل على الملف لحظة الدفع ومعاها المبلغ اللي اتحسبت عليه. وتقدر تطلب السجل ده في أي وقت.

النسب الحالية: [يستكملها المكتب]

مين اللي بيدفعها: [يستكملها المكتب]

اللي مش داخل فيها: الرسوم الحكومية ومصاريف الشهر العقاري والضرايب وأي رسوم لطرف تالت — دي منفصلة ومش بتخصّنا. وهنقول لك عليها قبل ما تلتزم.', 'المكتب بياخد كام، وإمتى.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- commission-policy
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('commission-policy', 'commission_policy', 'legal', 240, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Commission policy', 'How commission is set, recorded and disclosed.', 'Commission is earned on a completed transaction and on nothing else. An enquiry, a viewing, a valuation or a negotiation that ends without a transaction carries no charge.

When it is calculated. At the moment the payment is received at the office. The amount it is calculated on is the amount actually received, and both figures go onto the file together with the rate that was applied.

Disclosure before commitment. The rate that will apply is given to you in writing before you commit to anything. It is not disclosed afterwards and it is not varied afterwards.

Rounding. Commission is computed to the smallest unit of the currency of the transaction and rounded once, at the end. It is never estimated and never recomputed later from a rounded figure.

Capping. Commission never exceeds the amount received. Where a calculation would exceed it, it is capped and the file records that it was.

Fixed components. Where a fixed amount applies in addition to a percentage, it applies only in the currency it was set in. A fixed component with no amount in the currency of the transaction contributes nothing.

The rates themselves. [the office to complete]

Disputes. Ask the office for the commission record on your file. It states the amount received, the rate applied, each component, and whether a cap was reached.', 'How commission is set, recorded and disclosed.'),
  ('ar', 'سياسة العمولة', 'العمولة بتتحدد وبتتسجّل وبتتعلن إزاي.', 'العمولة بتُستحق على الصفقة اللي بتتم وبس. الاستفسار والمعاينة والتقييم والتفاوض اللي بينتهي من غير صفقة مفيش عليهم أي رسوم.

بتتحسب إمتى: لحظة استلام الدفعة في المكتب. والمبلغ اللي بتتحسب عليه هو المبلغ اللي اتقبض فعلًا، والرقمين بيتسجّلوا على الملف ومعاهم النسبة اللي اتطبّقت.

الإفصاح قبل الالتزام: النسبة اللي هتتطبّق بتتقال لك مكتوبة قبل ما تلتزم بأي حاجة. مش بعدين، ومبتتغيّرش بعدين.

التقريب: العمولة بتتحسب لأصغر وحدة في عملة الصفقة وبتتقرّب مرة واحدة في الآخر. ومبتتقدّرش ومبتتعادش حسابها بعدين من رقم مقرّب.

الحد الأقصى: العمولة عمرها ما بتزيد عن المبلغ المستلم. ولو الحساب زاد عنه، بتتقف عند الحد والملف بيسجّل إن ده حصل.

المكوّنات الثابتة: لو فيه مبلغ ثابت بينطبق فوق النسبة، فهو بينطبق بالعملة اللي اتحدد بيها بس. والمكوّن الثابت اللي مالوش قيمة بعملة الصفقة مبيضيفش حاجة.

النسب نفسها: [يستكملها المكتب]

الخلافات: اطلب من المكتب سجل العمولة على ملفك. وهو بيقول المبلغ المستلم والنسبة المطبّقة وكل مكوّن وهل اتوصل للحد الأقصى ولا لأ.', 'العمولة بتتحدد وبتتسجّل وبتتعلن إزاي.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- content-policy
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('content-policy', 'content_policy', 'legal', 250, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Content policy', 'What may appear on this site, and what may not.', 'Everything published here is published by this office. There is no user-generated listing on this site, which removes most of what a content policy normally has to deal with.

Listings. Describe the property as it is. No claim we have not checked, no measurement we have not seen a source for, and no photograph of a different property.

Photographs. Of the property itself. We may correct exposure and straighten a horizon; we do not remove a thing that is in the room or add a thing that is not.

Messages. Anything you send our team — an enquiry, a document, a message — must be yours to send and must not be abusive, threatening or unlawful.

Reporting. Every listing carries a report link. Tell us what is wrong and we will check it. A listing that is reported for an accuracy problem comes down while we check.

Removal. We remove anything that is inaccurate, unlawful, or that we no longer have the owner''s authority to publish.', 'What may appear on this site, and what may not.'),
  ('ar', 'سياسة المحتوى', 'إيه اللي ممكن يظهر على الموقع وإيه اللي مينفعش.', 'كل اللي بينشر هنا بينشره المكتب ده. مفيش إعلان بيكتبه مستخدم على الموقع، وده بيشيل معظم اللي سياسة المحتوى بتتعامل معاه عادةً.

الإعلانات: بتوصف العقار بحالته. مفيش ادّعاء إحنا متحققناش منه، ولا مساحة مشفناش مصدرها، ولا صورة لعقار تاني.

الصور: للعقار نفسه. ممكن نصلّح الإضاءة ونعدّل ميل الصورة؛ بس مش بنشيل حاجة موجودة في الأوضة ولا بنضيف حاجة مش موجودة.

الرسايل: أي حاجة بتبعتها لفريقنا — استفسار أو مستند أو رسالة — لازم تكون من حقك تبعتها ومتكونش مسيئة ولا فيها تهديد ولا مخالفة للقانون.

الإبلاغ: كل إعلان فيه رابط إبلاغ. قول لنا الغلط فين وإحنا نراجع. والإعلان اللي بيتبلّغ عنه بمشكلة دقة بينزل لحد ما نراجع.

الحذف: بنشيل أي حاجة غير دقيقة أو مخالفة للقانون أو مبقاش عندنا تفويض من المالك بنشرها.', 'إيه اللي ممكن يظهر على الموقع وإيه اللي مينفعش.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- contact
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('contact', 'contact', 'standard', 20, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Contact', 'How to reach the office, and what to expect when you do.', 'The fastest way to reach us about a specific property is the enquiry button on that property''s page. It reaches our team with the property already attached, so nobody has to ask you which one you meant.

For anything else — a property you want us to find, a valuation, a complaint, or a question about a payment — use the details below.

Telephone and address. [the office to complete]

Office hours. [the office to complete]

When you will hear back. We answer enquiries in the order they arrive, during office hours. An enquiry does not expire: it stays open on your account until it is closed, however long the conversation takes.

What we will never do. We will never ask you for a bank card number, an online transfer, or a payment of any kind outside the office. If a message claiming to be from us asks for money, it is not from us — tell us immediately.', 'How to reach the office, and what to expect when you do.'),
  ('ar', 'اتصل بنا', 'إزاي توصل للمكتب، وإيه اللي تتوقعه لما تعمل كده.', 'أسرع طريقة توصلنا بخصوص عقار معيّن هي زرار الاستفسار في صفحة العقار نفسه. الاستفسار بيوصل فريقنا والعقار مرفق معاه، فمحدش هيسألك إنت تقصد أنهي وحدة.

لأي حاجة تانية — عقار عايزنا ندوّرلك عليه، أو تقييم، أو شكوى، أو سؤال عن دفعة — استخدم البيانات اللي تحت.

التليفون والعنوان: [يستكملها المكتب]

مواعيد العمل: [يستكملها المكتب]

هترد علينا إمتى: بنرد على الاستفسارات بالترتيب اللي وصلت بيه، في مواعيد العمل. والاستفسار مبينتهيش: بيفضل مفتوح على حسابك لحد ما يتقفل، مهما الكلام خد وقت.

حاجة مش هنعملها أبدًا: مش هنطلب منك رقم كارت بنكي ولا تحويل أونلاين ولا أي دفع بره المكتب. لو وصلتك رسالة بتقول إنها مننا وبتطلب فلوس، فهي مش مننا — قول لنا على طول.', 'إزاي توصل للمكتب، وإيه اللي تتوقعه لما تعمل كده.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- cookies
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('cookies', 'cookies', 'legal', 210, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Cookies', 'The small number of cookies this site sets, and what each one is for.', 'A cookie is a small file a website asks your browser to keep. This site uses as few as it can.

Signing in. When you sign in, we set a cookie that keeps you signed in and one that protects the forms you submit from being submitted by another site on your behalf. Without these, you cannot have an account here. They are deleted when you sign out.

Your language. When you choose Arabic or English, we remember it so you are not asked again.

Measuring the site. We count how often a listing is opened, so the office knows what people are looking for. This is counted at the listing, not followed around the internet after you.

What we do not set. We set no advertising cookies and no cookies that follow you to other websites. There is no advertising network on this site.

Turning them off. Your browser can refuse or delete cookies. If you refuse the sign-in cookies you can still browse everything, but you will not be able to sign in or send an enquiry from an account.', 'The small number of cookies this site sets, and what each one is for.'),
  ('ar', 'ملفات تعريف الارتباط', 'العدد القليل من الكوكيز اللي الموقع بيستخدمه، وكل واحدة بتعمل إيه.', 'الكوكي ملف صغير الموقع بيطلب من متصفحك إنه يحتفظ بيه. والموقع ده بيستخدم أقل عدد ممكن منها.

تسجيل الدخول: لما تسجّل دخول، بنحط كوكي بتخليك فاضل داخل، وواحدة بتحمي النماذج اللي بتبعتها من إن موقع تاني يبعتها نيابة عنك. من غير دول مش هيكون عندك حساب هنا. وبتتمسح لما تسجّل خروج.

لغتك: لما تختار عربي أو إنجليزي، بنفتكرها عشان متتسألش تاني.

قياس استخدام الموقع: بنعدّ كام مرة الإعلان اتفتح، عشان المكتب يعرف الناس بتدوّر على إيه. والعدّ ده بيتم عند الإعلان، مش بتتبّعك في باقي الإنترنت بعد كده.

حاجات مبنحطهاش: مبنحطش كوكيز إعلانات ولا كوكيز بتتبعك لمواقع تانية. مفيش شبكة إعلانات على الموقع ده.

إزاي توقفها: متصفحك يقدر يرفضها أو يمسحها. ولو رفضت كوكيز الدخول هتفضل تقدر تتصفّح كل حاجة، بس مش هتقدر تسجّل دخول ولا تبعت استفسار من حساب.', 'العدد القليل من الكوكيز اللي الموقع بيستخدمه، وكل واحدة بتعمل إيه.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- faq
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('faq', 'faq', 'help', 40, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Frequently asked questions', 'The questions the office is actually asked.', 'Do I pay anything to use the site? No. Browsing, searching and sending an enquiry cost nothing.

Can I talk to the owner directly? No, and that is on purpose. Our team holds the conversation from the first enquiry to the handover. It is how the price you are quoted stays the price.

Is the price on the listing the final price? It is the asking price. Where a listing is marked negotiable, there is room to talk, and we do the talking on your behalf.

How do I pay? In full, at our office, once you and the owner have agreed. We record the payment against your file and the owner takes their share at the office. No payment is taken on this website.

Can I pay a deposit online? No. There is no online payment on this site at all, and nobody from this office will ever ask you for one.

How long does my enquiry stay open? As long as it takes. Property takes weeks, not minutes, so an enquiry is never closed automatically.

What if I change my mind? Tell us. Nothing is binding until the paperwork is signed at the office.

What about a refund? Refunds are settled at the office, between the office and you, under the agreement you signed. They are not processed through this website.

Do you deal with anything other than property? Not at the moment. Property only.

I found a listing that looks wrong. Use the report link on the listing, or contact the office. We would rather check ten correct listings than leave one wrong one up.', 'The questions the office is actually asked.'),
  ('ar', 'الأسئلة الشائعة', 'الأسئلة اللي بتتسأل للمكتب فعلًا.', 'هدفع حاجة عشان أستخدم الموقع؟ لأ. التصفّح والبحث وإرسال الاستفسار كلهم ببلاش.

أقدر أكلّم المالك على طول؟ لأ، وده مقصود. فريقنا بيمسك الكلام من أول استفسار لحد التسليم. وده اللي بيخلي السعر اللي اتقال لك هو السعر.

السعر المكتوب هو السعر النهائي؟ ده سعر الطلب. ولما الإعلان يكون مكتوب عليه "قابل للتفاوض" يبقى فيه مجال للكلام، وإحنا اللي بنتكلم نيابة عنك.

بدفع إزاي؟ المبلغ كامل، في مكتبنا، بعد ما تتفق إنت والمالك. بنسجّل الدفعة على ملفك والمالك بياخد نصيبه في المكتب. مفيش أي دفع بيتاخد على الموقع ده.

أقدر أدفع عربون أونلاين؟ لأ. مفيش دفع أونلاين على الموقع خالص، ومحدش من المكتب هيطلب منك ده أبدًا.

استفساري بيفضل مفتوح قد إيه؟ على قد ما يحتاج. العقارات بتاخد أسابيع مش دقايق، فالاستفسار عمره ما بيتقفل لوحده.

لو غيّرت رأيي؟ قول لنا. مفيش حاجة ملزمة قبل ما الورق يتوقّع في المكتب.

والاسترداد؟ الاسترداد بيتسوّى في المكتب، بينك وبين المكتب، حسب الاتفاق اللي وقّعته. ومبيتمش من خلال الموقع.

بتتعاملوا في حاجة غير العقارات؟ مش دلوقتي. عقارات بس.

لقيت إعلان شكله غلط. استخدم رابط الإبلاغ في الإعلان، أو كلّم المكتب. نراجع عشر إعلانات صح أحسن من إننا نسيب واحد غلط.', 'الأسئلة اللي بتتسأل للمكتب فعلًا.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- fraud-prevention
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('fraud-prevention', 'fraud_prevention', 'help', 70, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Fraud prevention', 'What we check, what we block, and what to do if you are targeted.', 'What we check before a property is listed. We see the property, we see the ownership documents, and we agree the price with the owner. A property does not appear on this site because somebody filled in a form.

What we do about duplicates. The same unit offered twice at two prices is the oldest trick in this market. Because every listing on this site comes through our office, there is one listing and one price.

What we never do. We never ask for money outside the office, never ask for card or bank details, and never ask you to pay a third party on our behalf. Read the safety page for the full list.

If you are targeted. Stop. Do not send anything. Call the office on the number on our contact page and tell us exactly what you were asked for and by whom. If money has already left your hands, report it to the police as well — the sooner the better.

Reporting a listing. Every listing has a report link. Use it. We would rather check a correct listing than leave a wrong one up.', 'What we check, what we block, and what to do if you are targeted.'),
  ('ar', 'منع الاحتيال', 'إحنا بنتحقق من إيه، وبنمنع إيه، وتعمل إيه لو اتعرضت لمحاولة.', 'بنتحقق من إيه قبل ما العقار يتعرض: بنشوف العقار، وبنشوف مستندات الملكية، وبنتفق على السعر مع المالك. العقار مبيظهرش على الموقع ده لمجرد إن حد ملا استمارة.

بنعمل إيه في التكرار: إن نفس الوحدة تتعرض مرتين بسعرين ده أقدم حيلة في السوق. وبما إن كل إعلان على الموقع بيعدّي من مكتبنا، يبقى فيه إعلان واحد وسعر واحد.

حاجات عمرنا ما بنعملها: عمرنا ما بنطلب فلوس بره المكتب، ولا بيانات كارت أو حساب، ولا بنطلب منك تدفع لطرف تالت نيابة عننا. اقرا صفحة الأمان للقايمة كاملة.

لو اتعرضت لمحاولة: وقّف. متبعتش حاجة. كلّم المكتب على الرقم اللي في صفحة اتصل بنا وقول لنا بالظبط اتطلب منك إيه ومن مين. ولو الفلوس خرجت من إيدك فعلًا، بلّغ الشرطة كمان — وكل ما تبكّر كان أحسن.

الإبلاغ عن إعلان: كل إعلان فيه رابط إبلاغ. استخدمه. نراجع إعلان صح أحسن من إننا نسيب واحد غلط.', 'إحنا بنتحقق من إيه، وبنمنع إيه، وتعمل إيه لو اتعرضت لمحاولة.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- help
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('help', 'help', 'help', 30, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Help', 'The short answers. Start here.', 'Finding a property. Use the search bar on the front page, or browse by category. Inside a category you can narrow by rooms, area, price and whatever else that category records — a villa and a shop are not described by the same details, so the filters change with the category.

Asking about a property. Open the property and use the enquiry button. Tell us what you need: when you want to view it, what your budget is, and anything that would rule a property out for you. The enquiry goes to our office team.

Who you are talking to. Always our team. You do not message the owner and the owner does not message you. That is deliberate: one team holding the whole conversation is what keeps the price and the facts consistent.

Viewing. We arrange it and we come with you.

Paying. In full, at the office, when you and the owner have agreed. We record it, the owner takes their share there, and you get the paperwork.

Listing your own property. Use "List your property" at the top of any page. We will contact you, see the property, agree the price with you, and put it on the site ourselves.

Changing or cancelling. An enquiry stays open until you or we close it. Nothing expires on its own and nothing is cancelled without telling you.', 'The short answers. Start here.'),
  ('ar', 'المساعدة', 'الإجابات المختصرة. ابدأ من هنا.', 'تدوّر على عقار إزاي: استخدم شريط البحث في الصفحة الرئيسية، أو اتصفّح حسب التصنيف. وجوّه التصنيف تقدر تضيّق بعدد الغرف والمساحة والسعر وأي تفصيلة التصنيف ده بيسجّلها — الفيلا والمحل مش بيتوصفوا بنفس التفاصيل، فالفلاتر بتتغيّر مع التصنيف.

تسأل عن عقار إزاي: افتح العقار واستخدم زرار الاستفسار. قول لنا محتاج إيه: عايز تعاين إمتى، وميزانيتك كام، وأي حاجة تخلي عقار مش مناسب ليك. الاستفسار بيروح لفريق المكتب.

بتتكلم مع مين: دايمًا فريقنا. إنت مش بتراسل المالك والمالك مش بيراسلك. وده مقصود: إن فريق واحد يمسك الكلام كله هو اللي بيخلي السعر والمعلومة ثابتين.

المعاينة: إحنا بنرتّبها وبنيجي معاك.

الدفع: المبلغ كامل، في المكتب، لما تتفق إنت والمالك. إحنا بنسجّله، والمالك بياخد نصيبه هناك، وإنت بتاخد الورق.

تعرض عقارك إنت: استخدم "أضف عقارك" فوق في أي صفحة. هنتواصل معاك، ونشوف العقار، ونتفق على السعر، وإحنا اللي بنحطه على الموقع.

التعديل والإلغاء: الاستفسار بيفضل مفتوح لحد ما تقفله إنت أو نقفله إحنا. مفيش حاجة بتنتهي لوحدها ومفيش حاجة بتتلغي من غير ما نقول لك.', 'الإجابات المختصرة. ابدأ من هنا.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- intellectual-property
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('intellectual-property', 'intellectual_property', 'legal', 270, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Intellectual property', 'Who owns what on this site.', 'The site. The design, the text, the arrangement of this site and the name and marks on it belong to this office. [the office to complete]

Photographs. Photographs of listed property are taken for this office or supplied to it by the owner for the purpose of marketing that property. They are not free for reuse. Taking them and republishing them — on another listings site, in an advertisement, anywhere — is not permitted.

What you may do. Look at the site, print or save a page for your own use, and share a link to a listing. Linking is welcome; copying is not.

What you may not do. Copy the catalogue, scrape it automatically, reproduce the listings on another site, or use our name or marks in a way that suggests we are connected to something we are not.

If you own something here. If you believe something on this site uses material you own, tell the office with enough detail to identify it. We will take it down while we check.', 'Who owns what on this site.'),
  ('ar', 'الملكية الفكرية', 'مين بيملك إيه على الموقع ده.', 'الموقع: التصميم والنصوص وترتيب الموقع والاسم والعلامات اللي عليه بتخص المكتب ده. [يستكملها المكتب]

الصور: صور العقارات المعروضة بتتصوّر للمكتب ده أو المالك بيدّيهاله عشان تسويق العقار ده. وهي مش متاحة لإعادة الاستخدام. وأخدها وإعادة نشرها — على موقع إعلانات تاني أو في إعلان أو في أي مكان — مش مسموح.

اللي ينفع تعمله: تتفرّج على الموقع، وتطبع أو تحفظ صفحة لاستخدامك الشخصي، وتشارك لينك لإعلان. المشاركة باللينك مرحّب بيها؛ النسخ لأ.

اللي مينفعش: تنسخ الكتالوج، أو تسحبه آليًا، أو تعيد نشر الإعلانات على موقع تاني، أو تستخدم اسمنا أو علاماتنا بشكل يوحي إننا مرتبطين بحاجة إحنا مش مرتبطين بيها.

لو إنت صاحب حاجة هنا: لو شايف إن حاجة على الموقع بتستخدم مادة بتملكها، قول للمكتب بتفاصيل كافية نحددها بيها. وهننزّلها لحد ما نراجع.', 'مين بيملك إيه على الموقع ده.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- privacy
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('privacy', 'privacy', 'legal', 200, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Privacy', 'What we hold about you, why, and what you can ask us to do with it.', 'Who holds your data. [the office to complete]

What we hold. What you give us: your name, your telephone number, your email address, and what you tell us you are looking for. What the site records: the pages you opened, the enquiries you sent, and the messages between you and our team. What the office records: the properties you viewed and any payment made at the office, with its date and amount.

Why we hold it. To answer your enquiry, to arrange viewings, to complete a transaction, to keep the records the law requires us to keep, and to protect the site and our customers from fraud.

What we do not do. We do not sell your data. We do not pass your contact details to a property owner — owners deal with our office, not with you directly. We do not take card or bank details on this website at all, because there is no payment on it.

Who else sees it. Our own staff, as needed to do the work. The companies that host this site and send our email and messages, under contract. Anybody we are legally obliged to disclose to.

How long we keep it. For as long as the enquiry is open, and after that for as long as the law requires us to keep the record of the transaction. [the office to complete]

Your rights. You can ask us for a copy of what we hold about you, ask us to correct it, ask us to delete what we are not obliged to keep, and object to how we use it. Ask the office.

Cookies. See the cookies page.

Complaints. Tell the office first. [the office to complete]', 'What we hold about you, why, and what you can ask us to do with it.'),
  ('ar', 'الخصوصية', 'إحنا ماسكين عنك إيه، وليه، وتقدر تطلب منّنا تعمل بيه إيه.', 'مين اللي ماسك بياناتك: [يستكملها المكتب]

ماسكين إيه: اللي بتديهولنا — اسمك ورقم تليفونك وبريدك الإلكتروني واللي بتقول لنا إنك بتدوّر عليه. واللي الموقع بيسجّله — الصفحات اللي فتحتها والاستفسارات اللي بعتها والرسايل بينك وبين فريقنا. واللي المكتب بيسجّله — العقارات اللي عاينتها وأي دفعة اتدفعت في المكتب بتاريخها ومبلغها.

ليه ماسكينه: عشان نرد على استفسارك، ونرتّب المعاينات، ونكمّل الصفقة، ونحتفظ بالسجلات اللي القانون بيلزمنا بيها، ونحمي الموقع وعملاءنا من النصب.

حاجات مش بنعملها: مش بنبيع بياناتك. ومش بنسلّم بيانات اتصالك لمالك عقار — الملاك بيتعاملوا مع مكتبنا مش معاك مباشرة. ومش بناخد بيانات كروت أو حسابات بنكية على الموقع خالص، لأن مفيش دفع عليه.

مين تاني بيشوفها: موظفينا، بالقدر اللازم للشغل. والشركات اللي بتستضيف الموقع وبتبعت بريدنا ورسايلنا، بعقود. وأي جهة القانون بيلزمنا بالإفصاح لها.

بنحتفظ بيها قد إيه: طول ما الاستفسار مفتوح، وبعد كده للمدة اللي القانون بيلزمنا نحتفظ فيها بسجل الصفقة. [يستكملها المكتب]

حقوقك: تقدر تطلب نسخة من اللي ماسكينه عنك، وتطلب تصحيحه، وتطلب حذف اللي مش ملزمين بحفظه، وتعترض على طريقة استخدامه. كلّم المكتب.

ملفات تعريف الارتباط: شوف صفحة ملفات تعريف الارتباط.

الشكاوى: كلّم المكتب الأول. [يستكملها المكتب]', 'إحنا ماسكين عنك إيه، وليه، وتقدر تطلب منّنا تعمل بيه إيه.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- prohibited-items
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('prohibited-items', 'prohibited_items', 'legal', 260, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'What we do not handle', 'The property and the arrangements this office will not take on.', 'This office handles property, and only property. There is no other kind of listing on this site.

We will not take on a property whose ownership cannot be evidenced, or where the person instructing us is not the owner and holds no written authority from the owner.

We will not take on a property that is the subject of a dispute we have been told about, or that is under a court order affecting its sale, until that is resolved.

We will not take on a property that cannot lawfully be sold or let in the way it is being offered — including a use the building is not licensed for.

We will not list a price the owner has not agreed in writing, and we will not list the same unit twice.

We will not act for both sides in a way that hides a conflict. Where we act for the owner, we say so.

We will not take or pass any payment outside the office, for any reason, however it is described.

If you are not sure whether something falls inside or outside this, ask the office before you spend time on it.', 'The property and the arrangements this office will not take on.'),
  ('ar', 'حاجات مش بنتعامل فيها', 'العقارات والترتيبات اللي المكتب ده مش بياخدها.', 'المكتب ده بيتعامل في العقارات، وفي العقارات بس. مفيش أي نوع تاني من الإعلانات على الموقع ده.

مش هناخد عقار ملكيته مش ممكن إثباتها، أو اللي بيكلّفنا مش المالك ومعهوش تفويض مكتوب من المالك.

مش هناخد عقار عليه نزاع اتقال لنا عليه، أو عليه حكم محكمة بيأثر على بيعه، لحد ما ده يتحل.

مش هناخد عقار مينفعش قانونًا يتباع أو يتأجّر بالشكل المعروض بيه — بما في ذلك استخدام المبنى مش مرخّص له.

مش هنعرض سعر المالك موافقش عليه مكتوب، ومش هنعرض نفس الوحدة مرتين.

مش هنشتغل للطرفين بطريقة بتخبّي تعارض مصالح. ولما نشتغل للمالك، بنقول كده.

مش هناخد ولا هنمرّر أي دفعة بره المكتب، لأي سبب، ومهما اتوصفت إزاي.

ولو مش متأكد إن حاجة داخلة في ده ولا لأ، اسأل المكتب قبل ما تضيّع وقتك فيها.', 'العقارات والترتيبات اللي المكتب ده مش بياخدها.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- refund-policy
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('refund-policy', 'refund_policy', 'legal', 220, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Refunds', 'Refunds are settled at the office, not on this website.', 'No payment is taken on this website. Every payment happens at our office, in person, and is recorded there against your file. It follows that no refund is processed on this website either.

How a refund is handled. Under the written agreement you signed at the office, and at the office. Bring the receipt we gave you. The agreement says what is returnable and what is not, and in what circumstances.

What we can tell you now. The amount, the date and what the payment was for are on your file, and you may ask for that record at any time.

What this office will never do. Ask you to pay a fee in order to receive a refund. Ask for your card or bank details to "process" one. Send you a link to claim one. If any of those reaches you, it is not from us.

Fees and government charges. Registration fees, taxes and third-party charges are not ours and are not refundable by us. Where they are refundable at all, it is by the body that took them.

If we cannot agree. [the office to complete]', 'Refunds are settled at the office, not on this website.'),
  ('ar', 'الاسترداد', 'الاسترداد بيتسوّى في المكتب، مش على الموقع.', 'مفيش دفع بيتاخد على الموقع ده. كل دفعة بتتم في مكتبنا، شخصيًا، وبتتسجّل هناك على ملفك. وبالتالي مفيش استرداد بيتم على الموقع كمان.

الاسترداد بيتم إزاي: حسب الاتفاق المكتوب اللي وقّعته في المكتب، وفي المكتب. هات الإيصال اللي إحنا إدّيناهولك. والاتفاق هو اللي بيقول إيه اللي بيترد وإيه اللي مبيتردش، وفي أنهي حالات.

اللي نقدر نقوله لك دلوقتي: المبلغ والتاريخ والدفعة كانت مقابل إيه — كلها على ملفك، وتقدر تطلب السجل ده في أي وقت.

حاجة المكتب ده عمره ما هيعملها: إنه يطلب منك تدفع رسوم عشان تستلم استرداد. أو يطلب بيانات كارتك أو حسابك عشان "ينفّذه". أو يبعت لك لينك تطالب بيه. لو أي حاجة من دول وصلتك، فهي مش مننا.

الرسوم والمصاريف الحكومية: رسوم الشهر العقاري والضرايب ورسوم أي طرف تالت مش بتاعتنا ومش بنردها. ولو كانت بترد أصلًا، فبترد من الجهة اللي أخدتها.

لو مقدرناش نتفق: [يستكملها المكتب]', 'الاسترداد بيتسوّى في المكتب، مش على الموقع.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- safety
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('safety', 'safety', 'help', 60, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Staying safe', 'How this office works, so you can tell when something is not us.', 'Most property fraud works by rushing you and by moving the money somewhere the office cannot see. Knowing how we actually work is most of the protection you need.

We never take payment outside the office. Not by bank transfer, not by wallet, not by card, not to a personal account, not "to hold the unit". Every payment happens at the office, in person, and is recorded against your file on the spot.

We never ask for card or bank details. Not on this website, not by message, not by telephone. There is no payment page on this site to put them into.

We arrange every viewing. You do not meet an owner alone at a property because a message told you to.

We do not rush you. Anyone pressing you to decide today, or to pay something today to stop someone else taking the unit, is not working the way this office works.

Check the paperwork before you pay, not after. Ask to see the ownership documents. We will show them to you; that is part of the job.

If something feels wrong, stop and call the office on the number on our contact page — not a number you were sent in a message.', 'How this office works, so you can tell when something is not us.'),
  ('ar', 'الأمان', 'إزاي المكتب بيشتغل، عشان تعرف لما حاجة متكونش مننا.', 'أغلب النصب في العقارات بيشتغل بإنه يستعجلك، وبإنه ينقل الفلوس لمكان المكتب مش شايفه. إنك تعرف إحنا بنشتغل إزاي ده معظم الحماية اللي محتاجها.

إحنا عمرنا ما بناخد فلوس بره المكتب. لا تحويل بنكي، ولا محفظة، ولا كارت، ولا حساب شخصي، ولا "عشان نحجز الوحدة". كل دفعة بتتم في المكتب، وجهًا لوجه، وبتتسجّل على ملفك في نفس اللحظة.

إحنا عمرنا ما بنطلب بيانات كارت أو حساب بنكي. لا على الموقع، ولا برسالة، ولا بالتليفون. مفيش أصلًا صفحة دفع على الموقع تحطهم فيها.

إحنا اللي بنرتّب كل معاينة. إنت مبتقابلش مالك لوحدك في عقار لمجرد إن رسالة قالت لك كده.

إحنا مش بنستعجلك. أي حد بيضغط عليك تقرر النهاردة، أو تدفع حاجة النهاردة عشان محدش ياخد الوحدة، فده مش أسلوب المكتب ده.

شوف الورق قبل ما تدفع، مش بعده. اطلب تشوف مستندات الملكية. وإحنا هنوريهالك؛ دي جزء من شغلنا.

ولو حسّيت إن فيه حاجة غلط، وقّف وكلّم المكتب على الرقم اللي في صفحة اتصل بنا — مش رقم جالك في رسالة.', 'إزاي المكتب بيشتغل، عشان تعرف لما حاجة متكونش مننا.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- seller-guidelines
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('seller-guidelines', 'seller_guidelines', 'help', 140, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Owner guidelines', 'How to get your property listed, and listed well.', 'Start with "List your property" at the top of any page. We will contact you, arrange to see the property, and take it from there.

Have the ownership documents ready. It is the step that holds everything else up. Bring what you have and we will tell you what else is needed.

Be honest about the condition. A problem we find at the viewing costs you a buyer. A problem you told us about at the start costs you nothing, because we price it in and we tell buyers before they come.

Let us price it. We will tell you what the property is worth on today''s market and why. An asking price set too high does not get you more; it gets you no viewings and a listing that goes stale.

Give us access. Viewings happen when buyers can come, which is often evenings and weekends. The easier it is to get in, the faster it sells.

Tidy, do not stage. Clear, clean and well lit beats furnished for a photograph. Buyers are looking at the space.

Tell us the moment anything changes — a price you want to revise, a sale you have agreed elsewhere, a tenant moving out. We cannot do our job on information that has gone out of date.', 'How to get your property listed, and listed well.'),
  ('ar', 'إرشادات المالك', 'إزاي تعرض عقارك، وتعرضه صح.', 'ابدأ بـ "أضف عقارك" فوق في أي صفحة. هنتواصل معاك، ونرتّب نشوف العقار، ونكمّل من هناك.

جهّز مستندات الملكية: دي الخطوة اللي بتعطّل كل اللي بعدها. هات اللي معاك وإحنا نقول لك محتاجين إيه كمان.

كن صريح في الحالة: المشكلة اللي بنكتشفها في المعاينة بتكلّفك مشتري. والمشكلة اللي قلت لنا عليها من الأول مبتكلّفكش حاجة، لأننا بنحسبها في السعر وبنقول للمشتري قبل ما ييجي.

سيبنا نحدد السعر: هنقول لك العقار يسوى كام في سوق النهاردة وليه. السعر المبالغ فيه مش بيجيب لك زيادة؛ بيجيب لك صفر معاينات وإعلان بيبهت.

سهّل الدخول: المعاينات بتحصل لما المشتري يقدر ييجي، وده غالبًا بالليل وفي الأجازات. وكل ما الدخول يكون أسهل كل ما البيع يبقى أسرع.

رتّب، متفرشش: النضافة والإضاءة والمساحة الفاضية أحسن من الفرش في الصورة. المشتري بيبص على المساحة.

قول لنا أول ما أي حاجة تتغيّر — سعر عايز تعدّله، بيع اتفقت عليه في مكان تاني، مستأجر خارج. إحنا مش هنقدر نشتغل بمعلومة قديمة.', 'إزاي تعرض عقارك، وتعرضه صح.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- seller-policy
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('seller-policy', 'seller_policy', 'legal', 130, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Owner policy', 'What we will and will not list.', 'We list property we have seen, whose ownership we have checked, and whose price the owner has agreed in writing. Anything else is not listed, however good the photographs are.

We will not list a property where the ownership cannot be evidenced, where there is a dispute we have been told about, where the person asking is not the owner and has no written authority, or where the price being asked is one the owner has not confirmed.

One listing per property. The same unit does not appear twice at two prices. If we find a duplicate, we remove it.

Accuracy. Measurements, floor, age, finishing and what is included are recorded as the owner states them and as we observe them. Where the two differ, we ask before we publish.

Photographs. Of the property itself, as it is. Not of a different unit, not of a show flat standing in for it, and not edited to remove something that is there.

Taking a listing down. We remove a listing when the property is sold or let, when the owner asks, when an accuracy problem is reported and confirmed, or when the agency agreement ends.', 'What we will and will not list.'),
  ('ar', 'سياسة المالك', 'بنعرض إيه ومش بنعرض إيه.', 'بنعرض العقار اللي شفناه، واللي اتحققنا من ملكيته، واللي المالك وافق على سعره مكتوب. وأي حاجة غير كده مبتتعرضش، مهما كانت الصور حلوة.

مش هنعرض عقار ملكيته مش ممكن إثباتها، أو فيه نزاع اتقال لنا عليه، أو اللي بيطلب العرض مش المالك ومعهوش تفويض مكتوب، أو السعر المطلوب المالك مأكّدوش.

إعلان واحد للعقار الواحد: نفس الوحدة مبتظهرش مرتين بسعرين. ولو لقينا تكرار بننزّله.

الدقة: المساحات والدور والعمر والتشطيب واللي داخل في السعر بتتسجّل زي ما المالك بيقولها وزي ما إحنا بنشوفها. ولو الاتنين اختلفوا، بنسأل قبل ما ننشر.

الصور: للعقار نفسه، بحالته. مش لوحدة تانية، ولا لشقة عرض بديلة عنه، ولا معدّلة عشان تشيل حاجة موجودة فيه.

سحب الإعلان: بننزّل الإعلان لما العقار يتباع أو يتأجّر، أو لما المالك يطلب، أو لما مشكلة دقة تتبلّغ وتتأكّد، أو لما اتفاق الوكالة ينتهي.', 'بنعرض إيه ومش بنعرض إيه.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- seller-terms
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('seller-terms', 'seller_terms', 'legal', 120, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Owner terms', 'The terms on which we list and sell a property for you.', 'These terms apply when you ask this office to market a property. They sit alongside the terms of use and under the written agency agreement you sign at the office.

Before we list. We will visit the property, read your ownership documents, and agree an asking price with you in writing. We do not list a property we have not seen or whose ownership we have not checked.

What you are telling us. That you are entitled to sell or let the property, that what you have told us about it is true, and that you will tell us promptly if anything changes — including if you agree a sale with somebody else.

Who talks to buyers. We do. Buyers do not contact you through this site and you do not contact them through it. One point of contact is what keeps the price and the facts consistent, and it is the service you are paying for.

Price changes. The asking price changes only with your agreement, in writing.

Completion and your money. The buyer pays the full amount at our office. Your share is paid to you at the office at that point, and our commission is calculated then, on the amount actually received. This site holds no balance for you and makes no transfer to you; there is no wallet and no withdrawal.

Ending the arrangement. Either of us may end it on the notice set out in your agency agreement. [the office to complete]

Removing a listing. Tell us and we will take it down. A property that is sold or let is taken down by us as a matter of course.', 'The terms on which we list and sell a property for you.'),
  ('ar', 'شروط المالك', 'الشروط اللي بنعرض ونبيع بيها عقارك.', 'الشروط دي بتنطبق لما تطلب من المكتب ده إنه يسوّق عقار. وهي جنب شروط الاستخدام وتحت اتفاق الوكالة المكتوب اللي بتوقّعه في المكتب.

قبل ما نعرض: هنزور العقار، ونقرا مستندات الملكية، ونتفق معاك على سعر الطلب مكتوب. وإحنا مبنعرضش عقار مشفناهوش أو ملكيته متحققناش منها.

إنت بتقول لنا إيه: إن من حقك تبيع أو تأجّر العقار، وإن اللي قلته لنا عنه صح، وإنك هتبلّغنا فورًا لو أي حاجة اتغيّرت — بما في ذلك لو اتفقت على بيع مع حد تاني.

مين اللي بيكلّم المشترين: إحنا. المشترين مبيتواصلوش معاك من خلال الموقع وإنت مبتتواصلش معاهم من خلاله. نقطة اتصال واحدة هي اللي بتخلي السعر والمعلومة ثابتين، وهي الخدمة اللي بتدفع عشانها.

تغيير السعر: سعر الطلب مبيتغيّرش غير بموافقتك، مكتوبة.

إتمام الصفقة وفلوسك: المشتري بيدفع المبلغ كامل في مكتبنا. ونصيبك بيتسلّم لك في المكتب في نفس اللحظة، والعمولة بتتحسب ساعتها على المبلغ اللي اتقبض فعلًا. الموقع ده مش بيمسك لك رصيد ومش بيحوّل لك حاجة؛ مفيش محفظة ومفيش سحب.

إنهاء التعاقد: أي طرف فينا يقدر ينهيه بالمهلة المنصوص عليها في اتفاق الوكالة. [يستكملها المكتب]

سحب الإعلان: قول لنا وهننزّله. والعقار اللي بيتباع أو بيتأجّر بننزّله إحنا بشكل تلقائي.', 'الشروط اللي بنعرض ونبيع بيها عقارك.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- terms
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('terms', 'terms', 'legal', 100, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Terms of use', 'The rules for using this website.', 'These terms govern your use of this website. They do not govern the sale or letting of any property: that is governed by the written agreement you sign at the office, which prevails over anything on this site if the two ever differ.

Who we are. [the office to complete]

What this site is. A catalogue of property our office handles, and a way to send us an enquiry about it. It is not a marketplace between you and an owner, there is no contract formed on it, and no payment is taken on it.

Listings are invitations, not offers. A price, a measurement, a photograph or a description on this site is given in good faith and may change. Nothing on this site binds anybody. The figures that bind are the ones in the agreement signed at the office.

Your account. Keep your sign-in details to yourself and tell us if you think somebody else has them. You are responsible for what is done with your account until you tell us.

Using the site properly. Do not try to break into it, scrape it, overload it, or use it to send anybody anything they did not ask for. Do not send us content you have no right to send.

Enquiries. An enquiry is a request to talk, not a commitment to buy or to rent, and it does not expire. We may close an enquiry after telling you why.

Suspension. We may suspend an account that is being used to abuse the site, to defraud somebody, or in breach of these terms, and we will say why.

Liability. We do not exclude liability for anything that cannot lawfully be excluded. Beyond that, we are not liable for loss arising from your reliance on information on this site rather than on the agreement you signed.

Changes. We may change these terms. The current version is always the one on this page.

Governing law. [the office to complete]', 'The rules for using this website.'),
  ('ar', 'شروط الاستخدام', 'قواعد استخدام الموقع ده.', 'الشروط دي بتحكم استخدامك للموقع. وهي مش بتحكم بيع أو تأجير أي عقار: ده بيحكمه الاتفاق المكتوب اللي بتوقّعه في المكتب، وهو اللي بيسود لو اختلف مع أي حاجة على الموقع.

مين إحنا: [يستكملها المكتب]

الموقع ده إيه: كتالوج للعقارات اللي بيتعامل فيها مكتبنا، ووسيلة تبعت لنا استفسار عنها. وهو مش سوق بينك وبين مالك، ومفيش عقد بينعقد عليه، ومفيش دفع بيتاخد عليه.

الإعلانات دعوة للتفاوض مش إيجاب: السعر والمساحة والصورة والوصف على الموقع ده بتتقال بحسن نية وممكن تتغيّر. مفيش حاجة على الموقع بتلزم حد. الأرقام الملزمة هي اللي في الاتفاق الموقّع في المكتب.

حسابك: خلّي بيانات دخولك لنفسك، وقول لنا لو شكّيت إن حد تاني وصل لها. إنت مسؤول عن اللي بيتعمل بحسابك لحد ما تبلّغنا.

استخدام الموقع بشكل سليم: متحاولش تخترقه، ولا تسحب بياناته آليًا، ولا تحمّله فوق طاقته، ولا تستخدمه عشان تبعت لحد حاجة هو مطلبهاش. ومتبعتش لنا محتوى مش من حقك تبعته.

الاستفسارات: الاستفسار طلب للكلام، مش التزام بالشراء أو الإيجار، ومبينتهيش بمرور الوقت. وممكن نقفل استفسار بعد ما نقول لك السبب.

الإيقاف: ممكن نوقف حساب بيتستخدم في إساءة استعمال الموقع أو في نصب حد أو بالمخالفة للشروط دي، وهنقول السبب.

المسؤولية: إحنا مبنستبعدش المسؤولية عن أي حاجة القانون مبيسمحش باستبعادها. وفيما عدا كده، إحنا مش مسؤولين عن خسارة ناتجة عن اعتمادك على معلومة على الموقع بدل الاتفاق اللي وقّعته.

التعديل: ممكن نعدّل الشروط دي. والنسخة السارية هي اللي على الصفحة دي دايمًا.

القانون الواجب التطبيق: [يستكملها المكتب]', 'قواعد استخدام الموقع ده.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- verification
with upserted as (
  insert into public.pages (slug, page_key, template, sort_order, status, published_at, is_indexable)
  values ('verification', 'verification', 'help', 80, 'published', now(), true)
  on conflict (slug) do nothing
  returning id
)
insert into public.page_translations (page_id, locale_code, title, excerpt, body, meta_description)
select u.id, v.locale_code, v.title, v.excerpt, v.body, v.meta_description
from upserted u
cross join (values
  ('en', 'Verification', 'What we verify before a property goes on the site.', 'Every property on this site has been through our office before it appears. That is what verification means here, and it is a different thing from a badge on a form.

We see the property. Someone from the office goes to it. A listing is not published from photographs alone.

We see the ownership documents. We ask the owner for proof that they are entitled to sell or let the property, and we read it.

We agree the price with the owner in writing, so the figure on the site is a figure the owner has committed to rather than an opening position invented for the advertisement.

What verification does not mean. It is not a survey, it is not a valuation for a bank, and it is not a guarantee about the structure of the building. If you want a structural survey, tell us and we will arrange access for a surveyor of your choosing.

If you believe a listed property has been misrepresented, use the report link on the listing. We take it down while we check.', 'What we verify before a property goes on the site.'),
  ('ar', 'التوثيق', 'بنتحقق من إيه قبل ما العقار ينزل الموقع.', 'كل عقار على الموقع ده عدّى على مكتبنا قبل ما يظهر. ده معنى التوثيق هنا، وهو حاجة تانية خالص غير علامة على استمارة.

بنشوف العقار: حد من المكتب بيروح له. الإعلان مبينشرش من صور بس.

بنشوف مستندات الملكية: بنطلب من المالك إثبات إنه من حقه يبيع أو يأجّر العقار، وبنقراه.

بنتفق على السعر مع المالك مكتوب، عشان الرقم اللي على الموقع يكون رقم المالك ملتزم بيه مش سعر افتتاحي اتعمل للإعلان.

التوثيق مش معناه إيه: مش فحص إنشائي، ولا تقييم للبنك، ولا ضمان على هيكل المبنى. لو عايز فحص إنشائي، قول لنا وإحنا نرتّب دخول مهندس إنت تختاره.

ولو شايف إن عقار معروض اتوصف بشكل مضلل، استخدم رابط الإبلاغ في الإعلان. بنوقّفه لحد ما نراجع.', 'بنتحقق من إيه قبل ما العقار ينزل الموقع.')
) as v (locale_code, title, excerpt, body, meta_description)
on conflict (page_id, locale_code) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_pages integer;
  v_translations integer;
  v_untranslated integer;
begin
  select count(*) into v_pages from public.pages where page_key is not null;
  if v_pages < 22 then
    raise exception 'expected at least 22 keyed pages, found %', v_pages;
  end if;

  -- Every page this migration seeded carries both locales. A page published in one language only would answer
  -- the other language with the default locale's text, which is the fallback for a translation gap and not
  -- something to create deliberately.
  select count(*) into v_untranslated
  from public.pages p
  where p.page_key is not null
    and (select count(*) from public.page_translations t
         where t.page_id = p.id and t.locale_code in ('en', 'ar')) < 2;
  if v_untranslated > 0 then
    raise exception '% keyed page(s) are missing a translation', v_untranslated;
  end if;

  select count(*) into v_translations from public.page_translations;
  if v_translations < 22 * 2 then
    raise exception 'expected at least % translations, found %', 22 * 2, v_translations;
  end if;

  -- Nothing here may publish a page with an empty body: the constraint already forbids it, and asserting it
  -- here is what catches a generator that emitted whitespace rather than text.
  if exists (select 1 from public.page_translations where length(btrim(body, E' \t\r\n')) = 0) then
    raise exception 'a seeded page has an empty body';
  end if;
end;
$$;
