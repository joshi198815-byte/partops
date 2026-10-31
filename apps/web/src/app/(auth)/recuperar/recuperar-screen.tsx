'use client';

import { emailSchema, passwordSchema } from '@partops/contracts';
import { Alert, Button, Field, Input } from '@partops/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { requestPasswordReset, resetPassword } from '@/lib/auth';
import { useSubmit } from '@/lib/use-submit';

/**
 * Recuperación en una sola pantalla.
 *
 * Si el enlace trae token, se pide la contraseña nueva; si no, se pide el correo. Son dos estados
 * del mismo trámite y mantenerlos en la misma ruta evita un salto extra y un enlace de correo que
 * puede quedar apuntando a una pantalla que ya no existe.
 */
export function RecuperarScreen({ token }: { token: string | null }) {
  return token ? <NewPassword token={token} /> : <RequestLink />;
}

function RequestLink() {
  const { pending, error, run } = useSubmit();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

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
      await requestPasswordReset(parsed.data);
    });
    if (ok) setSent(true);
  }

  if (sent) {
    return (
      <>
        <h1 className="font-[family-name:var(--font-display)] text-[24px] font-bold tracking-[-0.02em] text-[var(--foreground)]">
          Revisa tu correo
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
          Si existe una cuenta con <span className="font-medium text-[var(--foreground)]">{email}</span>, ya
          va en camino un enlace para restablecer la contraseña. Vence en una hora.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button variant="secondary" onClick={() => setSent(false)}>
            Pedir otro enlace
          </Button>
          <Link
            href="/entrar"
            className="text-center text-[13px] font-medium text-[var(--color-copper-700)] hover:underline"
          >
            Volver a entrar
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-[26px] font-bold tracking-[-0.02em] text-[var(--foreground)]">
        Recuperar acceso
      </h1>
      <p className="mt-1.5 text-[13px] text-[var(--foreground-muted)]">
        Te mandamos un enlace para elegir una contraseña nueva.
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

        <Button type="submit" size="lg" fullWidth loading={pending}>
          Mandar enlace
        </Button>
      </form>

      <Link
        href="/entrar"
        className="mt-6 block text-[13px] font-medium text-[var(--color-copper-700)] hover:underline"
      >
        Volver a entrar
      </Link>
    </>
  );
}

function NewPassword({ token }: { token: string }) {
  const router = useRouter();
  const { pending, error, run } = useSubmit();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      await run(async () => {
        throw new Error('Las dos contraseñas no coinciden');
      });
      return;
    }
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      await run(async () => {
        throw new Error(parsed.error.issues[0]?.message ?? 'Contraseña no válida');
      });
      return;
    }
    const ok = await run(async () => {
      await resetPassword({ token, newPassword: parsed.data });
    });
    if (ok) setDone(true);
  }

  if (done) {
    return (
      <>
        <h1 className="font-[family-name:var(--font-display)] text-[24px] font-bold text-[var(--foreground)]">
          Contraseña cambiada
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
          Ya puedes entrar con tu contraseña nueva. Las demás sesiones abiertas quedaron cerradas.
        </p>
        <Button
          className="mt-6"
          fullWidth
          size="lg"
          onClick={() => {
            router.replace('/entrar');
            router.refresh();
          }}
        >
          Entrar
        </Button>
      </>
    );
  }

  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-[26px] font-bold tracking-[-0.02em] text-[var(--foreground)]">
        Contraseña nueva
      </h1>
      <p className="mt-1.5 text-[13px] text-[var(--foreground-muted)]">
        Al guardarla se cierran las demás sesiones abiertas con la contraseña anterior.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}

        <Field label="Contraseña nueva" htmlFor="password" required hint="8 caracteres o más">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <Field label="Repítela" htmlFor="confirm" required>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>

        <Button type="submit" size="lg" fullWidth loading={pending}>
          Guardar contraseña
        </Button>
      </form>
    </>
  );
}
