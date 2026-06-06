import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

const files = ['**/*.{js,ts,tsx}'];

const disabledRules = {
  'no-unused-vars': 'off',
  'no-empty': 'off',
  'no-empty-pattern': 'off',
  'no-undef': 'off',
  'no-mixed-spaces-and-tabs': 'off',
  'no-control-regex': 'off',
  'no-constant-condition': 'off',
  'no-extra-boolean-cast': 'off',
  'no-extra-semi': 'off',
  'no-redeclare': 'off',
  'no-inner-declarations': 'off',
  'no-useless-catch': 'off',
  'no-unreachable': 'off',
  'no-case-declarations': 'off',
  'no-useless-escape': 'off',
  'no-prototype-builtins': 'off',
  'require-yield': 'off',
  '@typescript-eslint/no-unused-vars': 'off',
  '@typescript-eslint/no-explicit-any': 'off',
};

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'vendor/**',
      'coverage/**',
      '.tmp/**',
      '.tmp-*/**',
      '.tmp-kode-config/**',
      'cli.js',
      'cli-acp.js',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  {
    files,
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...disabledRules,
    },
  },
];
