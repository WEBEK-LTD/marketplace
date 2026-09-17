import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { AdminDocument } from '../src/components/admin-document';
import { ADMIN_LOCALES, directionFor, resolveAdminLocale } from '../src/i18n/locale';

describe('admin locale', () => {
  it('resolves to English until user profiles exist', async () => {
    await expect(resolveAdminLocale()).resolves.toBe('en');
    expect(ADMIN_LOCALES).toEqual(['en', 'ar']);
  });

  it('has the same message keys in both languages', () => {
    const keys = (value: object, prefix = ''): string[] =>
      Object.entries(value).flatMap(([key, child]) =>
        typeof child === 'object' && child !== null ? keys(child, `${prefix}${key}.`) : [`${prefix}${key}`],
      );
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });

  // Test-only override: the frame is rendered with Arabic explicitly (owner decision 8).
  it('renders Arabic right-to-left when given the Arabic locale', () => {
    const html = renderToStaticMarkup(
      <AdminDocument
        locale="ar"
        labels={{ siteName: ar.Site.name, section: ar.Site.section, skipToContent: ar.Accessibility.skipToContent, copyright: '© 2026 السوق' }}
      >
        <h1>{ar.Home.title}</h1>
      </AdminDocument>,
    );
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('السوق <span class="text-neutral-600">الإدارة</span>');
    expect(html).toContain('<h1>الإدارة</h1>');
    expect(html).toContain('تخطَّ إلى المحتوى');
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('en')).toBe('ltr');
  });
});
