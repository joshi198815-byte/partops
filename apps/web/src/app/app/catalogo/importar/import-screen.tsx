'use client';

import {
  type ColumnMapping,
  formatMoney,
  IMPORT_FIELDS,
  IMPORT_MODE_HINT,
  IMPORT_MODE_LABEL,
  IMPORT_MODES,
  IMPORT_STATUS_LABEL,
  type ImportFieldKey,
  type ImportJobDetail,
  type ImportJobSummary,
  type ImportMode,
  type ImportPreview,
  type ImportSheet,
  type ImportStatusKey,
  type ImportUploadResponse,
  mappingProblems,
} from '@partops/contracts';
import { Alert, Button, CodeChip, EmptyState, Field, Select } from '@partops/ui';
import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ApiError, api, apiUrl, CROSS_ORIGIN_API, errorMessage } from '@/lib/api';

interface Warehouse {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
}

/**
 * Importación desde Excel.
 *
 * La pantalla es un asistente de tres pasos porque el archivo se revisa antes de tocar la base. El
 * orden no es decorativo: subir → mapear → confirmar. Si se pudiera confirmar sin ver el mapeo, la
 * primera importación de una bodega metería la columna "Costo" como precio de venta y nadie lo
 * notaría hasta la primera venta con pérdida.
 *
 * Cada paso es una tarjeta numerada y no un wizard de una sola pantalla: quien vuelve al día
 * siguiente a revisar el reporte de errores encuentra el mismo archivo y el mismo estado.
 */
export function ImportScreen({ canImport }: { canImport: boolean }) {
  const [upload, setUpload] = useState<ImportUploadResponse | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mode, setMode] = useState<ImportMode>('CREAR');
  const [warehouseId, setWarehouseId] = useState<string>('');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [result, setResult] = useState<ImportJobDetail | null>(null);
  const [busy, setBusy] = useState<'upload' | 'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const required = useMemo(() => mappingProblems(mapping), [mapping]);

  const loadWarehouses = useCallback(async () => {
    try {
      const rows = await api<Warehouse[]>('/api/catalog/parts/warehouses');
      setWarehouses(rows);
      setWarehouseId((current) => current || (rows.find((w) => w.isDefault)?.id ?? rows[0]?.id ?? ''));
    } catch {
      // Sin bodegas el importador sigue funcionando si el archivo trae la columna de bodega.
    }
  }, []);

  async function send(file: File) {
    setBusy('upload');
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(apiUrl('/api/catalog/imports'), {
        method: 'POST',
        body: form,
        credentials: CROSS_ORIGIN_API ? 'include' : 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new ApiError(res.status, undefined, body?.message ?? 'No se pudo leer el archivo');
      }
      const data = (await res.json()) as ImportUploadResponse;
      setUpload(data);
      setMapping(data.sheet.mapping);
      setPreview(data.preview);
      setMode('CREAR');
      void loadWarehouses();
    } catch (err) {
      setError(errorMessage(err));
      setUpload(null);
    } finally {
      setBusy(null);
    }
  }

  async function remap(next: ColumnMapping) {
    setMapping(next);
    if (!upload) return;
    setBusy('preview');
    setError(null);
    try {
      const fresh = await api<ImportPreview>(`/api/catalog/imports/${upload.job.id}/preview`, {
        method: 'POST',
        body: { mapping: next },
      });
      setPreview(fresh);
    } catch (err) {
      setError(errorMessage(err));
      // Se conserva la vista previa anterior: es mejor un resumen viejo que una pantalla en blanco.
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!upload) return;
    setBusy('commit');
    setError(null);
    try {
      const done = await api<ImportJobDetail>(`/api/catalog/imports/${upload.job.id}/commit`, {
        method: 'POST',
        body: { mode, mapping, warehouseId: warehouseId || null },
      });
      setResult(done);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    setUpload(null);
    setPreview(null);
    setResult(null);
    setMapping({});
    setError(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  if (!canImport) {
    return (
      <EmptyState
        title="No puedes importar el catálogo"
        description="Pide a un administrador el permiso de importar desde Excel. Crear una pieza a la vez no requiere ese permiso."
        action={
          <Link
            href="/app/catalogo"
            className="text-[13px] font-medium text-[var(--color-copper-700)] hover:underline"
          >
            Volver al catálogo
          </Link>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--foreground-muted)]">
            Catálogo
          </p>
          <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
            Importar desde Excel
          </h1>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-[var(--foreground-muted)]">
            Sube el archivo tal como lo tienes. Revisas el mapeo y la vista previa antes de que se escriba
            nada.
          </p>
        </div>
        <Link
          href="/app/catalogo"
          className="text-[13px] font-medium text-[var(--color-copper-700)] hover:underline"
        >
          Volver al catálogo
        </Link>
      </header>

      {error ? (
        <div className="mb-4">
          <Alert tone="error" title="No se pudo completar">
            {error}
          </Alert>
        </div>
      ) : null}

      {result ? (
        <Result result={result} onAgain={reset} />
      ) : (
        <ol className="space-y-4">
          <StepCard step={1} title="El archivo" done={Boolean(upload)} active={!upload}>
            {upload ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium text-[var(--foreground)]">
                      {upload.job.fileName}
                    </p>
                    <p className="partops-num text-[12px] text-[var(--foreground-muted)]">
                      {upload.sheet.sheetName} · {upload.sheet.rowCount}{' '}
                      {upload.sheet.rowCount === 1 ? 'fila' : 'filas'} · {upload.sheet.headers.length}{' '}
                      columnas
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={reset}>
                    Cambiar archivo
                  </Button>
                </div>
                {upload.sheet.truncated ? (
                  <Alert tone="error" title="El archivo se cortó">
                    Solo se leyeron las primeras 5.000 filas. Sube el resto en un segundo archivo: si se
                    importa a medias, nadie sabe qué piezas faltan.
                  </Alert>
                ) : null}
              </div>
            ) : (
              /**
               * La zona de arrastre es un `label` del input: así el clic, el teclado y el lector de
               * pantalla funcionan sin `role` inventados, y arrastrar el archivo sigue siendo un
               * atajo, no la única forma.
               */
              <label
                htmlFor="import-file"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) void send(file);
                }}
                className={`flex cursor-pointer flex-col items-center gap-3 rounded-[var(--radius-sm)] border border-dashed px-6 py-8 text-center transition-colors ${
                  dragging
                    ? 'border-[var(--color-copper-600)] bg-[var(--surface-sunken)]'
                    : 'border-[var(--border-strong)] hover:border-[var(--border-strong)]'
                }`}
              >
                <span className="text-[13.5px] text-[var(--foreground)]">
                  Arrastra el archivo aquí o elígelo del disco
                </span>
                <span className="text-[12px] text-[var(--foreground-muted)]">
                  .xlsx o .csv · hasta 10 MB y 5.000 filas
                </span>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".xlsx,.csv"
                  className="sr-only"
                  id="import-file"
                  disabled={busy === 'upload'}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void send(file);
                  }}
                />
                <span
                  className="inline-flex h-9 items-center rounded-[var(--radius-sm)] bg-[var(--primary)] px-3 text-[13px] font-medium text-[var(--primary-foreground)]"
                  aria-hidden
                >
                  {busy === 'upload' ? 'Leyendo…' : 'Elegir archivo'}
                </span>
              </label>
            )}
          </StepCard>

          {upload && preview ? (
            <>
              <StepCard step={2} title="El mapeo" done={required.length === 0} active>
                <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--foreground-muted)]">
                  Cada columna de tu archivo se asigna a un dato del sistema. Se propuso solo; corrige lo que
                  esté mal.
                </p>
                <MappingGrid sheet={upload.sheet} mapping={mapping} onChange={(next) => void remap(next)} />
                {upload.sheet.unmapped.length ? (
                  <p className="mt-3 text-[12px] text-[var(--foreground-muted)]">
                    <span className="font-medium text-[var(--foreground)]">Sin usar:</span>{' '}
                    {upload.sheet.unmapped.join(', ')}. Se ignoran, no se borran de tu archivo.
                  </p>
                ) : null}
                {required.length ? (
                  <div className="mt-3">
                    <Alert tone="error" title="Falta mapear lo indispensable">
                      {required.join(' · ')}
                    </Alert>
                  </div>
                ) : null}
              </StepCard>

              <StepCard
                step={3}
                title="La vista previa"
                done={false}
                active={required.length === 0}
                aside={
                  busy === 'preview' ? (
                    <span className="text-[11.5px] text-[var(--foreground-muted)]">Recalculando…</span>
                  ) : null
                }
              >
                <PreviewBody preview={preview} />

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label="Qué hacer con los SKU que ya existen" htmlFor="mode">
                    <Select id="mode" value={mode} onChange={(e) => setMode(e.target.value as ImportMode)}>
                      {IMPORT_MODES.map((m) => (
                        <option key={m} value={m}>
                          {IMPORT_MODE_LABEL[m]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Bodega por defecto" htmlFor="warehouse" hint="si el archivo no la trae">
                    <Select
                      id="warehouse"
                      value={warehouseId}
                      onChange={(e) => setWarehouseId(e.target.value)}
                    >
                      <option value="">Sin bodega por defecto</option>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code} · {w.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--foreground-muted)]">
                  {IMPORT_MODE_HINT[mode]}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
                  <Button
                    onClick={() => void confirm()}
                    loading={busy === 'commit'}
                    disabled={required.length > 0 || preview.validRows === 0}
                  >
                    Importar {preview.validRows} {preview.validRows === 1 ? 'fila' : 'filas'}
                  </Button>
                  <span className="text-[12px] text-[var(--foreground-muted)]">
                    {preview.invalidRows > 0
                      ? `Las ${preview.invalidRows} con error quedan fuera y se reportan abajo.`
                      : 'Nada se guardó todavía.'}
                  </span>
                </div>
              </StepCard>
            </>
          ) : null}
        </ol>
      )}
    </div>
  );
}

function StepCard({
  step,
  title,
  done,
  active,
  aside,
  children,
}: {
  step: number;
  title: string;
  done: boolean;
  active: boolean;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li
      className={`rounded-[var(--radius-md)] border bg-[var(--surface)] ${
        active ? 'border-[var(--border-strong)]' : 'border-[var(--border)]'
      }`}
    >
      <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
        <span
          className={`partops-num flex size-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold ${
            done
              ? 'border-[var(--color-stock-ok)] text-[var(--color-stock-ok)]'
              : 'border-[var(--border-strong)] text-[var(--foreground-muted)]'
          }`}
        >
          {done ? '✓' : step}
        </span>
        <h2 className="text-[13.5px] font-semibold text-[var(--foreground)]">{title}</h2>
        {aside ? <span className="ml-auto">{aside}</span> : null}
      </div>
      <div className="px-4 py-4">{children}</div>
    </li>
  );
}

const GROUP_LABEL: Record<string, string> = {
  pieza: 'De la pieza',
  vehiculo: 'Del vehículo al que aplica',
  inventario: 'Del inventario',
};

/** Un selector por campo conocido, con lo que el archivo trae como opciones. */
function MappingGrid({
  sheet,
  mapping,
  onChange,
}: {
  sheet: ImportSheet;
  mapping: ColumnMapping;
  onChange: (next: ColumnMapping) => void;
}) {
  const byKey = new Map(Object.entries(mapping).filter(([, v]) => Boolean(v)) as [string, string][]);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {IMPORT_FIELDS.map((field) => {
        const id = `map-${field.key}`;
        return (
          <Field
            key={field.key}
            label={field.label}
            htmlFor={id}
            required={field.required}
            hint={field.required ? undefined : GROUP_LABEL[field.group]}
          >
            <Select
              id={id}
              value={byKey.get(field.key) ?? ''}
              onChange={(e) => {
                const next: ColumnMapping = { ...mapping };
                const value = e.target.value;
                if (value) next[field.key] = value;
                else delete next[field.key as ImportFieldKey];
                onChange(next);
              }}
              className="h-10 text-[13px]"
            >
              <option value="">— sin usar —</option>
              {sheet.headers.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </Select>
          </Field>
        );
      })}
    </div>
  );
}

function PreviewBody({ preview }: { preview: ImportPreview }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Mini label="Válidas" value={preview.validRows} tone="ok" />
        <Mini label="Con error" value={preview.invalidRows} tone={preview.invalidRows ? 'bad' : 'muted'} />
        <Mini label="Piezas" value={preview.parts} />
        <Mini label="Aplicaciones" value={preview.compatibilities} />
      </div>

      {preview.sample.length ? (
        <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
          <table className="w-full text-left text-[12.5px]">
            <thead className="bg-[var(--surface-sunken)] text-[11px] uppercase tracking-wide text-[var(--foreground-muted)]">
              <tr>
                <th className="px-2.5 py-1.5 font-semibold">Fila</th>
                <th className="px-2.5 py-1.5 font-semibold">SKU</th>
                <th className="px-2.5 py-1.5 font-semibold">Pieza</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Precio</th>
                <th className="px-2.5 py-1.5 text-right font-semibold">Exist.</th>
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((s) => (
                <tr key={s.rowNumber} className="border-t border-[var(--border)]">
                  <td className="partops-num px-2.5 py-1.5 text-[var(--foreground-muted)]">{s.rowNumber}</td>
                  <td className="px-2.5 py-1.5">
                    <CodeChip>{s.row.sku ?? '—'}</CodeChip>
                  </td>
                  <td className="max-w-[220px] truncate px-2.5 py-1.5 text-[var(--foreground)]">
                    {s.row.name}
                  </td>
                  <td className="partops-num px-2.5 py-1.5 text-right text-[var(--foreground)]">
                    {formatMoney(s.row.priceCents)}
                  </td>
                  <td className="partops-num px-2.5 py-1.5 text-right text-[var(--foreground-muted)]">
                    {s.row.stock}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {preview.errors.length ? (
        <div className="rounded-[var(--radius-sm)] border border-[var(--border)]">
          <p className="border-b border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
            Filas que no se van a importar
          </p>
          <ul className="max-h-52 divide-y divide-[var(--border)] overflow-y-auto">
            {preview.errors.slice(0, 100).map((e) => (
              <li key={e.rowNumber} className="flex items-start gap-2 px-3 py-1.5 text-[12.5px]">
                <span className="partops-num w-10 shrink-0 text-[var(--foreground-muted)]">
                  {e.rowNumber}
                </span>
                <span className="text-[var(--color-stock-out)]">
                  {e.errors.map((err) => err.message).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          {preview.errors.length > 100 ? (
            <p className="border-t border-[var(--border)] px-3 py-1.5 text-[11.5px] text-[var(--foreground-muted)]">
              y {preview.errors.length - 100} más. Corrige el archivo y vuelve a subirlo.
            </p>
          ) : null}
        </div>
      ) : null}

      {preview.warnings.length ? (
        <p className="text-[12px] text-[var(--foreground-muted)]">
          <span className="font-medium text-[var(--foreground)]">Avisos:</span>{' '}
          {preview.warnings
            .slice(0, 3)
            .map((w) => `fila ${w.rowNumber}: ${w.warnings.map((x) => x.message).join(', ')}`)
            .join('; ')}
          {preview.warnings.length > 3 ? ` y ${preview.warnings.length - 3} más.` : '.'}
        </p>
      ) : null}
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'bad' | 'muted' }) {
  const color =
    tone === 'ok'
      ? 'text-[var(--color-stock-ok)]'
      : tone === 'bad'
        ? 'text-[var(--color-stock-out)]'
        : 'text-[var(--foreground)]';
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 py-2">
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
        {label}
      </p>
      <p className={`partops-num text-[17px] font-semibold leading-tight ${color}`}>{value}</p>
    </div>
  );
}

function Result({ result, onAgain }: { result: ImportJobDetail; onAgain: () => void }) {
  const ok = result.status === 'COMPLETADA';
  return (
    <div className="space-y-4">
      <Alert
        tone={ok ? 'success' : result.successRows ? 'info' : 'error'}
        title={IMPORT_STATUS_LABEL[result.status as ImportStatusKey]}
      >
        {result.successRows} {result.successRows === 1 ? 'fila importada' : 'filas importadas'}
        {result.errorRows ? ` · ${result.errorRows} con error` : ''}
        {result.skippedRows ? ` · ${result.skippedRows} omitidas` : ''}.
      </Alert>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Mini label="Piezas nuevas" value={result.createdParts} />
        <Mini label="Variantes nuevas" value={result.createdVariants} />
        <Mini label="Actualizadas" value={result.updatedVariants} />
        <Mini label="Errores" value={result.errorRows} tone={result.errorRows ? 'bad' : 'muted'} />
      </div>

      {result.rowErrors.length ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--border)]">
          <p className="border-b border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
            Para corregir en el Excel
          </p>
          <ul className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto">
            {result.rowErrors.map((e, i) => (
              <li
                key={`${e.rowNumber}-${e.field ?? i}`}
                className="flex items-start gap-2 px-3 py-1.5 text-[12.5px]"
              >
                <span className="partops-num w-10 shrink-0 text-[var(--foreground-muted)]">
                  {e.rowNumber}
                </span>
                <span className="text-[var(--foreground)]">{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onAgain}>
          Importar otro archivo
        </Button>
        <Link
          href="/app/catalogo"
          className="inline-flex h-10 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-[var(--color-copper-700)] hover:underline"
        >
          Ver el catálogo
        </Link>
      </div>
    </div>
  );
}

/** Historial de importaciones: el reporte de ayer sigue disponible hoy. */
export function ImportHistory({ jobs }: { jobs: ImportJobSummary[] }) {
  if (!jobs.length) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--foreground-muted)]">
        Archivos anteriores
      </h2>
      <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)]">
        {jobs.map((job) => (
          <li key={job.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{job.fileName}</span>
            <span className="partops-num text-[var(--foreground-muted)]">
              {job.successRows}/{job.totalRows}
            </span>
            <span className="text-[var(--foreground-muted)]">{IMPORT_STATUS_LABEL[job.status]}</span>
            <time className="partops-num text-[11.5px] text-[var(--foreground-muted)]">
              {new Date(job.createdAt).toLocaleDateString('es-GT', {
                day: '2-digit',
                month: 'short',
              })}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}
