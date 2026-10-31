'use client';

import {
  type DispatchLine,
  type DispatchOp,
  type DispatchOrder,
  type DispatchQueueResponse,
  LINE_STATUS_LABEL,
  type LineStatus,
  scanVerdict,
} from '@partops/contracts';
import { Alert, Button, CodeChip, EmptyState, StatTile } from '@partops/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { type CueTone, playCue, primeAudio, subscribePush, vibrate } from '@/lib/notifications';
import { cacheQueue, enqueue, flush, newOpId, pendingCount, readCachedQueue } from '@/lib/outbox';
import { type ConnectionState, useRealtime } from '@/lib/realtime';

/**
 * Despacho.
 *
 * Pantalla de bodega, no de oficina. Las decisiones salen de cómo se usa de verdad:
 *
 *  - **Un pedido a la vez, a lo ancho.** El bodeguero sostiene el teléfono con una mano y la pieza
 *    con la otra. Nada de tres columnas ni de tablas: el pedido abierto ocupa la pantalla.
 *  - **El escaneo es el botón principal.** Marcar "listo" a mano es la forma de entregar la pieza
 *    equivocada; el campo está siempre a la vista y acepta lector Bluetooth, cámara o tecleo.
 *  - **Objetivos de 48 px.** Con guantes y a pleno sol, un botón de 32 px se falla.
 *  - **Sin señal se sigue trabajando.** Cada toque entra en la cola del teléfono y se pinta de
 *    inmediato; el envío ocurre cuando hay red, una sola vez por operación.
 */

interface WarehouseOption {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
}

interface Props {
  canTransfer: boolean;
  soundDefault: boolean;
}

const PRIORITY_LABEL = 'con prisa';

export function DispatchScreen({ canTransfer, soundDefault }: Props) {
  const [queue, setQueue] = useState<DispatchQueueResponse | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [warehouseId, setWarehouseId] = useState<string>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [flushing, setFlushing] = useState(false);
  const [sound, setSound] = useState(soundDefault);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [overlay, setOverlay] = useState<Map<string, LineStatus>>(new Map());
  const [pushState, setPushState] = useState('sin-permiso');

  const seq = useRef(0);
  const scanRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef<string | null>(null);
  openRef.current = openId;

  // El tono solo se puede crear tras un gesto: se desbloquea con el primer toque en la pantalla.
  useEffect(() => {
    const unlock = () => primeAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  const load = useCallback(async (warehouse: string, opts: { silent?: boolean } = {}) => {
    const mine = ++seq.current;
    if (!opts.silent) setLoading(true);
    try {
      const params = new URLSearchParams({ onlyActionable: 'true' });
      if (warehouse) params.set('warehouseId', warehouse);
      const res = await api<DispatchQueueResponse>(`/api/dispatch/queue?${params}`);
      if (mine !== seq.current) return;
      setQueue(res);
      setCachedAt(null);
      setError(null);
      void cacheQueue(res);
      if (!openRef.current && res.orders[0]) setOpenId(res.orders[0].orderId);
    } catch (err) {
      if (mine !== seq.current) return;
      // Sin red se pinta la última cola conocida y se dice cuándo se guardó. Mentir con una
      // lista vacía haría creer que no hay trabajo.
      const cached = await readCachedQueue();
      if (cached) {
        setQueue(cached.queue);
        setCachedAt(cached.savedAt);
      }
      setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void pendingCount().then(setPending);
    void api<{ key: string | null }>('/api/realtime/push/key')
      .then((res) => setPushState(res.key ? 'sin-permiso' : 'sin-servidor'))
      .catch(() => setPushState('sin-permiso'));
    void api<WarehouseOption[]>('/api/inventory/warehouses')
      .then((rows) => {
        setWarehouses(rows);
        const initial = rows.find((w) => w.isDefault)?.id ?? rows[0]?.id ?? '';
        setWarehouseId(initial);
        void load(initial);
      })
      .catch((err) => {
        setError(errorMessage(err));
        void load('');
      });
  }, [load]);

  /** Envía lo pendiente. Se llama al recuperar red, al reconectar y al abrir la pantalla. */
  const send = useCallback(async () => {
    if (flushing) return;
    setFlushing(true);
    try {
      const result = await flush();
      if (result.queue) setQueue(result.queue);
      if (result.rejected.length) {
        setError(result.rejected[0]?.message ?? 'Una operación no se pudo aplicar');
        playCue('SIN_STOCK', sound);
      }
      setPending(await pendingCount());
    } catch {
      setPending(await pendingCount());
    } finally {
      setFlushing(false);
    }
  }, [flushing, sound]);

  useEffect(() => {
    const onOnline = () => void send();
    window.addEventListener('online', onOnline);
    void send();
    return () => window.removeEventListener('online', onOnline);
  }, [send]);

  const onEvent = useCallback(
    (event: { type: string; [key: string]: unknown }) => {
      if (event.type === 'dispatch:notice') {
        const noticeEvent = event as unknown as { title: string; body: string };
        setNotice({ title: noticeEvent.title, body: noticeEvent.body });
        playCue('NUEVO', sound);
        vibrate('NUEVO', sound);
        void load(warehouseId, { silent: true });
        return;
      }

      const update = (
        event as unknown as { update: { kind: string; status: string; line: { status: string } | null } }
      ).update;
      if (update.kind === 'CREADO' || update.status === 'ENTREGADO' || update.status === 'CANCELADO') {
        void load(warehouseId, { silent: true });
      }

      const tone: CueTone | null =
        update.status === 'ENTREGADO'
          ? 'ENTREGADO'
          : update.status === 'CANCELADO'
            ? 'CANCELADO'
            : update.line?.status === 'SIN_STOCK'
              ? 'SIN_STOCK'
              : update.status === 'LISTO'
                ? 'LISTO'
                : null;
      if (tone) {
        playCue(tone, sound);
        vibrate(tone, sound);
      }
    },
    [load, sound, warehouseId],
  );

  const realtime = useRealtime({
    enabled: true,
    warehouseId: warehouseId || null,
    onEvent: onEvent as never,
    onResync: () => {
      void send();
      void load(warehouseId, { silent: true });
    },
  });

  /**
   * Estado efectivo de una línea.
   *
   * La cola del teléfono manda sobre lo que dijo el servidor: si el bodeguero marcó listo sin
   * señal, la pantalla tiene que mostrarlo listo aunque la respuesta vieja diga pendiente. Pintar
   * la verdad del servidor lo llevaría a escanear otra vez y el inventario se descontaría dos veces.
   */
  const statusOf = useCallback(
    (line: DispatchLine): LineStatus => overlay.get(line.itemId) ?? line.status,
    [overlay],
  );

  const mark = useCallback(
    (
      order: DispatchOrder,
      line: DispatchLine,
      status: 'LISTO' | 'SIN_STOCK' | 'ENTREGADO',
      scannedCode?: string,
    ) => {
      const op: DispatchOp = {
        opId: newOpId(),
        orderId: order.orderId,
        itemId: line.itemId,
        status,
        scannedCode: scannedCode ?? null,
      };

      // Optimista: se pinta antes de la red. Si falla, la cola lo conserva y se reintenta.
      setOverlay((prev) => new Map(prev).set(line.itemId, status));
      const tone: CueTone =
        status === 'SIN_STOCK' ? 'SIN_STOCK' : status === 'ENTREGADO' ? 'ENTREGADO' : 'LISTO';
      playCue(tone, sound);
      vibrate(tone, sound);

      void (async () => {
        /** Entrega y "no está" nunca son un escaneo: van por la cola idempotente. */
        if (status !== 'LISTO') {
          await enqueue(op);
          setPending(await pendingCount());
          await send();
          return;
        }

        /** Listo por escaneo: en línea, para que el servidor valide el código al instante. */
        if (typeof navigator === 'undefined' || navigator.onLine) {
          try {
            const res = await api<{ ok: boolean; message?: string }>(
              `/api/dispatch/orders/${order.orderId}/lines/${line.itemId}/scan`,
              { method: 'POST', body: { code: scannedCode ?? line.sku, status: 'LISTO' } },
            );
            if (res.ok) {
              await load(warehouseId, { silent: true });
              return;
            }
            setError(res.message ?? 'Ese código no es de esta pieza');
            setOverlay((prev) => {
              const next = new Map(prev);
              next.delete(line.itemId);
              return next;
            });
            playCue('SIN_STOCK', sound);
            return;
          } catch {
            // Sin red se encola: el servidor lo valida al sincronizar y lo rechaza si no era.
          }
        }

        await enqueue(op);
        setPending(await pendingCount());
      })();
    },
    [load, send, sound, warehouseId],
  );

  const orders = useMemo(() => {
    if (!queue) return [];
    return queue.orders.map((order) => {
      const lines = order.lines.map((line) => ({ ...line, status: statusOf(line) }));
      const pendingUnits = lines.filter((l) => l.status !== 'LISTO').reduce((acc, l) => acc + l.quantity, 0);
      const readyUnits = lines.filter((l) => l.status === 'LISTO').reduce((acc, l) => acc + l.quantity, 0);
      return { ...order, lines, pendingUnits, readyUnits };
    });
  }, [queue, statusOf]);

  const open = orders.find((o) => o.orderId === openId) ?? orders[0] ?? null;
  const totalPending = orders.reduce((a, o) => a + o.pendingUnits, 0);
  const totalReady = orders.reduce((a, o) => a + o.readyUnits, 0);

  return (
    <div className="mx-auto max-w-2xl pb-28">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.3rem,2.6vw,1.65rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
            Despacho
          </h1>
          <p className="mt-0.5 text-[13px] text-[var(--foreground-muted)]">
            Escanea la pieza antes de marcarla. Lo que toques sin señal se envía solo.
          </p>
        </div>
        <ConnectionPill
          state={realtime.state}
          pending={pending}
          flushing={flushing}
          onRetry={() => void send()}
        />
      </header>

      <div className="mb-3 grid grid-cols-3 gap-2">
        <StatTile label="Por preparar" value={String(totalPending)} hint="piezas en la cola" />
        <StatTile label="Listas" value={String(totalReady)} hint="esperando entrega" />
        <StatTile
          label="Sin enviar"
          value={String(pending)}
          hint={pending ? 'en este teléfono' : 'todo enviado'}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {warehouses.length > 1 ? (
          <label className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--foreground-muted)]">
            <span className="sr-only">Bodega</span>
            <select
              value={warehouseId}
              onChange={(event) => {
                const next = event.target.value;
                setWarehouseId(next);
                setOpenId(null);
                realtime.watch(next || null);
                void load(next);
              }}
              className="h-10 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-[13px] text-[var(--foreground)]"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          aria-pressed={sound}
          onClick={() => {
            setSound((v) => !v);
            primeAudio();
          }}
          className="h-10 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[12.5px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-sunken)]"
        >
          {sound ? 'Sonido sí' : 'Sonido no'}
        </button>
        {pushState === 'sin-permiso' ? (
          <button
            type="button"
            onClick={async () => setPushState(await subscribePush().catch(() => 'sin-permiso'))}
            className="h-10 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[12.5px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-sunken)]"
          >
            Activar avisos
          </button>
        ) : null}
      </div>

      {notice ? (
        <div className="mb-3">
          <Alert tone="info" title={notice.title}>
            <div className="flex items-center justify-between gap-3">
              <span>{notice.body}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="shrink-0 text-[12px] font-semibold underline"
              >
                Cerrar
              </button>
            </div>
          </Alert>
        </div>
      ) : null}

      {error ? (
        <div className="mb-3">
          <Alert tone="info" title="Aviso">
            {cachedAt ? `${error} Mostrando la lista guardada a las ${timeOf(cachedAt)}.` : error}
          </Alert>
        </div>
      ) : null}

      {loading && !queue ? (
        <p className="py-10 text-center text-[13px] text-[var(--foreground-muted)]">Cargando la cola…</p>
      ) : orders.length === 0 ? (
        <EmptyState
          title="Nada por preparar"
          description="Cuando entre una venta aparece aquí, ordenada por pasillo para que des una sola vuelta."
        />
      ) : (
        <div className="space-y-2">
          {orders.map((order) => (
            <OrderCard
              key={order.orderId}
              order={order}
              open={order.orderId === open?.orderId}
              onToggle={() => {
                setOpenId(order.orderId === open?.orderId ? null : order.orderId);
                setTimeout(() => scanRef.current?.focus(), 50);
              }}
              canTransfer={canTransfer}
              onMark={mark}
              scanRef={order.orderId === open?.orderId ? scanRef : undefined}
              sound={sound}
              onError={setError}
            />
          ))}
        </div>
      )}

      {/* Barra fija de entrega: cuando todo está escaneado, el siguiente paso no debe requerir
          buscar un botón entre la lista. */}
      {open && open.pendingUnits === 0 && open.lines.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="mx-auto flex max-w-2xl items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-[var(--foreground)]">
                {open.code} completo
              </p>
              <p className="text-[12px] text-[var(--foreground-muted)]">Todo escaneado. Falta entregarlo.</p>
            </div>
            <Button
              size="lg"
              onClick={() => {
                for (const line of open.lines) {
                  if (line.status === 'LISTO') mark(open, line, 'ENTREGADO');
                }
                setOpenId(null);
              }}
            >
              Entregar
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionPill({
  state,
  pending,
  flushing,
  onRetry,
}: {
  state: ConnectionState;
  pending: number;
  flushing: boolean;
  onRetry: () => void;
}) {
  const label =
    state === 'en-vivo'
      ? 'En vivo'
      : state === 'conectando'
        ? 'Conectando…'
        : state === 'reintentando'
          ? 'Reconectando'
          : state === 'sin-permiso'
            ? 'Sin permiso'
            : 'Solo HTTP';
  const tone =
    state === 'en-vivo'
      ? 'text-[var(--color-stock-ok)] border-[color-mix(in_oklch,var(--color-stock-ok)_35%,transparent)]'
      : state === 'reintentando'
        ? 'text-[var(--color-stock-low)] border-[color-mix(in_oklch,var(--color-stock-low)_35%,transparent)]'
        : 'text-[var(--foreground-muted)] border-[var(--border)]';

  return (
    <button
      type="button"
      onClick={onRetry}
      title={pending ? `${pending} cambios sin enviar` : 'Todo enviado'}
      className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium ${tone}`}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${
          state === 'en-vivo'
            ? 'bg-[var(--color-stock-ok)]'
            : state === 'reintentando' || flushing
              ? 'animate-pulse bg-[var(--color-stock-low)]'
              : 'bg-[var(--foreground-muted)]'
        }`}
      />
      {flushing ? 'Enviando…' : label}
      {pending ? <span className="partops-num">· {pending}</span> : null}
    </button>
  );
}

function OrderCard({
  order,
  open,
  onToggle,
  canTransfer,
  onMark,
  scanRef,
  sound,
  onError,
}: {
  order: DispatchOrder;
  open: boolean;
  onToggle: () => void;
  canTransfer: boolean;
  onMark: (
    order: DispatchOrder,
    line: DispatchLine,
    status: 'LISTO' | 'SIN_STOCK' | 'ENTREGADO',
    scannedCode?: string,
  ) => void;
  scanRef?: React.RefObject<HTMLInputElement | null>;
  sound: boolean;
  onError: (message: string | null) => void;
}) {
  const [code, setCode] = useState('');
  const [missed, setMissed] = useState<DispatchLine | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const next = order.lines.find((l) => l.status !== 'LISTO');

  /**
   * Escanear dentro del pedido.
   *
   * El código se compara contra TODAS las líneas del pedido antes de tocar nada: el bodeguero
   * escanea la pieza que tiene en la mano y el sistema decide a qué línea pertenece. Si no es de
   * ninguna, no se mueve nada y se le dice qué esperaba.
   */
  function onScan(value: string) {
    const scanned = value.trim();
    if (!scanned) return;
    setCode('');
    onError(null);

    const match = order.lines.find(
      (line) => line.status !== 'LISTO' && scanVerdict(line, scanned) === 'COINCIDE',
    );

    if (!match) {
      // Puede ser una pieza ya escaneada: se avisa en vez de decir "código inválido".
      const already = order.lines.find((line) => scanVerdict(line, scanned) === 'COINCIDE');
      setFlash(already ? `${already.sku} ya estaba listo` : `Ese código no es de ${order.code}`);
      playCue('SIN_STOCK', sound);
      return;
    }

    onMark(order, match, 'LISTO', scanned);
    setFlash(`${match.sku} listo`);
    setTimeout(() => setFlash(null), 2200);
    scanRef?.current?.focus();
  }

  return (
    <section
      className={`overflow-hidden rounded-[var(--radius-md)] border bg-[var(--surface)] ${
        open ? 'border-[var(--border-strong)] shadow-[var(--shadow-card)]' : 'border-[var(--border)]'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 p-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[13px] font-semibold text-[var(--foreground)]">{order.code}</span>
            {order.priority ? (
              <span className="rounded-full border border-[color-mix(in_oklch,var(--color-stock-low)_45%,transparent)] px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--color-stock-low)]">
                {PRIORITY_LABEL}
              </span>
            ) : null}
            <span className="partops-num text-[11.5px] text-[var(--foreground-muted)]">
              hace {order.ageMinutes} min
            </span>
          </div>
          <p className="mt-0.5 truncate text-[13.5px] text-[var(--foreground)]">{order.customerName}</p>
          <p className="text-[12px] text-[var(--foreground-muted)]">
            {order.pendingUnits === 0
              ? 'Todo escaneado'
              : `${order.pendingUnits} ${order.pendingUnits === 1 ? 'pieza' : 'piezas'} por preparar`}
            {order.readyUnits ? ` · ${order.readyUnits} listas` : ''}
          </p>
        </div>
        <span aria-hidden className="mt-1 text-[var(--foreground-muted)]">
          {open ? '−' : '+'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-[var(--border)] p-3">
          {next ? (
            <div className="mb-3">
              <label
                htmlFor={`scan-${order.orderId}`}
                className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]"
              >
                Escanear pieza
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id={`scan-${order.orderId}`}
                  ref={scanRef}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onScan(code);
                    }
                  }}
                  // `enterKeyHint` cambia el teclado del teléfono a "Listo": el bodeguero no tiene
                  // que apuntar a un botón con el guante puesto.
                  enterKeyHint="done"
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder={`${next.sku} · ${next.binLocation ?? 'sin ubicación'}`}
                  className="h-12 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 font-mono text-[15px] uppercase tracking-[0.02em] text-[var(--foreground)] placeholder:font-sans placeholder:normal-case placeholder:tracking-normal"
                />
                <Button size="lg" onClick={() => onScan(code)}>
                  Listo
                </Button>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p className="text-[11.5px] text-[var(--foreground-muted)]">
                  {flash ?? `Siguiente: ${next.name}`}
                </p>
                <button
                  type="button"
                  onClick={() => setMissed(next)}
                  className="shrink-0 rounded-[var(--radius-xs)] px-2 py-1 text-[12px] font-medium text-[var(--color-stock-out)] hover:bg-[var(--surface-sunken)]"
                >
                  No está
                </button>
              </div>
            </div>
          ) : null}

          {missed ? (
            <div className="mb-3 rounded-[var(--radius-sm)] border border-[color-mix(in_oklch,var(--color-stock-out)_35%,transparent)] bg-[var(--surface-sunken)] p-3">
              <p className="text-[13px] font-semibold text-[var(--foreground)]">
                ¿{missed.name} no está en el estante?
              </p>
              <p className="mt-0.5 text-[12px] text-[var(--foreground-muted)]">
                La línea queda sin stock y se libera la reserva. La venta no se cancela: el vendedor consigue
                la pieza en otra bodega.
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="md"
                  variant="danger"
                  onClick={() => {
                    onMark(order, missed, 'SIN_STOCK');
                    setMissed(null);
                  }}
                >
                  Sí, marcar sin stock
                </Button>
                <Button size="md" variant="secondary" onClick={() => setMissed(null)}>
                  Seguir buscando
                </Button>
              </div>
              {canTransfer ? (
                <p className="mt-2 text-[11.5px] text-[var(--foreground-muted)]">
                  Si está en otra sucursal, pide un traslado desde Inventario.
                </p>
              ) : null}
            </div>
          ) : null}

          <ul className="divide-y divide-[var(--border)]">
            {order.lines.map((line) => (
              <li key={line.itemId} className="flex items-start gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <CodeChip tone={line.status === 'LISTO' ? 'muted' : 'default'}>{line.sku}</CodeChip>
                    {line.binLocation ? (
                      <span className="rounded-[var(--radius-xs)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--foreground-muted)]">
                        {line.binLocation}
                      </span>
                    ) : (
                      <span className="text-[11px] text-[var(--foreground-muted)]">sin ubicación</span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[13px] text-[var(--foreground)]">{line.name}</p>
                  <p className="partops-num text-[11.5px] text-[var(--foreground-muted)]">
                    {line.quantity} {line.unit.toLowerCase()} · {LINE_STATUS_LABEL[line.status]}
                  </p>
                </div>
                {line.status === 'LISTO' ? (
                  <span className="mt-1 rounded-full border border-[color-mix(in_oklch,var(--color-stock-ok)_35%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-stock-ok)]">
                    Listo
                  </span>
                ) : line.status === 'SIN_STOCK' ? (
                  <span className="mt-1 rounded-full border border-[color-mix(in_oklch,var(--color-stock-out)_35%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-stock-out)]">
                    Sin stock
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onScan(line.sku)}
                    className="mt-1 h-9 shrink-0 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-2.5 text-[12px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-sunken)]"
                  >
                    Escanear
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });
}
