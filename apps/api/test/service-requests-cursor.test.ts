import { describe, expect, it } from 'vitest';
import {
  SERVICE_REQUESTS_CURSOR_VERSION,
  decodeServiceRequestsCursor,
  encodeServiceRequestsCursor,
} from '../src/services/service-requests-cursor.js';

/**
 * The service request list cursor (Phase 7-I).
 *
 * The cursor is client text that reaches a query, so what matters is that it decodes to a fixed pair of
 * typed values or to nothing at all. These tests hold it to that: a round trip is stable, every malformed
 * form refuses rather than resolving to a wrong position, and no decoded value can carry anything that is
 * not a timestamp and an identifier.
 */

const ID = 'd1000000-0000-4000-8000-000000000001';
const WHEN = new Date('2026-05-01T09:00:00.000Z');

const encode = (parts: readonly string[]): string =>
  Buffer.from(parts.join('|'), 'utf8').toString('base64url');

describe('a round trip', () => {
  it('returns the same position', () => {
    const decoded = decodeServiceRequestsCursor(encodeServiceRequestsCursor({ createdAt: WHEN, id: ID }));
    expect(decoded?.createdAt.toISOString()).toBe('2026-05-01T09:00:00.000Z');
    expect(decoded?.id).toBe(ID);
  });

  it('encodes the same position to the same string, every time', () => {
    const once = encodeServiceRequestsCursor({ createdAt: WHEN, id: ID });
    const twice = encodeServiceRequestsCursor({ createdAt: new Date(WHEN.getTime()), id: ID.toUpperCase() });
    expect(twice).toBe(once);
  });

  it('is base64url with no padding, so a URL carries it unescaped', () => {
    const cursor = encodeServiceRequestsCursor({ createdAt: WHEN, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('carries the version tag, and nothing that names a party', () => {
    const cursor = encodeServiceRequestsCursor({ createdAt: WHEN, id: ID });
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    expect(text.split('|')[0]).toBe(SERVICE_REQUESTS_CURSOR_VERSION);
    expect(text.split('|')).toHaveLength(3);
  });
});

describe('anything else refuses', () => {
  it.each([
    ['empty', ''],
    ['outside the alphabet', '!!!!'],
    ['padded base64', 'c3IxfDIwMjY='],
    ['not base64 at all', 'not a cursor'],
    ['a stray space', ' c3Ix'],
  ])('refuses a cursor that is %s', (_name, cursor) => {
    expect(decodeServiceRequestsCursor(cursor)).toBeNull();
  });

  it.each([
    ['another version', encode(['mi1', WHEN.toISOString(), ID])],
    ['no version', encode([WHEN.toISOString(), ID])],
    ['too few parts', encode([SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString()])],
    ['too many parts', encode([SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString(), ID, 'extra'])],
    ['a timestamp with no milliseconds', encode([SERVICE_REQUESTS_CURSOR_VERSION, '2026-05-01T09:00:00Z', ID])],
    ['a local timestamp', encode([SERVICE_REQUESTS_CURSOR_VERSION, '2026-05-01T09:00:00.000+02:00', ID])],
    ['a date that is not one', encode([SERVICE_REQUESTS_CURSOR_VERSION, '2026-02-31T09:00:00.000Z', ID])],
    ['an identifier that is not one', encode([SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString(), 'nope'])],
    [
      'an upper-case identifier',
      encode([SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString(), ID.toUpperCase()]),
    ],
  ])('refuses %s', (_name, cursor) => {
    expect(decodeServiceRequestsCursor(cursor)).toBeNull();
  });

  it('refuses a cursor carrying SQL rather than a position', () => {
    for (const payload of [
      "created_at desc; drop table public.service_requests",
      '1 or 1=1',
      'created_at asc',
    ]) {
      expect(decodeServiceRequestsCursor(encode([SERVICE_REQUESTS_CURSOR_VERSION, payload, ID]))).toBeNull();
      expect(decodeServiceRequestsCursor(encode([SERVICE_REQUESTS_CURSOR_VERSION, WHEN.toISOString(), payload]))).toBeNull();
    }
  });

  it('decodes to a Date and a string, never to anything a query could read as syntax', () => {
    const decoded = decodeServiceRequestsCursor(encodeServiceRequestsCursor({ createdAt: WHEN, id: ID }));
    expect(decoded).not.toBeNull();
    expect(Object.keys(decoded!).sort()).toEqual(['createdAt', 'id']);
    expect(decoded!.createdAt).toBeInstanceOf(Date);
    expect(decoded!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
