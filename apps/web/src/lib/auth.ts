import { api } from './api';

/**
 * Llamadas a Better Auth.
 *
 * Se usan los endpoints HTTP directos en vez de su cliente de React: son cuatro formularios y así
 * la web no arrastra un paquete más ni una capa que oculte qué se manda. El contrato es el mismo
 * que documenta Better Auth, y el puente de la API ya lo cubre con pruebas.
 */

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
}

export async function signUp(input: SignUpInput): Promise<void> {
  await api('/api/auth/sign-up/email', { method: 'POST', body: input });
}

export async function signIn(input: {
  email: string;
  password: string;
  rememberMe?: boolean;
}): Promise<void> {
  await api('/api/auth/sign-in/email', { method: 'POST', body: input });
}

export async function signOut(): Promise<void> {
  await api('/api/auth/sign-out', { method: 'POST', body: {} });
}

/** Siempre responde igual exista o no la cuenta: no se confirma qué correos están registrados. */
export async function requestPasswordReset(email: string): Promise<void> {
  await api('/api/auth/request-password-reset', {
    method: 'POST',
    body: { email, redirectTo: '/recuperar' },
  });
}

export async function resetPassword(input: { token: string; newPassword: string }): Promise<void> {
  await api('/api/auth/reset-password', { method: 'POST', body: input });
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}): Promise<void> {
  await api('/api/auth/change-password', {
    method: 'POST',
    body: { revokeOtherSessions: true, ...input },
  });
}
