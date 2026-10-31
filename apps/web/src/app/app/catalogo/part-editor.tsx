'use client';

import {
  type CatalogPartSummary,
  MAX_VARIANTS_PER_PART,
  normalizeSku,
  PART_CONDITIONS,
  PART_UNITS,
  type PartConditionKey,
  type PartUnit,
  partCreateSchema,
  partUpdateSchema,
} from '@partops/contracts';
import { Alert, Button, Field, Input, Select, TextArea } from '@partops/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSubmit, zodIssues } from '@/lib/use-submit';

interface VariantDraft {
  key: string;
  sku: string;
  title: string;
  partNumber: string;
  oemNumbers: string;
  price: string;
  cost: string;
}

const CONDITION_LABEL: Record<PartConditionKey, string> = {
  NUEVO: 'Nuevo',
  USADO: 'Usado',
  REMANUFACTURADO: 'Remanufacturado',
};

const UNIT_LABEL: Record<PartUnit, string> = {
  UNIDAD: 'Unidad',
  PAR: 'Par',
  JUEGO: 'Juego',
  KIT: 'Kit',
  LITRO: 'Litro',
  METRO: 'Metro',
};

let draftSeq = 0;
function emptyVariant(): VariantDraft {
  draftSeq += 1;
  return { key: `v${draftSeq}`, sku: '', title: '', partNumber: '', oemNumbers: '', price: '', cost: '' };
}

/**
 * Alta y edición de la pieza.
 *
 * El precio se pide en el alta y no después: una pieza sin precio aparece en el catálogo, se
 * encuentra en la búsqueda y no se puede cobrar. Es mejor frenar aquí que descubrirlo en caja.
 *
 * Las variantes se capturan en filas y no en una pantalla aparte porque en el mostrador se piensa
 * "este capó, izquierdo y derecho": dos filas de la misma pieza, no dos piezas.
 */
export function PartEditor({
  part,
  categories,
  onClose,
  onSaved,
}: {
  part: CatalogPartSummary | null;
  categories: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const editing = Boolean(part);
  const { pending, error, issues, run, setError } = useSubmit();

  const [name, setName] = useState(part?.name ?? '');
  const [brand, setBrand] = useState(part?.brand ?? '');
  const [categoryId, setCategoryId] = useState(part?.categoryId ?? '');
  const [newCategory, setNewCategory] = useState('');
  const [condition, setCondition] = useState<PartConditionKey>(part?.condition ?? 'NUEVO');
  const [unit, setUnit] = useState<PartUnit>((part?.unit as PartUnit) ?? 'UNIDAD');
  const [warranty, setWarranty] = useState(part?.warrantyDays ? String(part.warrantyDays) : '');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [variants, setVariants] = useState<VariantDraft[]>([emptyVariant()]);
  const [variantIssues, setVariantIssues] = useState<Record<string, string>>({});

  function patchVariant(key: string, patch: Partial<VariantDraft>) {
    setVariants((current) => current.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();

    const shared = {
      name: name.trim(),
      brand: brand.trim() || undefined,
      ...(categoryId ? { categoryId } : newCategory.trim() ? { categoryName: newCategory.trim() } : {}),
      condition,
      unit,
      warrantyDays: warranty.trim() ? Number(warranty) : undefined,
      description: description.trim() || undefined,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };

    if (editing) {
      const parsed = partUpdateSchema.safeParse({
        ...shared,
        brand: shared.brand ?? null,
        warrantyDays: shared.warrantyDays ?? null,
        description: shared.description ?? null,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Revisa los datos');
        return;
      }
      const ok = await run(async () => {
        await api(`/api/catalog/parts/${part!.id}`, { method: 'PATCH', body: parsed.data });
      });
      if (ok) onSaved(part!.id);
      return;
    }

    const payload = {
      ...shared,
      variants: variants.map((v) => ({
        sku: v.sku,
        title: v.title.trim() || undefined,
        partNumber: v.partNumber.trim() || undefined,
        oemNumbers: v.oemNumbers,
        price: v.price,
        cost: v.cost.trim() ? v.cost : undefined,
      })),
    };

    const parsed = partCreateSchema.safeParse(payload);
    if (!parsed.success) {
      // Los errores de una variante llegan con ruta `variants.0.sku`: se pintan en su fila.
      setError(parsed.error.issues[0]?.message ?? 'Revisa los datos');
      const byPath = zodIssues(parsed);
      setVariantIssues(byPath);
      return;
    }
    setVariantIssues({});

    const ok = await run(async () => {
      const created = await api<{ id: string }>('/api/catalog/parts', { method: 'POST', body: parsed.data });
      onSaved(created.id);
    });
    if (!ok) return;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="part-editor-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) onClose();
      }}
    >
      <form
        onSubmit={save}
        noValidate
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] sm:rounded-[var(--radius-lg)]"
      >
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h2 id="part-editor-title" className="text-[15px] font-semibold text-[var(--foreground)]">
            {editing ? `Editar ${part!.name}` : 'Nueva pieza'}
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--foreground-muted)]">
            {editing
              ? 'Nombre, marca y garantía. Las variantes y el precio se editan desde la ficha.'
              : 'Una pieza con al menos una variante: es lo que se cobra y lo que se cuenta.'}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {error ? <Alert tone="error">{error}</Alert> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre" htmlFor="part-name" required error={issues.name} className="sm:col-span-2">
              <Input
                id="part-name"
                required
                maxLength={120}
                value={name}
                invalid={Boolean(issues.name)}
                onChange={(e) => setName(e.target.value)}
                placeholder="Capó delantero"
                autoFocus
              />
            </Field>

            <Field label="Marca" htmlFor="part-brand" hint="Opcional" error={issues.brand}>
              <Input
                id="part-brand"
                maxLength={60}
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="Toyota"
              />
            </Field>

            <Field label="Categoría" htmlFor="part-category" error={issues.categoryId ?? issues.categoryName}>
              <Select
                id="part-category"
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  if (e.target.value) setNewCategory('');
                }}
              >
                <option value="">Sin categoría</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="__new">+ Nueva categoría…</option>
              </Select>
            </Field>

            {categoryId === '__new' || newCategory ? (
              <Field
                label="Nombre de la categoría nueva"
                htmlFor="part-category-new"
                className="sm:col-span-2"
                error={issues.categoryName}
              >
                <Input
                  id="part-category-new"
                  maxLength={60}
                  value={newCategory}
                  onChange={(e) => {
                    setNewCategory(e.target.value);
                    setCategoryId('__new');
                  }}
                  placeholder="Suspensión"
                />
              </Field>
            ) : null}

            <Field label="Condición" htmlFor="part-condition" error={issues.condition}>
              <Select
                id="part-condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value as PartConditionKey)}
              >
                {PART_CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {CONDITION_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Unidad" htmlFor="part-unit" error={issues.unit}>
              <Select id="part-unit" value={unit} onChange={(e) => setUnit(e.target.value as PartUnit)}>
                {PART_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABEL[u]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Garantía" htmlFor="part-warranty" hint="Días" error={issues.warrantyDays}>
              <Input
                id="part-warranty"
                inputMode="numeric"
                value={warranty}
                onChange={(e) => setWarranty(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="90"
              />
            </Field>

            <Field label="Etiquetas" htmlFor="part-tags" hint="Separadas por coma" className="sm:col-span-2">
              <Input
                id="part-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="delantero, original"
              />
            </Field>

            <Field label="Descripción" htmlFor="part-description" hint="Opcional" className="sm:col-span-2">
              <TextArea
                id="part-description"
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Lo que hay que saber al venderla: incluye empaque, no incluye tornillería…"
              />
            </Field>
          </div>

          {!editing ? (
            <section className="space-y-2 border-t border-[var(--border)] pt-3">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
                  Variantes
                </h3>
                <span className="text-[11px] text-[var(--foreground-muted)]">
                  {variants.length} de {MAX_VARIANTS_PER_PART}
                </span>
              </div>

              {variants.map((variant, index) => (
                <div
                  key={variant.key}
                  className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11.5px] font-medium text-[var(--foreground)]">
                      Variante {index + 1}
                    </span>
                    {variants.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => setVariants((current) => current.filter((v) => v.key !== variant.key))}
                        className="text-[11.5px] text-[var(--color-stock-out)] hover:underline"
                      >
                        Quitar
                      </button>
                    ) : null}
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field
                      label="SKU"
                      htmlFor={`sku-${variant.key}`}
                      required
                      error={variantIssues[`variants.${index}.sku`]}
                    >
                      <Input
                        id={`sku-${variant.key}`}
                        required
                        value={variant.sku}
                        onChange={(e) => patchVariant(variant.key, { sku: e.target.value })}
                        onBlur={() => {
                          // Se muestra ya normalizado lo que se va a guardar: "capó #12" → "CAPO-12".
                          if (variant.sku.trim())
                            patchVariant(variant.key, { sku: normalizeSku(variant.sku) });
                        }}
                        placeholder="CAP-DEL-0913"
                        spellCheck={false}
                      />
                    </Field>

                    <Field label="Distintivo" htmlFor={`title-${variant.key}`} hint="Izquierdo, 1.8L…">
                      <Input
                        id={`title-${variant.key}`}
                        maxLength={120}
                        value={variant.title}
                        onChange={(e) => patchVariant(variant.key, { title: e.target.value })}
                      />
                    </Field>

                    <Field
                      label="Precio"
                      htmlFor={`price-${variant.key}`}
                      required
                      error={variantIssues[`variants.${index}.price`]}
                    >
                      <Input
                        id={`price-${variant.key}`}
                        required
                        inputMode="decimal"
                        value={variant.price}
                        onChange={(e) => patchVariant(variant.key, { price: e.target.value })}
                        placeholder="450.00"
                      />
                    </Field>

                    <Field
                      label="Costo"
                      htmlFor={`cost-${variant.key}`}
                      hint="Opcional"
                      error={variantIssues[`variants.${index}.cost`]}
                    >
                      <Input
                        id={`cost-${variant.key}`}
                        inputMode="decimal"
                        value={variant.cost}
                        onChange={(e) => patchVariant(variant.key, { cost: e.target.value })}
                        placeholder="300.00"
                      />
                    </Field>

                    <Field label="Número de parte" htmlFor={`pn-${variant.key}`} hint="Opcional">
                      <Input
                        id={`pn-${variant.key}`}
                        maxLength={60}
                        value={variant.partNumber}
                        onChange={(e) => patchVariant(variant.key, { partNumber: e.target.value })}
                        spellCheck={false}
                      />
                    </Field>

                    <Field
                      label="Códigos OEM"
                      htmlFor={`oem-${variant.key}`}
                      hint="Separados por coma"
                      error={variantIssues[`variants.${index}.oemNumbers`]}
                    >
                      <Input
                        id={`oem-${variant.key}`}
                        value={variant.oemNumbers}
                        onChange={(e) => patchVariant(variant.key, { oemNumbers: e.target.value })}
                        placeholder="53301-02330"
                        spellCheck={false}
                      />
                    </Field>
                  </div>
                </div>
              ))}

              {variants.length < MAX_VARIANTS_PER_PART ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setVariants((current) => [...current, emptyVariant()])}
                >
                  Agregar variante
                </Button>
              ) : null}
            </section>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" size="sm" loading={pending}>
            {editing ? 'Guardar cambios' : 'Crear pieza'}
          </Button>
        </div>
      </form>
    </div>
  );
}
