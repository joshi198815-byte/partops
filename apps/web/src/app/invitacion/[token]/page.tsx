import { PartOpsLogo } from '@partops/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getMe, serverFetch } from '@/lib/session';
import { Accept } from './accept';

export const metadata: Metadata = { title: 'Invitación' };

interface InvitationPreview {
  email: string;
  status: string;
  expiresAt: string;
  state: 'VALIDA' | 'VENCIDA' | 'USADA';
  tenant: { name: string; slug: string; logoUrl: string | null };
}

/**
 * Entrada por invitación.
 *
 * La vista previa es pública a propósito: la persona tiene que ver de qué bodega se trata antes de
 * crear una cuenta. Lo que no se muestra es nada del negocio más allá del nombre.
 *
 * Se resuelve en el servidor si hay sesión y si el correo coincide, porque son tres pantallas
 * distintas: canjear, entrar con la cuenta correcta, o crear la cuenta. Mandar a alguien a "aceptar"
 * cuando no tiene sesión solo produce un 401 que parece un error del sistema.
 */
export default async function InvitacionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [res, me] = await Promise.all([
    serverFetch(`/api/invitations/${encodeURIComponent(token)}`),
    getMe(),
  ]);
  const invitation = res.ok ? ((await res.json()) as InvitationPreview) : null;
  const sessionEmail = me?.user.email.toLowerCase() ?? null;
  const invitedEmail = invitation?.email.toLowerCase() ?? null;

  return (
    <div className="grid min-h-dvh place-items-center bg-[var(--background)] px-5 py-10">
      <div className="w-full max-w-[420px]">
        <Link href="/" className="mb-8 inline-flex">
          <PartOpsLogo size={20} />
        </Link>

        {!invitation ? (
          <Card
            title="Esta invitación no existe"
            body="Puede que el enlace esté incompleto o que la invitación se haya cancelado. Pide uno nuevo a quien te invitó."
          />
        ) : invitation.state === 'USADA' ? (
          <Card
            title="Esta invitación ya se usó"
            body={`Si ya formas parte de ${invitation.tenant.name}, entra con tu cuenta. Si no, pide una invitación nueva.`}
          />
        ) : invitation.state === 'VENCIDA' ? (
          <Card
            title="Esta invitación venció"
            body={`Las invitaciones duran siete días. Pide a quien te invitó a ${invitation.tenant.name} que te mande otra.`}
          />
        ) : !sessionEmail ? (
          <Card
            title={`Te invitaron a ${invitation.tenant.name}`}
            body={`La invitación es para ${invitation.email}. Entra con ese correo o crea tu cuenta con él.`}
            primary={{ href: `/entrar?next=${encodeURIComponent(`/invitacion/${token}`)}`, label: 'Entrar' }}
            secondary={{
              href: `/registro?next=${encodeURIComponent(`/invitacion/${token}`)}`,
              label: 'Crear cuenta',
            }}
          />
        ) : sessionEmail !== invitedEmail ? (
          <Card
            title="Esa invitación es para otro correo"
            body={`Entraste como ${me?.user.email}, pero la invitación es para ${invitation.email}. Sal y entra con ese correo; no se puede aceptar por otra persona.`}
            primary={{ href: '/entrar', label: 'Entrar con otro correo' }}
          />
        ) : (
          <Accept token={token} invitation={invitation} />
        )}
      </div>
    </div>
  );
}

function Card({
  title,
  body,
  primary,
  secondary,
}: {
  title: string;
  body: string;
  primary?: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-6">
      <h1 className="font-[family-name:var(--font-display)] text-[21px] font-bold tracking-[-0.015em] text-[var(--foreground)]">
        {title}
      </h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">{body}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href={(primary?.href ?? '/entrar') as never}
          className="rounded-[var(--radius-sm)] bg-[var(--primary)] px-4 py-2 text-[13px] font-medium text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]"
        >
          {primary?.label ?? 'Ir a entrar'}
        </Link>
        {secondary ? (
          <Link
            href={secondary.href as never}
            className="text-[13px] font-medium text-[var(--color-copper-700)] hover:underline"
          >
            {secondary.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
