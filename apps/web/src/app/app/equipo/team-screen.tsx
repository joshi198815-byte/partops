'use client';

import { createRoleSchema, inviteMemberSchema, PERMISSION_GROUPS, type Permission } from '@partops/contracts';
import { Alert, Button, Checkbox, CodeChip, EmptyState, Field, Input, Select } from '@partops/ui';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useSubmit } from '@/lib/use-submit';

/**
 * Equipo y roles.
 *
 * La pantalla está construida alrededor de tres verdades del servidor y las respeta en vez de
 * repetirlas: no puedes cambiar tu propio rol, no puedes desactivarte, y el negocio no puede
 * quedarse sin propietario. Los controles que llevarían a esos errores se deshabilitan con el
 * motivo escrito, en lugar de dejar que la persona los pulse y reciba un 400.
 */

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  roleKey: string;
  roleName: string;
  warehouseIds: string[];
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
}

interface Warehouse {
  id: string;
  code: string;
  name: string;
}

interface Invitation {
  id: string;
  email: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  roleKey: string;
  roleName: string;
  invitedByName: string;
}

interface TeamData {
  members: Member[];
  roles: Role[];
  warehouses: Warehouse[];
  invitations: Invitation[];
  ownerCount: number;
}

export function TeamScreen({ currentUserId }: { currentUserId: string }) {
  const [data, setData] = useState<TeamData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await api<TeamData>('/api/team'));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError) {
    return (
      <Alert tone="error" title="No se pudo cargar el equipo">
        {loadError}
      </Alert>
    );
  }
  if (!data) {
    return <p className="text-[13px] text-[var(--foreground-muted)]">Cargando equipo…</p>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
          Equipo
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--foreground-muted)]">
          Quién entra, con qué rol y a qué bodegas. Los permisos se aplican en el servidor en cada petición:
          quitarle una bodega a alguien surte efecto en su siguiente clic.
        </p>
      </header>

      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Members
        data={data}
        currentUserId={currentUserId}
        onChanged={async (message) => {
          await reload();
          setNotice(message ?? null);
        }}
      />
      <Invitations data={data} onChanged={reload} />
      <Roles data={data} onChanged={reload} />
    </div>
  );
}

function Members({
  data,
  currentUserId,
  onChanged,
}: {
  data: TeamData;
  currentUserId: string;
  onChanged: (message?: string) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function patch(member: Member, body: Record<string, unknown>, message: string) {
    setBusyId(member.id);
    setError(null);
    try {
      await api(`/api/team/members/${member.id}`, { method: 'PATCH', body });
      await onChanged(message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(member: Member) {
    if (!window.confirm(`¿Quitar a ${member.name} del negocio? Su cuenta sigue existiendo.`)) return;
    setBusyId(member.id);
    setError(null);
    try {
      await api(`/api/team/members/${member.id}`, { method: 'DELETE' });
      await onChanged(`${member.name} ya no forma parte del negocio`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="miembros">
      <div className="mb-3 flex items-end justify-between gap-3">
        <h2
          id="miembros"
          className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
        >
          Personas ({data.members.filter((m) => m.isActive).length} activas)
        </h2>
        <span className="partops-num text-[11.5px] text-[var(--foreground-muted)]">
          {data.ownerCount} propietario{data.ownerCount === 1 ? '' : 's'}
        </span>
      </div>

      {error ? (
        <Alert tone="error" className="mb-3">
          {error}
        </Alert>
      ) : null}

      <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
        <table className="w-full border-collapse text-left">
          <thead className="bg-[var(--surface-sunken)]">
            <tr className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
              <th className="px-3 py-2 font-semibold">Persona</th>
              <th className="px-3 py-2 font-semibold">Rol</th>
              <th className="px-3 py-2 font-semibold">Bodegas</th>
              <th className="px-3 py-2 font-semibold">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((member) => {
              const isSelf = member.userId === currentUserId;
              const isLastOwner = member.roleKey === 'propietario' && data.ownerCount <= 1;
              const busy = busyId === member.id;
              return (
                <tr
                  key={member.id}
                  className={`border-t border-[var(--border)] text-[13px] ${member.isActive ? '' : 'opacity-55'}`}
                >
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-[var(--foreground)]">
                      {member.name}
                      {isSelf ? (
                        <span className="ml-1.5 text-[10.5px] font-normal uppercase tracking-wide text-[var(--color-copper-700)]">
                          tú
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate font-mono text-[11px] text-[var(--foreground-muted)]">
                      {member.email}
                    </p>
                    {!member.isActive ? (
                      <p className="mt-0.5 text-[11px] text-[var(--color-stock-out)]">Desactivado</p>
                    ) : null}
                  </td>

                  <td className="px-3 py-2.5">
                    <Select
                      aria-label={`Rol de ${member.name}`}
                      className="h-9 py-0 text-[12.5px]"
                      value={member.roleKey}
                      disabled={busy || isSelf || isLastOwner}
                      title={
                        isSelf
                          ? 'No puedes cambiar tu propio rol'
                          : isLastOwner
                            ? 'Es el único propietario del negocio'
                            : undefined
                      }
                      onChange={(e) => {
                        const role = data.roles.find((r) => r.key === e.target.value);
                        void patch(
                          member,
                          { roleKey: e.target.value },
                          `Rol de ${member.name}: ${role?.name}`,
                        );
                      }}
                    >
                      {data.roles.map((role) => (
                        <option key={role.key} value={role.key}>
                          {role.name}
                        </option>
                      ))}
                    </Select>
                  </td>

                  <td className="px-3 py-2.5">
                    {member.warehouseIds.length === 0 ? (
                      <span className="text-[12px] text-[var(--foreground-muted)]">Todas</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {member.warehouseIds.map((id) => {
                          const w = data.warehouses.find((x) => x.id === id);
                          return w ? <CodeChip key={id}>{w.code}</CodeChip> : null;
                        })}
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || isSelf || isLastOwner}
                        title={
                          isSelf
                            ? 'No puedes desactivarte'
                            : isLastOwner
                              ? 'Es el único propietario del negocio'
                              : undefined
                        }
                        onClick={() =>
                          void patch(
                            member,
                            { isActive: !member.isActive },
                            member.isActive
                              ? `${member.name} quedó desactivado`
                              : `${member.name} vuelve a entrar`,
                          )
                        }
                      >
                        {member.isActive ? 'Desactivar' : 'Reactivar'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || isSelf || isLastOwner}
                        onClick={() => void remove(member)}
                      >
                        Quitar
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Invitations({ data, onChanged }: { data: TeamData; onChanged: () => Promise<void> }) {
  const { pending, error, issues, runValue, setError } = useSubmit();
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('vendedor');
  const [warehouseIds, setWarehouseIds] = useState<string[]>([]);
  /**
   * Resultado del último envío. `delivered: false` significa que la invitación **existe** pero el
   * correo no salió (servidor con `MAIL_PROVIDER=log`). Decir "enviada" ahí dejaría a la persona
   * esperando un correo que no va a llegar, así que se ofrece el enlace para compartirlo a mano.
   */
  const [sent, setSent] = useState<{
    email: string;
    delivered: boolean;
    url: string;
  } | null>(null);
  /**
   * Resultado de reenviar. Antes el `catch` se tragaba el error y el botón parecía no hacer nada:
   * quien reenviaba no sabía si el correo salió. Ahora se dice, con la misma distinción que al
   * invitar (enviado vs. enlace para compartir a mano).
   */
  const [resend, setResend] = useState<{ email: string; delivered: boolean; url: string } | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    const parsed = inviteMemberSchema.safeParse({ email, roleKey, warehouseIds });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa los datos');
      return;
    }
    const result = await runValue(async () =>
      api<{ delivered: boolean; url: string }>('/api/team/invitations', {
        method: 'POST',
        body: parsed.data,
      }),
    );
    if (!result) return;
    setSent({ email, delivered: result.delivered, url: result.url });
    setEmail('');
    await onChanged();
  }

  /** Copiar sin `navigator.clipboard` (http sin TLS lo bloquea): el texto queda seleccionable. */
  function copy(url: string) {
    void navigator.clipboard?.writeText(url);
  }

  async function resendInvitation(inv: Invitation) {
    setResendError(null);
    try {
      const result = await api<{ delivered: boolean; url: string }>(
        `/api/team/invitations/${inv.id}/resend`,
        { method: 'POST', body: {} },
      );
      setResend({ email: inv.email, delivered: result.delivered, url: result.url });
      await onChanged();
    } catch (err) {
      setResendError(`${inv.email}: ${errorMessage(err)}`);
    }
  }

  return (
    <section aria-labelledby="invitar">
      <h2
        id="invitar"
        className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
      >
        Invitar
      </h2>

      <form
        onSubmit={invite}
        className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4"
        noValidate
      >
        {error ? (
          <Alert tone="error" className="mb-3">
            {error}
          </Alert>
        ) : null}
        {sent ? (
          <div
            className="mb-3 rounded-[var(--radius-sm)] border border-[var(--border)] border-l-2 bg-[var(--surface)] px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--foreground)]"
            style={{
              borderLeftColor: sent.delivered ? 'var(--color-stock-ok)' : 'var(--color-stock-low)',
            }}
            role="status"
          >
            {sent.delivered ? (
              <p>
                Invitación enviada a <span className="font-semibold">{sent.email}</span>. Vence en siete días
                y se puede reenviar desde la lista.
              </p>
            ) : (
              <>
                <p className="font-semibold">La invitación quedó creada, pero el correo no salió.</p>
                <p className="mt-1 text-[var(--foreground-muted)]">
                  Este servidor no tiene correo configurado. Comparte el enlace con {sent.email} por WhatsApp
                  o en mano: funciona igual y vence en siete días.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-[var(--radius-xs)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 font-mono text-[11px]">
                    {sent.url}
                  </code>
                  <Button size="sm" variant="secondary" onClick={() => copy(sent.url)}>
                    Copiar enlace
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-[1.5fr_0.9fr_auto] sm:items-end">
          <Field label="Correo" htmlFor="invite-email" error={issues.email}>
            <Input
              id="invite-email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vendedor@bodega.gt"
            />
          </Field>
          <Field label="Rol" htmlFor="invite-role">
            <Select id="invite-role" value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
              {data.roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" loading={pending}>
            Invitar
          </Button>
        </div>

        {data.warehouses.length > 1 ? (
          <div className="mt-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
              Bodegas {warehouseIds.length === 0 ? '(todas)' : ''}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {data.warehouses.map((w) => {
                const checked = warehouseIds.includes(w.id);
                return (
                  <label
                    key={w.id}
                    className={`cursor-pointer rounded-[var(--radius-xs)] border px-2 py-1 text-[12px] ${
                      checked
                        ? 'border-[var(--color-copper-600)] bg-[var(--color-copper-100)]/40'
                        : 'border-[var(--border)] text-[var(--foreground-muted)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() =>
                        setWarehouseIds((ids) => (checked ? ids.filter((id) => id !== w.id) : [...ids, w.id]))
                      }
                    />
                    <span className="font-mono">{w.code}</span> {w.name}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
      </form>

      {resendError ? (
        <Alert tone="error" className="mt-3">
          {resendError}
        </Alert>
      ) : null}
      {resend ? (
        <div
          className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border)] border-l-2 bg-[var(--surface)] px-3 py-2.5 text-[12.5px] leading-relaxed"
          style={{ borderLeftColor: resend.delivered ? 'var(--color-stock-ok)' : 'var(--color-stock-low)' }}
          role="status"
        >
          {resend.delivered ? (
            <p>
              Reenviada a <span className="font-semibold">{resend.email}</span>. El enlace es el mismo de
              antes: si ya lo había compartido, sigue sirviendo.
            </p>
          ) : (
            <>
              <p className="font-semibold">El enlace sigue vigente, pero el correo no salió.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-[var(--radius-xs)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 font-mono text-[11px]">
                  {resend.url}
                </code>
                <Button size="sm" variant="secondary" onClick={() => copy(resend.url)}>
                  Copiar enlace
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {data.invitations.length ? (
        <ul className="mt-3 divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
          {data.invitations.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-wrap items-center justify-between gap-2 bg-[var(--surface)] px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-[12px] text-[var(--foreground)]">{inv.email}</p>
                <p className="text-[11px] text-[var(--foreground-muted)]">
                  {inv.roleName} · invita {inv.invitedByName} · vence{' '}
                  {new Date(inv.expiresAt).toLocaleDateString('es-GT', { day: 'numeric', month: 'short' })}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const url = `${window.location.origin}/invitacion/${inv.token}`;
                    void navigator.clipboard?.writeText(url);
                  }}
                >
                  Copiar enlace
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void resendInvitation(inv)}>
                  Reenviar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api(`/api/team/invitations/${inv.id}`, { method: 'DELETE' }).catch(() => undefined);
                    await onChanged();
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Roles({ data, onChanged }: { data: TeamData; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section aria-labelledby="roles">
      <div className="mb-3 flex items-end justify-between gap-3">
        <h2
          id="roles"
          className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
        >
          Roles y permisos
        </h2>
        <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
          Crear rol
        </Button>
      </div>

      {error ? (
        <Alert tone="error" className="mb-3">
          {error}
        </Alert>
      ) : null}

      <ul className="grid gap-2 sm:grid-cols-2">
        {data.roles.map((role) => {
          const count = data.members.filter((m) => m.roleKey === role.key).length;
          return (
            <li
              key={role.id}
              className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-[var(--foreground)]">{role.name}</p>
                  <p className="mt-0.5 text-[12px] leading-snug text-[var(--foreground-muted)]">
                    {role.description ?? 'Rol propio del negocio'}
                  </p>
                </div>
                <span className="partops-num shrink-0 rounded-[var(--radius-xs)] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--foreground-muted)]">
                  {count}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-[var(--foreground-muted)]">
                  {role.permissions.length} permiso{role.permissions.length === 1 ? '' : 's'}
                  {role.isSystem ? ' · rol base' : ''}
                </span>
                {role.isSystem ? (
                  <span className="text-[11px] text-[var(--foreground-muted)]">No editable</span>
                ) : (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(role)}>
                      Editar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const target = window.prompt(
                          '¿A qué rol se mueve el equipo que tiene este rol? Escribe la clave, por ejemplo: vendedor',
                          'vendedor',
                        );
                        if (!target) return;
                        try {
                          await api(`/api/team/roles/${role.id}`, {
                            method: 'DELETE',
                            body: { moveToRoleKey: target.trim() },
                          });
                          await onChanged();
                        } catch (err) {
                          setError(errorMessage(err));
                        }
                      }}
                    >
                      Eliminar
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {creating || editing ? (
        <RoleEditor
          role={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Editor de permisos agrupado por área del producto.
 *
 * Se muestran todos los permisos existentes, con su descripción en español, no una lista de
 * claves técnicas: quien crea el rol es el dueño del negocio, no un programador.
 */
function RoleEditor({
  role,
  onClose,
  onSaved,
}: {
  role: Role | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? []);
  const { pending, error, run } = useSubmit();

  const groups = Object.entries(PERMISSION_GROUPS) as Array<
    [string, { label: string; permissions: Record<string, string> }]
  >;

  function toggle(permission: string) {
    setSelected((current) =>
      current.includes(permission) ? current.filter((p) => p !== permission) : [...current, permission],
    );
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const parsed = createRoleSchema.safeParse({
      name,
      description: description || undefined,
      permissions: selected,
    });
    if (!parsed.success) {
      await run(async () => {
        throw new Error(parsed.error.issues[0]?.message ?? 'Revisa el rol');
      });
      return;
    }
    const ok = await run(async () => {
      if (role) {
        await api(`/api/team/roles/${role.id}`, { method: 'PATCH', body: parsed.data });
      } else {
        await api('/api/team/roles', { method: 'POST', body: parsed.data });
      }
    });
    if (ok) await onSaved();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="role-editor-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <form
        onSubmit={save}
        className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] sm:rounded-[var(--radius-lg)]"
        noValidate
      >
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h3 id="role-editor-title" className="text-[15px] font-semibold text-[var(--foreground)]">
            {role ? `Editar ${role.name}` : 'Nuevo rol'}
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--foreground-muted)]">
            Elige qué puede hacer. El cambio aplica en el siguiente clic de cada persona con este rol.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {error ? <Alert tone="error">{error}</Alert> : null}

          <Field label="Nombre" htmlFor="role-name" required>
            <Input
              id="role-name"
              required
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Descripción" htmlFor="role-desc" hint="Opcional">
            <Input
              id="role-desc"
              maxLength={160}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Cajero de mostrador"
            />
          </Field>

          <div className="space-y-3">
            {groups.map(([key, group]) => (
              <fieldset key={key}>
                <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
                  {group.label}
                </legend>
                <div className="space-y-1">
                  {Object.entries(group.permissions).map(([permission, label]) => (
                    <Checkbox
                      key={permission}
                      label={label}
                      checked={selected.includes(permission)}
                      onChange={() => toggle(permission as Permission)}
                      className="border-transparent p-1.5 hover:bg-[var(--surface-sunken)]"
                    />
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-3">
          <span className="text-[11.5px] text-[var(--foreground-muted)]">
            {selected.length} seleccionados
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={pending}>
              Guardar rol
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

/** Estado vacío cuando el usuario no tiene `team.manage`: la ruta existe pero no se abre. */
export function NoAccess() {
  return (
    <EmptyState
      title="No tienes acceso a esta sección"
      description="El equipo y los roles los administra un propietario o alguien con permiso de equipo."
    />
  );
}
