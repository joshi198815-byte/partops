import type { MeResponse } from '@partops/contracts';
import { cookies } from 'next/headers';

/**
 * Sesión leída en el servidor.
 *
 * El layout necesita saber quién entra y si el negocio ya está configurado ANTES de pintar nada:
 * así el vendedor no ve un parpadeo de "no tienes acceso" mientras carga, y el asistente de alta
 * no se muestra a un negocio que terminó el mes pasado.
 *
 * Se llama a la API con las cookies del request: el rewrite de Next no existe en el servidor, así
 * que la URL es absoluta y la cabecera `cookie` se copia a mano.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const jar = await cookies();
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      cookie: jar.toString(),
      ...init.headers,
    },
    cache: 'no-store',
  });
}

/** `null` cuando no hay sesión válida: es el caso normal antes de entrar, no un error. */
export async function getMe(): Promise<MeResponse | null> {
  const res = await serverFetch('/api/me');
  if (!res.ok) return null;
  return (await res.json()) as MeResponse;
}

/** Igual que `getMe` pero sin tragarse los fallos del servidor: un 500 no debe parecer "sin sesión". */
export async function requireMe(): Promise<MeResponse> {
  const res = await serverFetch('/api/me');
  if (res.status === 401) return Promise.reject(new Error('UNAUTHENTICATED'));
  if (!res.ok) throw new Error(`La API respondió ${res.status} al pedir la sesión`);
  return (await res.json()) as MeResponse;
}
