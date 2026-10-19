import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['client/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: reactHooks.configs.flat.recommended.rules,
  },
  {
    files: [
      'server/**/*.ts',
      'desktop/**/*.{ts,cjs,mjs}',
      'scripts/**/*.{cjs,mjs}',
      '*.config.{js,ts}',
      'eslint.config.js',
    ],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Electron preload is intentionally CommonJS so Electron can load it before ESM.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
