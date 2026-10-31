import {
  amountInWords,
  formatMoney,
  ORDER_CHANNEL_LABEL,
  type OrderChannel,
  type ReceiptPublicView,
} from '@partops/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/**
 * Recibo público.
 *
 * Lo abre el cliente desde WhatsApp, sin cuenta y muchas veces desde un teléfono con mala señal.
 * Por eso: sin JS, sin fuentes externas, una sola columna y el PDF a un toque. Todo se resuelve en
 * el servidor para que la primera pintura ya tenga los datos.
 *
 * `noindex` se fija aquí además de en la API: son dos superficies distintas y basta que una lo
 * olvide para que un recibo con nombre, NIT y compras acabe en Google.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const receipt = await fetchReceipt(token);
  if (!receipt) return { title: 'Recibo no encontrado', robots: { index: false, follow: false } };
  return {
    title: `Recibo ${receipt.folio} · ${receipt.snapshot.tenant.name}`,
    description: `Comprobante del pedido ${receipt.snapshot.orderCode}`,
    robots: { index: false, follow: false, nocache: true },
  };
}

async function fetchReceipt(token: string): Promise<ReceiptPublicView | null> {
  if (!/^[A-Za-z0-9_-]{20,32}$/.test(token)) return null;
  const res = await fetch(`${API_URL}/api/public/receipts/${token}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as ReceiptPublicView;
}

export default async function ReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const receipt = await fetchReceipt(token);
  if (!receipt) notFound();

  const { snapshot } = receipt;
  const brand = snapshot.tenant.brandPrimary;
  const accent = snapshot.tenant.brandAccent;
  const paid = snapshot.totals.paidCents;
  const balance = snapshot.totals.balanceCents;

  return (
    <main className="min-h-dvh bg-[var(--background)] px-4 py-6 text-[var(--foreground)]">
      <article className="mx-auto w-full max-w-[560px] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
        {/* Franja de marca del negocio, no de PartOps: el cliente compró en la bodega. */}
        <div className="h-1.5" style={{ backgroundColor: brand }} />

        <header className="px-5 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-[family-name:var(--font-display)] text-[19px] font-bold leading-tight tracking-[-0.015em]">
                {snapshot.tenant.name}
              </h1>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--foreground-muted)]">
                {[
                  snapshot.tenant.legalName && snapshot.tenant.legalName !== snapshot.tenant.name
                    ? snapshot.tenant.legalName
                    : null,
                  snapshot.tenant.taxId ? `NIT ${snapshot.tenant.taxId}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {snapshot.tenant.address ? (
                <p className="text-[11.5px] leading-relaxed text-[var(--foreground-muted)]">
                  {snapshot.tenant.address}
                </p>
              ) : null}
              {snapshot.tenant.phone ? (
                <p className="partops-num text-[11.5px] text-[var(--foreground-muted)]">
                  {snapshot.tenant.phone}
                </p>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              <p className="font-[family-name:var(--font-display)] text-[17px] font-bold">
                {snapshot.orderCode}
              </p>
              <p className="text-[11px] text-[var(--foreground-muted)]">Recibo {receipt.folio}</p>
              <p className="partops-num text-[11px] text-[var(--foreground-muted)]">
                {new Date(receipt.createdAt).toLocaleDateString('es-GT', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                })}
              </p>
            </div>
          </div>
        </header>

        <section className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-[var(--border)] bg-[var(--surface-sunken)] px-5 py-3 text-[11.5px]">
          <Field label="Cliente" value={snapshot.customer.name} />
          {snapshot.customer.taxId ? <Field label="NIT" value={snapshot.customer.taxId} mono /> : null}
          <Field label="Atendió" value={snapshot.sellerName} />
          <Field label="Bodega" value={snapshot.warehouseCode} />
          <Field
            label="Canal"
            value={ORDER_CHANNEL_LABEL[snapshot.channel as OrderChannel] ?? snapshot.channel}
          />
        </section>

        <section className="px-5 py-4">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th
                  scope="col"
                  className="pb-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]"
                >
                  Pieza
                </th>
                <th
                  scope="col"
                  className="pb-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]"
                >
                  Importe
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.lines.map((line) => (
                <tr key={line.sku} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-2 align-top">
                    <p className="text-[13px] font-medium leading-snug">{line.name}</p>
                    <p className="partops-num text-[10.5px] text-[var(--foreground-muted)]">
                      {line.quantity} × {formatMoney(line.unitPriceCents, snapshot.currency)}
                      {line.oem.length ? ` · OEM ${line.oem.join(', ')}` : ''}
                    </p>
                    {line.vehicle ? (
                      <p className="text-[10.5px] text-[var(--foreground-muted)]">{line.vehicle}</p>
                    ) : null}
                  </td>
                  <td className="partops-num py-2 text-right align-top text-[13px]">
                    {formatMoney(line.totalCents, snapshot.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="border-t border-[var(--border)] px-5 py-4">
          <dl className="ml-auto grid max-w-[260px] grid-cols-2 gap-y-1 text-[12.5px]">
            <dt className="text-[var(--foreground-muted)]">Subtotal</dt>
            <dd className="partops-num text-right">
              {formatMoney(snapshot.totals.subtotalCents, snapshot.currency)}
            </dd>
            {snapshot.totals.discountCents > 0 ? (
              <>
                <dt className="text-[var(--foreground-muted)]">Descuento</dt>
                <dd className="partops-num text-right">
                  −{formatMoney(snapshot.totals.discountCents, snapshot.currency)}
                </dd>
              </>
            ) : null}
            <dt className="text-[var(--foreground-muted)]">IVA {(snapshot.taxRateBps / 100).toFixed(2)}%</dt>
            <dd className="partops-num text-right">
              {formatMoney(snapshot.totals.taxCents, snapshot.currency)}
            </dd>
            <dt className="mt-1 border-t border-[var(--border)] pt-1.5 font-semibold">Total</dt>
            <dd className="partops-num mt-1 border-t border-[var(--border)] pt-1.5 text-right font-semibold">
              {formatMoney(snapshot.totals.totalCents, snapshot.currency)}
            </dd>
            <dt className="text-[var(--foreground-muted)]">Pagado</dt>
            <dd className="partops-num text-right">{formatMoney(paid, snapshot.currency)}</dd>
            {balance !== 0 ? (
              <>
                <dt className="text-[var(--foreground-muted)]">{balance > 0 ? 'Saldo' : 'Cambio'}</dt>
                <dd className="partops-num text-right" style={{ color: accent }}>
                  {formatMoney(Math.abs(balance), snapshot.currency)}
                </dd>
              </>
            ) : null}
          </dl>

          <p className="mt-3 border-t border-[var(--border)] pt-2 text-[10px] uppercase leading-relaxed tracking-[0.04em] text-[var(--foreground-muted)]">
            {amountInWords(snapshot.totals.totalCents, snapshot.currency)}
          </p>
        </section>

        <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-sunken)] px-5 py-4">
          {receipt.pdfUrl ? (
            <a
              href={receipt.pdfUrl}
              className="rounded-[var(--radius-sm)] px-3.5 py-2 text-[13px] font-medium text-white"
              style={{ backgroundColor: brand }}
            >
              Descargar recibo
            </a>
          ) : null}
          {receipt.ticketUrl ? (
            <a
              href={receipt.ticketUrl}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3.5 py-2 text-[13px] font-medium hover:bg-[var(--surface)]"
            >
              Ticket
            </a>
          ) : null}
          <Link
            href="/"
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3.5 py-2 text-[13px] font-medium hover:bg-[var(--surface)]"
          >
            Conocer PartOps
          </Link>
          <p className="ml-auto text-[10.5px] text-[var(--foreground-muted)]">
            {snapshot.notes ?? 'Documento no fiscal'}
          </p>
        </footer>
      </article>

      <p className="mx-auto mt-4 max-w-[560px] text-center text-[10.5px] leading-relaxed text-[var(--foreground-muted)]">
        Este enlace es privado: quien lo tenga puede ver el recibo. No lo publiques.
      </p>
    </main>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
        {label}
      </p>
      <p className={`truncate text-[12px] leading-snug ${mono ? 'partops-num' : ''}`}>{value}</p>
    </div>
  );
}
