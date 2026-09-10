/**
 * Lint configuration.
 *
 * The rule set is deliberately opinionated about the things that cause real
 * defects in an extension: floating promises (a dropped `await` silently loses
 * an error), unchecked `any` crossing the VS Code API boundary, and implicit
 * boolean coercion of values that may legitimately be empty strings or zero.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'media/dist/**',
      'media/engine/**',
      'node_modules/**',
      'vendor/**',
      // A downloaded VS Code build lives here during integration testing. It is
      // hundreds of megabytes of JavaScript, and letting ESLint walk into it
      // exhausts the heap.
      '.vscode-test/**',
      '.git/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* Correctness */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      /* Style that carries meaning */
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false },
      ],
    },
  },
  {
    /* Build scripts and the integration harness are plain Node JavaScript and
       belong to no tsconfig, so every rule that needs type information is
       switched off for them. */
    files: ['**/*.mjs', '**/*.cjs'],
    // These belong to no tsconfig. Asking the project service to adopt them
    // makes it build an enormous inferred program and run out of heap, so
    // project lookup is switched off for them entirely.
    languageOptions: { parserOptions: { projectService: false, project: false } },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
      'no-undef': 'off',
      'no-empty': 'off',
      // The integration harness runs inside the VS Code extension host, which
      // is CommonJS; `require` is the only way to reach the `vscode` module.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
);
