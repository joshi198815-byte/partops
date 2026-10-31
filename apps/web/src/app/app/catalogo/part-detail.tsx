'use client';

import {
  type CatalogPartDetail,
  compatibilityRangeSchema,
  formatMoney,
  MAX_IMAGES_PER_PART,
  type VehicleOption,
} from '@partops/contracts';
import { Alert, Button, CodeChip, Field, Input, StockPill } from '@partops/ui';
import Image from 'next/image';
import { useCallback, useEffect, useState } from 'react';
import { api, apiUpload, errorMessage } from '@/lib/api';

const MOVEMENT_LABEL: Record<string, string> = {
  COMPRA: 'Compra',
  VENTA: 'Venta',
  AJUSTE: 'Ajuste',
  RESERVA: 'Reserva',
  LIBERACION: 'Liberación',
  TRASLADO_SALIDA: 'Traslado (sale)',
  TRASLADO_ENTRADA: 'Traslado (entra)',
  DEVOLUCION: 'Devolución',
  IMPORTACION: 'Importación',
};

/**
 * Ficha de la pieza.
 *
 * Se abre como panel lateral y no como página: el que revisa un precio suele estar comparando
 * contra la fila de al lado, y navegar perdería el filtro y la posición en la tabla.
 *
 * El ajuste de existencia pide la cantidad FINAL ("quedan 4"), no el delta. Contar y restar de
 * cabeza es donde se equivoca la gente, y un ajuste equivocado solo se descubre en el siguiente
 * conteo físico.
 */
export function PartDetail({
  partId,
  canUpdate,
  canArchive,
  canAdjust,
  canSeeCost,
  onClose,
  onChanged,
  onEdit,
}: {
  partId: string;
  canUpdate: boolean;
  canArchive: boolean;
  canAdjust: boolean;
  canSeeCost: boolean;
  onClose: () => void;
  onChanged: () => void;
  onEdit: (part: CatalogPartDetail) => void;
}) {
  const [part, setPart] = useState<CatalogPartDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPart(await api<CatalogPartDetail>(`/api/catalog/parts/${partId}`));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [partId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!part) return;
    setBusy(true);
    try {
      const result = await api<{ archived: boolean }>(`/api/catalog/parts/${part.id}`, { method: 'DELETE' });
      onChanged();
      if (result.archived) {
        // Se explica: la fila sigue en el listado y sin esto parece que el borrado no funcionó.
        await load();
        setError('La pieza tiene movimientos de inventario o ventas: se archivó en vez de borrarse.');
      } else {
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="part-detail-title"
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        // Escape cierra: el panel lateral se abre y se cierra decenas de veces al día.
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="flex h-dvh w-full max-w-xl flex-col border-l border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0">
            <h2
              id="part-detail-title"
              className="truncate text-[15px] font-semibold text-[var(--foreground)]"
            >
              {part?.name ?? 'Cargando…'}
            </h2>
            {part ? (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-[var(--foreground-muted)]">
                <span className="font-mono">{part.sku}</span>
                {part.brand ? <span>· {part.brand}</span> : null}
                {part.category ? <span>· {part.category}</span> : null}
                {part.warrantyDays ? <span>· garantía {part.warrantyDays} días</span> : null}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canUpdate && part ? (
              <Button size="sm" variant="secondary" onClick={() => onEdit(part)}>
                Editar
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {part?.status === 'ARCHIVADO' ? (
            <Alert tone="info" title="Pieza archivada">
              No aparece en la búsqueda del mostrador. {canUpdate ? 'Reactívala para volver a venderla.' : ''}
            </Alert>
          ) : null}

          {part ? (
            <>
              <section className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5">
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                    Precio
                  </p>
                  <p className="partops-num text-[14px] font-semibold text-[var(--foreground)]">
                    {part.priceMin === part.priceMax
                      ? formatMoney(part.priceMin)
                      : `${formatMoney(part.priceMin)} – ${formatMoney(part.priceMax)}`}
                  </p>
                </div>
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                    Disponible
                  </p>
                  <p className="partops-num text-[14px] font-semibold text-[var(--foreground)]">
                    {part.onHand - part.reserved} / {part.onHand}
                    <span className="ml-1 text-[11px] font-normal text-[var(--foreground-muted)]">
                      disp/físico
                    </span>
                  </p>
                </div>
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                    Aplicaciones
                  </p>
                  <p className="partops-num text-[14px] font-semibold text-[var(--foreground)]">
                    {part.isUniversal ? 'Universal' : part.vehicles.length}
                  </p>
                </div>
                {part.tags.length ? (
                  <div className="flex flex-wrap gap-1">
                    {part.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-[var(--radius-xs)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--foreground-muted)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </section>

              {part.description ? (
                <p className="text-[13px] leading-relaxed text-[var(--foreground)]">{part.description}</p>
              ) : null}

              <Variants
                part={part}
                canUpdate={canUpdate}
                canAdjust={canAdjust}
                canSeeCost={canSeeCost}
                busy={busy}
                mutate={mutate}
              />

              <Compatibility part={part} canUpdate={canUpdate} busy={busy} mutate={mutate} />

              <Images part={part} canUpdate={canUpdate} busy={busy} mutate={mutate} />

              <Movements part={part} />

              {canArchive ? (
                <section className="border-t border-[var(--border)] pt-3">
                  <Button size="sm" variant="danger" loading={busy} onClick={destroy}>
                    {part.status === 'ARCHIVADO' ? 'Archivar de nuevo' : 'Borrar o archivar'}
                  </Button>
                  <p className="mt-1 text-[11.5px] text-[var(--foreground-muted)]">
                    Si la pieza ya tuvo movimientos o ventas, se archiva para no romper recibos viejos.
                  </p>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Variants({
  part,
  canUpdate,
  canAdjust,
  canSeeCost,
  busy,
  mutate,
}: {
  part: CatalogPartDetail;
  canUpdate: boolean;
  canAdjust: boolean;
  canSeeCost: boolean;
  busy: boolean;
  mutate: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
        Variantes y existencias
      </h3>
      <div className="space-y-2">
        {part.variants.map((variant) => (
          <div key={variant.id} className="rounded-[var(--radius-sm)] border border-[var(--border)] p-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[13px] font-medium text-[var(--foreground)]">
                {variant.title === part.name ? variant.sku : variant.title}
              </p>
              <p className="partops-num text-[13px] text-[var(--foreground)]">
                {formatMoney(variant.priceCents)}
                {canSeeCost && variant.costCents !== null ? (
                  <span className="ml-2 text-[11px] text-[var(--foreground-muted)]">
                    costo {formatMoney(variant.costCents)}
                  </span>
                ) : null}
              </p>
            </div>

            <div className="mt-1 flex flex-wrap gap-1">
              <CodeChip label="sku">{variant.sku}</CodeChip>
              {variant.partNumber ? <CodeChip label="parte">{variant.partNumber}</CodeChip> : null}
              {variant.oemNumbers
                .filter((oem) => oem !== variant.partNumber)
                .map((oem) => (
                  <CodeChip key={oem} label="oem">
                    {oem}
                  </CodeChip>
                ))}
              {variant.barcode ? <CodeChip label="barra">{variant.barcode}</CodeChip> : null}
              {!variant.isActive ? (
                <span className="self-center text-[10.5px] uppercase tracking-wide text-[var(--color-stock-out)]">
                  inactiva
                </span>
              ) : null}
            </div>

            <ul className="mt-2 space-y-1">
              {variant.stock.map((row) => (
                <li
                  key={row.warehouseId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-xs)] bg-[var(--surface-sunken)] px-2 py-1"
                >
                  <span className="min-w-0 truncate text-[11.5px] text-[var(--foreground)]">
                    {row.warehouseCode} · {row.warehouseName}
                    {row.binLocation ? (
                      <span className="ml-1 font-mono text-[10.5px] text-[var(--foreground-muted)]">
                        {row.binLocation}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <StockPill quantity={row.available} reorderPoint={row.reorderPoint} />
                    {canAdjust ? (
                      <StockAdjust part={part} variantId={variant.id} row={row} busy={busy} mutate={mutate} />
                    ) : null}
                  </span>
                </li>
              ))}
              {variant.stock.length === 0 ? (
                <li className="text-[11.5px] text-[var(--foreground-muted)]">
                  Sin fila de existencia: nunca entró a ninguna bodega visible para ti.
                </li>
              ) : null}
            </ul>

            {canUpdate ? (
              <div className="mt-1.5 flex gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() =>
                      api(`/api/catalog/parts/${part.id}/variants/${variant.id}`, {
                        method: 'PATCH',
                        body: { isActive: !variant.isActive },
                      }),
                    )
                  }
                  className="text-[11.5px] text-[var(--color-copper-700)] hover:underline disabled:opacity-50"
                >
                  {variant.isActive ? 'Desactivar' : 'Reactivar'}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Ajuste en línea: la persona escribe la existencia final de esa bodega. */
function StockAdjust({
  part,
  variantId,
  row,
  busy,
  mutate,
}: {
  part: CatalogPartDetail;
  variantId: string;
  row: CatalogPartDetail['variants'][number]['stock'][number];
  busy: boolean;
  mutate: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(row.onHand));
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(String(row.onHand));
          setOpen(true);
        }}
        className="text-[11px] text-[var(--color-copper-700)] hover:underline"
      >
        ajustar
      </button>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await mutate(() =>
          api(`/api/catalog/parts/${part.id}/variants/${variantId}/stock`, {
            method: 'POST',
            body: {
              warehouseId: row.warehouseId,
              onHand: Number(value),
              reason: reason.trim() || undefined,
            },
          }),
        );
        setOpen(false);
        setReason('');
      }}
      className="flex flex-wrap items-center gap-1"
    >
      <label className="sr-only" htmlFor={`stock-${variantId}-${row.warehouseId}`}>
        Existencia final en {row.warehouseName}
      </label>
      <Input
        id={`stock-${variantId}-${row.warehouseId}`}
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 7))}
        className="h-7 w-16 px-1.5 text-[12px]"
        autoFocus
      />
      <Input
        aria-label="Motivo del ajuste"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Motivo"
        maxLength={200}
        className="h-7 w-32 px-1.5 text-[12px]"
      />
      <Button type="submit" size="sm" loading={busy} className="h-7 px-2 text-[11.5px]">
        Guardar
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[11.5px]"
        onClick={() => setOpen(false)}
      >
        Cancelar
      </Button>
    </form>
  );
}

/**
 * Compatibilidad por rango.
 *
 * Se pide "Corolla 2009 a 2013", no una lista de años: es como lo dice el mostrador y como viene en
 * el catálogo del fabricante. Si la aplicación exacta no existe, se crea; si existe, se reutiliza.
 */
function Compatibility({
  part,
  canUpdate,
  busy,
  mutate,
}: {
  part: CatalogPartDetail;
  canUpdate: boolean;
  busy: boolean;
  mutate: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [yearStart, setYearStart] = useState('');
  const [yearEnd, setYearEnd] = useState('');
  const [engine, setEngine] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<VehicleOption[]>([]);

  // Sugerencias de la referencia global: evita que "Toyota" y "toyota " creen dos marcas.
  useEffect(() => {
    const term = `${brand} ${model}`.trim();
    if (term.length < 2) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      api<VehicleOption[]>(`/api/catalog/parts/vehicles?q=${encodeURIComponent(term)}&limit=6`)
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [brand, model]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const parsed = compatibilityRangeSchema.safeParse({
      brand: brand.trim(),
      model: model.trim(),
      yearStart: Number(yearStart),
      yearEnd: Number(yearEnd || yearStart),
      engine: engine.trim() || undefined,
      notes: notes.trim() || undefined,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Revisa el rango');
      return;
    }
    setFormError(null);
    await mutate(() =>
      api(`/api/catalog/parts/${part.id}/compatibility`, { method: 'POST', body: { ranges: [parsed.data] } }),
    );
    setModel('');
    setYearStart('');
    setYearEnd('');
    setEngine('');
    setNotes('');
  }

  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
        Aplicaciones
      </h3>

      {part.vehicles.length ? (
        <ul className="space-y-1">
          {part.vehicles.map((v) => (
            <li
              key={v.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-xs)] bg-[var(--surface-sunken)] px-2 py-1"
            >
              <span className="text-[12px] text-[var(--foreground)]">
                {v.brand} {v.model}{' '}
                <span className="partops-num text-[var(--foreground-muted)]">
                  {v.yearStart === v.yearEnd ? v.yearStart : `${v.yearStart}–${v.yearEnd}`}
                </span>
                {v.engine ? <span className="ml-1 text-[var(--foreground-muted)]">{v.engine}</span> : null}
                {v.notes ? (
                  <span className="ml-1 text-[11px] text-[var(--foreground-muted)]">({v.notes})</span>
                ) : null}
              </span>
              {canUpdate ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() =>
                      api(`/api/catalog/parts/${part.id}/compatibility/${v.id}`, { method: 'DELETE' }),
                    )
                  }
                  className="text-[11px] text-[var(--color-stock-out)] hover:underline disabled:opacity-50"
                >
                  Quitar
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-[var(--foreground-muted)]">
          {part.isUniversal ? 'Es universal: aplica a cualquier vehículo.' : 'Sin aplicaciones todavía.'}
        </p>
      )}

      {canUpdate ? (
        <form
          onSubmit={add}
          className="mt-2 space-y-2 rounded-[var(--radius-sm)] border border-[var(--border)] p-2.5"
        >
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="Marca" htmlFor="compat-brand" required>
              <Input
                id="compat-brand"
                required
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="Toyota"
                list="vehicle-brands"
              />
            </Field>
            <Field label="Modelo" htmlFor="compat-model" required>
              <Input
                id="compat-model"
                required
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Corolla"
              />
            </Field>
            <Field label="Desde" htmlFor="compat-year-start" required hint="Año">
              <Input
                id="compat-year-start"
                required
                inputMode="numeric"
                value={yearStart}
                onChange={(e) => setYearStart(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="2009"
              />
            </Field>
            <Field label="Hasta" htmlFor="compat-year-end" hint="Vacío = mismo año">
              <Input
                id="compat-year-end"
                inputMode="numeric"
                value={yearEnd}
                onChange={(e) => setYearEnd(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="2013"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Motor" htmlFor="compat-engine" hint="Opcional">
              <Input
                id="compat-engine"
                value={engine}
                onChange={(e) => setEngine(e.target.value)}
                placeholder="1.8L"
              />
            </Field>
            <Field label="Nota" htmlFor="compat-notes" hint="Opcional">
              <Input
                id="compat-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Solo con ABS"
              />
            </Field>
          </div>

          {suggestions.length ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10.5px] uppercase tracking-wide text-[var(--foreground-muted)]">
                Ya existe:
              </span>
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setBrand(s.brand);
                    setModel(s.model);
                    setYearStart(String(s.yearStart));
                    setYearEnd(String(s.yearEnd));
                    setEngine(s.engine ?? '');
                  }}
                  className="rounded-[var(--radius-xs)] border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11.5px] text-[var(--foreground)] hover:bg-[var(--surface-sunken)]"
                >
                  {s.brand} {s.model}{' '}
                  <span className="partops-num text-[var(--foreground-muted)]">
                    {s.yearStart === s.yearEnd ? s.yearStart : `${s.yearStart}–${s.yearEnd}`}
                  </span>
                  {s.engine ? <span className="ml-1 text-[var(--foreground-muted)]">{s.engine}</span> : null}
                </button>
              ))}
            </div>
          ) : null}

          <Button type="submit" size="sm" variant="secondary" loading={busy}>
            Agregar aplicación
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function Images({
  part,
  canUpdate,
  busy,
  mutate,
}: {
  part: CatalogPartDetail;
  canUpdate: boolean;
  busy: boolean;
  mutate: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      await apiUpload(`/api/catalog/parts/${part.id}/images`, file);
      await mutate(async () => undefined);
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const ids = part.images.map((i) => i.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    const a = ids[index]!;
    const b = ids[target]!;
    ids[index] = b;
    ids[target] = a;
    await mutate(() => api(`/api/catalog/parts/${part.id}/images/order`, { method: 'PUT', body: { ids } }));
  }

  return (
    <section>
      <h3 className="mb-2 flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
        <span>Fotos</span>
        <span className="normal-case tracking-normal">
          {part.images.length} de {MAX_IMAGES_PER_PART} · la primera es la portada
        </span>
      </h3>

      {uploadError ? (
        <Alert tone="error" className="mb-2">
          {uploadError}
        </Alert>
      ) : null}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {part.images.map((image, index) => (
          <figure
            key={image.id}
            className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)]"
          >
            {/* `unoptimized`: la imagen ya viene en AVIF a 1400 px de sharp; el optimizador de
                Next la re-codificaría por segunda vez sin ganar un byte. */}
            <Image
              src={image.url}
              alt={image.alt ?? part.name}
              width={400}
              height={400}
              unoptimized
              className="aspect-square w-full object-cover"
            />
            {canUpdate ? (
              <div className="flex items-center justify-between gap-1 bg-[var(--surface-sunken)] px-1 py-0.5">
                <button
                  type="button"
                  disabled={busy || index === 0}
                  onClick={() => void move(index, -1)}
                  aria-label="Mover antes"
                  className="px-1 text-[12px] text-[var(--foreground-muted)] disabled:opacity-30"
                >
                  ←
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() =>
                      api(`/api/catalog/parts/${part.id}/images/${image.id}`, { method: 'DELETE' }),
                    )
                  }
                  className="text-[10.5px] text-[var(--color-stock-out)] disabled:opacity-40"
                >
                  Quitar
                </button>
                <button
                  type="button"
                  disabled={busy || index === part.images.length - 1}
                  onClick={() => void move(index, 1)}
                  aria-label="Mover después"
                  className="px-1 text-[12px] text-[var(--foreground-muted)] disabled:opacity-30"
                >
                  →
                </button>
              </div>
            ) : null}
          </figure>
        ))}

        {canUpdate && part.images.length < MAX_IMAGES_PER_PART ? (
          <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-strong)] text-[11.5px] text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)]">
            <span>{uploading ? 'Subiendo…' : 'Agregar foto'}</span>
            <span className="text-[10px]">JPG, PNG o HEIC</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void upload(file);
              }}
            />
          </label>
        ) : null}
      </div>

      <p className="mt-1.5 text-[11px] text-[var(--foreground-muted)]">
        La foto se reduce a 1400 px y se guarda en AVIF con respaldo WebP. El EXIF —incluidas las coordenadas
        de dónde se tomó— se descarta al re-codificarla.
      </p>
    </section>
  );
}

function Movements({ part }: { part: CatalogPartDetail }) {
  const [open, setOpen] = useState(false);
  if (!part.movements.length) return null;

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 border-t border-[var(--border)] pt-3 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
          Últimos movimientos
        </span>
        <span className="text-[11.5px] text-[var(--color-copper-700)]">{open ? 'Ocultar' : 'Ver'}</span>
      </button>

      {open ? (
        <ul className="mt-2 space-y-1">
          {part.movements.map((m) => (
            <li key={m.id} className="flex items-baseline justify-between gap-2 text-[11.5px]">
              <span className="min-w-0 truncate text-[var(--foreground)]">
                <span className="partops-num text-[var(--foreground-muted)]">
                  {new Date(m.createdAt).toLocaleString('es-GT', { dateStyle: 'short', timeStyle: 'short' })}
                </span>{' '}
                {MOVEMENT_LABEL[m.type] ?? m.type} · {m.warehouseCode}
                {m.reason ? <span className="text-[var(--foreground-muted)]"> · {m.reason}</span> : null}
                {m.userName ? <span className="text-[var(--foreground-muted)]"> · {m.userName}</span> : null}
              </span>
              <span
                className={`partops-num shrink-0 ${
                  m.delta > 0 ? 'text-[var(--color-stock-ok)]' : 'text-[var(--color-stock-out)]'
                }`}
              >
                {m.delta > 0 ? '+' : ''}
                {m.delta} → {m.balanceAfter}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
