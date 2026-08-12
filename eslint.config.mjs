import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'docs/**',
      // Skills instaladas por herramientas externas: no son código del proyecto.
      '.agents/**',
      '.claude/**',
      // Generado por Next.js en cada build.
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // §11.6: no exponer trazas internas. `console` se reemplaza por logs
      // estructurados con requestId (Épica E12-3).
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ── ADR-008 ────────────────────────────────────────────────────────────────
  // `packages/domain` no importa nada de `apps/` ni de `services/`.
  // La dependencia es unidireccional: las transiciones de estado y las reglas de
  // permiso tienen UNA sola implementación, y vive en el dominio.
  //
  // Sin esta regla, una validación corregida en la interfaz y olvidada en el
  // worker produce estados inválidos persistidos.
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/**', '@tcl-kol-os/web', '**/services/**'],
              message:
                'ADR-008: packages/domain no puede depender de apps/ ni de services/. La dependencia es unidireccional.',
            },
          ],
        },
      ],
    },
  },

  // Las pruebas pueden ser más laxas con los tipos auxiliares.
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
