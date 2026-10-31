'use client';

import { Field, Input } from '@partops/ui';
import { useState } from 'react';
import { api, errorMessage, fieldErrors } from '@/lib/api';

/**
 * "Avísame cuando llegue".
 *
 * Dos campos y nada más. Cada campo extra en una pantalla de teléfono cuesta envíos, y aquí el
 * cliente ya decidió que quiere la pieza: lo único que falta es un número al que escribirle. El
 * nombre va porque una lista de avisos sin nombre es una lista de números a la que nadie se atreve
 * a escribir.
 *
 * Se manda la variante cuando existe —es lo que la bodega va a reponer— y el texto de la búsqueda
 * cuando no: en el catálogo público, la mitad de la demanda llega por una búsqueda sin resultado y
 * esa persona merece el mismo aviso que la que llegó a una ficha agotada.
 */
export function StockWatchForm({
  slug,
  variantId,
  partId,
  q,
  compact,
}: {
  slug: string;
  variantId?: string;
  partId?: string;
  q?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(!compact);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<'new' | 'exists' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setIssues({});
    try {
      const res = await api<{ ok: boolean; already?: boolean }>(
        `/api/public/catalog/${encodeURIComponent(slug)}/watch`,
        {
          method: 'POST',
          body: { name, phone, variantId, partId, q },
        },
      );
      setDone(res.already ? 'exists' : 'new');
    } catch (err) {
      setError(errorMessage(err));
      setIssues(fieldErrors(err));
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p
        role="status"
        className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-[12px] leading-snug"
      >
        {done === 'exists'
          ? 'Ya teníamos tu aviso para esta pieza. Te escribimos en cuanto llegue.'
          : 'Anotado. La bodega te escribe por WhatsApp en cuanto llegue la pieza.'}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 text-[12.5px] font-medium hover:bg-[var(--surface-sunken)]"
      >
        Avísame cuando llegue
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--border)] p-3"
    >
      <p className="text-[12px] leading-snug text-[var(--foreground-muted)]">
        Déjanos tu nombre y teléfono. Te escribimos por WhatsApp en cuanto entre la pieza.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Nombre" htmlFor="watch-name" error={issues.name} required>
          <Input
            id="watch-name"
            value={name}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
            className="h-10"
          />
        </Field>
        <Field label="Teléfono" htmlFor="watch-phone" error={issues.phone} required>
          <Input
            id="watch-phone"
            value={phone}
            inputMode="tel"
            autoComplete="tel"
            placeholder="5555-1234"
            onChange={(e) => setPhone(e.target.value)}
            className="partops-num h-10"
          />
        </Field>
      </div>
      {error ? <p className="text-[12px] text-[var(--color-stock-out)]">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="h-10 w-full rounded-[var(--radius-sm)] bg-[var(--shop-primary)] px-3 text-[13px] font-semibold disabled:opacity-50"
        style={{ color: 'var(--shop-on-primary)' }}
      >
        {pending ? 'Anotando…' : 'Avisarme cuando llegue'}
      </button>
    </form>
  );
}
