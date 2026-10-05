import { describe, expect, it } from 'vitest';
import {
  AdminCategoryDetailSchema,
  AdminCategoryNodeSchema,
  AdminCategoryTranslationSchema,
  CATEGORY_LEVELS,
  CATEGORY_MAX_DEPTH,
  CATEGORY_META_DESCRIPTION_MAX,
  CATEGORY_META_TITLE_MAX,
  CATEGORY_NAME_MAX,
  CategoryStateRequestSchema,
  CreateCategoryRequestSchema,
  SaveCategoryTranslationRequestSchema,
  UpdateCategoryRequestSchema,
} from '../src/index.js';

/**
 * The admin category contracts.
 *
 * What is worth proving here is what each request makes **impossible**, because that is where this contract does
 * its work:
 *
 * **A rename cannot be expressed.** The slug is on the create and nowhere else, and the update is strict, so a
 * `slug` field is a validation failure rather than a value silently dropped by a service.
 *
 * **Visibility cannot change by accident.** `isActive` is absent from both the create and the update: a category
 * is created hidden and shown by its own request.
 *
 * **"Move to the root" and "leave the parent alone" are different requests**, which is what `setParent` is for.
 *
 * **The limits are the database's.** Each one is checked against the constraint it came from in migration 0010.
 */

const NODE = {
  categoryId: '11111111-1111-4111-8111-111111111111',
  parentId: null,
  slug: 'furniture',
  depth: 0,
  sortOrder: 1,
  listingTypeCode: 'product',
  isActive: true,
  isVisible: true,
  childCount: 2,
  listingCount: 7,
  translatedLocales: ['en', 'ar'],
  name: 'Furniture',
  updatedAt: '2026-05-02T09:00:00.000Z',
} as const;

describe('a node of the tree', () => {
  it('carries the public answer separately from the stored state', () => {
    // They differ exactly when an active category sits under a hidden ancestor, which is the state an author
    // most needs to see and the one a row cannot report about itself.
    const shadowed = AdminCategoryNodeSchema.parse({ ...NODE, isActive: true, isVisible: false });
    expect(shadowed.isActive).toBe(true);
    expect(shadowed.isVisible).toBe(false);
  });

  it('allows a category nobody has written yet', () => {
    const unwritten = AdminCategoryNodeSchema.parse({ ...NODE, name: null, translatedLocales: [] });
    expect(unwritten.name).toBeNull();
    expect(unwritten.translatedLocales).toEqual([]);
  });

  it('keeps depth inside D8s three levels', () => {
    expect(CATEGORY_MAX_DEPTH).toBe(2);
    expect(CATEGORY_LEVELS).toBe(3);
    for (const depth of [0, 1, 2]) {
      expect(AdminCategoryNodeSchema.safeParse({ ...NODE, depth }).success, String(depth)).toBe(true);
    }
    for (const depth of [-1, 3, 1.5]) {
      expect(AdminCategoryNodeSchema.safeParse({ ...NODE, depth }).success, String(depth)).toBe(false);
    }
  });

  it('refuses a slug that is not slug-shaped', () => {
    for (const slug of ['', 'Furniture', 'a b', '-x', 'x-', '../x', 'a'.repeat(81)]) {
      expect(AdminCategoryNodeSchema.safeParse({ ...NODE, slug }).success, slug).toBe(false);
    }
    expect(AdminCategoryNodeSchema.safeParse({ ...NODE, slug: 'a'.repeat(80) }).success).toBe(true);
  });

  it('refuses a listing type the catalogue does not have, and allows none at all', () => {
    expect(AdminCategoryNodeSchema.safeParse({ ...NODE, listingTypeCode: null }).success).toBe(true);
    expect(AdminCategoryNodeSchema.safeParse({ ...NODE, listingTypeCode: 'rental' }).success).toBe(false);
  });

  it('refuses a locale the public surfaces do not exist for', () => {
    expect(AdminCategoryNodeSchema.safeParse({ ...NODE, translatedLocales: ['fr'] }).success).toBe(false);
  });

  it('never reports a negative count', () => {
    expect(AdminCategoryNodeSchema.safeParse({ ...NODE, childCount: -1 }).success).toBe(false);
    expect(AdminCategoryNodeSchema.safeParse({ ...NODE, listingCount: -1 }).success).toBe(false);
  });
});

describe('the detail', () => {
  it('says whether this caller may change anything, and names the parent', () => {
    const detail = AdminCategoryDetailSchema.parse({
      ...NODE,
      name: undefined,
      parentSlug: 'home',
      createdAt: '2026-04-01T09:00:00.000Z',
      canManage: false,
    });
    expect(detail.canManage).toBe(false);
    expect(detail.parentSlug).toBe('home');
  });

  it('requires canManage rather than letting it default', () => {
    // A console renders its controls from this, so an absent value must be a failure and never a false that
    // looks like a decision.
    const { ...withoutFlag } = { ...NODE, parentSlug: null, createdAt: '2026-04-01T09:00:00.000Z' };
    expect(AdminCategoryDetailSchema.safeParse(withoutFlag).success).toBe(false);
  });
});

describe('creating one', () => {
  it('takes the slug, and the slug is the only address it will ever have', () => {
    expect(CreateCategoryRequestSchema.parse({ slug: 'garden' })).toEqual({ slug: 'garden' });
  });

  it('accepts a parent, a surface and an order', () => {
    const parsed = CreateCategoryRequestSchema.parse({
      slug: 'planters',
      parentId: '11111111-1111-4111-8111-111111111111',
      listingTypeCode: 'service',
      sortOrder: 4,
    });
    expect(parsed.sortOrder).toBe(4);
  });

  it('does not accept an active state: a new category is always hidden', () => {
    expect(CreateCategoryRequestSchema.safeParse({ slug: 'garden', isActive: true }).success).toBe(false);
  });

  it('does not accept a depth: the tree decides that', () => {
    expect(CreateCategoryRequestSchema.safeParse({ slug: 'garden', depth: 1 }).success).toBe(false);
  });

  it('refuses a malformed slug rather than letting the database do it', () => {
    for (const slug of ['', 'Garden', 'gar den', 'a'.repeat(81)]) {
      expect(CreateCategoryRequestSchema.safeParse({ slug }).success, slug).toBe(false);
    }
  });
});

describe('updating one', () => {
  it('cannot express a rename', () => {
    // The decisive assertion of this file. A rename would break a live public address with no redirect, so the
    // field is not droppable-but-ignored: it is a validation failure.
    expect(UpdateCategoryRequestSchema.safeParse({ setParent: false, slug: 'renamed' }).success).toBe(false);
  });

  it('cannot express a visibility change either', () => {
    expect(UpdateCategoryRequestSchema.safeParse({ setParent: false, isActive: false }).success).toBe(false);
  });

  it('tells "move to the root" apart from "leave the parent alone"', () => {
    expect(UpdateCategoryRequestSchema.parse({ setParent: true, parentId: null })).toEqual({
      setParent: true,
      parentId: null,
    });
    expect(UpdateCategoryRequestSchema.parse({ setParent: false })).toEqual({ setParent: false });
  });

  it('refuses a parent offered without the flag that would apply it', () => {
    // Otherwise a caller could believe it had moved a category and be wrong.
    expect(
      UpdateCategoryRequestSchema.safeParse({ setParent: false, parentId: '11111111-1111-4111-8111-111111111111' })
        .success,
    ).toBe(false);
  });

  it('requires the flag to be stated', () => {
    expect(UpdateCategoryRequestSchema.safeParse({ sortOrder: 2 }).success).toBe(false);
  });

  it('refuses an order outside an integer column', () => {
    expect(UpdateCategoryRequestSchema.safeParse({ setParent: false, sortOrder: -1 }).success).toBe(false);
    expect(UpdateCategoryRequestSchema.safeParse({ setParent: false, sortOrder: 2_147_483_648 }).success).toBe(false);
    expect(UpdateCategoryRequestSchema.safeParse({ setParent: false, sortOrder: 1.5 }).success).toBe(false);
  });
});

describe('showing and hiding', () => {
  it('is its own request, and states the state explicitly', () => {
    expect(CategoryStateRequestSchema.parse({ isActive: true })).toEqual({ isActive: true });
    expect(CategoryStateRequestSchema.safeParse({}).success).toBe(false);
    expect(CategoryStateRequestSchema.safeParse({ isActive: true, slug: 'x' }).success).toBe(false);
  });
});

describe('writing a locale', () => {
  it('requires a name, because the column is not null', () => {
    expect(SaveCategoryTranslationRequestSchema.safeParse({}).success).toBe(false);
    expect(SaveCategoryTranslationRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(SaveCategoryTranslationRequestSchema.parse({ name: 'Furniture' }).name).toBe('Furniture');
  });

  it('holds every field to the length its own constraint sets', () => {
    expect(CATEGORY_NAME_MAX).toBe(120);
    expect(CATEGORY_META_TITLE_MAX).toBe(70);
    expect(CATEGORY_META_DESCRIPTION_MAX).toBe(320);

    expect(SaveCategoryTranslationRequestSchema.safeParse({ name: 'x'.repeat(120) }).success).toBe(true);
    expect(SaveCategoryTranslationRequestSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(SaveCategoryTranslationRequestSchema.safeParse({ name: 'n', metaTitle: 'x'.repeat(70) }).success).toBe(true);
    expect(SaveCategoryTranslationRequestSchema.safeParse({ name: 'n', metaTitle: 'x'.repeat(71) }).success).toBe(false);
    expect(SaveCategoryTranslationRequestSchema.safeParse({ name: 'n', metaDescription: 'x'.repeat(320) }).success).toBe(true);
    expect(SaveCategoryTranslationRequestSchema.safeParse({ name: 'n', metaDescription: 'x'.repeat(321) }).success).toBe(false);
  });

  it('accepts an empty optional field, which is how a value is cleared', () => {
    const parsed = SaveCategoryTranslationRequestSchema.parse({
      name: 'Furniture',
      description: '',
      metaTitle: '',
      metaDescription: '',
    });
    expect(parsed.description).toBe('');
  });

  it('accepts nothing it was not given a field for', () => {
    expect(SaveCategoryTranslationRequestSchema.safeParse({ name: 'n', localeCode: 'en' }).success).toBe(false);
  });

  it('reads back a stored translation with its nulls intact', () => {
    const translation = AdminCategoryTranslationSchema.parse({
      localeCode: 'ar',
      name: 'أثاث',
      description: null,
      metaTitle: null,
      metaDescription: null,
      updatedAt: '2026-05-02T09:00:00.000Z',
    });
    expect(translation.metaTitle).toBeNull();
  });
});
