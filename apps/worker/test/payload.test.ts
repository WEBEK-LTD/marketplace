import { describe, expect, it } from 'vitest';
import { assertIdPayload, InvalidJobPayloadError } from '../src/queue/payload.js';
import { ID_A, ID_B } from './support/runtime.js';

describe('IDs-only job payloads', () => {
  it('accepts <name>Id keys with UUID values', () => {
    expect(() => assertIdPayload({ orderId: ID_A })).not.toThrow();
    expect(() => assertIdPayload({ orderId: ID_A, sellerId: ID_B.toUpperCase() })).not.toThrow();
  });

  it.each([
    ['null', null],
    ['array', [ID_A]],
    ['empty object', {}],
    ['string', ID_A],
    ['non-Id key', { order: ID_A }],
    ['email value', { userId: 'person@example.com' }],
    ['number value', { orderId: 42 }],
    ['nested object', { orderId: { id: ID_A } }],
    ['free text', { noteId: 'call the buyer' }],
    ['uppercase key start', { OrderId: ID_A }],
    ['class instance', new (class { orderId = ID_A })()],
  ])('rejects %s', (_label, value) => {
    expect(() => assertIdPayload(value)).toThrow(InvalidJobPayloadError);
  });
});
