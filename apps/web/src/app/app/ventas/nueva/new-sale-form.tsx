'use client';

import { formatMoney, ORDER_CHANNEL_LABEL, type OrderChannel, type OrderDetail } from '@partops/contracts';
import { Alert, Button, CodeChip, Select } from '@partops/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, fieldErrors } from '@/lib/api';

interface CatalogOption {
  variantId: string;
  partName: string;
  title: string;
  sku: string;
  partNumber: string | null;
  unit: string;
  priceCents: number;
  costCents: number | null;
  available: number;
  binLocation: string | null;
  warehouseId: string | null;
  warehouseCode: string | null;
}

interface Line {
  variantId: string;
  partName: string;
  title: string;
  sku: string;
  unit: string;
  priceCents: number;
  quantity: string;
  available: number;
  warehouseCode: string | null;
}

/**
 * Armar una venta.
 *
 * Tres decisiones de mostrador:
 *
 *  - El buscador muestra el disponible ANTES de agregar. Descubrir que no hay hasta confirmar
 *    obliga a rehacer el pedido delante del cliente.
 *  - Se puede vender lo que no hay: la línea nace "sin stock" y el pedido queda abierto para
 *    conseguirlo. Esconder la pieza hace perder la venta.
 *  - La clave de idempotencia se genera al abrir la pantalla y no cambia en los reintentos: si la
 *    red del mostrador se cae al confirmar, volver a tocar no duplica el pedido.
 */
export function NewSaleForm({ canOverride }: { canOverride: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<CatalogOption[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [channel, setChannel] = useState<OrderChannel>('MOSTRADOR');
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  // Una clave por intento de venta: se reutiliza en cada reintento del mismo carrito.
  const idempotencyKey = useRef<string>(makeKey());

  useEffect(() => {
    // Sin texto no se busca: al agregar una pieza el campo se vacía y pintar todo el catálogo
    // tapa el carrito justo cuando el vendedor va a revisarlo.
    if (!q.trim()) {
      setOptions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, limit: '12' });
        setOptions(await api<CatalogOption[]>(`/api/orders/catalog?${params}`));
      } catch {
        setOptions([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [q]);

  function add(option: CatalogOption) {
    setLines((current) => {
      const existing = current.find(
        (l) => l.variantId === option.variantId && l.warehouseCode === option.warehouseCode,
      );
      if (existing) {
        return current.map((l) => (l === existing ? { ...l, quantity: String(Number(l.quantity) + 1) } : l));
      }
      return [
        ...current,
        {
          variantId: option.variantId,
          partName: option.partName,
          title: option.title,
          sku: option.sku,
          unit: option.unit,
          priceCents: option.priceCents,
          quantity: '1',
          available: option.available,
          warehouseCode: option.warehouseCode,
        },
      ];
    });
    setQ('');
    setOptions([]);
  }

  function setQuantity(variantId: string, value: string) {
    setLines((current) => current.map((l) => (l.variantId === variantId ? { ...l, quantity: value } : l)));
  }

  function setPrice(variantId: string, raw: string) {
    const cents = parseMoney(raw);
    setLines((current) =>
      current.map((l) => (l.variantId === variantId ? { ...l, priceCents: cents ?? l.priceCents } : l)),
    );
  }

  const totalCents = lines.reduce((acc, l) => acc + (Number(l.quantity) || 0) * l.priceCents, 0);
  const missing = lines.filter((l) => (Number(l.quantity) || 0) > l.available);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setIssues({});
    try {
      const order = await api<OrderDetail>('/api/orders', {
        method: 'POST',
        body: {
          customerName: customerName.trim() || undefined,
          customerPhone: customerPhone.trim() || undefined,
          channel,
          notes: notes.trim() || undefined,
          idempotencyKey: idempotencyKey.current,
          items: lines.map((l) => ({
            variantId: l.variantId,
            quantity: Number(l.quantity),
            // Solo se manda el precio si el vendedor lo tocó: mandarlo siempre haría que un cambio
            // de precio en el catálogo dejara de aplicarse a las ventas nuevas.
            unitPriceCents: l.priceCents,
          })),
        },
      });
      router.push(`/app/ventas?pedido=${order.code}` as never);
    } catch (err) {
      // Reintento tras un fallo de red: la clave sigue siendo la misma, así que la API devuelve el
      // pedido ya creado en vez de duplicarlo. Si el segundo intento también falla, se avisa.
      setError(errorMessage(err));
      setIssues(fieldErrors(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-4xl space-y-4">
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
          Nueva venta
        </h1>
        <p className="mt-1 text-[13px] text-[var(--foreground-muted)]">
          Al confirmar se aparta la pieza. Bodega la prepara y la entrega contra el pedido.
        </p>
      </header>

      <section className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
              Cliente*
            </span>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Nombre o razón social"
              autoComplete="off"
              className="h-10 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 text-[13.5px] text-[var(--foreground)]"
            />
            {issues.customerName ? (
              <span className="text-[11.5px] text-[var(--color-stock-out)]">{issues.customerName}</span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
              Teléfono
            </span>
            <input
              type="tel"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="Para avisar cuando esté lista"
              autoComplete="off"
              className="h-10 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 text-[13.5px] text-[var(--foreground)]"
            />
            <span className="text-[10.5px] text-[var(--foreground-muted)]">
              Se reutiliza el cliente si ya existe con ese número
            </span>
          </label>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="sale-channel"
              className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]"
            >
              Canal
            </label>
            <Select
              id="sale-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as OrderChannel)}
              className="h-10 text-[13.5px]"
            >
              {Object.entries(ORDER_CHANNEL_LABEL).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </section>

      <section className="relative space-y-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar pieza por SKU, nombre, número de parte u OEM"
          aria-label="Buscar pieza para la venta"
          spellCheck={false}
          autoComplete="off"
          className="h-11 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[14px] text-[var(--foreground)]"
        />
        {options.length ? (
          <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] shadow-sm">
            {options.map((option) => (
              <li key={option.variantId}>
                <button
                  type="button"
                  onClick={() => add(option)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[var(--surface-sunken)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-[var(--foreground)]">
                      {option.partName}
                      {option.title && option.title !== option.partName ? ` · ${option.title}` : ''}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10.5px] text-[var(--foreground-muted)]">
                        {option.sku}
                      </span>
                      <span className="text-[10.5px] text-[var(--foreground-muted)]">
                        {option.warehouseCode ?? 'sin bodega'}
                        {option.binLocation ? ` · ${option.binLocation}` : ''}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="partops-num block text-[12.5px] font-semibold text-[var(--foreground)]">
                      {formatMoney(option.priceCents)}
                    </span>
                    <span
                      className={`partops-num block text-[10.5px] ${
                        option.available > 0
                          ? 'text-[var(--foreground-muted)]'
                          : 'text-[var(--color-stock-out)]'
                      }`}
                    >
                      {option.available > 0 ? `${option.available} disp` : 'sin existencia'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {q.trim() && !options.length ? (
          <p className="text-[12px] text-[var(--foreground-muted)]">
            Ninguna pieza coincide. Revisa el código o créala en el catálogo.
          </p>
        ) : null}
      </section>

      {lines.length ? (
        <section className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
          <table className="w-full text-left">
            <thead className="bg-[var(--surface-sunken)]">
              <tr>
                {['Pieza', 'Cantidad', 'Precio', 'Importe', ''].map((h, i) => (
                  <th
                    key={h || i}
                    scope="col"
                    className="px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const qty = Number(line.quantity) || 0;
                const short = qty > line.available;
                return (
                  <tr key={line.variantId} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2">
                      <span className="block text-[13px] text-[var(--foreground)]">{line.partName}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <CodeChip label="sku">{line.sku}</CodeChip>
                        {short ? (
                          <span className="text-[10.5px] text-[var(--color-stock-out)]">
                            solo {line.available} disponibles: se aparta lo que hay y el resto queda pendiente
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={1}
                        inputMode="numeric"
                        value={line.quantity}
                        onChange={(e) => setQuantity(line.variantId, e.target.value)}
                        aria-label={`Cantidad de ${line.sku}`}
                        className="h-8 w-16 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--surface)] px-1.5 text-right text-[13px] text-[var(--foreground)]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      {canOverride ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          defaultValue={formatMoney(line.priceCents).replace(/[^\d.,]/g, '')}
                          onBlur={(e) => setPrice(line.variantId, e.target.value)}
                          aria-label={`Precio de ${line.sku}`}
                          className="h-8 w-24 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--surface)] px-1.5 text-right text-[13px] text-[var(--foreground)]"
                        />
                      ) : (
                        <span className="partops-num text-[13px] text-[var(--foreground)]">
                          {formatMoney(line.priceCents)}
                        </span>
                      )}
                    </td>
                    <td className="partops-num px-3 py-2 text-[13px] font-medium text-[var(--foreground)]">
                      {formatMoney(line.priceCents * qty)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setLines((c) => c.filter((l) => l.variantId !== line.variantId))}
                        className="text-[11.5px] text-[var(--foreground-muted)] hover:underline"
                      >
                        quitar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : (
        <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--border)] px-3 py-8 text-center text-[12.5px] text-[var(--foreground-muted)]">
          Sin piezas. Busca arriba y agrega la primera.
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
            Nota para bodega
          </span>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={600}
            placeholder="Ej. el cliente pasa a las 4"
            className="h-10 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 text-[13.5px] text-[var(--foreground)]"
          />
        </label>
        <div className="flex flex-col justify-end">
          <p className="text-right text-[11px] uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
            Total con IVA
          </p>
          <p className="partops-num text-right font-[family-name:var(--font-display)] text-[24px] font-bold leading-none text-[var(--foreground)]">
            {formatMoney(totalCents)}
          </p>
        </div>
      </section>

      {missing.length ? (
        <Alert tone="info" title="Hay piezas sin existencia suficiente">
          {missing.length === 1 ? 'Una línea' : `${missing.length} líneas`} se apartará con lo disponible y
          quedará pendiente el resto. El pedido nace abierto para conseguirla.
        </Alert>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          loading={pending}
          disabled={!lines.length || !customerName.trim() || lines.some((l) => !Number(l.quantity))}
        >
          Confirmar pedido
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push('/app/ventas' as never)}>
          Cancelar
        </Button>
        <span className="text-[11px] text-[var(--foreground-muted)]">
          Al confirmar se apartan las piezas por 20 minutos.
        </span>
      </div>
    </form>
  );
}

/** 32 hex: suficiente para que dos intentos distintos no colisionen en la misma clave. */
function makeKey(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,]/g, '');
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  const normalized =
    lastComma > lastDot ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '');
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
