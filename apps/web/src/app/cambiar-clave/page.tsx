'use client';

import { passwordSchema } from '@partops/contracts';
import { Alert, Button, Field, Input } from '@partops/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { changePassword } from '@/lib/auth';
import { useSubmit } from '@/lib/use-submit';

/**
 * Cambio obligatorio de la contraseña temporal.
 *
 * Es la pantalla que se abre cuando el dueño dicta una clave por teléfono. Hasta cambiarla, el
 * guard rechaza todo lo demás: quien conoce la clave dictada no puede operar el negocio. Se puede
 * salir de la sesión, porque un empleado que ya no trabaja ahí no debe quedar atorado.
 */
export default function CambiarClavePage() {
  const router = useRouter();
  const { pending, error, run } = useSubmit();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (next !== confirm) {
      await run(async () => {
        throw new Error('Las dos contraseñas nuevas no coinciden');
      });
      return;
    }
    const parsed = passwordSchema.safeParse(next);
    if (!parsed.success) {
      await run(async () => {
        throw new Error(parsed.error.issues[0]?.message ?? 'Contraseña no válida');
      });
      return;
    }
    const ok = await run(async () => {
      await changePassword({ currentPassword: current, newPassword: parsed.data });
    });
    if (!ok) return;
    router.replace('/app' as never);
    router.refresh();
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-[var(--background)] px-5 py-10">
      <div className="w-full max-w-[400px]">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-copper-700)]">
          Contraseña temporal
        </p>
        <h1 className="mt-1.5 font-[family-name:var(--font-display)] text-[24px] font-bold leading-tight tracking-[-0.02em] text-[var(--foreground)]">
          Elige tu propia contraseña
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
          Entraste con una contraseña que alguien más conoce. Cámbiala para poder usar el sistema; las demás
          sesiones de esa clave se cierran.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          {error ? <Alert tone="error">{error}</Alert> : null}

          <Field label="Contraseña actual" htmlFor="current" required>
            <Input
              id="current"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>

          <Field label="Contraseña nueva" htmlFor="next" required hint="8 caracteres o más">
            <Input
              id="next"
              type="password"
              autoComplete="new-password"
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
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
            Guardar y continuar
          </Button>
        </form>

        <Link
          href="/entrar"
          className="mt-6 block text-center text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
        >
          Salir de esta cuenta
        </Link>
      </div>
    </div>
  );
}
