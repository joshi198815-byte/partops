'use client';

import { formatGtPhone } from '@partops/contracts';
import { Alert, Button, Checkbox, CodeChip, Field, Input } from '@partops/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useSubmit } from '@/lib/use-submit';

interface Settings {
  name: string;
  slug: string;
  legalName: string | null;
  taxId: string | null;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  taxRateBps: number;
  pricesIncludeTax: boolean;
  catalogEnabled: boolean;
  catalogTagline: string | null;
}

/**
 * Configuración del negocio.
 *
 * Dos formularios que se guardan por separado porque se tocan en momentos distintos: la identidad
 * cuando algo cambia de nombre, los impuestos cuando el contador pregunta. El slug se muestra como
 * dato fijo: es la dirección del catálogo y ya se compartió por WhatsApp.
 */
export function SettingsScreen({
  tenant,
  canManageTeam,
}: {
  tenant: { id: string; name: string; slug: string; role: string };
  canManageTeam: boolean;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<Settings>('/api/settings')
      .then(setSettings)
      .catch((err) => setLoadError(errorMessage(err)));
  }, []);

  if (loadError) {
    return (
      <Alert tone="error" title="No se pudo cargar la configuración">
        {loadError}
      </Alert>
    );
  }
  if (!settings) return <p className="text-[13px] text-[var(--foreground-muted)]">Cargando…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
          Configuración
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-[var(--foreground-muted)]">
          Tu rol: <span className="font-medium text-[var(--foreground)]">{tenant.role}</span>
          <CodeChip>partops.gt/{settings.slug}</CodeChip>
        </p>
      </header>

      <Identity settings={settings} onSaved={setSettings} />
      <Taxes settings={settings} onSaved={setSettings} />
      <PublicCatalog settings={settings} onSaved={setSettings} />

      <p className="text-[12px] leading-relaxed text-[var(--foreground-muted)]">
        {canManageTeam
          ? 'Los roles, las invitaciones y las bodegas asignadas están en '
          : 'Para cambiar roles o invitar gente, pide a un propietario que entre a '}
        <Link href="/app/equipo" className="font-medium text-[var(--color-copper-700)] hover:underline">
          Equipo
        </Link>
        .
      </p>
    </div>
  );
}

function Identity({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const { pending, error, run } = useSubmit();
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    name: settings.name,
    legalName: settings.legalName ?? '',
    taxId: settings.taxId ?? '',
    phone: settings.phone ?? '',
    whatsapp: settings.whatsapp ?? '',
    address: settings.address ?? '',
  });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      const next = await api<Settings>('/api/settings', {
        method: 'PATCH',
        body: {
          name: form.name.trim(),
          legalName: form.legalName.trim(),
          taxId: form.taxId.trim(),
          phone: form.phone.trim(),
          whatsapp: form.whatsapp.trim(),
          address: form.address.trim(),
        },
      });
      onSaved(next);
    });
    setSaved(ok);
  }

  return (
    <form onSubmit={save} noValidate>
      <SectionTitle id="negocio" title="Negocio" />
      <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {saved ? <Alert tone="success">Datos del negocio guardados.</Alert> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nombre" htmlFor="name" required>
            <Input
              id="name"
              required
              maxLength={80}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label="Razón social" htmlFor="legalName">
            <Input
              id="legalName"
              maxLength={160}
              value={form.legalName}
              onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
            />
          </Field>
          <Field label="NIT" htmlFor="taxId">
            <Input
              id="taxId"
              maxLength={12}
              value={form.taxId}
              onChange={(e) => setForm((f) => ({ ...f, taxId: e.target.value }))}
            />
          </Field>
          <Field
            label="WhatsApp"
            htmlFor="whatsapp"
            hint={formatGtPhone(settings.whatsapp) || 'Sin registrar'}
          >
            <Input
              id="whatsapp"
              inputMode="tel"
              value={form.whatsapp}
              onChange={(e) => setForm((f) => ({ ...f, whatsapp: e.target.value }))}
              placeholder="5555-1234"
            />
          </Field>
          <Field label="Dirección" htmlFor="address" className="sm:col-span-2">
            <Input
              id="address"
              maxLength={240}
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            />
          </Field>
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Guardar
          </Button>
        </div>
      </div>
    </form>
  );
}

function Taxes({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const { pending, error, run } = useSubmit();
  const [saved, setSaved] = useState(false);
  const [pricesIncludeTax, setPricesIncludeTax] = useState(settings.pricesIncludeTax);
  const [taxRateBps, setTaxRateBps] = useState(settings.taxRateBps);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      const next = await api<Settings>('/api/settings', {
        method: 'PATCH',
        body: { pricesIncludeTax, taxRateBps },
      });
      onSaved(next);
    });
    setSaved(ok);
  }

  return (
    <form onSubmit={save} noValidate>
      <SectionTitle id="impuestos" title="Impuestos" />
      <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {saved ? <Alert tone="success">Impuestos guardados. Aplica a las ventas nuevas.</Alert> : null}

        <Checkbox
          label="Los precios ya incluyen IVA"
          description="Si lo desmarcas, el IVA se suma al cobrar. Las ventas ya hechas conservan su desglose: no se recalculan."
          checked={pricesIncludeTax}
          onChange={(e) => {
            setPricesIncludeTax(e.target.checked);
            setSaved(false);
          }}
        />

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Tasa" htmlFor="rate" className="w-32">
            <select
              id="rate"
              value={taxRateBps}
              onChange={(e) => {
                setTaxRateBps(Number(e.target.value));
                setSaved(false);
              }}
              className="h-11 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[14px]"
            >
              <option value={1200}>12 %</option>
              <option value={500}>5 %</option>
              <option value={0}>Exento</option>
            </select>
          </Field>
          <Button type="submit" loading={pending}>
            Guardar impuestos
          </Button>
        </div>
      </div>
    </form>
  );
}

function PublicCatalog({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const { pending, error, run } = useSubmit();
  const [enabled, setEnabled] = useState(settings.catalogEnabled);
  const [tagline, setTagline] = useState(settings.catalogTagline ?? '');

  async function toggle(next: boolean) {
    setEnabled(next);
    const ok = await run(async () => {
      const updated = await api<Settings>('/api/settings', {
        method: 'PATCH',
        body: { catalogEnabled: next },
      });
      onSaved(updated);
    });
    if (!ok) setEnabled(!next);
  }

  async function saveTagline(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      const updated = await api<Settings>('/api/settings', {
        method: 'PATCH',
        body: { catalogTagline: tagline.trim() || null },
      });
      onSaved(updated);
    });
  }

  return (
    <section aria-labelledby="catalogo">
      <SectionTitle id="catalogo" title="Catálogo público" />
      <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Checkbox
          label="Publicar mi catálogo en el enlace del negocio"
          description={`Los clientes verán piezas y precios en partops.gt/${settings.slug}. La existencia se muestra como disponibilidad, nunca como el número exacto.`}
          checked={enabled}
          disabled={pending}
          onChange={(e) => void toggle(e.target.checked)}
        />

        <form onSubmit={(e) => void saveTagline(e)} className="mt-3 space-y-2">
          <Field label="Frase de la portada" htmlFor="catalog-tagline" hint={`${tagline.length}/120`}>
            <Input
              id="catalog-tagline"
              value={tagline}
              maxLength={120}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Repuestos para tu carro, el mismo día"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" size="sm" loading={pending}>
              Guardar frase
            </Button>
            {enabled ? (
              <a
                href={`/c/${encodeURIComponent(settings.slug)}`}
                target="_blank"
                rel="noreferrer"
                className="text-[12.5px] text-[var(--color-copper-700)] hover:underline"
              >
                Ver mi catálogo →
              </a>
            ) : (
              <span className="text-[12px] text-[var(--foreground-muted)]">
                Publícalo para compartir el enlace.
              </span>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}

function SectionTitle({ id, title }: { id: string; title: string }) {
  return (
    <h2
      id={id}
      className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
    >
      {title}
    </h2>
  );
}
