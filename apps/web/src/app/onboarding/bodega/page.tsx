'use client';

import { normalizeGtPhone } from '@partops/contracts';
import { Alert, Checkbox, Field, Input, TextArea } from '@partops/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSubmit } from '@/lib/use-submit';
import { StepActions, StepHeading } from '../_components/step';

/**
 * Paso 2 — la primera bodega.
 *
 * El código es lo que se grita en el pasillo ("está en la B1"), así que se limita a seis
 * caracteres y se sugiere solo. La dirección y el teléfono son opcionales: la bodega ya existe en
 * la cabeza del dueño, esto solo la nombra en el sistema.
 */
export default function BodegaPage() {
  const router = useRouter();
  const { pending, error, issues, run } = useSubmit();

  const [name, setName] = useState('Bodega Central');
  const [code, setCode] = useState('B1');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [sellsOnline, setSellsOnline] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      await api('/api/onboarding/bodega', {
        method: 'POST',
        body: {
          name: name.trim(),
          code: code.trim() ? code.trim().toUpperCase() : undefined,
          address: address.trim() || undefined,
          phone: phone.trim() ? (normalizeGtPhone(phone) ?? phone.trim()) : undefined,
          sellsOnline,
        },
      });
    });
    if (!ok) return;
    router.push('/onboarding/impuestos');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <StepHeading
        step="Paso 2"
        title="Tu primera bodega"
        body="La bodega es el lugar físico donde están las piezas. Si vendes desde el mostrador, esa es tu bodega."
      />

      {error ? (
        <Alert tone="error" className="mb-5">
          {error}
        </Alert>
      ) : null}

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1.6fr_0.7fr]">
          <Field label="Nombre de la bodega" htmlFor="name" required error={issues.name}>
            <Input
              id="name"
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Bodega Central"
            />
          </Field>

          <Field label="Código" htmlFor="code" hint="Se grita en el pasillo" error={issues.code}>
            <Input
              id="code"
              className="font-mono uppercase"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              placeholder="B1"
            />
          </Field>
        </div>

        <Field label="Dirección" htmlFor="address" hint="Opcional" error={issues.address}>
          <TextArea
            id="address"
            maxLength={240}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Bodega trasera, 12 avenida 4-12, zona 1"
          />
        </Field>

        <Field label="Teléfono de la bodega" htmlFor="phone" hint="Opcional" error={issues.phone}>
          <Input
            id="phone"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="5555-1234"
          />
        </Field>

        <Checkbox
          checked={sellsOnline}
          onChange={(e) => setSellsOnline(e.target.checked)}
          label="Esta bodega despacha pedidos del catálogo público"
          description="Si lo dejas apagado, las piezas igual se buscan y se venden desde el mostrador. El catálogo público se activa cuando tú quieras."
        />
      </div>

      <StepActions pending={pending} label="Guardar y seguir" />
    </form>
  );
}
