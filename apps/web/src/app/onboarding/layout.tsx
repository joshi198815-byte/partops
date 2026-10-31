import { PartOpsLogo, Stepper } from '@partops/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';

export const metadata = { title: 'Configura tu bodega' };

/** Los cuatro pasos en el orden en que el servidor los exige. */
const STEPS = [
  { key: 'business', label: 'Negocio' },
  { key: 'warehouse', label: 'Bodega' },
  { key: 'tax', label: 'Impuestos' },
  { key: 'team', label: 'Equipo' },
];

/**
 * Marco del asistente.
 *
 * El progreso viene del servidor (`/me.onboarding`), no de un estado local ni de la URL: si alguien
 * escribe `/onboarding/impuestos` sin bodega, aquí se le manda al paso que de verdad toca. El
 * servidor es el único que sabe qué existe en la base.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  // Terminó el alta: el asistente no debe volver a aparecer ni por un enlace guardado.
  if (!me.onboarding) redirect(me.homePath as never);
  if (me.user.mustChangePassword) redirect('/cambiar-clave');

  const done = Object.values(me.onboarding.steps).filter(Boolean).length;

  return (
    <div className="min-h-dvh bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-5">
          <Link href="/" className="shrink-0">
            <PartOpsLogo size={18} />
          </Link>
          <span className="partops-num hidden font-mono text-[11px] text-[var(--foreground-muted)] sm:inline">
            {done} de 4
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-5 py-8 sm:py-12">
        <Stepper steps={STEPS} current={done} className="mb-8" />
        {children}
      </div>
    </div>
  );
}
