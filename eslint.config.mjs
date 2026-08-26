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

  // Scripts de línea de comandos: `console` ES su interfaz de usuario, no una
  // traza olvidada. La prohibición existe para el código de servidor, donde
  // los logs deben ser estructurados y llevar requestId (Épica E12-3).
  {
    files: ['packages/db/src/migrate.ts', 'packages/db/src/seed.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Archivos de configuración: corren en Node, fuera del bundle.
  {
    files: ['*.config.mjs', '*.config.ts', '**/next.config.mjs'],
    languageOptions: {
      globals: { process: 'readonly', __dirname: 'readonly' },
    },
  },

  // scripts/: herramientas de línea de comandos en Node, fuera del bundle.
  // `console` ES su interfaz de usuario (mismo motivo que migrate.ts/seed.ts).
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
