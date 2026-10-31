'use client';

import {
  formatMoney,
  LINE_STATUS_LABEL,
  type LineStatus,
  ORDER_CHANNEL_LABEL,
  ORDER_STATUS_LABEL,
  type OrderDetail,
  type OrderLineRow,
  type OrderStatus,
  type OrderSummary,
  PAYMENT_METHOD_LABEL,
  type ReceiptSummary,
} from '@partops/contracts';
import { Alert, Button, CodeChip, EmptyState, Select, StatTile, StockPill } from '@partops/ui';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

interface ScreenProps {
  canCreate: boolean;
  canDispatch: boolean;
  canCancel: boolean;
  canSeeCost: boolean;
  canResendReceipt: boolean;
}

type Tab = 'abiertos' | 'cerrados';

/**
 * Pedidos.
 *
 * La lista mezcla tres oficios en una sola tabla porque son la misma pregunta desde tres lugares:
 * el vendedor busca "el pedido de doña Marta", el bodeguero busca "qué me toca preparar" y el dueño
 * busca "qué se vendió hoy". El filtro de estado resuelve el resto sin duplicar pantallas.
 *
 * El detalle se abre debajo de la fila, no en otra página: preparar un pedido es cotejar línea por
 * línea contra lo que hay en el estante, y cambiar de pantalla en medio de eso hace perder el hilo.
 */
export function SalesScreen({
  canCreate,
  canDispatch,
  canCancel,
  canSeeCost,
  canResendReceipt,
}: ScreenProps) {
  const [tab, setTab] = useState<Tab>('abiertos');
  const [q, setQ] = useState('');
  const [channel, setChannel] = useState('');
  const [items, setItems] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Una respuesta vieja no puede pisar a la nueva: se filtra mientras llega lo anterior.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (channel) params.set('channel', channel);
      params.set('open', String(tab === 'abiertos'));
      const res = await api<{ items: OrderSummary[]; total: number }>(`/api/orders?${params}`);
      if (mine === seq.current) setItems(res.items);
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [q, channel, tab]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 220);
    return () => clearTimeout(timer);
  }, [load]);

  const openOrders = (items ?? []).filter((o) => o.status !== 'ENTREGADO' && o.status !== 'CANCELADO');
  const pendingUnits = openOrders.reduce((a, o) => a + o.pendingUnits, 0);
  const toCollect = openOrders.reduce((a, o) => a + Math.max(0, o.balanceCents), 0);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
            Ventas
          </h1>
          <p className="mt-1 text-[13px] text-[var(--foreground-muted)]">
            El pedido reserva la pieza al confirmar y bodega la prepara línea por línea.
          </p>
        </div>
        {canCreate ? (
          <Link
            href="/app/ventas/nueva"
            className="inline-flex h-10 items-center rounded-[var(--radius-sm)] bg-[var(--primary)] px-3.5 text-[13px] font-semibold text-[var(--primary-foreground)] hover:opacity-90"
          >
            Nueva venta
          </Link>
        ) : null}
      </header>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <StatTile label="Pedidos abiertos" value={String(openOrders.length)} hint="con trabajo en bodega" />
        <StatTile
          label="Piezas por preparar"
          value={String(pendingUnits)}
          hint={pendingUnits === 0 ? 'nada pendiente' : 'incluye lo que no hay en existencia'}
        />
        <StatTile label="Por cobrar" value={formatMoney(toCollect)} hint="en pedidos abiertos" />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)]">
          {(['abiertos', 'cerrados'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`px-3 py-1.5 text-[12.5px] transition-colors ${
                tab === t
                  ? 'bg-[var(--primary)] font-semibold text-[var(--primary-foreground)]'
                  : 'bg-[var(--surface)] text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)]'
              }`}
            >
              {t === 'abiertos' ? 'Abiertos' : 'Cerrados'}
            </button>
          ))}
        </div>

        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Cliente, teléfono o folio"
          aria-label="Buscar pedido"
          spellCheck={false}
          className="h-9 min-w-[180px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--foreground)]"
        />

        <Select
          aria-label="Canal del pedido"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="h-9 w-auto text-[13px]"
        >
          <option value="">Todos los canales</option>
          {Object.entries(ORDER_CHANNEL_LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      {error ? (
        <Alert tone="error" title="No se pudieron cargar los pedidos">
          {error}
        </Alert>
      ) : null}

      {items && items.length === 0 && !loading ? (
        <EmptyState
          title={tab === 'abiertos' ? 'Ningún pedido abierto' : 'Sin pedidos cerrados'}
          description={
            tab === 'abiertos'
              ? 'Cuando vendas una pieza, el pedido aparece aquí para que bodega la prepare.'
              : 'Los pedidos entregados y cancelados se guardan aquí para consultar el historial.'
          }
          action={
            tab === 'abiertos' && canCreate ? (
              <Link
                href="/app/ventas/nueva"
                className="inline-flex h-9 items-center rounded-[var(--radius-sm)] bg-[var(--primary)] px-3 text-[12.5px] font-semibold text-[var(--primary-foreground)]"
              >
                Nueva venta
              </Link>
            ) : undefined
          }
        />
      ) : null}

      {items?.length ? (
        <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
          {items.map((order) => (
            <li key={order.id} className="border-b border-[var(--border)] last:border-b-0">
              <button
                type="button"
                onClick={() => setOpenId(openId === order.id ? null : order.id)}
                aria-expanded={openId === order.id}
                className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2.5 text-left hover:bg-[var(--surface-sunken)]"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <CodeChip label="folio">{order.code}</CodeChip>
                  <span className="min-w-0 truncate text-[13px] font-medium text-[var(--foreground)]">
                    {order.customerName}
                  </span>
                  <span className="text-[11.5px] text-[var(--foreground-muted)]">
                    {order.lineCount} {order.lineCount === 1 ? 'línea' : 'líneas'} · {order.units} u
                    {order.pendingUnits > 0 ? ` · ${order.pendingUnits} por preparar` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="partops-num text-[13px] font-semibold text-[var(--foreground)]">
                    {formatMoney(order.totalCents)}
                  </span>
                  <OrderBadge status={order.status} />
                  <span className="text-[11px] text-[var(--foreground-muted)]">
                    {formatDate(order.createdAt)}
                  </span>
                </span>
              </button>
              {openId === order.id ? (
                <OrderPanel
                  id={order.id}
                  canDispatch={canDispatch}
                  canCancel={canCancel}
                  canCreate={canCreate}
                  canSeeCost={canSeeCost}
                  canResendReceipt={canResendReceipt}
                  onChanged={() => void load()}
                  onClose={() => setOpenId(null)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {loading && !items ? (
        <p className="py-6 text-center text-[12.5px] text-[var(--foreground-muted)]">Cargando pedidos…</p>
      ) : null}
    </div>
  );
}

function OrderPanel({
  id,
  canDispatch,
  canCancel,
  canCreate,
  canSeeCost,
  canResendReceipt,
  onChanged,
  onClose,
}: {
  id: string;
  canDispatch: boolean;
  canCancel: boolean;
  canCreate: boolean;
  canSeeCost: boolean;
  canResendReceipt: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [payMethod, setPayMethod] = useState('EFECTIVO');
  const [payAmount, setPayAmount] = useState('');
  const [payReceived, setPayReceived] = useState('');
  const [receipt, setReceipt] = useState<ReceiptSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setOrder(await api<OrderDetail>(`/api/orders/${id}`));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, path: string, body?: unknown) {
    setBusy(key);
    setError(null);
    try {
      const next = await api<OrderDetail>(`/api/orders/${id}/${path}`, {
        method: 'POST',
        body: body ?? {},
      });
      setOrder(next);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function lineAct(itemId: string, status: LineStatus) {
    void act(`line:${itemId}:${status}`, `lines/${itemId}/status`, { status });
  }

  async function issueReceipt() {
    setBusy('receipt:issue');
    setError(null);
    try {
      setReceipt(await api<ReceiptSummary>(`/api/orders/${id}/receipt`, { method: 'POST' }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function resend() {
    setBusy('receipt:resend');
    setError(null);
    try {
      setReceipt(await api<ReceiptSummary>(`/api/orders/${id}/receipt/resend`, { method: 'POST' }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  /** Al abrir un pedido ya emitido se muestra su recibo en vez de ofrecer emitir otro. */
  useEffect(() => {
    api<ReceiptSummary>(`/api/orders/${id}/receipt`)
      .then(setReceipt)
      .catch(() => undefined);
  }, [id]);

  async function pay() {
    const cents = parseMoney(payAmount);
    if (cents === null) {
      setError('Escribe un monto válido');
      return;
    }
    const received = parseMoney(payReceived);
    await act('pay', 'payments', {
      method: payMethod,
      amountCents: cents,
      receivedCents: received ?? undefined,
    });
    setPayAmount('');
    setPayReceived('');
  }

  if (!order) {
    return (
      <div className="border-t border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-3 text-[12px] text-[var(--foreground-muted)]">
        {error ?? 'Cargando pedido…'}
      </div>
    );
  }

  const closed = order.status === 'CANCELADO';
  const delivered = order.status === 'ENTREGADO';

  return (
    <div className="space-y-3 border-t border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--foreground-muted)]">
        <span>
          Canal <strong className="text-[var(--foreground)]">{ORDER_CHANNEL_LABEL[order.channel]}</strong>
        </span>
        <span>
          Bodega <strong className="text-[var(--foreground)]">{order.warehouseCode}</strong>
        </span>
        <span>Vendió {order.sellerName}</span>
        {order.customerPhone ? (
          <a href={`tel:${order.customerPhone}`} className="font-mono hover:underline">
            {order.customerPhone}
          </a>
        ) : null}
        {order.next ? <span className="text-[var(--color-copper-700)]">{order.next.label}</span> : null}
      </div>

      {order.notes ? (
        <p className="rounded-[var(--radius-xs)] bg-[var(--surface)] px-2 py-1.5 text-[12px] text-[var(--foreground-muted)]">
          {order.notes}
        </p>
      ) : null}

      <table className="w-full text-left">
        <thead>
          <tr>
            {['Pieza', 'Cant.', 'Precio', 'Estado', ''].map((h, i) => (
              <th
                key={h || i}
                scope="col"
                className="pb-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <OrderLine
              key={line.id}
              line={line}
              canDispatch={canDispatch}
              canSeeCost={canSeeCost}
              closed={closed || delivered}
              busy={busy}
              onAct={lineAct}
            />
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-start justify-between gap-3 border-t border-[var(--border)] pt-2">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-[12px]">
          <dt className="text-[var(--foreground-muted)]">Subtotal</dt>
          <dd className="partops-num text-right text-[var(--foreground)]">
            {formatMoney(order.subtotalCents)}
          </dd>
          <dt className="text-[var(--foreground-muted)]">IVA</dt>
          <dd className="partops-num text-right text-[var(--foreground)]">{formatMoney(order.taxCents)}</dd>
          <dt className="font-semibold text-[var(--foreground)]">Total</dt>
          <dd className="partops-num text-right font-semibold text-[var(--foreground)]">
            {formatMoney(order.totalCents)}
          </dd>
          <dt className="text-[var(--foreground-muted)]">Pagado</dt>
          <dd className="partops-num text-right text-[var(--foreground)]">{formatMoney(order.paidCents)}</dd>
          <dt className="text-[var(--foreground-muted)]">{order.balanceCents < 0 ? 'Cambio' : 'Saldo'}</dt>
          <dd
            className={`partops-num text-right ${
              order.balanceCents > 0 ? 'text-[var(--color-copper-700)]' : 'text-[var(--foreground)]'
            }`}
          >
            {formatMoney(Math.abs(order.balanceCents))}
          </dd>
        </dl>

        {canCreate && !closed && order.balanceCents > 0 ? (
          <form
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void pay();
            }}
          >
            <Select
              aria-label="Forma de pago"
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value)}
              className="h-8 w-auto text-[12.5px]"
            >
              {Object.entries(PAYMENT_METHOD_LABEL)
                .filter(([key]) => key !== 'MIXTO')
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </Select>
            <input
              type="text"
              inputMode="decimal"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              placeholder={formatMoney(order.balanceCents)}
              aria-label="Monto a cobrar"
              className="h-8 w-24 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--surface)] px-1.5 text-right text-[12.5px] text-[var(--foreground)]"
            />
            {payMethod === 'EFECTIVO' ? (
              <input
                type="text"
                inputMode="decimal"
                value={payReceived}
                onChange={(e) => setPayReceived(e.target.value)}
                placeholder="recibido"
                aria-label="Efectivo recibido"
                className="h-8 w-24 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--surface)] px-1.5 text-right text-[12.5px] text-[var(--foreground)]"
              />
            ) : null}
            <Button size="sm" type="submit" loading={busy === 'pay'}>
              Cobrar
            </Button>
          </form>
        ) : null}
      </div>

      {order.payments.length ? (
        <ul className="space-y-0.5 border-t border-[var(--border)] pt-2">
          {order.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
              <span className="text-[var(--foreground-muted)]">
                {PAYMENT_METHOD_LABEL[p.method]} · {formatDate(p.createdAt)}
                {p.reference ? ` · ${p.reference}` : ''}
              </span>
              <span className="partops-num text-[var(--foreground)]">
                {formatMoney(p.amountCents)}
                {p.changeCents ? (
                  <span className="ml-1.5 text-[var(--foreground-muted)]">
                    cambio {formatMoney(p.changeCents)}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <section className="border-t border-[var(--border)] pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
            Recibo
          </span>
          {receipt ? (
            <>
              <CodeChip>{receipt.folio}</CodeChip>
              <a
                href={receipt.publicUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11.5px] text-[var(--color-copper-700)] hover:underline"
              >
                Ver en línea
              </a>
              <a
                href={receipt.pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11.5px] text-[var(--color-copper-700)] hover:underline"
              >
                Carta
              </a>
              {receipt.ticketUrl ? (
                <a
                  href={receipt.ticketUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11.5px] text-[var(--color-copper-700)] hover:underline"
                >
                  Ticket 80 mm
                </a>
              ) : null}
              {receipt.whatsappUrl ? (
                <a
                  href={receipt.whatsappUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11.5px] font-medium text-[var(--color-copper-700)] hover:underline"
                >
                  WhatsApp
                </a>
              ) : null}
              {canResendReceipt ? (
                <button
                  type="button"
                  onClick={() => void resend()}
                  disabled={busy === 'receipt:resend'}
                  className="text-[11.5px] text-[var(--foreground-muted)] hover:underline disabled:opacity-50"
                >
                  {busy === 'receipt:resend' ? 'Reenviando…' : 'Reenviar'}
                </button>
              ) : null}
            </>
          ) : (
            <>
              <Button size="sm" loading={busy === 'receipt:issue'} onClick={() => void issueReceipt()}>
                Emitir recibo
              </Button>
              <span className="text-[11px] text-[var(--foreground-muted)]">
                Carta y ticket, congelados: aunque el pedido cambie, el recibo no.
              </span>
            </>
          )}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
        {canCancel && !closed && !delivered ? (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'cancel'}
            onClick={() => void act('cancel', 'cancel', { reason: 'Cancelado desde ventas' })}
          >
            Cancelar pedido
          </Button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="text-[11.5px] text-[var(--foreground-muted)] hover:underline"
        >
          Cerrar detalle
        </button>
      </div>

      {order.events.length ? (
        <details className="border-t border-[var(--border)] pt-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
            Historial · {order.events.length}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {order.events.map((e) => (
              <li key={e.id} className="text-[11.5px] text-[var(--foreground-muted)]">
                <span className="font-mono text-[10.5px]">{formatTime(e.createdAt)}</span>{' '}
                <span className="text-[var(--foreground)]">{eventLabel(e.type)}</span>
                {e.actorName ? ` · ${e.actorName}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Una línea con su siguiente paso.
 *
 * Solo se ofrece el paso que la máquina de estados permite: un botón "entregar" sobre una línea
 * pendiente es una invitación a saltarse la preparación, y el ledger registra una salida que nadie
 * escaneó.
 */
function OrderLine({
  line,
  canDispatch,
  canSeeCost,
  closed,
  busy,
  onAct,
}: {
  line: OrderLineRow;
  canDispatch: boolean;
  canSeeCost: boolean;
  closed: boolean;
  busy: string | null;
  onAct: (itemId: string, status: LineStatus) => void;
}) {
  const next: LineStatus | null =
    line.status === 'PENDIENTE'
      ? 'EN_PREPARACION'
      : line.status === 'EN_PREPARACION'
        ? 'LISTO'
        : line.status === 'LISTO'
          ? 'ENTREGADO'
          : line.status === 'SIN_STOCK'
            ? 'PENDIENTE'
            : null;

  const actionable = canDispatch && !closed && next !== null;

  return (
    <tr className="border-t border-[var(--border)] align-top">
      <td className="py-1.5 pr-2">
        <span className="block text-[12.5px] leading-tight text-[var(--foreground)]">{line.name}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          <span className="font-mono text-[10.5px] text-[var(--foreground-muted)]">{line.sku}</span>
          <span className="text-[10.5px] text-[var(--foreground-muted)]">
            {line.warehouseCode}
            {line.binLocation ? ` · ${line.binLocation}` : ''}
          </span>
        </span>
        {canSeeCost && line.unitCostCents !== null ? (
          <span className="mt-0.5 block text-[10.5px] text-[var(--foreground-muted)]">
            costo {formatMoney(line.unitCostCents)}
          </span>
        ) : null}
      </td>
      <td className="partops-num py-1.5 pr-2 text-[12.5px] text-[var(--foreground)]">{line.quantity}</td>
      <td className="partops-num py-1.5 pr-2 text-[12.5px] text-[var(--foreground)]">
        {formatMoney(line.totalCents)}
        {line.discountCents > 0 ? (
          <span className="block text-[10.5px] text-[var(--color-copper-700)]">
            −{formatMoney(line.discountCents)}
          </span>
        ) : null}
      </td>
      <td className="py-1.5 pr-2">
        <LineBadge status={line.status} />
        {line.reservedUntil && line.status !== 'ENTREGADO' ? (
          <span className="mt-0.5 block text-[10px] text-[var(--foreground-muted)]">
            apartada hasta {formatTime(line.reservedUntil)}
          </span>
        ) : null}
      </td>
      <td className="py-1.5 text-right">
        {actionable && next ? (
          <Button
            size="sm"
            variant={next === 'PENDIENTE' ? 'secondary' : 'primary'}
            loading={busy === `line:${line.id}:${next}`}
            onClick={() => onAct(line.id, next)}
          >
            {next === 'EN_PREPARACION'
              ? 'Preparar'
              : next === 'LISTO'
                ? 'Listo'
                : next === 'ENTREGADO'
                  ? 'Entregar'
                  : 'Reintentar'}
          </Button>
        ) : (
          <StockPill quantity={line.quantity} unit={line.unit === 'UNIDAD' ? 'u' : line.unit.toLowerCase()} />
        )}
      </td>
    </tr>
  );
}

function OrderBadge({ status }: { status: OrderStatus }) {
  const tone =
    status === 'ENTREGADO'
      ? 'text-[var(--color-stock-ok)] border-[color-mix(in_oklch,var(--color-stock-ok)_30%,transparent)]'
      : status === 'CANCELADO'
        ? 'text-[var(--foreground-muted)] border-[var(--border)]'
        : status === 'PARCIAL'
          ? 'text-[var(--color-stock-low)] border-[color-mix(in_oklch,var(--color-stock-low)_35%,transparent)]'
          : status === 'LISTO'
            ? 'text-[var(--color-copper-700)] border-[color-mix(in_oklch,var(--color-copper-600)_40%,transparent)]'
            : 'text-[var(--color-copper-800)] border-[color-mix(in_oklch,var(--color-copper-600)_35%,transparent)]';

  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {ORDER_STATUS_LABEL[status]}
    </span>
  );
}

function LineBadge({ status }: { status: LineStatus }) {
  const tone =
    status === 'ENTREGADO'
      ? 'text-[var(--color-stock-ok)]'
      : status === 'CANCELADO' || status === 'SIN_STOCK'
        ? 'text-[var(--color-stock-out)]'
        : status === 'LISTO'
          ? 'text-[var(--color-copper-700)]'
          : 'text-[var(--foreground-muted)]';
  return <span className={`text-[11.5px] font-medium ${tone}`}>{LINE_STATUS_LABEL[status]}</span>;
}

function eventLabel(type: string): string {
  switch (type) {
    case 'CREADO':
      return 'Pedido creado';
    case 'LINEA':
      return 'Línea actualizada';
    case 'PAGO':
      return 'Pago registrado';
    case 'CANCELADO':
      return 'Pedido cancelado';
    case 'RESERVA_VENCIDA':
      return 'Reserva vencida';
    default:
      return type;
  }
}

/** Acepta "1,250.50", "1250,5" y "1250". Devuelve centavos o `null` si no se entiende. */
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-GT', { day: '2-digit', month: 'short' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });
}
