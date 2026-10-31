import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { SettingsScreen } from './settings-screen';

export const metadata = { title: 'Configuración' };

export default async function ConfiguracionPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.tenant) redirect('/onboarding/negocio');

  const perms = new Set(me.tenant.permissions);
  if (!perms.has('settings.manage')) {
    return (
      <EmptyState
        title="No tienes acceso a la configuración"
        description="La configuración del negocio la administra el propietario o alguien con permiso de ajustes."
      />
    );
  }

  return (
    <SettingsScreen
      tenant={{
        id: me.tenant.id,
        name: me.tenant.name,
        slug: me.tenant.slug,
        role: me.tenant.role,
      }}
      canManageTeam={perms.has('team.manage')}
    />
  );
}
