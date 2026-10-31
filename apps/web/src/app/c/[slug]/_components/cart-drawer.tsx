'use client';

import { AVAILABILITY_LABEL, formatMoney, type PublicOrderResult } from '@partops/contracts';
import { Alert, Button, CodeChip, EmptyState } from '@partops/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { newOrderKey } from '@/lib/storefront-cart';
import { useCart } from './storefront-shell';
import { TurnstileWidget } from './turnstile-widget';

/**
 * Carrito y pedido.
 *
 * Un panel, no una página: el cliente que ya eligió una pieza no debe perder el filtro del vehículo
 * ni el scroll del catálogo por ir a "finalizar compra". En el teléfono entra desde abajo y ocupa
 * la pantalla; en escritorio, desde la derecha.
 *
 * El formulario pide lo mínimo —nombre, teléfono, nota opcional— porque cada campo extra cuesta
 * pedidos. El teléfono no es opcional: sin él no hay a quién avisar cuando la pieza esté lista, y
 * una pieza apartada para nadie es inventario detenido.
 *
 * Después de enviar NO se cierra el panel: se muestra el folio y el botón de WhatsApp. Cerrar en
 * silencio deja al cliente sin saber si el pedido entró.
 */
export function CartDrawer({
  open,
  notice,
  turnstile,
  onDismissNotice,
  onClose,
}: {
  open: boolean;
  notice: string | null;
  turnstile: { required: boolean; siteKey: string | null };
  onDismissNotice: () => void;
  onClose: () => void;
}) {
  const { shop, lines, total, setQuantity, clear } = useCart();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublicOrderResult | null>(null);
  const [showForm, setShowForm] = useState(false);

  // La clave cambia cuando cambia el contenido del carrito, no en cada clic: así el doble toque por
  // mala señal devuelve el mismo pedido y no reserva dos veces las mismas piezas.
  const signature = useMemo(() => lines.map((l) => `${l.variantId}:${l.quantity}`).join('|'), [lines]);
  const [orderKey, setOrderKey] = useState(newOrderKey);
  const previousSignature = useRef(signature);
  useEffect(() => {
    if (previousSignature.current !== signature) {
      previousSignature.current = signature;
      setOrderKey(newOrderKey());
    }
  }, [signature]);

  // Escape cierra: es lo que hace cualquiera que abrió un panel por error.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const submit = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const res = await api<PublicOrderResult>(`/api/public/catalog/${shop.slug}/order`, {
        method: 'POST',
        body: {
          customerName: name.trim(),
          customerPhone: phone.trim(),
          note: note.trim() || undefined,
          items: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
          idempotencyKey: orderKey,
          turnstileToken: token ?? undefined,
        },
      });
      setResult(res);
      clear();
    } catch (err) {
      setError(errorMessage(err));
      // Un token de Turnstile se consume al usarlo: sin uno nuevo, el reintento falla seguro.
      setToken(null);
    } finally {
      setPending(false);
    }
  }, [shop.slug, name, phone, note, lines, orderKey, token, clear]);

  function close() {
    if (result) {
      setResult(null);
      setShowForm(false);
      setName('');
      setPhone('');
      setNote('');
      setToken(null);
    }
    onClose();
  }

  if (!open) return null;

  const money = (cents: number) => formatMoney(cents, shop.currency);
  const canSend = lines.length > 0 && name.trim().length >= 2 && phone.replace(/\D/g, '').length >= 8;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Cerrar el pedido"
        onClick={close}
        className="absolute inset-0 bg-[oklch(20%_0.03_246_/_0.45)]"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Tu pedido"
        className="relative flex h-full w-full max-w-[440px] flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)]"
      >
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-[16px] font-bold tracking-[-0.01em]">
              {result ? 'Pedido enviado' : 'Tu pedido'}
            </h2>
            <p className="text-[11.5px] text-[var(--foreground-muted)]">
              {result
                ? 'La bodega ya lo tiene en su cola'
                : `${lines.length} ${lines.length === 1 ? 'pieza' : 'piezas'} · ${shop.name}`}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-[var(--radius-sm)] px-2 py-1 text-[20px] leading-none text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)]"
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>

        {result ? (
          <OrderDone result={result} currency={shop.currency} onClose={close} />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {notice ? (
                <div className="mb-3">
                  <Alert tone="info">
                    <span className="flex items-start justify-between gap-2">
                      <span>{notice}</span>
                      <button
                        type="button"
                        onClick={onDismissNotice}
                        className="shrink-0 text-[11px] underline"
                      >
                        Entendido
                      </button>
                    </span>
                  </Alert>
                </div>
              ) : null}

              {lines.length === 0 ? (
                <EmptyState
                  title="El pedido está vacío"
                  description="Elige una pieza del catálogo y aparecerá aquí. No necesitas cuenta."
                />
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {lines.map((line) => (
                    <li key={line.variantId} className="py-3 first:pt-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[13.5px] font-medium leading-snug text-[var(--foreground)]">
                            {line.partName}
                          </p>
                          <p className="text-[12px] text-[var(--foreground-muted)]">{line.variantTitle}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <CodeChip label="SKU">{line.sku}</CodeChip>
                            {line.bucket !== 'HAY' ? (
                              <span className="text-[11px] text-[var(--color-stock-low)]">
                                {AVAILABILITY_LABEL[line.bucket]}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <p className="partops-num shrink-0 text-[13.5px] font-semibold">
                          {money(line.priceCents * line.quantity)}
                        </p>
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        <Stepper
                          value={line.quantity}
                          onChange={(next) => setQuantity(line.variantId, next)}
                        />
                        <span className="partops-num text-[11.5px] text-[var(--foreground-muted)]">
                          {money(line.priceCents)} c/u
                        </span>
                        <button
                          type="button"
                          onClick={() => setQuantity(line.variantId, 0)}
                          className="ml-auto text-[11.5px] text-[var(--foreground-muted)] underline hover:text-[var(--color-stock-out)]"
                        >
                          Quitar
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {lines.length > 0 && !showForm ? (
                <p className="mt-4 rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--foreground-muted)]">
                  Al enviar, la bodega aparta la existencia y te confirma por teléfono o WhatsApp. No se cobra
                  nada en línea.
                </p>
              ) : null}

              {lines.length > 0 && showForm ? (
                <OrderForm
                  name={name}
                  phone={phone}
                  note={note}
                  onName={setName}
                  onPhone={setPhone}
                  onNote={setNote}
                  onToken={setToken}
                  turnstile={turnstile}
                  error={error}
                />
              ) : null}
            </div>

            {lines.length > 0 ? (
              <footer className="border-t border-[var(--border)] px-4 py-3">
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="text-[12.5px] text-[var(--foreground-muted)]">
                    Total {shop.pricesIncludeTax ? 'con IVA' : 'sin IVA'}
                  </span>
                  <span className="partops-num font-[family-name:var(--font-display)] text-[20px] font-bold">
                    {money(total)}
                  </span>
                </div>
                {showForm ? (
                  <Button
                    fullWidth
                    size="lg"
                    loading={pending}
                    disabled={!canSend}
                    onClick={() => void submit()}
                  >
                    Enviar pedido
                  </Button>
                ) : (
                  <Button fullWidth size="lg" onClick={() => setShowForm(true)}>
                    Continuar
                  </Button>
                )}
                <p className="mt-2 text-center text-[11px] text-[var(--foreground-muted)]">
                  Sin cuenta, sin tarjeta. La bodega confirma antes de preparar.
                </p>
              </footer>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function OrderForm({
  name,
  phone,
  note,
  onName,
  onPhone,
  onNote,
  onToken,
  turnstile,
  error,
}: {
  name: string;
  phone: string;
  note: string;
  onName: (v: string) => void;
  onPhone: (v: string) => void;
  onNote: (v: string) => void;
  onToken: (v: string | null) => void;
  turnstile: { required: boolean; siteKey: string | null };
  error: string | null;
}) {
  return (
    <div className="mt-4 space-y-3 border-t border-[var(--border)] pt-4">
      <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
        ¿A nombre de quién?
      </p>
      <label className="block space-y-1">
        <span className="text-[12px] font-medium">Nombre</span>
        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          autoComplete="name"
          placeholder="Como te llamas"
          maxLength={80}
          className="h-11 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[14px]"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] font-medium">Teléfono</span>
        <input
          value={phone}
          onChange={(e) => onPhone(e.target.value)}
          inputMode="tel"
          autoComplete="tel"
          placeholder="5555 0000"
          maxLength={24}
          className="partops-num h-11 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[14px]"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] font-medium">
          Nota <span className="font-normal text-[var(--foreground-muted)]">(opcional)</span>
        </span>
        <textarea
          value={note}
          onChange={(e) => onNote(e.target.value)}
          placeholder="Para qué vehículo es, o a qué hora pasas"
          maxLength={300}
          rows={2}
          className="w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-[13.5px] leading-relaxed"
        />
      </label>

      {turnstile.required && turnstile.siteKey ? (
        <div className="space-y-1">
          <span className="text-[11px] text-[var(--foreground-muted)]">Verificación anti-robot</span>
          <TurnstileWidget siteKey={turnstile.siteKey} onToken={onToken} />
        </div>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <div className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border-strong)]">
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        className="h-8 w-8 text-[15px] leading-none text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)]"
        aria-label="Quitar una unidad"
      >
        −
      </button>
      <span className="partops-num w-7 text-center text-[13px] font-semibold">{value}</span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        className="h-8 w-8 text-[15px] leading-none text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)]"
        aria-label="Agregar una unidad"
      >
        +
      </button>
    </div>
  );
}

/**
 * Confirmación.
 *
 * El folio va primero y en grande: es lo que el cliente dicta por teléfono. El botón de WhatsApp es
 * el camino corto para cerrar la venta, y el de seguir comprando evita que la vitrina termine en un
 * callejón después del pedido.
 */
function OrderDone({
  result,
  currency,
  onClose,
}: {
  result: PublicOrderResult;
  currency: string;
  onClose: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--foreground-muted)]">
          Tu folio
        </p>
        <p className="partops-num font-[family-name:var(--font-display)] text-[28px] font-bold leading-tight">
          {result.code}
        </p>
        <p className="mt-1 text-[12px] text-[var(--foreground-muted)]">
          {result.allAvailable
            ? 'Las piezas quedaron apartadas.'
            : 'Una pieza no estaba disponible: la bodega la consigue y te avisa.'}
        </p>
      </div>

      <ul className="mt-4 divide-y divide-[var(--border)]">
        {result.lines.map((line) => (
          <li key={line.sku} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-[13px] font-medium leading-snug">{line.name}</p>
              <p className="partops-num text-[11.5px] text-[var(--foreground-muted)]">
                {line.sku} × {line.quantity}
              </p>
            </div>
            <p className="partops-num shrink-0 text-[13px]">{formatMoney(line.totalCents, currency)}</p>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex items-baseline justify-between border-t border-[var(--border)] pt-2">
        <span className="text-[12.5px] text-[var(--foreground-muted)]">Total</span>
        <span className="partops-num text-[17px] font-bold">{formatMoney(result.totalCents, currency)}</span>
      </div>

      <div className="mt-4 space-y-2">
        {result.whatsappUrl ? (
          <a
            href={result.whatsappUrl}
            target="_blank"
            rel="noreferrer"
            className="flex h-12 w-full items-center justify-center rounded-[var(--radius-sm)] text-[15px] font-semibold"
            style={{ backgroundColor: 'var(--shop-accent)', color: 'var(--accent-foreground)' }}
          >
            Confirmar por WhatsApp
          </a>
        ) : null}
        <Button variant="secondary" fullWidth onClick={onClose}>
          Seguir viendo el catálogo
        </Button>
      </div>

      <p className="mt-3 text-center text-[11px] leading-relaxed text-[var(--foreground-muted)]">
        Guarda tu folio. La bodega lo usa para encontrar tu pedido cuando llames.
      </p>
    </div>
  );
}
