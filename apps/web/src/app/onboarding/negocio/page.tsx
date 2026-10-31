'use client';

import { isReservedSlug, normalizeGtPhone, normalizeNit, slugify, suggestSlug } from '@partops/contracts';
import { Alert, Field, Input, TextArea } from '@partops/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useSubmit } from '@/lib/use-submit';
import { StepActions, StepHeading } from '../_components/step';

/**
 * Paso 1 — el negocio.
 *
 * El slug se previsualiza mientras se escribe el nombre porque es la dirección del catálogo
 * público y cambiarla después rompe los enlaces que ya se compartieron por WhatsApp. Se muestra
 * como URL completa, no como campo abstracto: el dueño ve exactamente qué va a decir su enlace.
 */
export default function NegocioPage() {
  const router = useRouter();
  const { pending, error, issues, run } = useSubmit();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [legalName, setLegalName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [address, setAddress] = useState('');

  const effectiveSlug = slugTouched ? slug : suggestSlug(name || '');
  const slugProblem = useMemo(() => {
    if (!effectiveSlug) return null;
    if (effectiveSlug.length < 3) return 'Al menos 3 caracteres';
    if (isReservedSlug(effectiveSlug)) return 'Esa dirección está reservada';
    return null;
  }, [effectiveSlug]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      await api('/api/onboarding/negocio', {
        method: 'POST',
        body: {
          name: name.trim(),
          slug: slugTouched ? slugify(slug) : undefined,
          legalName: legalName.trim() || undefined,
          taxId: taxId.trim() ? (normalizeNit(taxId) ?? taxId.trim()) : undefined,
          phone: phone.trim() ? (normalizeGtPhone(phone) ?? phone.trim()) : undefined,
          whatsapp: whatsapp.trim() ? (normalizeGtPhone(whatsapp) ?? whatsapp.trim()) : undefined,
          address: address.trim() || undefined,
        },
      });
    });
    if (!ok) return;
    router.push('/onboarding/bodega');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <StepHeading
        step="Paso 1"
        title="¿Cómo se llama tu negocio?"
        body="Es lo que ve el cliente en el recibo. El resto lo puedes completar después."
      />

      {error ? (
        <Alert tone="error" className="mb-5">
          {error}
        </Alert>
      ) : null}

      <div className="space-y-4">
        <Field label="Nombre del negocio" htmlFor="name" required error={issues.name}>
          <Input
            id="name"
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Repuestos El Tornillo"
          />
        </Field>

        <Field
          label="Dirección web"
          htmlFor="slug"
          hint="Se puede cambiar"
          error={slugProblem ?? issues.slug}
        >
          <div className="flex items-stretch">
            <span className="flex items-center rounded-l-[var(--radius-sm)] border border-r-0 border-[var(--border-strong)] bg-[var(--surface-sunken)] px-2.5 font-mono text-[12px] text-[var(--foreground-muted)]">
              partops.autos/
            </span>
            <Input
              id="slug"
              className="rounded-l-none font-mono"
              value={slugTouched ? slug : effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
              }}
              invalid={Boolean(slugProblem)}
              placeholder="repuestos-el-tornillo"
            />
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Razón social" htmlFor="legalName" hint="Opcional" error={issues.legalName}>
            <Input
              id="legalName"
              maxLength={160}
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Repuestos El Tornillo, S.A."
            />
          </Field>

          <Field label="NIT" htmlFor="taxId" hint="Opcional" error={issues.taxId}>
            <Input
              id="taxId"
              inputMode="text"
              autoCapitalize="characters"
              maxLength={12}
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
              placeholder="1234567-8"
            />
          </Field>

          <Field label="Teléfono" htmlFor="phone" hint="8 dígitos" error={issues.phone}>
            <Input
              id="phone"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="5555-1234"
            />
          </Field>

          <Field label="WhatsApp" htmlFor="whatsapp" hint="Para los recibos" error={issues.whatsapp}>
            <Input
              id="whatsapp"
              inputMode="tel"
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
              placeholder="5555-1234"
            />
          </Field>
        </div>

        <Field label="Dirección" htmlFor="address" hint="Opcional" error={issues.address}>
          <TextArea
            id="address"
            maxLength={240}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="3a. calle 12-45, zona 9, Ciudad de Guatemala"
          />
        </Field>
      </div>

      <StepActions pending={pending} label="Guardar y seguir" />
    </form>
  );
}
