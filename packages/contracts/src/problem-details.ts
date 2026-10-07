import { z } from './zod.js';

/** Stable, machine-readable problem codes produced by the API. */
export const PROBLEM_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'HTTP_ERROR',
  'INTERNAL_ERROR',
  // Owner decision C-2. One code for every authentication failure: a wrong password, an identifier that
  // matches no account and a locked account are indistinguishable to the caller, by code as well as by
  // body. Nothing here ever says which one happened.
  'AUTHENTICATION_FAILED',
  'TOO_MANY_REQUESTS',
  'SERVICE_UNAVAILABLE',
  // F4 contact change. The approved contract names its own two codes: a request without a usable
  // session is AUTHENTICATION_REQUIRED (nothing was attempted), while a refused code stays
  // AUTHENTICATION_FAILED, and its throttle answers THROTTLED. The login codes above are untouched.
  'AUTHENTICATION_REQUIRED',
  'THROTTLED',
  // Phase 7-B TOTP. Two codes, and they are the only things this surface says beyond the generic
  // refusal — because both are facts about the caller's own account, which the same surface already
  // reports to them: they have a verified authenticator when they asked to enrol one, or they have none
  // when a challenge was asked for. A wrong code, an expired challenge, a spent challenge and a factor
  // belonging to somebody else all stay AUTHENTICATION_FAILED, indistinguishable from each other.
  'TOTP_ALREADY_ENROLLED',
  'TOTP_NOT_ENROLLED',
  // Phase 7-C notifications. One code for every unusable cursor — malformed, tampered, or from a version
  // this API no longer reads — for the same reason the messaging one has only one: the client's remedy is
  // identical in all three, and naming which check failed would only help somebody mapping the format.
  // There is deliberately no "notification not found" and no "forbidden": every operation here is scoped
  // to the caller in the statement, so a notification that is not theirs is simply not matched, and
  // reporting on it would be reporting on somebody else's inbox.
  'NOTIFICATIONS_CURSOR_INVALID',
  // Phase 5-C messaging reads. One code for every unusable cursor — malformed, tampered, or from a
  // version this API no longer reads — because the client's remedy is the same in all three and naming
  // which check failed would only help somebody mapping the format. And one code for a conversation the
  // caller may not read, which is deliberately the same code, status and body a conversation that does
  // not exist produces: a distinct "forbidden" would confirm that the conversation is real.
  'MESSAGING_CURSOR_INVALID',
  'MESSAGING_CONVERSATION_NOT_FOUND',
  // Phase 5-E messaging writes. A closed conversation, a blocked pair and a seller who cannot be
  // contacted are all states the caller can do something about, so each gets its own code — unlike the
  // inaccessible-conversation case above, which stays deliberately indistinguishable from absence.
  'MESSAGING_CONVERSATION_CLOSED',
  'MESSAGING_BLOCKED',
  'MESSAGING_SELLER_NOT_CONTACTABLE',
  'MESSAGING_REPORT_TARGET_NOT_FOUND',
  // 0104 conversation attachments. Two codes, and deliberately only two, because only two refusals are things
  // a caller can act on; everything else is a plain NOT_FOUND or VALIDATION_FAILED.
  //
  // `MESSAGE_ATTACHMENT_LIMIT_REACHED` — the message already holds the five it may. Its own code because the
  // remedy is specific and not obvious: send another message and attach to that one. A bare refusal would
  // leave somebody retrying the same upload.
  //
  // `MESSAGE_ATTACHMENT_OBJECT_MISSING` — a confirmation arrived for a file the storage provider does not
  // have, exactly as `SUPPORT_ATTACHMENT_OBJECT_MISSING` reports for a ticket. Its own code because the remedy
  // is to upload the bytes again rather than to stop, and because recording a row that points at nothing would
  // leave a thread showing a file nobody can open.
  //
  // A **blocked pair** reuses `MESSAGING_BLOCKED` above rather than adding a third: it is the same refusal for
  // the same reason, and a second name for it would be two things to keep in step.
  'MESSAGE_ATTACHMENT_LIMIT_REACHED',
  'MESSAGE_ATTACHMENT_OBJECT_MISSING',
  // Phase 6-C seller onboarding. Two conflicts a form can act on, and they are deliberately distinct: the
  // caller already has a storefront, or the public address they chose belongs to somebody else. The second
  // says only that the address is unavailable — never who holds it, or what state their storefront is in.
  // Everything else onboarding refuses is an ordinary VALIDATION_FAILED, so no code names a column.
  'SELLER_PROFILE_EXISTS',
  'SELLER_SLUG_TAKEN',
  // Phase 6-D. A suspended or closed storefront cannot be edited. Its own code because the caller can do
  // something about knowing it — their own account state is already readable — and the sentence behind it
  // says only that, never the reason, which is moderation's and not the seller's to read.
  'SELLER_PROFILE_NOT_EDITABLE',
  // Phase 6-E. The object the caller asked to confirm is not in storage, so there is nothing to record. Its
  // own code because the remedy is specific — upload the file, then confirm — and a generic validation
  // failure would send somebody looking at their form fields instead.
  'SELLER_MEDIA_OBJECT_MISSING',
  // Phase 6-F seller listings. Three conflicts a seller surface can act on, and they stay distinct because
  // the remedies differ: the listing is in a state this surface does not write (a submitted draft, a listing
  // that is not live), the address they chose is unavailable, or the draft is not yet complete enough to be
  // reviewed. None of them names a moderation reason, a moderator or another account — a listing that is not
  // the caller's is a plain NOT_FOUND, exactly like one that does not exist, and a listing the caller may not
  // reach is never distinguished from absence. One code for every unusable listings cursor, for the same
  // reason the messaging one has only one.
  'SELLER_LISTING_NOT_EDITABLE',
  'SELLER_LISTING_SLUG_TAKEN',
  'SELLER_LISTING_INCOMPLETE',
  'SELLER_LISTING_CURSOR_INVALID',
  // Phase 6-I seller verification submission. Four conflicts a seller surface can act on, distinct because
  // the remedies differ and each is something the caller can already see about their own account.
  //
  // `SELLER_VERIFICATION_EXISTS` — an attempt is already open, so a second one is not started. The form's
  // answer is to work on the one that exists, which the same surface returns.
  //
  // `SELLER_VERIFICATION_ALREADY_VERIFIED` — the storefront is verified, so there is nothing to apply for
  // (owner decision 2). No attempt is created, and the surface offers no way to reapply.
  //
  // `SELLER_VERIFICATION_NOT_EDITABLE` — the storefront is suspended or closed, or the attempt has reached a
  // state that is no longer the seller's to change: `under_review`, `approved`, `rejected` or `expired`. One
  // code for all of them, and the sentence behind it names no reviewer, no decision and no reason, because a
  // decision's reasoning is the reviewer's and is never disclosed to the applicant by this API.
  //
  // `SELLER_VERIFICATION_DOCUMENT_PATH_TAKEN` — that object has already been recorded. Its own code because
  // the remedy is to authorize a fresh upload rather than to correct a field.
  //
  // Everything else is VALIDATION_FAILED or a plain NOT_FOUND. A document that is not the caller's is
  // NOT_FOUND, identical to one that does not exist, so asking cannot reveal that somebody else's document
  // is there. There is no code for "not enough documents": by owner decision 1 there is no minimum, and
  // whether the evidence suffices is the reviewer's judgement, not this API's.
  'SELLER_VERIFICATION_EXISTS',
  'SELLER_VERIFICATION_ALREADY_VERIFIED',
  'SELLER_VERIFICATION_NOT_EDITABLE',
  'SELLER_VERIFICATION_DOCUMENT_PATH_TAKEN',
  // Phase 7-E buyer account. Three codes, and deliberately only three, because only three refusals are
  // things the caller can act on and all three are facts about their own account.
  //
  // `SAVED_SEARCH_NAME_TAKEN` — they already have a saved search by that name. The 0013 constraint is
  // per account, so this says nothing about anybody else, and the remedy is to choose another name.
  //
  // `ADDRESS_COUNTRY_NOT_SHIPPABLE` — D17: an address used for shipping must sit in a marketplace-enabled
  // country. Its own code because a bare validation failure would send somebody looking at their street
  // name; the remedy is another country, or an address kept for billing only.
  //
  // `ACCOUNT_CURSOR_INVALID` — one code for every unusable favorites or saved-search cursor, for the same
  // reason the messaging and notification ones have only one: the remedy is identical in all cases and
  // naming which structural check failed would only help somebody mapping the format.
  //
  // Everything else is VALIDATION_FAILED or a plain NOT_FOUND. A saved search, an address or a listing
  // that is not the caller's is NOT_FOUND, identical to one that does not exist, so asking cannot reveal
  // that somebody else's row is there. There is no "forbidden" anywhere on these surfaces, because every
  // operation is scoped to the caller in the statement and a row that is not theirs is never matched.
  'SAVED_SEARCH_NAME_TAKEN',
  'ADDRESS_COUNTRY_NOT_SHIPPABLE',
  'ACCOUNT_CURSOR_INVALID',
  // Phase 7-G seller verification review. Three codes, and deliberately only three, because only three
  // refusals are things a reviewer can act on. Every other refusal on this surface — an unauthorized
  // caller, a verification that does not exist, a draft, and a document belonging to an application the
  // caller may not review — is a plain NOT_FOUND, identical in code, status and body, so asking cannot
  // confirm that somebody's application or document is there. There is deliberately **no** "forbidden":
  // a 403 on a specific verification would confirm it exists.
  //
  // `VERIFICATION_NOT_DECIDABLE` — the application is not in a state this path decides from: already
  // approved or rejected by somebody else, or expired. Its own code because the remedy is to reload and
  // look at the decision that is already there, and because it is exactly what a reviewer must be told
  // when two people opened the same case. The body names no reviewer.
  //
  // `VERIFICATION_CONTACTS_UNVERIFIED` — 0009's `seller_verifications_approval_needs_contacts`: an
  // approval requires both of the applicant's contact verifications. Its own code because the remedy is
  // specific and is not about the form's fields.
  //
  // `VERIFICATION_CURSOR_INVALID` — one code for every unusable queue cursor, for the same reason the
  // messaging, notification and account ones have only one.
  //
  // A rejection without a reason is an ordinary VALIDATION_FAILED naming the field, because that is what
  // it is: a form that has not been filled in.
  'VERIFICATION_NOT_DECIDABLE',
  'VERIFICATION_CONTACTS_UNVERIFIED',
  'VERIFICATION_CURSOR_INVALID',
  // Phase 7-H offers. Each of these is a fact about the offer or the listing in front of the caller, and
  // each has a different remedy — which is why they are distinct rather than one conflict code. An offer
  // that is not the caller's, on either side, is a plain NOT_FOUND identical to one that does not exist,
  // so there is no "forbidden" here either.
  //
  // `OFFER_ALREADY_OPEN` — 0015's one-open-per-buyer index: the caller already has a live offer on this
  // listing. The remedy is to go to it, which the same surface lists.
  //
  // `OFFER_NOT_AVAILABLE` — the listing is not in a state that can be bought, so it is not in a state
  // that can be offered on. The same admission test the listing's own purchase path uses.
  //
  // `OFFER_OWN_LISTING` — 0015's `offers_not_self`. The listing page is public and cacheable and cannot
  // know who is looking, so this is the first moment the caller can be told.
  //
  // `OFFER_BLOCKED` — one of the two parties has blocked the other. It says that and nothing more: never
  // which of them, and never when, because that is the other party's business.
  //
  // `OFFER_NOT_ACTIONABLE` — the offer has already been accepted, rejected, withdrawn, countered or
  // expired. Its own code because the remedy is to reload and look at what happened, and because it is
  // exactly what both parties must be told when they acted at the same moment.
  //
  // `OFFER_LAPSED` — the offer's negotiation window has passed. Distinct from the code above because the
  // status has not moved yet: the scheduled sweeper records it within minutes, and until then the honest
  // answer is that the window closed, not that somebody decided.
  //
  // `OFFER_PAYMENT_POLICY_MISSING` — the admin-configured payment window is absent or unusable, so the
  // payable obligation cannot be computed. A 503 and an integrity failure, never a silent default: an
  // acceptance with a guessed deadline would be a worse outcome than no acceptance.
  //
  // `OFFERS_CURSOR_INVALID` — one code for every unusable list cursor, for the same reason the messaging,
  // notification, account and verification ones have only one.
  'OFFER_ALREADY_OPEN',
  'OFFER_NOT_AVAILABLE',
  'OFFER_OWN_LISTING',
  'OFFER_BLOCKED',
  'OFFER_NOT_ACTIONABLE',
  'OFFER_LAPSED',
  'OFFER_PAYMENT_POLICY_MISSING',
  'OFFERS_CURSOR_INVALID',
  // Phase 7-I service requests and quotes, Option 1. Each is a fact about the listing, the request or the
  // quote in front of the caller, and each has a different remedy. A request or a quote the caller is not a
  // party to is a plain NOT_FOUND identical to one that does not exist, so there is no "forbidden" here.
  //
  // `SERVICE_REQUEST_NOT_AVAILABLE` — the service listing is not in a state that can be bought, so it is
  // not one that can be briefed either. The same admission test its own purchase path uses.
  //
  // `SERVICE_REQUEST_NOT_CUSTOM` — the service is fixed-price, so it is bought through the cart rather than
  // quoted. v5.2's own division, and the remedy is to buy it.
  //
  // `SERVICE_REQUEST_OWN_LISTING` — the schema's not-self rule. The public service page cannot know who is
  // looking, so this is the first moment the caller can be told.
  //
  // `SERVICE_REQUEST_BLOCKED` — one of the two parties has blocked the other. It says that and nothing more.
  //
  // `SERVICE_REQUEST_NOT_ACTIONABLE` — the request is closed, or the quote has already been decided. One
  // code for both because the remedy is the same: reload and look at what happened. It names no party.
  //
  // `SERVICE_QUOTE_LAPSED` — the quote's validity window has passed. Distinct from the code above because
  // the status has not moved yet: the scheduled sweeper records it within minutes.
  //
  // `SERVICE_QUOTE_PAYMENT_POLICY_MISSING` — the admin-configured payment window is absent or unusable, so
  // the payable obligation cannot be computed. A 503 and an integrity failure, never a silent default.
  //
  // `SERVICE_REQUEST_CURRENCY_UNAVAILABLE` — an Admin Only brief takes its currency from the platform's own
  //   default, and the platform has none. A 503 and an integrity failure, deliberately, for the same reason
  //   a missing payment window is: guessing a currency would be worse than not writing the brief.
  //
  // `SERVICE_REQUESTS_CURSOR_INVALID` — one code for every unusable list cursor, for the same reason the
  // others have only one.
  'SERVICE_REQUEST_NOT_AVAILABLE',
  'SERVICE_REQUEST_NOT_CUSTOM',
  'SERVICE_REQUEST_OWN_LISTING',
  'SERVICE_REQUEST_BLOCKED',
  'SERVICE_REQUEST_NOT_ACTIONABLE',
  'SERVICE_QUOTE_LAPSED',
  'SERVICE_QUOTE_PAYMENT_POLICY_MISSING',
  'SERVICE_REQUEST_CURRENCY_UNAVAILABLE',
  'SERVICE_REQUESTS_CURSOR_INVALID',
  // Phase 7-K support, the requester side. A ticket, a message or an attachment the caller did not raise is
  // a plain NOT_FOUND identical to one that does not exist — on this surface there is no "forbidden" and no
  // code that could confirm somebody else's ticket is real.
  //
  // `SUPPORT_TICKET_NOT_ACTIONABLE` — the ticket is closed, so it takes no further message, no further
  // attachment and no second closure. 0028's own rule, reported before it becomes an exception; the remedy
  // is specific, which is why it is not folded into the generic refusal: open a new ticket.
  //
  // `SUPPORT_TICKETS_CURSOR_INVALID` — one code for every unusable list or conversation cursor, for the same
  // reason the messaging, notification, account, verification, offer and service-request ones have only one.
  //
  // `SUPPORT_ATTACHMENT_OBJECT_MISSING` — a confirmation arrived for a file the storage provider does not
  // have. Its own code, as 6-E's and 6-I's equivalent has, because the remedy is to upload the bytes again
  // rather than to stop: recording a row that points at nothing would leave a ticket showing a file an
  // agent cannot open.
  'SUPPORT_TICKET_NOT_ACTIONABLE',
  'SUPPORT_ATTACHMENT_OBJECT_MISSING',
  'SUPPORT_TICKETS_CURSOR_INVALID',
  // Phase 7-L, the support agent console. A ticket held by another agent, one that does not exist and a
  // caller who holds neither support key are one NOT_FOUND, so there is no "forbidden" here either and no
  // code that could confirm a colleague's work exists.
  //
  // `SUPPORT_TICKET_NOT_WORKABLE` — the ticket cannot take this action: it is closed, it is already
  // resolved and resolution was asked for again, or the agent is trying to work a ticket nobody holds.
  // Its own code, distinct from the requester's `SUPPORT_TICKET_NOT_ACTIONABLE`, because the remedies
  // differ: claim it, or reload and look at what a colleague did.
  'SUPPORT_TICKET_NOT_WORKABLE',
  // Phase 7-M, the reporter side of reporting. A subject the public cannot see and one that does not exist
  // are one NOT_FOUND, exactly as 5-H's message reporting has it, so nothing here can be used to discover
  // that a hidden listing or an unlisted storefront is real.
  //
  // `REPORT_SUBJECT_NOT_REPORTABLE` — the subject type is not one this surface files. It is not a
  // not-found: the caller named a kind of thing rather than a thing, and the remedy is a different surface
  // (a message is reported from the conversation it is in) rather than a different identifier.
  //
  // `REPORT_SUBJECT_IS_THE_REPORTER` — somebody is reporting their own storefront. 0027 refuses it and the
  // refusal has its own code because it is the one refusal on this surface that discloses nothing and has
  // a remedy the reporter can act on: there is nothing to report.
  //
  // `REPORTS_CURSOR_INVALID` — one code for every unusable history cursor, for the same reason the
  // messaging, notification, account, verification, offer, service-request and support ones have only one.
  'REPORT_SUBJECT_NOT_REPORTABLE',
  'REPORT_SUBJECT_IS_THE_REPORTER',
  'REPORTS_CURSOR_INVALID',
  // Phase 7-N, the admin moderation console. A report or a listing a caller may not read, and one that does
  // not exist, are one NOT_FOUND — so nothing here can be used to discover that a report or a draft listing
  // is real, and there is no "forbidden" on this surface at all.
  //
  // `REPORT_ALREADY_FINAL` — the report is already actioned, dismissed or a duplicate. 0027's own rule
  // ("a closed report cannot be reopened by this path"), reported before it becomes an exception; its own
  // code because the remedy is to reload and read the decision rather than to try again.
  //
  // `REPORT_IS_OWN` — the caller filed this report. 0027 refuses it ("nobody rules on their own report")
  // and it has its own code because it discloses nothing — the only account it concerns is the caller's —
  // and the remedy is for a colleague to take it.
  //
  // `LISTING_IS_OWN` — the caller sells this listing. `moderate_listing`'s own refusal, same reasoning.
  //
  // `LISTING_MODERATION_NO_CHANGE` — the action would leave the status where it is, which
  // `listing_moderation_actions_status_moved` refuses. This is what a repeat looks like and what the loser
  // of two colleagues acting at once receives, so the remedy is to reload: somebody already did it.
  //
  // `LISTING_MODERATION_NOT_APPLICABLE` — the listing cannot hold the status this action would give it:
  // it has no price and would have gone live, or it was never approved and cannot be reinstated. Its own
  // code because retrying will never help and the remedy is elsewhere — the seller must supply a price.
  'REPORT_ALREADY_FINAL',
  'REPORT_IS_OWN',
  'LISTING_IS_OWN',
  'LISTING_MODERATION_NO_CHANGE',
  'LISTING_MODERATION_NOT_APPLICABLE',
  // Phase 7-O, the seller, user, recovery and audit surfaces. A storefront, an account or a recovery
  // request a caller may not read, and one that does not exist, are again one NOT_FOUND — and there is no
  // "forbidden" on any of them. That matters more here than anywhere else, because these four surfaces sit
  // behind keys that are deliberately not held together: a support agent reads accounts and not their
  // security events, a moderator reads storefronts and not roles, and only an administrator reads the audit
  // trail. A distinguishable refusal would turn each of those boundaries into a way to ask whether a
  // particular person has an account.
  //
  // There is deliberately **no code here for assigning a role or for changing a seller's account status**,
  // because there is no operation that does either: neither has an authoritative writer in this repository
  // and both are reported as capability gaps rather than invented.
  //
  // `RECOVERY_IS_OWN` — the request is the caller's own account, which 0028 refuses at every step. It
  // discloses nothing, because the only account it concerns is the caller's.
  //
  // `RECOVERY_NEEDS_ANOTHER_PERSON` — the two-person rule: the reviewer can never approve their own review.
  // The account holder reaches the same refusal and arrives as the same code, because to a console the two
  // mean the same thing and separating them would say which of the two the caller is.
  //
  // `RECOVERY_NOT_REVIEWABLE`, `RECOVERY_NOT_DECIDABLE`, `RECOVERY_NOT_COMPLETABLE` — the request is not at
  // that step. Each is also what a repeat looks like and what the second of two colleagues acting at once
  // receives, the writer having locked the row, so the remedy is to reload rather than to try again.
  // `RECOVERY_NOT_COMPLETABLE` additionally covers a request whose new contact was never verified and one
  // that matched no account: one code, because telling those apart would say more about somebody's account
  // than a completion screen needs to.
  'RECOVERY_IS_OWN',
  'RECOVERY_NEEDS_ANOTHER_PERSON',
  'RECOVERY_NOT_REVIEWABLE',
  'RECOVERY_NOT_DECIDABLE',
  'RECOVERY_NOT_COMPLETABLE',
  // Phase 7-O, seller account status management. A storefront a caller may not move, and one that does not
  // exist, are again one NOT_FOUND, and there is no "forbidden" here either: `sellers.profile.manage` is
  // held by admin and super_admin alone, and a moderator holding only the read key must not be able to tell
  // a storefront it cannot manage from one that is not there.
  //
  // `SELLER_STATUS_NOT_ALLOWED` — the transition is not one of the seven legal pairs. It covers every move
  // out of `closed`, which is terminal; `active → pending`; and `pending → active`, which belongs to the
  // verification approval rather than to this operation. Retrying never helps.
  //
  // `SELLER_STATUS_NO_CHANGE` — the storefront already holds that status. This is what a repeat looks like
  // and what the second of two colleagues acting at once receives, the writer having locked the row, so the
  // remedy is to reload rather than to try again.
  //
  // `SELLER_STATUS_REASON_REQUIRED` — a suspension with no reason. Checked in the contract and again in the
  // writer, so this is the floor rather than the path.
  //
  // `SELLER_STATUS_NOT_VERIFIED` — reinstating to `active` a storefront whose verification is not
  // `verified`, which `seller_profiles_active_needs_verification` would refuse. The remedy is `pending`, or
  // the verification review.
  //
  // `SELLER_STATUS_ALREADY_VERIFIED` — reinstating to `pending` a storefront that is verified. The remedy is
  // `active`: a verified storefront reinstates there, and parking it in `pending` would be a way to change
  // its standing without touching the verification workflow that owns it.
  'SELLER_STATUS_NOT_ALLOWED',
  'SELLER_STATUS_NO_CHANGE',
  'SELLER_STATUS_REASON_REQUIRED',
  'SELLER_STATUS_NOT_VERIFIED',
  'SELLER_STATUS_ALREADY_VERIFIED',
  // 0100, staff role assignment. The most privilege-sensitive writer the platform has, so each refusal says
  // which boundary stopped it — and an absence, a role nobody holds and a caller without `users.role.manage`
  // are all one NOT_FOUND, as everywhere else in this console.
  //
  // `STAFF_ROLE_IS_SELF` — the caller is the target. Refused for granting and revoking alike, so nobody
  // promotes or demotes themselves. Discloses nothing: the caller already knows who they are.
  //
  // `STAFF_ROLE_ABOVE_CEILING` — the role's `sort_order` is above the caller's own highest effective role, or
  // the caller effectively holds none. The remedy is somebody more senior, never a retry.
  //
  // `STAFF_ROLE_NOT_GRANTABLE` — `super_admin`, which this console never grants whoever asks. It is a
  // database-level operation by decision, in both directions.
  //
  // `STAFF_ROLE_NOT_REVOCABLE` — `super_admin` again, from the other side: the console that cannot create one
  // does not destroy one either.
  //
  // `STAFF_ROLE_NOT_ASSIGNABLE` — `roles.is_assignable` is false for that role. It is reference data, not a
  // state, so retrying never helps.
  //
  // `STAFF_ROLE_ALREADY_REVOKED` — the grant was already withdrawn. This is what a repeat looks like, and what
  // the second of two colleagues acting at once receives, the writer having locked the row.
  //
  // `STAFF_ROLE_EXPIRY_INVALID` — an expiry that is not in the future, which 0003's own constraint refuses.
  //
  // `STAFF_ROLE_REASON_REQUIRED` — a blank reason. The contract refuses it first, so this is the floor.
  'STAFF_ROLE_IS_SELF',
  'STAFF_ROLE_ABOVE_CEILING',
  'STAFF_ROLE_NOT_GRANTABLE',
  'STAFF_ROLE_NOT_REVOCABLE',
  'STAFF_ROLE_NOT_ASSIGNABLE',
  'STAFF_ROLE_ALREADY_REVOKED',
  'STAFF_ROLE_EXPIRY_INVALID',
  'STAFF_ROLE_REASON_REQUIRED',
  // Phase 7-P, review moderation. A review a caller may not read, and one that does not exist, are one
  // NOT_FOUND, and there is no "forbidden" on this surface either.
  //
  // `REVIEW_IS_PARTY` — the caller is the review's buyer or its seller. 0026 refuses it ("nobody moderates a
  // review they are a party to") and it has its own code because it discloses nothing: the only relationship
  // it concerns is the caller's own, and the remedy is for a colleague to take it.
  //
  // `REVIEW_REASON_REQUIRED` — a decision with no reason. `reviews_moderated_has_reason` enforces it in the
  // schema and the contract checks it first, so this is the floor rather than the path.
  //
  // There is deliberately **no code for an illegal transition**, because 0026 has no transition matrix: any
  // of its four statuses may follow any other, and re-recording the current one re-affirms it. And none for
  // moderating a reply, because no writer for one exists.
  'REVIEW_IS_PARTY',
  'REVIEW_REASON_REQUIRED',
  // Phase 7-R, dispute management. A dispute a caller may not read, and one that does not exist, are one
  // NOT_FOUND, and there is no "forbidden" on this surface either.
  //
  // `DISPUTE_IS_PARTY` — the caller is the dispute's buyer or its seller. 0027 refuses a resolver who is one
  // ("nobody resolves a dispute they are a party to") and refuses an internal note from one; both share this
  // code because both disclose nothing, concerning only the caller's own relationship to a dispute they are
  // already reading, and both have the same remedy: a colleague takes it.
  //
  // `DISPUTE_THREAD_CLOSED` — a message on a dispute that is resolved or cancelled. 0027's own refusal.
  //
  // `DISPUTE_ALREADY_RESOLVED` — somebody else ruled first, or the page is stale.
  //
  // `DISPUTE_REASON_REQUIRED` — a decision with no reason. `disputes_resolved_has_note` enforces it in the
  // schema and the contract checks it first, so this is the floor rather than the path.
  //
  // `DISPUTE_AMOUNT_NOT_ALLOWED` — an amount against a resolution that is not a refund.
  // `disputes_resolution_amount_is_for_a_refund` is the rule, and the refusal is explicit rather than
  // silently dropping the amount.
  //
  // There is deliberately **no code for a refund that failed**, for an insufficient balance, for a provider
  // rejection or for anything else financial: a resolution records a decision and moves no money, so none of
  // those failures can arise here. Issuing the refund is a separate, later operation with its own codes.
  'DISPUTE_IS_PARTY',
  'DISPUTE_THREAD_CLOSED',
  'DISPUTE_ALREADY_RESOLVED',
  'DISPUTE_REASON_REQUIRED',
  'DISPUTE_AMOUNT_NOT_ALLOWED',
  // CMS static pages. A page a caller may not read, and one that does not exist, are one NOT_FOUND, and a
  // caller holding `cms.page.read` without `cms.page.manage` gets that same NOT_FOUND from a write rather than
  // a forbidden — the detail already tells a console whether it may manage the page, so a second, narrower
  // refusal would only tell somebody which pages exist that they cannot edit.
  //
  // The three codes below are write refusals, which are not absences: each names a conflict the console has to
  // be able to show, and each is decided in the database rather than in the API.
  //
  // `CMS_PAGE_LOCALE_REQUIRED` — publishing or scheduling a page that has not been written in any locale, or
  // removing the last locale of one that is already live. One code for both, because they are one rule read
  // from two directions: a live page has text. The remedy is to write a locale, or to return the page to
  // draft first.
  //
  // `CMS_PAGE_TRANSITION_NOT_ALLOWED` — a lifecycle edge that does not exist. 0030's transition trigger owns
  // the set of legal edges; retrying never helps, and the remedy is a different target state.
  //
  // `CMS_PAGE_SLUG_TAKEN` — the address is in use by another page, or was previously used by one. A previous
  // slug belongs permanently to the page that gave it up, because it still redirects there, so this refusal
  // can also mean "that address is somebody's history". The remedy is a different slug.
  //
  // `CMS_PAGE_COVER_MEDIA_MISSING` (0099) — the cover image named does not exist in the media library. It is
  // 0030's own foreign key refusing, and it is the only existence check there is on that path, so there is no
  // second rule in the API that could disagree with it. Reported rather than swallowed, because a console that
  // silently accepted an unknown id would leave an editor believing a cover was attached. The remedy is to
  // name an entry that is in the library; it is not an absence, so it is not a 404.
  'CMS_PAGE_LOCALE_REQUIRED',
  'CMS_PAGE_TRANSITION_NOT_ALLOWED',
  'CMS_PAGE_SLUG_TAKEN',
  'CMS_PAGE_COVER_MEDIA_MISSING',
  // The SEO redirect map. Two codes, both decided by migration 0030's constraints and neither by the API, and
  // the same read/manage split as the pages above: a caller holding `seo.redirect.read` without
  // `seo.redirect.manage` gets NOT_FOUND from a write rather than a forbidden.
  //
  // `SEO_REDIRECT_PATH_TAKEN` — another entry already names that `from_path`. One entry per address is 0030's
  // unique index, and it is what makes a redirect unambiguous. The remedy is to edit the entry that holds the
  // address rather than to add a second one.
  //
  // `SEO_REDIRECT_NOT_ALLOWED` — the entry itself is not a legal one: a path that is not relative, a
  // protocol-relative or external destination, an entry pointing at itself, or a status code outside 301, 302,
  // 307 and 308. One code for the family, because 0030 raises one SQLSTATE for all of them and inventing a
  // finer distinction here would mean keeping a second copy of its constraints. Retrying never helps.
  'SEO_REDIRECT_PATH_TAKEN',
  'SEO_REDIRECT_NOT_ALLOWED',
  // Per-entity SEO metadata. Two codes, both decided by migration 0030's constraints and neither by the API, with
  // the same read/manage split as everything else in this console.
  //
  // `SEO_METADATA_NOT_ALLOWED` — the entry itself is not a legal one: an entity kind 0030 does not list, a path
  // that is not relative or would leave the site, a value past one of the length bounds, an empty directive set, a
  // directive outside the allowed list, or a set that contradicts itself. One code for the family, because 0030
  // raises one SQLSTATE for all of them and a finer distinction here would mean a second copy of its constraints.
  //
  // `SEO_METADATA_TARGET_UNKNOWN` — a locale code or a share-image identifier that names no row. The remedy is a
  // different value, not a retry.
  'SEO_METADATA_NOT_ALLOWED',
  'SEO_METADATA_TARGET_UNKNOWN',
  // The category tree (D8). Migration 0010 owns every one of these rules; the API reports them and decides none
  // of them, which is why they are four codes and not one generic conflict.
  //
  // `CATEGORY_TREE_NOT_ALLOWED` — the shape of the tree refused the change: a fourth level, a category under its
  // own descendant or itself, or a move that would re-depth a category that still has children. One code for the
  // family, because 0010's trigger raises one SQLSTATE for all of them and inventing a finer distinction here
  // would mean keeping a second copy of its rules. The remedy is a different parent, or moving the children first.
  //
  // `CATEGORY_SLUG_TAKEN` — the address is in use. A category slug can never be changed and there is no slug
  // history, so unlike a page this means only that another category holds it. The remedy is a different slug.
  //
  // `CATEGORY_NAME_REQUIRED` — a category cannot be shown before it has been named in some locale, and the last
  // locale of one that is shown cannot be removed. The public tree falls back to the slug when no translation
  // exists, so showing an unnamed category would publish `winter-coats` as its name.
  //
  // `CATEGORY_VALUE_NOT_ALLOWED` — a length or a format the column refuses. The contract checks all of these
  // first, so reaching this means the two disagreed, and the remedy is a shorter or better-formed value.
  'CATEGORY_TREE_NOT_ALLOWED',
  'CATEGORY_SLUG_TAKEN',
  'CATEGORY_NAME_REQUIRED',
  'CATEGORY_VALUE_NOT_ALLOWED',
  // The structured attribute and tag vocabulary (D8). Migrations 0010 and 0011 own every rule behind these; as
  // with the tree above, the API reports them and decides none of them.
  //
  // `ATTRIBUTE_KEY_TAKEN` — an attribute key, an option value within its attribute, or a tag slug is already in
  // use. All three are machine identity, none of the three can be changed once written, and the remedy for all
  // three is a different one.
  //
  // `ATTRIBUTE_NOT_ANSWERABLE` — the vocabulary refused a change that would leave sellers a question they cannot
  // answer or an answer they cannot give: showing a select attribute that has no active option, or giving an
  // option to an attribute that is not a select one. The remedy is to add an option first, or to stop trying to
  // give options to a number.
  //
  // `ATTRIBUTE_VALUE_NOT_ALLOWED` — a length, a format or a unit the column refuses, including a unit on an
  // attribute that is not a number. The contract checks what it can see first, so reaching this means the
  // request was well formed and the attribute is what refused it.
  //
  // `LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED` — a seller's answer was not acceptable: an answer whose kind is not
  // the attribute's, an option that is not that attribute's or is hidden, more than one option on a
  // single-select, or an attribute this listing's category does not ask about. One code for the family, because
  // 0011's validation trigger is the single judge of all of it and a finer distinction here would be a second
  // copy of its rules. **Never raised for an unanswered required attribute**: `is_required` is advisory.
  'ATTRIBUTE_KEY_TAKEN',
  'ATTRIBUTE_NOT_ANSWERABLE',
  'ATTRIBUTE_VALUE_NOT_ALLOWED',
  'LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED',
  // The blog (0092). Migrations 0030 and 0092 own every rule behind these; the API reports them and decides none
  // of them, which is why they are four codes rather than one generic conflict.
  //
  // `BLOG_LOCALE_REQUIRED` — one rule read from two directions: a post cannot be published or scheduled before
  // it has been written in some locale, and a post that is live cannot lose its last one. Either way the remedy
  // is the same, which is why it is one code: write the post, or unpublish it before emptying it.
  //
  // `BLOG_CHANGE_NOT_ALLOWED` — the post's current state refused the change: a lifecycle edge 0030's transition
  // trigger does not allow, or a constraint such as the rule that only a published post may be featured. One
  // code for the family, because the trigger and the constraints raise one SQLSTATE between them and inventing a
  // finer distinction here would mean keeping a second copy of their rules.
  //
  // `BLOG_SLUG_TAKEN` — the address is in use, or it belongs to another post's slug history and can never be
  // taken over because it still redirects there. The remedy for both is a different slug.
  //
  // `BLOG_REFERENCE_UNKNOWN` — a category, cover image or tag in the request does not exist. Reported rather
  // than swallowed: a console that sent one has a bug, and silently dropping it would hide it.
  'BLOG_LOCALE_REQUIRED',
  'BLOG_CHANGE_NOT_ALLOWED',
  'BLOG_SLUG_TAKEN',
  'BLOG_REFERENCE_UNKNOWN',
  // The homepage (0093). Migrations 0030 and 0093 own both of these rules; the API reports them.
  //
  // `HOMEPAGE_SECTION_KEY_TAKEN` — another section already holds that key. A key is machine identity and the
  // remedy is a different one.
  //
  // `HOMEPAGE_SECTION_NOT_ALLOWED` — one of 0030's own column constraints refused the value: a key that is not a
  // key, a section type it does not have, a title longer than the column, or a configuration that is not a JSON
  // object. One code for the family, because the constraints raise one SQLSTATE between them and a finer
  // distinction here would be a second copy of their rules.
  'HOMEPAGE_SECTION_KEY_TAKEN',
  'HOMEPAGE_SECTION_NOT_ALLOWED',
  // Navigation (0094). Migrations 0030 and 0094 own both of these rules; the API reports them.
  //
  // `NAVIGATION_MENU_KEY_TAKEN` — another menu already holds that key. A key is machine identity, the public
  // reader addresses a menu by it, and the remedy is a different one.
  //
  // `NAVIGATION_NOT_ALLOWED` — one of 0030's own constraints or triggers refused the arrangement: a key that is
  // not a key, a label longer than the column, a path that is not relative, a third level, or a child in a
  // different menu from its parent. One code for the family, because those constraints and that trigger raise
  // one SQLSTATE between them and a finer distinction here would be a second copy of their rules.
  //
  // `NAVIGATION_REFERENCE_UNKNOWN` — the page, post, category, menu or parent named does not exist. Reported
  // rather than swallowed: a console that sent one has a bug, and dropping it silently would hide it.
  'NAVIGATION_MENU_KEY_TAKEN',
  'NAVIGATION_NOT_ALLOWED',
  'NAVIGATION_REFERENCE_UNKNOWN',
  // The help centre (0095). Migrations 0030 and 0095 own this rule; the API reports it.
  //
  // `FAQ_NOT_ALLOWED` — one of 0030's own constraints refused the value: a topic that is not a topic, a question
  // longer than the column, or an answer with nothing in it. One code for the family, because those constraints
  // raise one SQLSTATE between them and a finer distinction here would be a second copy of their rules.
  'FAQ_NOT_ALLOWED',
  // Site-wide SEO settings (0096). Migration 0030 owns both of these rules; the API reports them.
  //
  // `SEO_SETTINGS_NOT_ALLOWED` — one of 0030's own five constraints refused the value: a site name that is blank
  // or past 120 characters, a default title past 70 or description past 320, a handle that is not `@` followed by
  // up to fifteen word characters, or an organization document that is not a JSON object. One code for the family,
  // because those constraints raise one SQLSTATE between them and a finer distinction here would be a second copy
  // of their rules.
  //
  // `SEO_SETTINGS_MEDIA_MISSING` — the share image named does not exist. Reported rather than swallowed: a console
  // that sent one has a bug, and dropping it silently would hide it.
  'SEO_SETTINGS_NOT_ALLOWED',
  'SEO_SETTINGS_MEDIA_MISSING',
  // The CMS media library (0098). Migration 0030 and the `cms-media` bucket own both of these rules; the API
  // reports them.
  //
  // `CMS_MEDIA_NOT_ALLOWED` — the bucket or one of 0030's own constraints refused the value: a content type the
  // bucket does not allow (SVG among them), a size outside its limit, an object path that is not the shape the
  // authorizer issues, or an extension that disagrees with the declared type. One code for the family, because a
  // finer distinction here would be a second copy of rules this API does not own.
  //
  // `CMS_MEDIA_OBJECT_MISSING` — the confirmation named a path with no object behind it. Recording a row for a file
  // nobody uploaded would be a library pointing at nothing, which is the state that rots quietly.
  //
  // `CMS_MEDIA_PATH_TAKEN` — that object already has a library entry. 0030's unique index, reported rather than
  // raised, because a retried confirmation is a client's accident and not an error worth a 500.
  'CMS_MEDIA_NOT_ALLOWED',
  'CMS_MEDIA_OBJECT_MISSING',
  'CMS_MEDIA_PATH_TAKEN',
  // 0102. One code for a malformed list position, an altered one, one of the wrong kind and one from a
  // retired version: the remedy is the same in all four, and naming which check failed would help only
  // somebody probing the format.
  'LISTING_ANALYTICS_CURSOR_INVALID',
] as const;

export const ProblemCodeSchema = z.enum(PROBLEM_CODES).openapi('ProblemCode');

export const ValidationIssueSchema = z
  .object({
    path: z.string(),
    message: z.string(),
  })
  .strict()
  .openapi('ValidationIssue');

/** RFC 9457 problem details (media type application/problem+json). */
export const ProblemDetailsSchema = z
  .object({
    type: z.literal('about:blank'),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    instance: z.string(),
    code: ProblemCodeSchema,
    errors: z.array(ValidationIssueSchema).optional(),
  })
  .strict()
  .openapi('ProblemDetails');

export const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

export type ProblemCode = z.infer<typeof ProblemCodeSchema>;
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
