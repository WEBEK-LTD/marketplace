// ESLint (owner decision E4, Phase 1 Step 9): ESLint 10.9.1 with typescript-eslint 8.69.0,
// @next/eslint-plugin-next 16.3.4 and eslint-plugin-react-hooks 7.1.1 only.
// eslint-config-next and eslint-plugin-react are intentionally not used.
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.netlify/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
      '**/test-results/**',
      '**/playwright-report/**',
      'supabase/.temp/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Names starting with "_" are intentionally unused (for example interface parameters).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/admin/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/admin/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: ['apps/web/', 'apps/admin/'] } },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs['core-web-vitals'].rules },
  },
);
