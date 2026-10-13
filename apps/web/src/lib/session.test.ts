/** `authProvider`: el acceso `dev` es opt-in explícito y falla cerrado en producción. */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('@tcl-kol-os/db', () => ({ findUserById: vi.fn() }));

import { authProvider } from './session.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

function entorno(authProviderValue: string | undefined, nodeEnv: string): void {
  vi.stubEnv('NODE_ENV', nodeEnv);
  if (authProviderValue === undefined) vi.stubEnv('AUTH_PROVIDER', '');
  else vi.stubEnv('AUTH_PROVIDER', authProviderValue);
  if (authProviderValue === undefined) delete process.env['AUTH_PROVIDER'];
}

describe('authProvider', () => {
  it.each(['development', 'test', 'production'])(
    'AUTH_PROVIDER=dev es dev con NODE_ENV=%s (opt-in)',
    (nodeEnv) => {
      entorno('dev', nodeEnv);
      expect(authProvider()).toBe('dev');
    },
  );

  it.each(['development', 'test', 'production'])('AUTH_PROVIDER=oidc es oidc con NODE_ENV=%s', (nodeEnv) => {
    entorno('oidc', nodeEnv);
    expect(authProvider()).toBe('oidc');
  });

  it.each(['development', 'test'])('sin definir cae a dev fuera de producción (%s)', (nodeEnv) => {
    entorno(undefined, nodeEnv);
    expect(authProvider()).toBe('dev');
  });

  it('sin definir en producción cae a oidc (login dev rechazado)', () => {
    entorno(undefined, 'production');
    expect(authProvider()).toBe('oidc');
  });

  it('un valor desconocido en producción tampoco habilita dev', () => {
    entorno('cualquiera', 'production');
    expect(authProvider()).toBe('oidc');
    entorno('', 'production');
    expect(authProvider()).toBe('oidc');
  });
});
