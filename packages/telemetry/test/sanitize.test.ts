import { describe, expect, it } from 'vitest';
import { pathOnly, sanitizeAttributes, sanitizeSpanName } from '../src/index.js';

describe('URL sanitisation (in-process test of the http.url cleaning, O8-11/O8-18)', () => {
  it.each([
    ['/ar/items?q=canary', '/ar/items'],
    ['/?email=canary@example.test', '/'],
    ['/path#fragment?x', '/path'],
    ['https://user:pw@host.example:8443/a/b?c=d', '/a/b'],
    ['http://host/a?x', '/a'],
    ['', ''],
    ['https://%zz', ''],
  ])('%s -> %s', (input, expected) => {
    expect(pathOnly(input)).toBe(expected);
  });

  it('removes queries from span names', () => {
    expect(sanitizeSpanName('GET /[locale]?token=canary')).toBe('GET /[locale]');
    expect(sanitizeSpanName('render route (app) /[locale]#x')).toBe('render route (app) /[locale]');
  });

  it('drops non-string URL values and unknown keys', () => {
    expect(sanitizeAttributes({ 'http.url': 42, 'http.method': 'GET', secret: 'x' })).toEqual({ 'http.method': 'GET' });
  });
});
