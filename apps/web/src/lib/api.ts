/**
 * Cliente HTTP de la web.
 *
 * **Por defecto todo va por `/api/*` en el mismo origen**: Next reescribe hacia la API (ver
 * `next.config.mjs`). Así la cookie de sesión viaja sola, sin CORS, y el navegador no necesita saber
 * en qué host vive el backend. Este camino sigue siendo el respaldo cuando
 * `NEXT_PUBLIC_API_URL` está vacía, que es lo que pasa en desarrollo.
 *
 * Cuando `NEXT_PUBLIC_API_URL` tiene valor (`https://api.partops.autos` en producción), las llamadas
 * van **directo a la API** con `credentials: 'include'`. Eso saca la CPU de la web (0.1 CPU) del
 * camino caliente: buscar una pieza ya no consume un proceso de Next para hacer de proxy. Requiere
 * que la API ponga la cookie en `.partops.autos`; si no, el login se pierde en la pantalla
 * siguiente.
 */

/** Origen de la API. Vacío = mismo origen por el rewrite. Se resuelve al construir. */
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');

/** ¿Las llamadas salen del dominio de la web? Cambia `credentials` y el destino. */
export const CROSS_ORIGIN_API = API_BASE !== '';

/** Une la base con la ruta sin duplicar `/api`: el llamador siempre pasa `/api/...`. */
export function apiUrl(path: string): string {
  if (!API_BASE) return path;
  return path.startsWith('/') ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
}

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly issues: ApiIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

async function throwFromResponse(res: Response): Promise<never> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Un proxy o un error 502 puede devolver HTML: el mensaje útil es el estado, no el parseo.
    data = null;
  }
  const body = (data ?? {}) as { code?: string; message?: string; issues?: ApiIssue[] };
  throw new ApiError(
    res.status,
    body.code,
    body.message ?? 'No se pudo completar la operación',
    body.issues ?? [],
  );
}

/**
 * Subida de archivos.
 *
 * No se usa `api` porque ahí el cuerpo se serializa a JSON y aquí tiene que ser `FormData` con su
 * `boundary`: poner el `content-type` a mano rompe el parseo del multipart en el servidor.
 */
export async function apiUpload<T>(path: string, file: File, field = 'file'): Promise<T> {
  const form = new FormData();
  form.append(field, file);

  const res = await fetch(apiUrl(path), {
    method: 'POST',
    body: form,
    credentials: CROSS_ORIGIN_API ? 'include' : 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) await throwFromResponse(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers } = options;

  const res = await fetch(apiUrl(path), {
    method,
    // Con API en otro origen, `include` es lo que manda la cookie de `.partops.autos`. Con el
    // rewrite, `same-origin` basta y evita mandar cookies a rutas que no las necesitan.
    credentials: CROSS_ORIGIN_API ? 'include' : 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });

  if (res.status === 204) return undefined as T;
  if (!res.ok) await throwFromResponse(res);
  return (await res.json()) as T;
}

/** Errores por campo, con la ruta tal como la manda el servidor (`phone`, `invites.0.email`). */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[issue.path] = issue.message;
  return out;
}

/** Mensaje para mostrar arriba del formulario. Nunca se enseña un `[object Object]` al usuario. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Algo salió mal. Intenta de nuevo.';
}
