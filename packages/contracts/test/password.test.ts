import { describe, expect, it } from 'vitest';
import {
  PASSWORD_ISSUE,
  PASSWORD_MAX_UTF8_BYTES,
  PASSWORD_MIN_CHARACTERS,
  PasswordSchema,
  characterLength,
  utf8ByteLength,
} from '../src/index.js';

/** Every fixture's size is measured, never assumed, so a wrong assumption fails here and not silently. */
const bytes = (value: string) => new TextEncoder().encode(value).length;

// Arabic letters are 2 UTF-8 bytes each, so 36 of them are exactly 72 bytes but only 36 characters.
const ARABIC_LETTER = 'ب';
const arabic = (count: number) => ARABIC_LETTER.repeat(count);

function ruleOf(value: string): string[] {
  const result = PasswordSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => String((issue as { params?: { rule?: unknown } }).params?.rule));
}

describe('measurement helpers', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength(ARABIC_LETTER)).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength(arabic(36))).toBe(72);
  });

  it('counts characters as code points, not UTF-16 code units', () => {
    expect(characterLength('😀')).toBe(1);
    expect('😀'.length).toBe(2); // the JavaScript trap this avoids
    expect(characterLength(arabic(36))).toBe(36);
  });
});

describe('minimum length (D1: 10 characters)', () => {
  it('rejects below the minimum', () => {
    expect(ruleOf('short')).toContain(PASSWORD_ISSUE.tooShort);
    expect(ruleOf('a'.repeat(9))).toContain(PASSWORD_ISSUE.tooShort);
    expect(ruleOf('')).toContain(PASSWORD_ISSUE.tooShort);
  });

  it('accepts exactly 10 characters', () => {
    const value = 'a'.repeat(PASSWORD_MIN_CHARACTERS);
    expect(characterLength(value)).toBe(10);
    expect(PasswordSchema.safeParse(value).success).toBe(true);
  });

  it('counts a multibyte character as one character', () => {
    const value = arabic(10);
    expect(characterLength(value)).toBe(10);
    expect(bytes(value)).toBe(20);
    expect(PasswordSchema.safeParse(value).success).toBe(true);
  });

  it('does not let UTF-16 code units inflate a short password past the minimum', () => {
    // Five emoji are 10 UTF-16 code units. `.length` would call this 10 and wrongly accept it.
    const value = '😀'.repeat(5);
    expect(value.length).toBe(10);
    expect(characterLength(value)).toBe(5);
    expect(ruleOf(value)).toContain(PASSWORD_ISSUE.tooShort);
  });
});

describe('maximum length (D1/N2: 72 UTF-8 bytes)', () => {
  it('accepts 72 ASCII bytes', () => {
    const value = 'a'.repeat(72);
    expect(bytes(value)).toBe(72);
    expect(PasswordSchema.safeParse(value).success).toBe(true);
  });

  it('accepts exactly 72 UTF-8 bytes of multibyte text', () => {
    // The D1-1 clause "exactly-72-byte password verifies", on the validator side.
    const value = arabic(36);
    expect(bytes(value)).toBe(PASSWORD_MAX_UTF8_BYTES);
    expect(characterLength(value)).toBe(36);
    expect(PasswordSchema.safeParse(value).success).toBe(true);
  });

  it('rejects 73 bytes', () => {
    const value = `${'a'.repeat(71)}${ARABIC_LETTER}`;
    expect(bytes(value)).toBe(73);
    expect(ruleOf(value)).toContain(PASSWORD_ISSUE.tooManyBytes);
  });

  it('rejects 73 ASCII bytes', () => {
    const value = 'a'.repeat(73);
    expect(bytes(value)).toBe(73);
    expect(ruleOf(value)).toContain(PASSWORD_ISSUE.tooManyBytes);
  });

  it('rejects long multibyte input that is well under 72 characters', () => {
    // 40 Arabic letters: 40 characters, 80 bytes. The character count would have accepted it.
    const value = arabic(40);
    expect(characterLength(value)).toBe(40);
    expect(bytes(value)).toBe(80);
    expect(ruleOf(value)).toContain(PASSWORD_ISSUE.tooManyBytes);
  });

  it('rejects mixed ASCII and multibyte input that crosses the byte limit', () => {
    const value = `${'password'}${arabic(33)}`; // 8 + 66 = 74 bytes, 41 characters
    expect(characterLength(value)).toBe(41);
    expect(bytes(value)).toBe(74);
    expect(ruleOf(value)).toContain(PASSWORD_ISSUE.tooManyBytes);
  });

  it('accepts mixed ASCII and multibyte input that fits', () => {
    const value = `${'pass'}${arabic(34)}`; // 4 + 68 = 72 bytes
    expect(bytes(value)).toBe(72);
    expect(PasswordSchema.safeParse(value).success).toBe(true);
  });
});

describe('no truncation, no normalization, exact value preservation', () => {
  it('returns the accepted value unchanged', () => {
    const value = `${arabic(20)}Aa1!${'😀'}`;
    const result = PasswordSchema.safeParse(value);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(value);
      expect(bytes(result.data)).toBe(bytes(value));
    }
  });

  it('rejects an over-long password rather than truncating it to 72 bytes', () => {
    const value = arabic(50); // 100 bytes
    const result = PasswordSchema.safeParse(value);
    expect(result.success).toBe(false);
    // Nothing anywhere in the result is a shortened copy of the input.
    expect(JSON.stringify(result)).not.toContain(arabic(36));
  });

  it('does not normalize: NFC and NFD forms stay distinct and are each preserved', () => {
    const composed = `é${'a'.repeat(9)}`; // é as one code point
    const decomposed = `é${'a'.repeat(9)}`; // e + combining acute
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize('NFD')).toBe(decomposed);

    const a = PasswordSchema.safeParse(composed);
    const b = PasswordSchema.safeParse(decomposed);
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) {
      expect(a.data).toBe(composed);
      expect(b.data).toBe(decomposed);
      expect(a.data).not.toBe(b.data);
    }
  });

  it('does not trim: surrounding whitespace is part of the password', () => {
    const value = `  ${'a'.repeat(8)}  `;
    const result = PasswordSchema.safeParse(value);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(value);
  });

  it('does not change case', () => {
    const value = 'PaSsWoRdXy';
    const result = PasswordSchema.safeParse(value);
    expect(result.success && result.data).toBe(value);
  });
});

describe('no forced character mix (D1)', () => {
  it.each([
    ['lowercase only', 'abcdefghij'],
    ['digits only', '0123456789'],
    ['uppercase only', 'ABCDEFGHIJ'],
    ['symbols only', '!!!!!!!!!!'],
    ['spaces only', '          '],
    ['Arabic only', arabic(10)],
  ])('accepts %s when the length rules are met', (_label, value) => {
    expect(PasswordSchema.safeParse(value).success).toBe(true);
  });
});

describe('the rule leaks nothing and runs anywhere', () => {
  it('never puts the password in an error', () => {
    // Distinctive on purpose: a short fixture like "sh" would collide with the rule name
    // "password_too_short" and fail for a reason that has nothing to do with leaking.
    const secret = 'Xq7#vZ';
    const result = PasswordSchema.safeParse(secret);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain(secret);
      for (const issue of result.error.issues) expect(issue.message).not.toContain(secret);
    }
  });

  it('works without Buffer, so the browser half of "UI and API" holds', () => {
    const saved = Reflect.get(globalThis, 'Buffer') as unknown;
    Reflect.deleteProperty(globalThis, 'Buffer');
    try {
      expect(PasswordSchema.safeParse(arabic(36)).success).toBe(true);
      expect(PasswordSchema.safeParse(arabic(37)).success).toBe(false);
      expect(utf8ByteLength(arabic(36))).toBe(72);
    } finally {
      Reflect.set(globalThis, 'Buffer', saved);
    }
  });

  it('exposes the approved limits as the single source of truth', () => {
    expect(PASSWORD_MIN_CHARACTERS).toBe(10);
    expect(PASSWORD_MAX_UTF8_BYTES).toBe(72);
  });
});
