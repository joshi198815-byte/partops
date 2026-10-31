'use client';

import { DEFAULT_ROLES, emailSchema } from '@partops/contracts';
import { Alert, Button, Field, Input, Select } from '@partops/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSubmit } from '@/lib/use-submit';
import { StepActions, StepHeading } from '../_components/step';

/**
 * Paso 4 — el equipo.
 *
 * Se puede saltar: una bodega donde trabaja una sola persona es el caso más común. Las filas se
 * agregan de una en una porque cada invitación es un correo real con un enlace de siete días, y
 * un formulario de "diez correos separados por comas" invita a equivocarse en el segundo.
 *
 * Nadie se crea aquí con contraseña: la persona invitada elige la suya al abrir el enlace. Así el
 * dueño nunca conoce la clave de un empleado.
 */
export default function EquipoPage() {
  const router = useRouter();
  const { pending, error, issues, run } = useSubmit();

  const [rows, setRows] = useState<Array<{ id: string; email: string; roleKey: string }>>([
    { id: 'invite-1', email: '', roleKey: 'vendedor' },
  ]);
  const [nextId, setNextId] = useState(2);
  const [result, setResult] = useState<{
    invited: string[];
    skipped: Array<{ email: string; reason: string }>;
  } | null>(null);

  const roles = DEFAULT_ROLES.filter((r) => r.key !== 'propietario');

  function update(index: number, patch: Partial<{ email: string; roleKey: string }>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function finish(invites: Array<{ email: string; roleKey: string }>) {
    const ok = await run(async () => {
      const res = await api<{
        invited: string[];
        skipped: Array<{ email: string; reason: string }>;
      }>('/api/onboarding/equipo', { method: 'POST', body: { invites } });
      setResult(res);
    });
    if (!ok) return;
    // El alta terminó; `/me` ya no trae onboarding y el layout del asistente dejará pasar.
    router.refresh();
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const filled = rows.filter((r) => r.email.trim());
    const valid = filled.every((r) => emailSchema.safeParse(r.email).success);
    if (!valid) {
      await run(async () => {
        throw new Error('Revisa los correos: hay uno que no se ve bien');
      });
      return;
    }
    await finish(filled);
  }

  if (result) {
    return (
      <>
        <StepHeading
          step="Listo"
          title="Tu bodega ya está en PartOps"
          body="Lo que sigue es cargar el catálogo. Puedes importar tu Excel actual sin capturar nada de nuevo."
        />
        {result.invited.length ? (
          <Alert tone="success" title={`${result.invited.length} invitación(es) enviada(s)`}>
            Cada persona recibió un enlace de siete días para crear su cuenta. Las ves en Equipo mientras
            estén pendientes.
          </Alert>
        ) : null}
        {result.skipped.length ? (
          <Alert tone="error" className="mt-3" title="Estas no se pudieron invitar">
            <ul className="mt-1 space-y-0.5">
              {result.skipped.map((s) => (
                <li key={s.email}>
                  {s.email} —{' '}
                  {s.reason === 'YA_ES_MIEMBRO'
                    ? 'ya trabaja contigo'
                    : s.reason === 'INVITACION_PENDIENTE'
                      ? 'ya tiene una invitación pendiente'
                      : 'ese rol no existe'}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <div className="mt-7 border-t border-[var(--border)] pt-5">
          <Button
            size="lg"
            onClick={() => {
              router.replace('/app' as never);
              router.refresh();
            }}
          >
            Ir al tablero
          </Button>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <StepHeading
        step="Paso 4"
        title="¿Quién más trabaja contigo?"
        body="Invita a tus vendedores y bodegueros. Cada uno recibe un correo y entra con su propia cuenta; tú nunca ves su contraseña."
      />

      {error ? (
        <Alert tone="error" className="mb-5">
          {error}
        </Alert>
      ) : null}

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={row.id} className="grid gap-2 sm:grid-cols-[1.6fr_0.9fr_auto] sm:items-start">
            <Field
              label={i === 0 ? 'Correo' : ''}
              htmlFor={`email-${i}`}
              error={issues[`invites.${i}.email`]}
            >
              <Input
                id={`email-${i}`}
                type="email"
                inputMode="email"
                value={row.email}
                onChange={(e) => update(i, { email: e.target.value })}
                placeholder="vendedor@bodega.gt"
              />
            </Field>
            <Field label={i === 0 ? 'Rol' : ''} htmlFor={`role-${i}`}>
              <Select
                id={`role-${i}`}
                value={row.roleKey}
                onChange={(e) => update(i, { roleKey: e.target.value })}
              >
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className={i === 0 ? 'sm:pt-[26px]' : ''}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Quitar ${row.email || 'fila'}`}
                disabled={rows.length === 1}
                onClick={() => setRows((current) => current.filter((_, j) => j !== i))}
              >
                Quitar
              </Button>
            </div>
          </div>
        ))}
      </div>

      {rows.length < 10 ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => {
            setRows((current) => [...current, { id: `invite-${nextId}`, email: '', roleKey: 'vendedor' }]);
            setNextId((n) => n + 1);
          }}
        >
          Agregar otra persona
        </Button>
      ) : null}

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--foreground-muted)]">
        Los roles base se pueden ajustar después en Equipo, y puedes crear roles propios con los permisos que
        necesites.
      </p>

      <StepActions
        pending={pending}
        label="Enviar invitaciones y terminar"
        onSkip={() => void finish([])}
        skipLabel="Terminar sin invitar"
      />
    </form>
  );
}
