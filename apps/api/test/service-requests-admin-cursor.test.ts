import { describe, expect, it } from 'vitest';
import {
  ADMIN_SERVICE_REQUESTS_CURSOR_VERSION,
  ADMIN_SERVICE_REQUEST_MANAGE_PERMISSION,
  ADMIN_SERVICE_REQUEST_READ_PERMISSION,
  SERVICE_REQUEST_PAYMENT_INFO_PERMISSION,
  decodeAdminServiceRequestsCursor,
  encodeAdminServiceRequestsCursor,
} from '../src/admin/service-requests-admin.cursor.js';
import {
  SERVICE_REQUESTS_CURSOR_VERSION,
  encodeServiceRequestsCursor,
} from '../src/services/service-requests-cursor.js';

/**
 * The Admin Only queue cursor, and the three permission keys beside it (Phase 7-J).
 *
 * The cursor is client text that reaches a query, so what matters is that it decodes to a fixed pair of typed
 * values or to nothing at all. The one property specific to this cursor is that it is **not** 7-I's: the two
 * lists run in opposite orders, so a position in one is the wrong position in the other, and the version tag is
 * what refuses the confusion.
 */

const ID = 'd4000000-0000-4000-8000-000000000001';
const WHEN = new Date('2026-05-01T09:00:00.000Z');

const encode = (parts: readonly string[]): string =>
  Buffer.from(parts.join('|'), 'utf8').toString('base64url');

describe('a round trip', () => {
  it('returns the same position', () => {
    const decoded = decodeAdminServiceRequestsCursor(
      encodeAdminServiceRequestsCursor({ createdAt: WHEN, id: ID }),
    );
    expect(decoded?.createdAt.toISOString()).toBe('2026-05-01T09:00:00.000Z');
    expect(decoded?.id).toBe(ID);
  });

  it('encodes the same position to the same string, every time', () => {
    const once = encodeAdminServiceRequestsCursor({ createdAt: WHEN, id: ID });
    const twice = encodeAdminServiceRequestsCursor({
      createdAt: new Date(WHEN.getTime()),
      id: ID.toUpperCase(),
    });
    expect(twice).toBe(once);
  });

  it('is base64url with no padding, so a URL carries it unescaped', () => {
    const cursor = encodeAdminServiceRequestsCursor({ createdAt: WHEN, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('carries its own version tag, and three parts', () => {
    const cursor = encodeAdminServiceRequestsCursor({ createdAt: WHEN, id: ID });
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    expect(text.split('|')[0]).toBe(ADMIN_SERVICE_REQUESTS_CURSOR_VERSION);
    expect(text.split('|')).toHaveLength(3);
  });
});

describe('it is not the buyer list’s cursor', () => {
  it('uses a different version tag', () => {
    expect(ADMIN_SERVICE_REQUESTS_CURSOR_VERSION).not.toBe(SERVICE_REQUESTS_CURSOR_VERSION);
    expect(ADMIN_SERVICE_REQUESTS_CURSOR_VERSION).toBe('aq1');
  });

  it('refuses a cursor minted for the buyer’s list, whose order is the opposite', () => {
    const buyers = encodeServiceRequestsCursor({ createdAt: WHEN, id: ID });
    expect(decodeAdminServiceRequestsCursor(buyers)).toBeNull();
  });

  it('and the two encodings of one position differ, so neither can be mistaken for the other', () => {
    expect(encodeAdminServiceRequestsCursor({ createdAt: WHEN, id: ID })).not.toBe(
      encodeServiceRequestsCursor({ createdAt: WHEN, id: ID }),
    );
  });
});

describe('anything else refuses', () => {
  it.each([
    ['empty', ''],
    ['outside the alphabet', '!!!!'],
    ['padded base64', 'YXExfDIwMjY='],
    ['not base64 at all', 'not a cursor'],
    ['a stray space', ' YXEx'],
  ])('refuses a cursor that is %s', (_name, cursor) => {
    expect(decodeAdminServiceRequestsCursor(cursor)).toBeNull();
  });

  it.each([
    ['no version', encode([WHEN.toISOString(), ID])],
    ['too few parts', encode([ADMIN_SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString()])],
    ['too many parts', encode([ADMIN_SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString(), ID, 'extra'])],
    [
      'a timestamp with no milliseconds',
      encode([ADMIN_SERVICE_REQUESTS_CURSOR_VERSION, '2026-05-01T09:00:00Z', ID]),
    ],
    [
      'a local timestamp',
      encode([ADMIN_SERVICE_REQUESTS_CURSOR_VERSION, '2026-05-01T09:00:00.000+02:00', ID]),
    ],
    [
      'a date that is not one',
      encode([ADMIN_SERVICE_REQUESTS_CURSOR_VERSION, '2026-02-31T09:00:00.000Z', ID]),
    ],
    ['an identifier that is not one', encode([ADMIN_SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString(), 'nope'])],
    [
      'an upper-case identifier',
      encode([ADMIN_SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString(), ID.toUpperCase()]),
    ],
  ])('refuses %s', (_name, cursor) => {
    expect(decodeAdminServiceRequestsCursor(cursor)).toBeNull();
  });

  it('refuses a cursor carrying SQL rather than a position', () => {
    for (const payload of ['created_at desc; drop table public.service_requests', '1 or 1=1', 'created_at desc']) {
      expect(
        decodeAdminServiceRequestsCursor(encode([ADMIN_SERVICE_REQUESTS_CURSOR_VERSION, payload, ID])),
      ).toBeNull();
      expect(
        decodeAdminServiceRequestsCursor(
          encode([ADMIN_SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString(), payload]),
        ),
      ).toBeNull();
    }
  });

  it('decodes to a Date and a string, never to anything a query could read as syntax', () => {
    const decoded = decodeAdminServiceRequestsCursor(
      encodeAdminServiceRequestsCursor({ createdAt: WHEN, id: ID }),
    );
    expect(decoded).not.toBeNull();
    expect(Object.keys(decoded!).sort()).toEqual(['createdAt', 'id']);
    expect(decoded!.createdAt).toBeInstanceOf(Date);
    expect(decoded!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('the three permission keys', () => {
  it('are exactly the approved ones', () => {
    expect(ADMIN_SERVICE_REQUEST_READ_PERMISSION).toBe('service_requests.request.read');
    expect(ADMIN_SERVICE_REQUEST_MANAGE_PERMISSION).toBe('service_requests.request.manage');
    expect(SERVICE_REQUEST_PAYMENT_INFO_PERMISSION).toBe('service_requests.payment_info.read');
  });

  it('are three distinct keys, so one cannot stand in for another', () => {
    const keys = new Set([
      ADMIN_SERVICE_REQUEST_READ_PERMISSION,
      ADMIN_SERVICE_REQUEST_MANAGE_PERMISSION,
      SERVICE_REQUEST_PAYMENT_INFO_PERMISSION,
    ]);
    expect(keys.size).toBe(3);
  });

  it('name no manage counterpart for payment information', () => {
    for (const key of [
      ADMIN_SERVICE_REQUEST_READ_PERMISSION,
      ADMIN_SERVICE_REQUEST_MANAGE_PERMISSION,
      SERVICE_REQUEST_PAYMENT_INFO_PERMISSION,
    ]) {
      expect(key).not.toBe('service_requests.payment_info.manage');
    }
  });
});
