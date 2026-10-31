'use client';

import { useCallback, useState } from 'react';
import { ApiError, errorMessage, fieldErrors } from './api';

/**
 * Estado de un formulario que habla con la API.
 *
 * Distingue tres cosas que suelen confundirse: si está enviando, el mensaje general del error y
 * el error de cada campo. El servidor manda los dos y el formulario los pinta donde tocan, así
 * nadie tiene que adivinar a qué campo se refiere "datos inválidos".
 */
export function useSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  const run = useCallback(async (fn: () => Promise<void>) => {
    setPending(true);
    setError(null);
    setIssues({});
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      setIssues(fieldErrors(err));
      // Un error de sesión no se arregla corrigiendo el formulario: se manda a entrar de nuevo.
      if (err instanceof ApiError && err.status === 401 && typeof window !== 'undefined') {
        window.location.href = '/entrar';
      }
      return false;
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, error, issues, run, setError };
}

/** Errores de un `safeParse` de Zod, con la misma forma que los del servidor. */
export function zodIssues(result: {
  success: boolean;
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) {
  const out: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    const key = issue.path.map(String).join('.') || '(raíz)';
    out[key] ??= issue.message;
  }
  return out;
}
