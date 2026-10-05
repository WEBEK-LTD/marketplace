import { describe, expect, it } from 'vitest';
import {
  AdminServiceRequestDecisionResponseSchema,
  AdminServiceRequestDetailResponseSchema,
  AdminServiceRequestDetailSchema,
  AdminServiceRequestSummarySchema,
  AdminServiceRequestsResponseSchema,
  CreateAdminOnlyServiceRequestSchema,
  CreateServiceQuoteSchema,
  CreateServiceRequestSchema,
  PROBLEM_CODES,
  SERVICE_REQUEST_ROUTING_MODES,
  SERVICE_QUOTE_STATUSES,
  SERVICE_REQUESTS_DEFAULT_LIMIT,
  SERVICE_REQUESTS_MAX_LIMIT,
  SERVICE_REQUEST_STATUSES,
  ServiceQuoteDecisionResponseSchema,
  ServiceQuoteMutationResponseSchema,
  ServiceQuoteSchema,
  ServiceRequestDetailResponseSchema,
  ServiceRequestDetailSchema,
  ServiceRequestMutationResponseSchema,
  ServiceRequestPaymentInformationResponseSchema,
  ServiceRequestPaymentInformationSchema,
  ServiceRequestStatusResponseSchema,
  ServiceRequestSummarySchema,
  ServiceRequestsResponseSchema,
} from '../src/index.js';

/**
 * The service request and quote contracts (Phase 7-I).
 *
 * A contract is where a field nobody approved either fails to arrive or slips through, so these tests are
 * about what the shapes **refuse**: an account, a side, a status, a currency, an acceptance time and, above
 * all, a payment deadline. They also hold the two time fields apart — the validity window a seller states
 * and the payment deadline the database derives are different things and must not be interchangeable.
 */

const ID = 'd1000000-0000-4000-8000-000000000001';

const REQUEST = {
  listingId: ID,
  title: 'Build me a shelf',
  brief: 'A brief that is comfortably longer than ten characters.',
};

const QUOTE = {
  amountMinor: '380000',
  deliveryDays: 10,
  revisionsIncluded: 2,
  scope: 'A scope long enough to satisfy the ten-character rule.',
  validForDays: 14,
};

const SUMMARY = {
  id: ID,
  status: 'open',
  routingMode: 'seller',
  title: 'Build me a shelf',
  budgetMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  neededBy: '2026-06-01',
  listingSlug: 'sr-custom-one',
  listingTitle: 'A quotable service',
  counterpartyName: 'Service Shop One',
  quoteCount: 1,
  liveQuoteCount: 1,
  acceptedPaymentDueAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const QUOTE_VIEW = {
  id: ID,
  status: 'sent',
  amountMinor: '380000',
  deliveryDays: 10,
  revisionsIncluded: 2,
  scope: 'A scope long enough to satisfy the ten-character rule.',
  isLapsed: false,
  expiresAt: '2026-05-15T09:00:00.000Z',
  respondedAt: null,
  acceptedAt: null,
  paymentDueAt: null,
  createdAt: '2026-05-02T09:00:00.000Z',
};

const DETAIL = {
  id: ID,
  status: 'quoted',
  routingMode: 'seller',
  isBuyer: true,
  isSeller: false,
  title: 'Build me a shelf',
  brief: 'A brief that is comfortably longer than ten characters.',
  budgetMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  neededBy: '2026-06-01',
  listingSlug: 'sr-custom-one',
  listingTitle: 'A quotable service',
  buyerName: 'Buyer A',
  sellerSlug: 'sr-shop-one',
  sellerName: 'Service Shop One',
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  quotes: [QUOTE_VIEW],
};

describe('the vocabulary is the schema’s, unchanged', () => {
  it('names exactly the six request statuses 0015 defines', () => {
    expect([...SERVICE_REQUEST_STATUSES]).toEqual([
      'open',
      'quoted',
      'accepted',
      'declined',
      'cancelled',
      'expired',
    ]);
  });

  it('names exactly the five quote statuses 0015 defines', () => {
    expect([...SERVICE_QUOTE_STATUSES]).toEqual([
      'sent',
      'accepted',
      'rejected',
      'withdrawn',
      'expired',
    ]);
  });

  it('invents no status of its own for a lapsed quote', () => {
    expect(SERVICE_QUOTE_STATUSES).not.toContain('lapsed');
    expect(SERVICE_QUOTE_STATUSES).not.toContain('pending');
    const parsed = ServiceQuoteSchema.parse({ ...QUOTE_VIEW, isLapsed: true });
    expect(parsed.status).toBe('sent');
  });

  it('pages within bounds the reader can clamp', () => {
    expect(SERVICE_REQUESTS_DEFAULT_LIMIT).toBeLessThanOrEqual(SERVICE_REQUESTS_MAX_LIMIT);
    expect(SERVICE_REQUESTS_MAX_LIMIT).toBeLessThanOrEqual(50);
  });
});

describe('no request names a party, a status or an outcome', () => {
  const requestSchemas = {
    CreateServiceRequestSchema,
    CreateServiceQuoteSchema,
  };

  it.each(Object.entries(requestSchemas))('%s accepts no field naming an account', (_name, schema) => {
    for (const key of Object.keys(schema.shape)) {
      const lower = key.toLowerCase();
      expect(lower).not.toContain('userid');
      expect(lower).not.toContain('buyer');
      expect(lower).not.toContain('seller');
      expect(lower).not.toContain('account');
      expect(lower).not.toContain('role');
    }
  });

  it.each(Object.entries(requestSchemas))('%s accepts no status and no outcome', (_name, schema) => {
    for (const key of Object.keys(schema.shape)) {
      const lower = key.toLowerCase();
      expect(lower).not.toContain('status');
      expect(lower).not.toContain('accepted');
      expect(lower).not.toContain('closed');
      expect(lower).not.toContain('responded');
    }
  });

  it.each(Object.entries(requestSchemas))('%s accepts no payment deadline of any spelling', (_name, schema) => {
    for (const key of Object.keys(schema.shape)) {
      const lower = key.toLowerCase();
      expect(lower).not.toContain('paymentdue');
      expect(lower).not.toContain('duedate');
      expect(lower).not.toContain('dueat');
      expect(lower).not.toContain('hours');
    }
  });

  it.each(Object.entries(requestSchemas))('%s accepts no currency', (_name, schema) => {
    expect(Object.keys(schema.shape)).not.toContain('currencyCode');
    expect(Object.keys(schema.shape)).not.toContain('currencyMinorUnit');
  });

  it.each(Object.entries(requestSchemas))('%s accepts nothing that routes anywhere', (_name, schema) => {
    for (const key of Object.keys(schema.shape)) {
      const lower = key.toLowerCase();
      expect(lower).not.toContain('route');
      expect(lower).not.toContain('admin');
      expect(lower).not.toContain('staff');
      expect(lower).not.toContain('assign');
    }
  });

  it.each([
    ['a seller', { ...REQUEST, sellerUserId: ID }],
    ['a status', { ...REQUEST, status: 'accepted' }],
    ['a currency', { ...REQUEST, currencyCode: 'EGP' }],
    ['a deadline', { ...REQUEST, paymentDueAt: '2026-05-05T09:00:00.000Z' }],
    ['a routing flag', { ...REQUEST, routeToAdmin: true }],
    // D7-08's column by its real name, and its admin value. The foundation is schema-only in 7-I.
    ['a routing mode', { ...REQUEST, routingMode: 'admin_only' }],
    ['the admin-only mode alone', { ...REQUEST, adminOnly: true }],
    ['a closing time', { ...REQUEST, closedAt: '2026-05-05T09:00:00.000Z' }],
  ])('refuses a brief carrying %s', (_name, payload) => {
    expect(CreateServiceRequestSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    ['its own request', { ...QUOTE, serviceRequestId: ID }],
    ['a status', { ...QUOTE, status: 'accepted' }],
    ['a currency', { ...QUOTE, currencyCode: 'EGP' }],
    ['an explicit expiry', { ...QUOTE, expiresAt: '2026-05-15T09:00:00.000Z' }],
    ['a deadline', { ...QUOTE, paymentDueAt: '2026-05-05T09:00:00.000Z' }],
    ['accepted terms', { ...QUOTE, acceptedTerms: {} }],
  ])('refuses a quote carrying %s', (_name, payload) => {
    expect(CreateServiceQuoteSchema.safeParse(payload).success).toBe(false);
  });
});

describe('the brief', () => {
  it('accepts a listing, a title and a brief, with nothing else required', () => {
    const parsed = CreateServiceRequestSchema.parse(REQUEST);
    expect(parsed.budgetMinor).toBeUndefined();
    expect(parsed.neededBy).toBeUndefined();
  });

  it('holds the schema’s own lengths', () => {
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, title: 'ab' }).success).toBe(false);
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, title: 'abc' }).success).toBe(true);
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, title: 'x'.repeat(140) }).success).toBe(true);
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, title: 'x'.repeat(141) }).success).toBe(false);
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, brief: 'x'.repeat(9) }).success).toBe(false);
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, brief: 'x'.repeat(10) }).success).toBe(true);
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, brief: 'x'.repeat(10_001) }).success).toBe(false);
  });

  it('takes a needed-by date and refuses a timestamp', () => {
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, neededBy: '2026-06-01' }).success).toBe(true);
    for (const neededBy of ['2026-06-01T00:00:00Z', '01-06-2026', 'tomorrow', '2026-6-1', '']) {
      expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, neededBy }).success, neededBy).toBe(false);
    }
  });

  it('refuses a listing that is not an identifier', () => {
    for (const listingId of ['not-a-uuid', '', 'sr-custom-one']) {
      expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, listingId }).success, listingId).toBe(false);
    }
  });
});

describe('money is a decimal string of minor units', () => {
  it.each([
    ['a number', 400000],
    ['a decimal', '4000.00'],
    ['zero', '0'],
    ['a leading zero', '0400'],
    ['a negative amount', '-1'],
    ['a thousands separator', '400,000'],
    ['an empty string', ''],
    ['something longer than any amount', '1'.repeat(20)],
  ])('refuses a budget given as %s', (_name, budgetMinor) => {
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, budgetMinor }).success).toBe(false);
  });

  it.each([['1'], ['400000'], ['9999999999999999999']])('accepts %s', (budgetMinor) => {
    expect(CreateServiceRequestSchema.safeParse({ ...REQUEST, budgetMinor }).success).toBe(true);
  });

  it('carries the authoritative decimal places beside every amount it reads back', () => {
    for (const schema of [ServiceRequestSummarySchema, ServiceRequestDetailSchema]) {
      expect(Object.keys(schema.shape)).toContain('currencyCode');
      expect(Object.keys(schema.shape)).toContain('currencyMinorUnit');
    }
  });

  it('reads no amount back as a number, and converts nothing', () => {
    const parsed = ServiceRequestSummarySchema.parse(SUMMARY);
    expect(typeof parsed.budgetMinor).toBe('string');
    expect(ServiceRequestSummarySchema.safeParse({ ...SUMMARY, budgetMinor: 400000 }).success).toBe(false);

    for (const schema of [ServiceRequestSummarySchema, ServiceRequestDetailSchema, ServiceQuoteSchema]) {
      for (const key of Object.keys(schema.shape)) {
        const lower = key.toLowerCase();
        expect(lower).not.toContain('converted');
        expect(lower).not.toContain('formatted');
        expect(lower).not.toContain('displayamount');
        expect(lower).not.toContain('amountdisplay');
        expect(lower).not.toContain('usd');
      }
    }
  });
});

describe('the validity window and the payment deadline stay apart', () => {
  it('requires the seller to state how long the quote stands', () => {
    const { validForDays: _window, ...withoutWindow } = QUOTE;
    expect(CreateServiceQuoteSchema.safeParse(withoutWindow).success).toBe(false);
  });

  it('bounds the window by the same 1..365 the schema bounds delivery by', () => {
    for (const validForDays of [0, -1, 366, 1.5, '14', null]) {
      expect(CreateServiceQuoteSchema.safeParse({ ...QUOTE, validForDays }).success, String(validForDays)).toBe(
        false,
      );
    }
    for (const validForDays of [1, 14, 365]) {
      expect(CreateServiceQuoteSchema.safeParse({ ...QUOTE, validForDays }).success, String(validForDays)).toBe(
        true,
      );
    }
    for (const deliveryDays of [0, 366]) {
      expect(CreateServiceQuoteSchema.safeParse({ ...QUOTE, deliveryDays }).success, String(deliveryDays)).toBe(
        false,
      );
    }
  });

  it('defaults revisions to none rather than requiring a number nobody stated', () => {
    const parsed = CreateServiceQuoteSchema.parse({
      amountMinor: QUOTE.amountMinor,
      deliveryDays: QUOTE.deliveryDays,
      scope: QUOTE.scope,
      validForDays: QUOTE.validForDays,
    });
    expect(parsed.revisionsIncluded).toBe(0);
    expect(CreateServiceQuoteSchema.safeParse({ ...QUOTE, revisionsIncluded: -1 }).success).toBe(false);
  });

  it('reads the two back as separate fields with separate meanings', () => {
    const parsed = ServiceQuoteSchema.parse({
      ...QUOTE_VIEW,
      status: 'accepted',
      acceptedAt: '2026-05-03T09:00:00.000Z',
      paymentDueAt: '2026-05-05T09:00:00.000Z',
      respondedAt: '2026-05-03T09:00:00.000Z',
    });
    expect(parsed.expiresAt).toBe('2026-05-15T09:00:00.000Z');
    expect(parsed.paymentDueAt).toBe('2026-05-05T09:00:00.000Z');
    expect(parsed.expiresAt).not.toBe(parsed.paymentDueAt);
  });

  it('leaves a list one obligation fact and no window of its own', () => {
    const keys = Object.keys(ServiceRequestSummarySchema.shape);
    expect(keys).toContain('acceptedPaymentDueAt');
    expect(keys).not.toContain('expiresAt');
  });
});

describe('what is read back', () => {
  it('parses a page and a detail exactly', () => {
    expect(ServiceRequestsResponseSchema.parse({ items: [SUMMARY], nextCursor: null }).items).toHaveLength(1);
    expect(ServiceRequestDetailResponseSchema.parse({ request: DETAIL }).request.quotes).toHaveLength(1);
  });

  it('never carries an account, on either side', () => {
    for (const schema of [ServiceRequestSummarySchema, ServiceRequestDetailSchema, ServiceQuoteSchema]) {
      for (const key of Object.keys(schema.shape)) {
        const lower = key.toLowerCase();
        expect(lower).not.toContain('userid');
        expect(lower).not.toContain('email');
        expect(lower).not.toContain('phone');
      }
    }
    expect(ServiceRequestDetailSchema.safeParse({ ...DETAIL, buyerUserId: ID }).success).toBe(false);
    expect(ServiceQuoteSchema.safeParse({ ...QUOTE_VIEW, sellerUserId: ID }).success).toBe(false);
  });

  it('tells a caller which side they are on, and takes it from nobody', () => {
    const keys = Object.keys(ServiceRequestDetailSchema.shape);
    expect(keys).toContain('isBuyer');
    expect(keys).toContain('isSeller');
    expect(Object.keys(CreateServiceRequestSchema.shape)).not.toContain('isBuyer');
    expect(Object.keys(CreateServiceQuoteSchema.shape)).not.toContain('isSeller');
  });

  it('accepts a removed listing without losing the request', () => {
    const parsed = ServiceRequestSummarySchema.parse({ ...SUMMARY, listingSlug: null, listingTitle: null });
    expect(parsed.listingSlug).toBeNull();
    expect(parsed.title).toBe('Build me a shelf');
  });

  it('refuses a status outside the schema’s vocabulary', () => {
    expect(ServiceRequestSummarySchema.safeParse({ ...SUMMARY, status: 'routed' }).success).toBe(false);
    expect(ServiceQuoteSchema.safeParse({ ...QUOTE_VIEW, status: 'lapsed' }).success).toBe(false);
  });

  it('records an obligation only where one exists', () => {
    expect(
      ServiceQuoteDecisionResponseSchema.parse({
        status: 'accepted',
        acceptedAt: '2026-05-03T09:00:00.000Z',
        paymentDueAt: '2026-05-05T09:00:00.000Z',
      }).paymentDueAt,
    ).toBe('2026-05-05T09:00:00.000Z');
    expect(
      ServiceQuoteDecisionResponseSchema.parse({ status: 'rejected', acceptedAt: null, paymentDueAt: null })
        .paymentDueAt,
    ).toBeNull();
    expect(
      ServiceQuoteDecisionResponseSchema.safeParse({ status: 'accepted', acceptedAt: null }).success,
    ).toBe(false);
  });

  it('answers a write with an identifier and a status, and nothing else', () => {
    expect(Object.keys(ServiceRequestMutationResponseSchema.shape).sort()).toEqual(['requestId', 'status']);
    expect(Object.keys(ServiceQuoteMutationResponseSchema.shape).sort()).toEqual(['quoteId', 'status']);
    expect(Object.keys(ServiceRequestStatusResponseSchema.shape)).toEqual(['status']);
  });

  /**
   * Routing travels one way only (7-J).
   *
   * `routingMode` is read back, because a surface that could not tell the two flows apart would say "no quote
   * yet, the seller will answer" about a brief no seller ever sees. It is accepted from nobody: the server
   * decides which flow a brief belongs to by which writer created it.
   */
  it('accepts no routing field from a caller, on any request schema', () => {
    for (const schema of [
      CreateServiceRequestSchema,
      CreateServiceQuoteSchema,
      CreateAdminOnlyServiceRequestSchema,
    ]) {
      for (const key of Object.keys(schema.shape)) {
        const lower = key.toLowerCase();
        for (const forbidden of ['routing', 'route', 'adminonly', 'staff', 'seller', 'currency']) {
          expect(lower, `${key} / ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
    expect(CreateAdminOnlyServiceRequestSchema.safeParse({
      title: REQUEST.title,
      brief: REQUEST.brief,
      preferredPaymentMethod: 'Bank transfer',
      routingMode: 'seller',
    }).success).toBe(false);
  });

  it('reads it back on both shapes, from the vocabulary the schema defines', () => {
    expect([...SERVICE_REQUEST_ROUTING_MODES]).toEqual(['seller', 'admin_only']);
    expect(ServiceRequestSummarySchema.parse(SUMMARY).routingMode).toBe('seller');
    expect(
      ServiceRequestDetailSchema.parse({ ...DETAIL, routingMode: 'admin_only' }).routingMode,
    ).toBe('admin_only');
    expect(ServiceRequestSummarySchema.safeParse({ ...SUMMARY, routingMode: 'staff_pool' }).success).toBe(
      false,
    );
    expect(ServiceRequestSummarySchema.safeParse({ ...SUMMARY, routingMode: undefined }).success).toBe(
      false,
    );
  });

  it('carries no routing field on a quote at all', () => {
    for (const key of Object.keys(ServiceQuoteSchema.shape)) {
      const lower = key.toLowerCase();
      for (const forbidden of ['routing', 'route', 'adminonly', 'staff']) {
        expect(lower, `${key} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('carries nothing from Phase 8', () => {
    for (const schema of [
      ServiceRequestSummarySchema,
      ServiceRequestDetailSchema,
      ServiceQuoteSchema,
      ServiceQuoteDecisionResponseSchema,
    ]) {
      for (const key of Object.keys(schema.shape)) {
        const lower = key.toLowerCase();
        for (const forbidden of ['order', 'checkout', 'payout', 'ledger', 'refund', 'invoice', 'paid']) {
          expect(lower, `${key} / ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });
});

describe('the problem codes', () => {
  it.each([
    'SERVICE_REQUEST_NOT_AVAILABLE',
    'SERVICE_REQUEST_NOT_CUSTOM',
    'SERVICE_REQUEST_OWN_LISTING',
    'SERVICE_REQUEST_BLOCKED',
    'SERVICE_REQUEST_NOT_ACTIONABLE',
    'SERVICE_QUOTE_LAPSED',
    'SERVICE_QUOTE_PAYMENT_POLICY_MISSING',
    'SERVICE_REQUESTS_CURSOR_INVALID',
  ])('declares %s', (code) => {
    expect(PROBLEM_CODES).toContain(code);
  });

  it('declares no routing, staff or payment-information code — 7-J and D7-09 own those', () => {
    for (const code of PROBLEM_CODES) {
      if (!code.startsWith('SERVICE_REQUEST') && !code.startsWith('SERVICE_QUOTE')) continue;
      expect(code).not.toContain('ROUTING');
      expect(code).not.toContain('ADMIN');
      expect(code).not.toContain('STAFF');
      expect(code).not.toContain('PAYMENT_INFO');
    }
  });

  it('declares no code that would report a party or a configuration detail', () => {
    for (const code of PROBLEM_CODES) {
      if (!code.startsWith('SERVICE_REQUEST') && !code.startsWith('SERVICE_QUOTE')) continue;
      expect(code).not.toContain('SELLER_');
      expect(code).not.toContain('BUYER_');
      expect(code).not.toContain('SETTING');
      expect(code).not.toContain('FORBIDDEN');
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Option 2 — Admin Only (Phase 7-J)                                                                 */
/* ------------------------------------------------------------------------------------------------ */

const ADMIN_REQUEST = {
  title: 'Build me a shelf',
  brief: 'A brief that is comfortably longer than ten characters.',
  preferredPaymentMethod: 'Bank transfer, end of month',
};

const ADMIN_SUMMARY = {
  id: ID,
  status: 'open',
  title: 'Build me a shelf',
  budgetMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  neededBy: '2026-06-01',
  buyerName: 'Buyer A',
  hasPaymentNotes: true,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
};

const ADMIN_DETAIL = {
  ...ADMIN_SUMMARY,
  brief: 'A brief that is comfortably longer than ten characters.',
};

describe('sending an Admin Only brief', () => {
  it('takes a title, a brief and a payment method, and nothing else is required', () => {
    const parsed = CreateAdminOnlyServiceRequestSchema.parse(ADMIN_REQUEST);
    expect(parsed.preferredPaymentMethod).toBe('Bank transfer, end of month');
    expect(parsed.paymentNotes).toBeUndefined();
    expect(parsed.budgetMinor).toBeUndefined();
    expect(parsed.neededBy).toBeUndefined();
  });

  it('names no seller, no listing, no currency and no status', () => {
    expect(Object.keys(CreateAdminOnlyServiceRequestSchema.shape).sort()).toEqual([
      'brief',
      'budgetMinor',
      'neededBy',
      'paymentNotes',
      'preferredPaymentMethod',
      'title',
    ]);
  });

  it.each([
    ['a seller', { ...ADMIN_REQUEST, sellerUserId: ID }],
    ['a listing', { ...ADMIN_REQUEST, listingId: ID }],
    ['a currency', { ...ADMIN_REQUEST, currencyCode: 'EGP' }],
    ['a routing mode', { ...ADMIN_REQUEST, routingMode: 'admin_only' }],
    ['a status', { ...ADMIN_REQUEST, status: 'declined' }],
    ['a closing time', { ...ADMIN_REQUEST, closedAt: '2026-05-05T09:00:00.000Z' }],
    ['a payment deadline', { ...ADMIN_REQUEST, paymentDueAt: '2026-05-05T09:00:00.000Z' }],
    ['a staff permission', { ...ADMIN_REQUEST, permission: 'service_requests.request.manage' }],
  ])('refuses a brief carrying %s', (_name, payload) => {
    expect(CreateAdminOnlyServiceRequestSchema.safeParse(payload).success).toBe(false);
  });

  it('requires the payment method, and bounds it at 120 characters', () => {
    const { preferredPaymentMethod: _omitted, ...without } = ADMIN_REQUEST;
    expect(CreateAdminOnlyServiceRequestSchema.safeParse(without).success).toBe(false);
    for (const preferredPaymentMethod of ['', '   ', 'x'.repeat(121)]) {
      expect(
        CreateAdminOnlyServiceRequestSchema.safeParse({ ...ADMIN_REQUEST, preferredPaymentMethod }).success,
      ).toBe(false);
    }
    expect(
      CreateAdminOnlyServiceRequestSchema.safeParse({ ...ADMIN_REQUEST, preferredPaymentMethod: 'x'.repeat(120) })
        .success,
    ).toBe(true);
  });

  it('bounds the note at 2000 characters and leaves it optional', () => {
    expect(
      CreateAdminOnlyServiceRequestSchema.safeParse({ ...ADMIN_REQUEST, paymentNotes: 'x'.repeat(2000) }).success,
    ).toBe(true);
    expect(
      CreateAdminOnlyServiceRequestSchema.safeParse({ ...ADMIN_REQUEST, paymentNotes: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('holds the same title and brief bounds Option 1 holds', () => {
    expect(CreateAdminOnlyServiceRequestSchema.safeParse({ ...ADMIN_REQUEST, title: 'ab' }).success).toBe(false);
    expect(CreateAdminOnlyServiceRequestSchema.safeParse({ ...ADMIN_REQUEST, brief: 'too short' }).success).toBe(
      false,
    );
  });

  it('is free text: no payment vocabulary is encoded anywhere in the shape', () => {
    const shape = JSON.stringify(Object.keys(CreateAdminOnlyServiceRequestSchema.shape)).toLowerCase();
    for (const forbidden of ['card', 'cvv', 'iban', 'wallet', 'provider', 'token', 'otp', 'credential']) {
      expect(shape, forbidden).not.toContain(forbidden);
    }
  });
});

describe('what staff read', () => {
  it('parses the queue and the detail', () => {
    expect(AdminServiceRequestsResponseSchema.parse({ items: [ADMIN_SUMMARY], nextCursor: null }).items).toHaveLength(
      1,
    );
    expect(AdminServiceRequestDetailResponseSchema.parse({ request: ADMIN_DETAIL }).request.brief).toContain(
      'comfortably',
    );
  });

  it('carries neither payment field, on either shape', () => {
    for (const schema of [AdminServiceRequestSummarySchema, AdminServiceRequestDetailSchema]) {
      expect(Object.keys(schema.shape)).not.toContain('preferredPaymentMethod');
      expect(Object.keys(schema.shape)).not.toContain('paymentNotes');
    }
    expect(
      AdminServiceRequestSummarySchema.safeParse({ ...ADMIN_SUMMARY, preferredPaymentMethod: 'Cash' }).success,
    ).toBe(false);
    expect(AdminServiceRequestDetailSchema.safeParse({ ...ADMIN_DETAIL, paymentNotes: 'A note' }).success).toBe(
      false,
    );
  });

  it('says whether there is a note without carrying it', () => {
    expect(AdminServiceRequestSummarySchema.parse(ADMIN_SUMMARY).hasPaymentNotes).toBe(true);
    expect(typeof AdminServiceRequestSummarySchema.parse(ADMIN_SUMMARY).hasPaymentNotes).toBe('boolean');
  });

  it('names the buyer and nothing else about them', () => {
    for (const key of Object.keys(AdminServiceRequestDetailSchema.shape)) {
      const lower = key.toLowerCase();
      for (const forbidden of ['userid', 'email', 'phone', 'address']) {
        expect(lower, `${key} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('carries nothing from Phase 8 and no quote', () => {
    for (const schema of [
      AdminServiceRequestSummarySchema,
      AdminServiceRequestDetailSchema,
      AdminServiceRequestDecisionResponseSchema,
    ]) {
      for (const key of Object.keys(schema.shape)) {
        const lower = key.toLowerCase();
        for (const forbidden of ['quote', 'order', 'checkout', 'payout', 'ledger', 'refund', 'due', 'paid']) {
          expect(lower, `${key} / ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });
});

describe('the payment information, in a shape of its own', () => {
  it('is two nullable strings and nothing else', () => {
    expect(Object.keys(ServiceRequestPaymentInformationSchema.shape).sort()).toEqual([
      'paymentNotes',
      'preferredPaymentMethod',
    ]);
    const parsed = ServiceRequestPaymentInformationResponseSchema.parse({
      paymentInformation: { preferredPaymentMethod: 'Bank transfer', paymentNotes: null },
    });
    expect(parsed.paymentInformation.preferredPaymentMethod).toBe('Bank transfer');
    expect(parsed.paymentInformation.paymentNotes).toBeNull();
  });

  it('accepts both as null, which is what a purged request reads as', () => {
    expect(
      ServiceRequestPaymentInformationSchema.parse({ preferredPaymentMethod: null, paymentNotes: null }),
    ).toEqual({ preferredPaymentMethod: null, paymentNotes: null });
  });

  it('is a separate document from the request, so a caller without the key receives no field to hide', () => {
    expect(Object.keys(AdminServiceRequestDetailResponseSchema.shape)).toEqual(['request']);
    expect(Object.keys(ServiceRequestPaymentInformationResponseSchema.shape)).toEqual(['paymentInformation']);
  });

  it('carries no amount, no deadline and no provider', () => {
    for (const key of Object.keys(ServiceRequestPaymentInformationSchema.shape)) {
      const lower = key.toLowerCase();
      for (const forbidden of ['amount', 'minor', 'due', 'provider', 'card', 'token', 'secret']) {
        expect(lower, `${key} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('the staff closure', () => {
  it('answers with a status and nothing else', () => {
    expect(Object.keys(AdminServiceRequestDecisionResponseSchema.shape)).toEqual(['status']);
    expect(AdminServiceRequestDecisionResponseSchema.parse({ status: 'declined' }).status).toBe('declined');
  });

  it('refuses a status outside the schema vocabulary, and adds none', () => {
    expect(AdminServiceRequestDecisionResponseSchema.safeParse({ status: 'closed' }).success).toBe(false);
    expect(AdminServiceRequestDecisionResponseSchema.safeParse({ status: 'admin_declined' }).success).toBe(false);
    expect(SERVICE_REQUEST_STATUSES).toHaveLength(6);
  });

  it('records no obligation: there is no acceptance time and no payment deadline to record', () => {
    expect(
      AdminServiceRequestDecisionResponseSchema.safeParse({ status: 'declined', paymentDueAt: null }).success,
    ).toBe(false);
    expect(
      AdminServiceRequestDecisionResponseSchema.safeParse({ status: 'declined', acceptedAt: null }).success,
    ).toBe(false);
  });
});

describe('the Option 2 problem code', () => {
  it('declares one, for a platform with no default currency', () => {
    expect(PROBLEM_CODES).toContain('SERVICE_REQUEST_CURRENCY_UNAVAILABLE');
  });

  it('declares no payment-information manage code and no routing code', () => {
    for (const code of PROBLEM_CODES) {
      expect(code).not.toContain('PAYMENT_INFO_MANAGE');
      if (code.startsWith('SERVICE_REQUEST')) expect(code).not.toContain('ROUTING_MODE');
    }
  });
});
