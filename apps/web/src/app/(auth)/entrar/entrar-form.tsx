'use client';

import { emailSchema } from '@partops/contracts';
import { Alert, Button, Field, Input } from '@partops/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { signIn } from '@/lib/auth';
import { useSubmit } from '@/lib/use-submit';

/**
 * Formulario de entrada.
 *
 * El destino posterior (`next`) llega como prop desde el servidor en vez de leerse con
 * `useSearchParams`: así la página se puede renderizar sin suspenso y sin esperar a que hidrate
 * para saber a dónde va.
 */
export function EntrarForm({ next }: { next: string | null }) {
  const router = useRouter();
  const { pending, error, run } = useSubmit();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      await run(async () => {
        throw new Error(parsed.error.issues[0]?.message ?? 'Escribe un correo válido');
      });
      return;
    }

    const ok = await run(async () => {
      await signIn({ email: parsed.data, password });
    });
    if (!ok) return;

    // El destino final depende de si falta onboarding, y eso solo lo sabe el servidor.
    const me = await api<{ homePath: string }>('/api/me').catch(() => null);
    router.replace((next ?? me?.homePath ?? '/app') as never);
    router.refresh();
  }

  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-[26px] font-bold tracking-[-0.02em] text-[var(--foreground)]">
        Entrar
      </h1>
      <p className="mt-1.5 text-[13px] text-[var(--foreground-muted)]">
        Usa el correo con el que te registraste o con el que te invitaron.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}

        <Field label="Correo" htmlFor="email" required>
          <Input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="dueno@bodega.gt"
          />
        </Field>

        <Field
          label="Contraseña"
          htmlFor="password"
          required
          hint={
            <Link
              href="/recuperar"
              className="underline-offset-2 hover:text-[var(--foreground)] hover:underline"
            >
              ¿La olvidaste?
            </Link>
          }
        >
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" size="lg" fullWidth loading={pending}>
          Entrar
        </Button>
      </form>

      <p className="mt-6 text-[13px] text-[var(--foreground-muted)]">
        ¿Todavía no tienes cuenta?{' '}
        <Link href="/registro" className="font-medium text-[var(--color-copper-700)] hover:underline">
          Crear una
        </Link>
      </p>
    </>
  );
}
