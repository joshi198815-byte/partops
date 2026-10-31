import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';

/** `/onboarding` sin paso: se manda al que toca según la base. */
export default async function OnboardingIndex() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  redirect((me.onboarding?.nextPath ?? me.homePath) as never);
}
