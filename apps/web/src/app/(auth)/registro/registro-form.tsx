'use client';

import { emailSchema, passwordSchema } from '@partops/contracts';
import { Alert, Button, Field, Input } from '@partops/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { signUp } from '@/lib/auth';
import { useSubmit } from '@/lib/use-submit';

export function RegistroForm({ next }: { next: string | null }) {
  const router = useRouter();
  const { pending, error, issues, run } = useSubmit();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    const parsedEmail = emailSchema.safeParse(email);
    const parsedPassword = passwordSchema.safeParse(password);
    const parsedName = name.trim().length >= 2;
    if (!parsedName || !parsedEmail.success || !parsedPassword.success || password !== confirm) {
      await run(async () => {
        throw new Error(
          password !== confirm
            ? 'Las dos contraseñas no coinciden'
            : !parsedName
              ? 'Escribe tu nombre'
              : (parsedEmail.error?.issues[0]?.message ?? parsedPassword.error?.issues[0]?.message),
        );
      });
      return;
    }

    const ok = await run(async () => {
      await signUp({ name: name.trim(), email: parsedEmail.data, password: parsedPassword.data });
    });
    if (!ok) return;

    // Con `next` (una invitación) se vuelve ahí; sin él, al asistente de alta.
    const me = next ? null : await api<{ homePath: string }>('/api/me').catch(() => null);
    router.replace((next ?? me?.homePath ?? '/onboarding/negocio') as never);
    router.refresh();
  }

  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-[26px] font-bold tracking-[-0.02em] text-[var(--foreground)]">
        Crear cuenta
      </h1>
      <p className="mt-1.5 text-[13px] text-[var(--foreground-muted)]">
        Después configuras tu bodega en cuatro pasos cortos. Puedes dejarlo a medias y volver.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}

        <Field label="Tu nombre" htmlFor="name" required error={issues.name}>
          <Input
            id="name"
            autoComplete="name"
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ana López"
          />
        </Field>

        <Field label="Correo" htmlFor="email" required error={issues.email}>
          <Input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
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
          hint="8 caracteres o más"
          error={issues.password}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </Field>

        <Field label="Repite la contraseña" htmlFor="confirm" required>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" size="lg" fullWidth loading={pending}>
          Crear cuenta
        </Button>
      </form>

      <p className="mt-6 text-[13px] text-[var(--foreground-muted)]">
        ¿Ya tienes cuenta?{' '}
        <Link href="/entrar" className="font-medium text-[var(--color-copper-700)] hover:underline">
          Entrar
        </Link>
      </p>
    </>
  );
}
