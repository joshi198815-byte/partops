import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { requireMe } from '@/lib/session';

export const metadata = { title: 'PartOps' };

/**
 * Layout de la aplicación.
 *
 * Tres puertas antes de pintar: sin sesión va a entrar; con contraseña temporal va a cambiarla;
 * sin negocio configurado va al asistente. Se resuelven en el servidor para que no haya un
 * parpadeo de contenido que la persona no debería ver.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (me.user.mustChangePassword) redirect('/cambiar-clave');
  if (!me.tenant) redirect((me.onboarding?.nextPath ?? '/onboarding/negocio') as never);

  return <AppShell me={me}>{children}</AppShell>;
}
