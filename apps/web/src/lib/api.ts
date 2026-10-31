/**
 * Cliente HTTP de la web.
 *
 * Todo pasa por `/api/*` en el mismo origen: Next reescribe hacia la API (ver `next.config.mjs`).
 * Así la cookie de sesión viaja sola, sin CORS ni `credentials` en cada llamada, y el navegador no
 * necesita saber en qué puerto vive el backend.
 */

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

  const res = await fetch(path, {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) await throwFromResponse(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers } = options;

  const res = await fetch(path, {
    method,
    // Mismo origen, pero explícito: si algún día la web y la API se separan, esto ya está bien.
    credentials: 'same-origin',
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
