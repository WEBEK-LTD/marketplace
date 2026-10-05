import { describe, expect, it } from 'vitest';
import {
  CreateAttributeDefinitionRequestSchema,
  FileReportRequestSchema,
  ModerationReasonSchema,
  PasswordSchema,
  ReportDetailsSchema,
  ResolutionNoteSchema,
  SaveCategoryTranslationRequestSchema,
  SendMessageRequestSchema,
  UpdateAttributeDefinitionRequestSchema,
} from '../src/index.js';

/**
 * Whitespace normalisation — the request layer (0105).
 *
 * `z.string().min(1)` counts characters, so a value of one tab satisfies it. On the way out, `btrim(x)` with no
 * character set trims spaces only, so the same tab satisfied the CHECK constraint that was supposed to refuse an
 * empty value. Two consequences of that were proved reachable before 0105: a whitespace-only **category name**
 * reached the public, unauthenticated catalogue, and a report could be **closed on a whitespace-only resolution
 * note** — defeating an invariant the database function names in its own error message.
 *
 * 0105 fixes all three layers. The database is the authority and is asserted in
 * `supabase/tests/0105_whitespace_normalisation.test.sql`; this file covers the six request schemas, which do
 * two things the database deliberately does not:
 *
 *   1. they turn a blank value into a clean 400 rather than a constraint violation surfacing as a 500;
 *   2. they **normalise what is stored**, because `.trim()` rewrites the parsed value. Most of the writers check
 *      a trimmed copy and store what they were given, so this is the layer that decides a stored name is not
 *      padded. That is why each case below asserts the parsed output, not merely that parsing succeeded.
 *
 * Interior whitespace is never touched. This increment refuses an empty value; it does not reformat text.
 */

/** Every way of writing "nothing" that the loose form admitted. Only the first was ever refused. */
const BLANKS: readonly [string, string][] = [
  ['spaces', '   '],
  ['a tab', '\t'],
  ['two tabs', '\t\t'],
  ['a newline', '\n'],
  ['a carriage return', '\r'],
  ['a mixture of all four', ' \t\r\n \t'],
];

/** A value with whitespace at both ends and inside it. The inside must survive. */
const PADDED = '\t Garden  Furniture \n';
const TRIMMED = 'Garden  Furniture';

describe('the six schemas 0105 trimmed', () => {
  it('min(1) alone counts a tab as a character, which is the whole defect', () => {
    // Stated here rather than assumed, because it is the premise of every case below.
    expect('\t'.length).toBe(1);
    expect('\t'.trim()).toBe('');
  });

  describe('a category translation name — proved reachable on the public catalogue', () => {
    // The schema is `.strict()` and carries no locale: the locale is a path segment. An earlier version of this
    // fixture passed `localeCode` and every refusal below passed for that reason instead of the one being
    // tested, which is a test that proves nothing while looking like it proves something.
    const parse = (name: string) => SaveCategoryTranslationRequestSchema.safeParse({ name });

    it('the fixture is accepted with a real name, so only the name can refuse it', () => {
      expect(parse('Furniture').success).toBe(true);
    });

    it.each(BLANKS)('refuses a name of %s', (_label, value) => {
      expect(parse(value).success).toBe(false);
    });

    it('accepts a real name and strips only its edges', () => {
      const result = parse(PADDED);
      expect(result.success).toBe(true);
      expect(result.success && result.data.name).toBe(TRIMMED);
    });

    it('does not trim the description, which is a different field with different bounds', () => {
      // Guarding the scope of the change: 0105 touched `name`, and nothing else in this schema. The three
      // optional fields accept an empty string because a blank **clears** them, and trimming them would be a
      // change of behaviour rather than a hardening.
      const padded = SaveCategoryTranslationRequestSchema.safeParse({
        name: 'Furniture',
        description: '  spaced  ',
      });
      expect(padded.success).toBe(true);
      expect(padded.success && padded.data.description).toBe('  spaced  ');
    });
  });

  describe('a report resolution note — proved able to close a report while blank', () => {
    it.each(BLANKS)('refuses a note of %s', (_label, value) => {
      expect(ResolutionNoteSchema.safeParse(value).success).toBe(false);
    });

    it('accepts a real note and keeps its interior spacing', () => {
      const result = ResolutionNoteSchema.safeParse('\tCounterfeit  confirmed. \n');
      expect(result.success).toBe(true);
      expect(result.success && result.data).toBe('Counterfeit  confirmed.');
    });

    it('still enforces the 4000-character ceiling after trimming, not before', () => {
      expect(ResolutionNoteSchema.safeParse(`  ${'x'.repeat(4000)}  `).success).toBe(true);
      expect(ResolutionNoteSchema.safeParse('x'.repeat(4001)).success).toBe(false);
    });
  });

  describe('a moderation reason', () => {
    it.each(BLANKS)('refuses a reason of %s', (_label, value) => {
      expect(ModerationReasonSchema.safeParse(value).success).toBe(false);
    });

    it('accepts a real reason, trimmed, and keeps its 500-character bound', () => {
      const result = ModerationReasonSchema.safeParse(' Prohibited  item. ');
      expect(result.success && result.data).toBe('Prohibited  item.');
      expect(ModerationReasonSchema.safeParse('x'.repeat(501)).success).toBe(false);
    });
  });

  describe('report details — nullable, so a blank box is absent rather than a refusal', () => {
    it.each(BLANKS)('refuses details of %s when the field is present', (_label, value) => {
      expect(ReportDetailsSchema.safeParse(value).success).toBe(false);
    });

    it('accepts real details, trimmed', () => {
      const result = ReportDetailsSchema.safeParse('\tThe photographs  differ. \n');
      expect(result.success && result.data).toBe('The photographs  differ.');
    });

    it('and the filing request omits the field rather than carrying a blank', () => {
      const omitted = FileReportRequestSchema.safeParse({
        subjectType: 'listing',
        subjectSlug: 'walnut-table',
        reasonCode: 'misleading',
      });
      expect(omitted.success).toBe(true);
      expect(omitted.success && omitted.data.details).toBeUndefined();
      // A blank is a refusal, not a silent conversion to absent. The database makes the other choice, on
      // purpose: `report_file_for_reporter` files a whitespace-only box as no details at all, because by then
      // nobody is left to tell. Here somebody is, so they are told.
      expect(
        FileReportRequestSchema.safeParse({
          subjectType: 'listing',
          subjectSlug: 'walnut-table',
          reasonCode: 'misleading',
          details: '\t\t',
        }).success,
      ).toBe(false);
    });
  });

  describe('a conversation message body', () => {
    it.each(BLANKS)('refuses a body of %s', (_label, value) => {
      expect(SendMessageRequestSchema.safeParse({ body: value }).success).toBe(false);
    });

    it('accepts a real body, trimmed, so 0104 attachments still hang off a message with text', () => {
      const result = SendMessageRequestSchema.safeParse({ body: '\tIs it  still available? \n' });
      expect(result.success).toBe(true);
      expect(result.success && result.data.body).toBe('Is it  still available?');
    });
  });

  describe('an attribute unit — optional, and only meaningful on a number attribute', () => {
    const create = (unit: string) =>
      CreateAttributeDefinitionRequestSchema.safeParse({
        key: 'width',
        dataType: 'number',
        nameEn: 'Width',
        nameAr: 'العرض',
        unit,
      });

    it.each(BLANKS)('refuses a unit of %s', (_label, value) => {
      expect(create(value).success).toBe(false);
    });

    it('accepts a real unit, trimmed', () => {
      const result = create(' cm ');
      expect(result.success).toBe(true);
      expect(result.success && result.data.unit).toBe('cm');
    });

    // The update request is deliberately **not** trimmed, and that is the one place in this increment where
    // leaving a schema alone was the correct answer. It replaces the whole row, so an empty string there means
    // *clear the unit* rather than *send nothing* — adding `trim().min(1)` would have made clearing a unit
    // impossible. The invariant is still held, one layer down: `attribute_definition_update_for_staff` stores
    // `nullif(btrim(coalesce(p_unit, ''), E' \t\r\n'), '')`, so any whitespace-only unit becomes null.
    it('the update request accepts a blank unit, because a blank clears it', () => {
      const base = {
        nameEn: 'Width',
        nameAr: 'العرض',
        isFilterable: true,
        sortOrder: 10,
      };
      expect(UpdateAttributeDefinitionRequestSchema.safeParse({ ...base, unit: '' }).success).toBe(true);
      for (const [, value] of BLANKS) {
        const result = UpdateAttributeDefinitionRequestSchema.safeParse({ ...base, unit: value });
        expect(result.success).toBe(true);
        // Carried through verbatim: the request layer does not decide this one, the writer does.
        expect(result.success && result.data.unit).toBe(value);
      }
    });
  });
});

describe('what 0105 deliberately left alone', () => {
  it('does not treat Unicode whitespace as blank (owner decision 4)', () => {
    // `String.prototype.trim` removes U+00A0, so the request layer is *stricter* here than the database, whose
    // character set is exactly four ASCII characters. That asymmetry is recorded rather than smoothed over: the
    // database is the authority, and widening its set needs a decision about which code points count.
    expect(' '.trim()).toBe('');
    expect(ModerationReasonSchema.safeParse(' ').success).toBe(false);

    // A zero-width space is not whitespace to either layer, and is accepted by both. This is the deferred case.
    expect('​'.trim()).toBe('​');
    expect(ModerationReasonSchema.safeParse('​').success).toBe(true);
  });

  it('leaves a password untouched, where trimming would be a security defect', () => {
    // Asserted here because a password is the one string in this platform that must not be normalised, and a
    // sweep for "add .trim() everywhere" would have broken it: trimming would silently change the credential
    // and let two different passwords authenticate the same account. See the comment in src/password.ts.
    const padded = '  correct horse battery staple  ';
    const result = PasswordSchema.safeParse(padded);
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe(padded);
  });
});
