'use client';

import { Alert, Button } from '@partops/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSubmit } from '@/lib/use-submit';

/**
 * Canje de la invitación.
 *
 * Hay tres caminos y el servidor decide cuál aplica: con sesión del correo invitado se entra
 * directo; sin sesión, se manda a crear la cuenta o a entrar y se vuelve aquí. El correo se
 * compara en el servidor: si alguien reenvía el enlace por WhatsApp, no sirve con otra cuenta.
 */
export function Accept({
  token,
  invitation,
}: {
  token: string;
  invitation: { email: string; tenant: { name: string; logoUrl: string | null } };
}) {
  const router = useRouter();
  const { pending, error, run } = useSubmit();
  const [done, setDone] = useState(false);
  const next = `/invitacion/${token}`;

  async function accept() {
    const ok = await run(async () => {
      await api('/api/invitations/accept', { method: 'POST', body: { token } });
    });
    if (!ok) return;
    setDone(true);
    router.refresh();
    // `/me` ya sabe cuál es el negocio activo tras aceptar; se deja que el servidor decida la ruta.
    const me = await api<{ homePath: string }>('/api/me').catch(() => null);
    router.replace((me?.homePath ?? '/app') as never);
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--color-copper-700)]">
        Invitación
      </p>
      <h1 className="mt-1.5 font-[family-name:var(--font-display)] text-[22px] font-bold leading-tight tracking-[-0.015em] text-[var(--foreground)]">
        Te invitaron a {invitation.tenant.name}
      </h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
        La invitación es para <span className="font-medium text-[var(--foreground)]">{invitation.email}</span>
        . Tienes que entrar con ese mismo correo.
      </p>

      {error ? (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      ) : null}

      <div className="mt-5 flex flex-col gap-2">
        <Button size="lg" fullWidth loading={pending} disabled={done} onClick={accept}>
          Aceptar y entrar
        </Button>
        <div className="flex items-center justify-between text-[12.5px] text-[var(--foreground-muted)]">
          <Link href={`/entrar?next=${encodeURIComponent(next)}`} className="hover:underline">
            Entrar con otra cuenta
          </Link>
          <Link
            href={`/registro?next=${encodeURIComponent(next)}`}
            className="font-medium text-[var(--color-copper-700)] hover:underline"
          >
            Crear cuenta
          </Link>
        </div>
      </div>
    </div>
  );
}
