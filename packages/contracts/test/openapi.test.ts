import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument, serializeOpenApiDocument } from '../src/index.js';

const committed = readFileSync(new URL('../openapi/openapi.json', import.meta.url), 'utf8');

describe('OpenAPI document', () => {
  const doc = generateOpenApiDocument();

  it('uses the approved header', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({ title: 'API', version: '0.0.0' });
  });

  it('contains only the documented operations', () => {
    // The health and readiness checks from Phase 1 Step 3, the `/v1` foundation probe added with the
    // internal BFF credential boundary, the F2 login route, the three approved F3 recovery routes, the
    // two F4 contact-change routes, the Phase 4-A public category tree, the two Phase 4-B public
    // listing routes, the two Phase 4-C public service routes the Phase 4-D category landing route, the
    // Phase 4-E seller profile route, the Phase 4-F search route, the three Phase 5-A session routes
    // the three Phase 5-C messaging read routes, the six Phase 5-E messaging write routes and the one
    // Phase 5-H reporting route, the Phase 6-A authenticated seller identity (which 6-C and 6-D extended in
    // place with a creation and an edit), the two Phase 6-E seller media routes, the four Phase 6-F seller
    // listing routes, the two Phase 6-G seller service routes and the five Phase 6-I seller verification
    // routes. Anything else appearing here is an undocumented route or a business endpoint that has not been
    // approved.
    //
    // 6-G adds two paths and not four: a service is submitted and archived through the listing routes above,
    // which move the same `listings` row, so there is no service submission or archive path to document.
    //
    // 6-I adds five paths and no admin surface at all: the attempt (read and start share one address), the
    // upload authorization, the document record, one document by its id, and the submission. There is no
    // route here that decides a verification, and there is deliberately none for shipping configuration,
    // which the approved S-11 decision defers to Phase 8.
    //
    // 7-A adds the two registration paths. There is deliberately no email-verification path: this
    // repository's canonical verified contact is the phone, and registration uses the established
    // WhatsApp OTP lifecycle rather than a second mechanism.
    //
    // 7-F adds exactly one: the staff console session the admin shell reads before it renders
    // anything. There is deliberately no admin business path — 7-F is the shell — and no
    // "get current permissions" write of any kind.
    //
    // 7-E adds the buyer account surfaces: favorites, saved searches, addresses, the profile and the
    // settings, all under /v1/users/me, plus the country reference an address form needs. There is
    // deliberately no saved-search match path and no checkout or order path — no matching engine exists
    // and shipping is Phase 8.
    //
    // 6-J adds five read paths and no write path at all: orders, reviews, earnings, promotions and analytics,
    // every one a GET. There is deliberately no listing-level analytics path, because no authoritative
    // listing-level rollup exists to read, and deliberately no withdrawal, payout or order-status path,
    // because those are Phase 8 writers.
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      '/health',
      '/ready',
      // 7-N: the moderation console. A report queue, one report, its decision and the actions citing it;
      // a listing queue, one listing, its decision and its trail. Eight paths, and deliberately no ninth:
      // nothing updates a decision, nothing reverses one, and nothing assigns a report — no writer in this
      // repository does any of those.
      // 7-O: the audit trail. One read and no writer anywhere — reading it writes nothing to it, and
      // there is no audit path that is not a GET.
      // 8-C: the attribute and tag vocabulary. Attaching an attribute to a category is governed by the
      // category key rather than the attribute key, which is what the table's own write policy says.
      '/v1/admin/analytics/listings',
      '/v1/admin/attributes',
      '/v1/admin/attributes/{definitionId}',
      '/v1/admin/attributes/{definitionId}/options',
      '/v1/admin/attributes/{definitionId}/options/{optionId}',
      '/v1/admin/attributes/{definitionId}/options/{optionId}/state',
      '/v1/admin/attributes/{definitionId}/state',
      '/v1/admin/audit',
      '/v1/admin/blog',
      '/v1/admin/blog/categories',
      '/v1/admin/blog/categories/{categoryId}',
      '/v1/admin/blog/tags',
      '/v1/admin/blog/tags/{tagId}',
      '/v1/admin/blog/taxonomy',
      '/v1/admin/blog/{postId}',
      '/v1/admin/blog/{postId}/status',
      '/v1/admin/blog/{postId}/tags',
      '/v1/admin/blog/{postId}/translations/{localeCode}',
      // The category tree (D8): the whole tree, one category, create, edit, show/hide, and one locale.
      '/v1/admin/categories',
      '/v1/admin/categories/{categoryId}',
      '/v1/admin/categories/{categoryId}/attributes',
      '/v1/admin/categories/{categoryId}/attributes/{definitionId}',
      '/v1/admin/categories/{categoryId}/state',
      '/v1/admin/categories/{categoryId}/translations/{localeCode}',
      // 0098. The media library: a page of entries, the two halves of a signed upload, one entry's references,
      // a staff-only signed preview, its alt text and its removal. There is deliberately no public counterpart —
      // no public media delivery exists.
      '/v1/admin/cms/media',
      '/v1/admin/cms/media/uploads',
      '/v1/admin/cms/media/{mediaId}',
      '/v1/admin/cms/media/{mediaId}/alt-text',
      '/v1/admin/cms/media/{mediaId}/preview',
      '/v1/admin/cms/media/{mediaId}/usage',
      '/v1/admin/cms/pages',
      '/v1/admin/cms/pages/{pageId}',
      '/v1/admin/cms/pages/{pageId}/cover',
      '/v1/admin/cms/pages/{pageId}/status',
      '/v1/admin/cms/pages/{pageId}/translations/{localeCode}',
      // 7-R: dispute management. Three reads and two writes, and **neither write moves money**: a resolution
      // records a decision, and the refund it may imply is a separate financial operation no writer in this
      // repository performs. Deliberately no sixth path: nothing assigns a dispute, nothing changes a due
      // date, nothing cancels one, and nothing attaches or reads evidence — no writer exists for any of
      // those. Sorted before `/v1/admin/moderation/...` because `disputes` precedes `moderation`.
      '/v1/admin/disputes',
      '/v1/admin/disputes/{disputeId}',
      '/v1/admin/disputes/{disputeId}/messages',
      '/v1/admin/disputes/{disputeId}/resolution',
      // 8-E (0095): the help centre. Six operations — an entry is created, changed, published, unpublished and
      // removed, with the topic list beside them because which topics exist and which of them any public address
      // shows is the one thing an operator cannot work out from the entries alone. The reorder is one request for
      // a whole topic, for the reason every other reorder in this document is.
      '/v1/admin/faqs',
      '/v1/admin/faqs/reorder',
      '/v1/admin/faqs/topics',
      '/v1/admin/faqs/{faqId}',
      '/v1/admin/faqs/{faqId}/state',
      '/v1/admin/homepage/sections',
      '/v1/admin/homepage/sections/reorder',
      '/v1/admin/homepage/sections/{sectionId}',
      '/v1/admin/homepage/sections/{sectionId}/state',
      '/v1/admin/moderation/listings',
      '/v1/admin/moderation/listings/{listingId}',
      '/v1/admin/moderation/listings/{listingId}/actions',
      '/v1/admin/moderation/listings/{listingId}/history',
      '/v1/admin/moderation/reports',
      '/v1/admin/moderation/reports/{reportId}',
      '/v1/admin/moderation/reports/{reportId}/actions',
      '/v1/admin/moderation/reports/{reportId}/resolution',
      // 8-E (0094): navigation. Eight operations — a menu is created, changed, shown, hidden and removed, and so
      // is an entry, with one more route for promoting an entry out from under its heading, because an absent
      // `parentId` on a change has to keep meaning "leave it where it is". The reorder is one request for a whole
      // menu, for the reason every other reorder in this document is.
      '/v1/admin/navigation/items',
      '/v1/admin/navigation/items/reorder',
      '/v1/admin/navigation/items/{itemId}',
      '/v1/admin/navigation/items/{itemId}/promote',
      '/v1/admin/navigation/items/{itemId}/state',
      '/v1/admin/navigation/menus',
      '/v1/admin/navigation/menus/{menuId}',
      '/v1/admin/navigation/menus/{menuId}/state',
      // 7-Q: platform job runs and outbox health. Five operations and every one a GET — the group that
      // proves the point: the workers own every write to a run and to an event, and no writer for a retry,
      // a cancel, a requeue or a dead-letter replay exists, so no path here offers one. Sorted before
      // `/v1/admin/recovery/...` because `platform` precedes `recovery`.
      '/v1/admin/platform/job-runs',
      '/v1/admin/platform/job-runs/{runId}',
      '/v1/admin/platform/outbox',
      '/v1/admin/platform/schedule-problems',
      '/v1/admin/platform/scheduled-jobs',
      // 7-O: account recovery review. The queue, one request, its evidence, and the three steps of the
      // existing state machine — review, decision, completion. Deliberately no fourth step: verifying the
      // new contact is the requester's own, through a one-time code, and no admin path does it.
      '/v1/admin/recovery/requests',
      '/v1/admin/recovery/requests/{requestId}',
      '/v1/admin/recovery/requests/{requestId}/completion',
      '/v1/admin/recovery/requests/{requestId}/decision',
      '/v1/admin/recovery/requests/{requestId}/evidence',
      '/v1/admin/recovery/requests/{requestId}/review',
      // 7-O: the role catalogue, read only. There is no POST, PUT, PATCH or DELETE on a role anywhere in
      // this document.
      // 7-P: review moderation. A queue, one review with its reply, that review's trail, and one decision.
      // Four paths, and deliberately no fifth: nothing moderates a review *reply*, because no writer for a
      // reply's status exists in this repository — a reported capability gap, not an omission.
      '/v1/admin/reviews',
      '/v1/admin/reviews/{reviewId}',
      '/v1/admin/reviews/{reviewId}/actions',
      '/v1/admin/reviews/{reviewId}/moderation',
      '/v1/admin/roles',
      '/v1/admin/roles/grantable',
      '/v1/admin/seller-verifications',
      '/v1/admin/seller-verifications/{verificationId}',
      '/v1/admin/seller-verifications/{verificationId}/decision',
      '/v1/admin/seller-verifications/{verificationId}/documents/{documentId}/link',
      // 7-O: the storefronts. Two reads and one write — the status transition below. Role assignment has
      // no path anywhere in this document: that writer is deferred to its own increment after Phase 7.
      '/v1/admin/sellers',
      '/v1/admin/sellers/{slug}',
      // 7-O's one seller write: the status transition, POST and nothing else. There is deliberately no
      // PATCH on the storefront itself and no separate suspend/close/reinstate path — one operation carries
      // the target status, and the database owns which pairs are legal.
      '/v1/admin/sellers/{slug}/status',
      // 8-E: the SEO redirect map. A list, a detail, a create, an edit, the state transition on its own path,
      // and a removal — the only admin surface in this document with a real DELETE, because a map entry is an
      // instruction about an address rather than content with a history. There is no priority, group, pattern
      // or analytics path anywhere: none of those exists on this map.
      // 8-F: per-entity metadata. A list, a detail, one `PUT` on the collection because a surface and a locale
      // have one row and the request is that row, and a removal that returns the surface to its derived metadata.
      '/v1/admin/seo/metadata',
      '/v1/admin/seo/metadata/{entryId}',
      '/v1/admin/seo/redirects',
      '/v1/admin/seo/redirects/{redirectId}',
      '/v1/admin/seo/redirects/{redirectId}/state',
      // 0096. Authoring only: the collection reads every active locale and the locale route writes or removes one.
      // There is deliberately no public counterpart — `/v1/seo/robots` is 0086's and already serves the one column
      // of this table that anything reads.
      '/v1/admin/seo/settings',
      '/v1/admin/seo/settings/{localeCode}',
      // 7-J: the Admin Only queue, one detail, the payment information behind its own permission, and the
      // one approved staff closure.
      '/v1/admin/service-requests',
      '/v1/admin/service-requests/{requestId}',
      '/v1/admin/service-requests/{requestId}/decline',
      '/v1/admin/service-requests/{requestId}/payment-information',
      '/v1/admin/session',
      // 7-L: the support agent console. Two lists, one ticket, the conversation and the notes with a read
      // and a write each, the two assignment steps, the decision and one signed attachment read — all
      // inside the approved /v1/admin/support/* group.
      '/v1/admin/support/assigned',
      '/v1/admin/support/queue',
      '/v1/admin/support/tickets/{ticketId}',
      '/v1/admin/support/tickets/{ticketId}/attachments/{attachmentId}/link',
      '/v1/admin/support/tickets/{ticketId}/claim',
      '/v1/admin/support/tickets/{ticketId}/decision',
      '/v1/admin/support/tickets/{ticketId}/messages',
      '/v1/admin/support/tickets/{ticketId}/notes',
      '/v1/admin/support/tickets/{ticketId}/release',
      // 8-C: the tag vocabulary, behind its own key. Holding it grants nothing on attributes, and nothing
      // here deletes a tag: `listing_tags` restricts, so hiding is the operation that exists.
      '/v1/admin/tags',
      '/v1/admin/tags/{tagId}',
      '/v1/admin/tags/{tagId}/state',
      // 7-O: the accounts, read only, and the two reads behind their own separate keys. The roles path is
      // a GET and nothing else: no authoritative writer for a role assignment exists in this repository,
      // so there is deliberately no POST or DELETE beside it.
      '/v1/admin/users',
      '/v1/admin/users/{userId}',
      '/v1/admin/users/{userId}/roles',
      '/v1/admin/users/{userId}/roles/revoke',
      '/v1/admin/users/{userId}/security-events',
      '/v1/auth/login',
      '/v1/auth/logout',
      '/v1/auth/recovery/reset',
      '/v1/auth/recovery/start',
      '/v1/auth/recovery/verify',
      '/v1/auth/refresh',
      '/v1/auth/register',
      '/v1/auth/register/resend',
      '/v1/auth/register/verify',
      // Phase 7-B. There is deliberately no path for removing a factor and none for backup codes: the
      // specification gates D9's recovery path on O-1 tests 4 and 5, which have not been run.
      '/v1/auth/totp',
      '/v1/auth/totp/challenge',
      '/v1/auth/totp/enrol',
      '/v1/auth/totp/verify',
      '/v1/blog',
      '/v1/blog/taxonomy',
      '/v1/blog/{slug}',
      '/v1/categories',
      '/v1/categories/{slug}',
      // 8-D: the listings in a category and every active category beneath it, with the filter panel that
      // produced the page. Unauthenticated, like every other public catalogue read.
      '/v1/categories/{slug}/listings',
      '/v1/cms/pages',
      '/v1/cms/pages/{slug}',
      // 8-E (0095): the published entries of one topic, read by the page that shows it. One operation, no writes:
      // the public never authors a question.
      '/v1/faqs',
      '/v1/foundation',
      '/v1/homepage',
      '/v1/listings',
      '/v1/listings/{slug}',
      '/v1/messaging/conversations',
      '/v1/messaging/conversations/{conversationId}/attachments/{attachmentId}/link',
      '/v1/messaging/conversations/{conversationId}/closed',
      '/v1/messaging/conversations/{conversationId}/membership',
      '/v1/messaging/conversations/{conversationId}/messages',
      '/v1/messaging/conversations/{conversationId}/messages/{messageId}/attachments',
      '/v1/messaging/conversations/{conversationId}/messages/{messageId}/attachments/uploads',
      '/v1/messaging/conversations/{conversationId}/muted',
      '/v1/messaging/conversations/{conversationId}/read',
      '/v1/messaging/reports',
      '/v1/messaging/unread-count',
      // 8-E (0094): the public menus, read once per page for the whole chrome. One operation, no writes: the
      // public never authors navigation.
      '/v1/navigation',
      // Phase 7-C. Four operations and deliberately no fifth: notifications are created by the domains
      // that cause them, so there is no create path, and archiving is how a row leaves an inbox, so
      // there is no delete path either.
      '/v1/notifications',
      '/v1/notifications/archive',
      '/v1/notifications/read',
      '/v1/notifications/unread-count',
      // 7-H: two reads, one create and four named transitions. There is no path that assigns a status
      // and none that accepts a payment deadline.
      '/v1/reference/countries',
      // 7-M: one create and one read, and no third. A report is a request for a look, so nothing here
      // updates or withdraws one, and the reporter names a subject by its public slug rather than by an id.
      '/v1/reports',
      '/v1/search',
      '/v1/sellers/me',
      '/v1/sellers/me/analytics',
      '/v1/sellers/me/earnings',
      '/v1/sellers/me/listing-analytics',
      '/v1/sellers/me/listings',
      '/v1/sellers/me/listings/{slug}',
      '/v1/sellers/me/listings/{slug}/archive',
      // 8-C: reading the questions a listing's category asks and answering them share an address, on both
      // seller surfaces. A POST, because nothing under /v1/sellers replaces a resource wholesale.
      '/v1/sellers/me/listings/{slug}/attributes',
      '/v1/sellers/me/listings/{slug}/submission',
      '/v1/sellers/me/listings/{slug}/tags',
      '/v1/sellers/me/media',
      '/v1/sellers/me/media/uploads',
      '/v1/sellers/me/orders',
      '/v1/sellers/me/promotions',
      '/v1/sellers/me/reviews',
      '/v1/sellers/me/services',
      '/v1/sellers/me/services/{slug}',
      '/v1/sellers/me/services/{slug}/attributes',
      '/v1/sellers/me/services/{slug}/tags',
      '/v1/sellers/me/verification',
      '/v1/sellers/me/verification/documents',
      '/v1/sellers/me/verification/documents/uploads',
      '/v1/sellers/me/verification/documents/{documentId}',
      '/v1/sellers/me/verification/submission',
      '/v1/sellers/{slug}',
      // Public SEO delivery: the redirect-map question, the robots body, the sitemap index's counts, and the
      // numbered child sitemaps. Unauthenticated and read-only — every value exists to be served to a crawler.
      // The resolution route is asked only about a path the site has already decided answers 404, because the
      // approved precedence is LIVE PAGE WINS.
      // 8-F's public read: addressed by slug or by route path, never by an identifier, so no internal id has to
      // cross into a public response to make it possible.
      '/v1/seo/metadata',
      '/v1/seo/redirects/resolve',
      '/v1/seo/robots',
      '/v1/seo/sitemap',
      '/v1/seo/sitemap/{type}/{page}',
      // 7-I: two lists, one detail, one create, two request transitions, one quote create and three quote
      // transitions — all inside the approved /v1/service-requests/* group.
      '/v1/service-requests',
      // 7-J: the buyer's Admin Only create. Its name describes the row it produces, not a privilege the
      // caller holds — the server writes the routing mode either way.
      '/v1/service-requests/admin-only',
      '/v1/service-requests/made',
      '/v1/service-requests/{requestId}',
      '/v1/service-requests/{requestId}/cancel',
      '/v1/services',
      '/v1/services/{slug}',
      // 7-K: the requester side of support. One list, one create, one detail, one conversation, one reply,
      // one closure, the two halves of an attachment upload and one signed read — all inside the approved
      // /v1/support/* group, and none of them an agent surface.
      '/v1/support/tickets',
      '/v1/support/tickets/{ticketId}',
      '/v1/support/tickets/{ticketId}/attachments/{attachmentId}/link',
      '/v1/support/tickets/{ticketId}/close',
      '/v1/support/tickets/{ticketId}/messages',
      '/v1/support/tickets/{ticketId}/messages/{messageId}/attachments',
      '/v1/support/tickets/{ticketId}/messages/{messageId}/attachments/uploads',
      '/v1/track',
      '/v1/users/me',
      '/v1/users/me/addresses',
      '/v1/users/me/addresses/{addressId}',
      '/v1/users/me/blocks',
      '/v1/users/me/blocks/{reference}',
      '/v1/users/me/contact/phone/start',
      '/v1/users/me/contact/phone/verify',
      '/v1/users/me/favorites',
      '/v1/users/me/favorites/{listingId}',
      '/v1/users/me/profile',
      '/v1/users/me/saved-searches',
      '/v1/users/me/saved-searches/{savedSearchId}',
      '/v1/users/me/settings',
    ]);
    expect(doc.paths?.['/health']?.get?.operationId).toBe('getHealth');
    expect(doc.paths?.['/ready']?.get?.operationId).toBe('getReadiness');
    expect(doc.paths?.['/v1/foundation']?.get?.operationId).toBe('getV1Foundation');
    expect(doc.paths?.['/v1/auth/login']?.post?.operationId).toBe('postV1AuthLogin');
    expect(doc.paths?.['/v1/auth/recovery/start']?.post?.operationId).toBe('postV1AuthRecoveryStart');
    expect(doc.paths?.['/v1/auth/recovery/verify']?.post?.operationId).toBe('postV1AuthRecoveryVerify');
    expect(doc.paths?.['/v1/auth/recovery/reset']?.post?.operationId).toBe('postV1AuthRecoveryReset');
    expect(doc.paths?.['/v1/categories/{slug}']?.get?.operationId).toBe('getV1CategoryBySlug');
    expect(doc.paths?.['/v1/listings']?.get?.operationId).toBe('getV1Listings');
    expect(doc.paths?.['/v1/listings/{slug}']?.get?.operationId).toBe('getV1ListingBySlug');
    expect(doc.paths?.['/v1/search']?.get?.operationId).toBe('getV1Search');
    expect(doc.paths?.['/v1/sellers/{slug}']?.get?.operationId).toBe('getV1SellerBySlug');
    expect(doc.paths?.['/v1/services']?.get?.operationId).toBe('getV1Services');
    expect(doc.paths?.['/v1/services/{slug}']?.get?.operationId).toBe('getV1ServiceBySlug');
    expect(doc.paths?.['/v1/users/me/contact/phone/start']?.post?.operationId).toBe('postV1UsersMeContactPhoneStart');
    expect(doc.paths?.['/v1/users/me/contact/phone/verify']?.post?.operationId).toBe('postV1UsersMeContactPhoneVerify');
  });

  it('documents the contact-change routes with the approved statuses and no account field', () => {
    for (const path of ['/v1/users/me/contact/phone/start', '/v1/users/me/contact/phone/verify']) {
      const responses = doc.paths?.[path]?.post?.responses ?? {};
      expect(Object.keys(responses).sort()).toEqual(['200', '400', '401', '403', '429', '500', '503']);
      // The caller's session decides the account; a request may never name one.
      expect(JSON.stringify(doc.paths?.[path]?.post?.requestBody)).not.toMatch(/user_?id/i);
      expect(JSON.stringify(doc.paths?.[path]?.post?.parameters)).toContain('x-session-token');
    }
    const schemas = (doc.components?.schemas ?? {}) as Record<string, { properties?: Record<string, unknown> }>;
    expect(Object.keys(schemas['ContactPhoneStartRequest']?.properties ?? {})).toEqual(['phone']);
    expect(Object.keys(schemas['ContactPhoneVerifyRequest']?.properties ?? {}).sort()).toEqual(['challengeId', 'otp']);
    expect(Object.keys(schemas['ContactPhoneStartResponse']?.properties ?? {})).toEqual(['status']);
    expect(Object.keys(schemas['ContactPhoneVerifyResponse']?.properties ?? {})).toEqual(['status']);
  });

  it('documents the recovery routes with no field that could carry a token, a code or a destination', () => {
    // The shapes, not the prose: a success body may carry no token, code or destination field.
    const schemas = (doc.components?.schemas ?? {}) as Record<string, { properties?: Record<string, unknown> }>;
    for (const name of ['RecoveryStartResponse', 'RecoveryVerifyResponse', 'RecoveryResetResponse']) {
      const properties = Object.keys(schemas[name]?.properties ?? {});
      expect(properties.length).toBeGreaterThan(0);
      for (const property of properties) {
        expect(property).not.toMatch(/token|otp|code|phone|email|destination|user/i);
      }
    }
    expect(Object.keys(schemas['RecoveryStartResponse']?.properties ?? {}).sort()).toEqual(['challengeId', 'status']);
    expect(Object.keys(schemas['RecoveryVerifyResponse']?.properties ?? {})).toEqual(['status']);
    expect(Object.keys(schemas['RecoveryResetResponse']?.properties ?? {})).toEqual(['status']);
    // Start must not even hint at an account: its 200 body is a status and an opaque challenge id.
    const start = doc.paths?.['/v1/auth/recovery/start']?.post?.responses ?? {};
    expect(Object.keys(start).sort()).toEqual(['200', '400', '403', '429', '500', '503']);
    // No 401 on start: a missing account is not an authentication failure and must not look like one.
    expect(start['401']).toBeUndefined();
    const verify = doc.paths?.['/v1/auth/recovery/verify']?.post?.responses ?? {};
    expect(Object.keys(verify).sort()).toEqual(['200', '400', '401', '403', '429', '500', '503']);
    const reset = doc.paths?.['/v1/auth/recovery/reset']?.post?.responses ?? {};
    expect(Object.keys(reset).sort()).toEqual(['200', '400', '401', '403', '429', '500', '503']);
    // The reset token is a header the BFF sets, never a field in the browser's body.
    expect(JSON.stringify(doc.paths?.['/v1/auth/recovery/reset']?.post?.requestBody)).not.toMatch(/token/i);
    expect(JSON.stringify(doc.paths?.['/v1/auth/recovery/reset']?.post?.parameters)).toContain('x-reset-token');
  });

  it('documents the login route without a single field that could carry a token', () => {
    const responses = doc.paths?.['/v1/auth/login']?.post?.responses ?? {};
    // C-8: the browser session is a cookie the BFF sets. A 200 says only that it worked.
    const success = JSON.stringify(responses['200']);
    expect(success).not.toMatch(/access_token|accessToken|refresh_token|refreshToken|bearer/i);
    // C-2: every approved status is documented, and the three authentication outcomes share the one.
    expect(Object.keys(responses).sort()).toEqual(['200', '400', '401', '403', '429', '500', '503']);
  });

  it('documents the /v1 foundation probe as guarded and business-free', () => {
    const responses = doc.paths?.['/v1/foundation']?.get?.responses ?? {};
    // 403 for a refused internal credential; no 401, because this boundary is not user authentication.
    expect(Object.keys(responses).sort()).toEqual(['200', '403', '500']);
    const forbidden = responses['403'] as { content?: Record<string, unknown> };
    expect(Object.keys(forbidden.content ?? {})).toEqual(['application/problem+json']);
  });

  it('uses application/problem+json for error responses', () => {
    const error = doc.paths?.['/health']?.get?.responses?.['500'] as { content?: Record<string, unknown> };
    expect(Object.keys(error.content ?? {})).toEqual(['application/problem+json']);
  });

  it('is deterministic and matches the committed file', () => {
    expect(serializeOpenApiDocument()).toBe(serializeOpenApiDocument());
    expect(serializeOpenApiDocument()).toBe(committed);
  });
});
