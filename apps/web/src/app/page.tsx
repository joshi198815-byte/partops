import { Button, CodeChip, PartOpsLogo, StatTile, StockPill, VehicleBreadcrumb } from '@partops/ui';
import Link from 'next/link';

/**
 * Landing de PartOps.
 *
 * Regla de la casa: ninguna cifra, ningún logo de cliente y ningún testimonio inventado. Lo que
 * aquí se afirma es lo que el producto hace hoy. El sitio vende porque describe el trabajo real
 * de una bodega —buscar por vehículo, saber qué hay en cada estante, despachar sin sobresaltos—
 * no porque prometa un porcentaje mágico.
 */
export default function HomePage() {
  return (
    <main className="min-h-dvh bg-[var(--background)]">
      <SiteHeader />
      <Hero />
      <Workflow />
      <Capabilities />
      <Details />
      <ClosingNote />
      <SiteFooter />
    </main>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--background)]/92 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
        <PartOpsLogo size={20} />
        <nav className="hidden items-center gap-6 text-[13px] text-[var(--foreground-muted)] sm:flex">
          <a href="#flujo" className="hover:text-[var(--foreground)]">
            Cómo funciona
          </a>
          <a href="#capacidades" className="hover:text-[var(--foreground)]">
            Qué incluye
          </a>
          <a href="#detalles" className="hover:text-[var(--foreground)]">
            Detalles
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/entrar">
            <Button variant="ghost" size="sm">
              Entrar
            </Button>
          </Link>
          <Link href="/registro">
            <Button size="sm">Crear cuenta</Button>
          </Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="border-b border-[var(--border)]">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:py-24">
        <div>
          <p className="inline-flex items-center gap-2 rounded-[var(--radius-xs)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
            <span className="size-1.5 rounded-full bg-[var(--accent)]" />
            Hecho para bodegas de Guatemala
          </p>

          <h1 className="mt-5 font-[family-name:var(--font-display)] text-[clamp(2.1rem,4.6vw,3.4rem)] font-extrabold leading-[1.04] tracking-[-0.028em] text-[var(--foreground)]">
            La pieza correcta,
            <br />
            en el estante correcto,
            <br />
            <span className="text-[var(--color-copper-700)]">antes de que el cliente cuelgue.</span>
          </h1>

          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--foreground-muted)]">
            PartOps busca por vehículo, número OEM o como lo dice el cliente en el mostrador. Sabe qué hay en
            cada bodega, reserva lo que se está vendiendo y avisa al bodeguero qué preparar. Sin hojas de
            Excel paralelas.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link href="/registro">
              <Button size="lg">Empezar con mi bodega</Button>
            </Link>
            <Link href="/catalogo">
              <Button size="lg" variant="secondary">
                Ver el catálogo de ejemplo
              </Button>
            </Link>
          </div>

          <p className="mt-4 text-[12px] text-[var(--foreground-muted)]">
            Se configura en una tarde. Importa su Excel actual: no hay que capturar el catálogo otra vez.
          </p>
        </div>

        {/* Vista previa del producto: la búsqueda real, con la jerga de mostrador. */}
        <div className="relative">
          <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
              <span className="size-2 rounded-full bg-[var(--border-strong)]" />
              <span className="size-2 rounded-full bg-[var(--border-strong)]" />
              <span className="size-2 rounded-full bg-[var(--border-strong)]" />
              <span className="ml-2 font-mono text-[11px] text-[var(--foreground-muted)]">
                partops.gt/app/buscar
              </span>
            </div>

            <div className="p-4">
              <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--background)] px-3 py-2.5">
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="size-4 shrink-0 text-[var(--foreground-muted)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <circle cx="7" cy="7" r="4.5" />
                  <path d="M10.5 10.5 14 14" strokeLinecap="round" />
                </svg>
                <span className="text-[13px] text-[var(--foreground)]">capo toyota corolla 2009</span>
                <span className="ml-auto h-4 w-px animate-pulse bg-[var(--accent)]" />
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <CodeChip label="marca">Toyota</CodeChip>
                <CodeChip label="modelo">Corolla</CodeChip>
                <CodeChip label="año">2009</CodeChip>
                <span className="text-[11px] text-[var(--foreground-muted)]">· 3 resultados</span>
              </div>

              <div className="mt-4 space-y-2">
                <ResultRow
                  name="Capó delantero"
                  oem="53301-02310"
                  warehouse="Central · A-03-2"
                  stock={4}
                  price="Q 1,850.00"
                  best
                />
                <ResultRow
                  name="Capó delantero — genérico"
                  oem="53301-02311"
                  warehouse="Tienda Zona 4 · sin ubicar"
                  stock={0}
                  price="Q 1,240.00"
                />
              </div>
            </div>
          </div>

          {/* Nota al margen: el detalle que distingue a un sistema de bodega de un e-commerce. */}
          <div className="absolute -bottom-5 -left-3 hidden max-w-[230px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--shadow-card)] lg:block">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-copper-700)]">
              Reserva activa
            </p>
            <p className="mt-1 text-[12px] leading-snug text-[var(--foreground-muted)]">
              Sale del estante en cuanto se confirma la venta. Si nadie lo prepara en 30 minutos, la pieza
              vuelve a estar disponible sola.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ResultRow({
  name,
  oem,
  warehouse,
  stock,
  price,
  best = false,
}: {
  name: string;
  oem: string;
  warehouse: string;
  stock: number;
  price: string;
  best?: boolean;
}) {
  return (
    <div
      className={`rounded-[var(--radius-sm)] border p-3 ${
        best
          ? 'border-[var(--color-copper-600)]/45 bg-[var(--color-copper-100)]/35'
          : 'border-[var(--border)]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-[var(--foreground)]">{name}</p>
          <p className="mt-0.5 font-mono text-[11px] text-[var(--foreground-muted)]">OEM {oem}</p>
        </div>
        <p className="partops-num shrink-0 text-[13px] font-semibold text-[var(--foreground)]">{price}</p>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-[var(--foreground-muted)]">{warehouse}</span>
        <StockPill quantity={stock} reorderPoint={2} />
      </div>
    </div>
  );
}

function Workflow() {
  const steps = [
    {
      n: '01',
      title: 'Busca como habla el cliente',
      body: '“cubierta”, “capó”, “balatas”, “el faro del corola 2009”. Entiende sinónimos, tildes y erratas, y separa marca, modelo y año solo.',
    },
    {
      n: '02',
      title: 'Ve dónde está, no solo si hay',
      body: 'Existencia por bodega y por pasillo. Si está en la central, se traslada; si no está, queda registrado como demanda para comprarlo.',
    },
    {
      n: '03',
      title: 'Reserva y despacha',
      body: 'La venta reserva la pieza al instante. El bodeguero ve la lista, escanea y marca entregado. La reserva vence sola si nadie la atiende.',
    },
    {
      n: '04',
      title: 'Entrega el recibo',
      body: 'Recibo con NIT, folio y garantía, en carta o en 80 mm. Se comparte por WhatsApp con un enlace que el cliente abre sin crear cuenta.',
    },
  ];

  return (
    <section id="flujo" className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <div className="max-w-2xl">
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.6vw,2rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
            Del mostrador a la bodega, sin gritar por el pasillo
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--foreground-muted)]">
            El recorrido completo de una venta de repuesto, con los puntos donde hoy se pierde dinero:
            existencia que no aparece, piezas reservadas dos veces y recibos escritos a mano.
          </p>
        </div>

        <ol className="mt-9 grid gap-px overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s) => (
            <li key={s.n} className="bg-[var(--surface)] p-5">
              <span className="partops-num font-mono text-[11px] font-semibold text-[var(--color-copper-700)]">
                {s.n}
              </span>
              <h3 className="mt-2 text-[14px] font-semibold text-[var(--foreground)]">{s.title}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--foreground-muted)]">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Capabilities() {
  const groups = [
    {
      title: 'Catálogo',
      items: [
        'Piezas con variantes por marca, condición y garantía',
        'Compatibilidad por vehículo: marca, modelo, años y motor',
        'Búsqueda por OEM, número de parte, nombre o jerga local',
        'Importación desde Excel con vista previa y reporte de errores por fila',
      ],
    },
    {
      title: 'Inventario',
      items: [
        'Existencias por bodega, con pasillo y estante',
        'Historial de cada movimiento, sin poder reescribirlo',
        'Reservas que vencen solas y traslados entre bodegas',
        'Punto de reorden y etiquetas con código de barras',
      ],
    },
    {
      title: 'Ventas y despacho',
      items: [
        'Pedidos con surtido por línea: una venta puede salir de dos bodegas',
        'Despacho en el teléfono del bodeguero, con escáner',
        'Recibo inmutable con folio, NIT y garantía',
        'Cobro en efectivo, tarjeta, transferencia o crédito',
      ],
    },
    {
      title: 'Negocio',
      items: [
        'Utilidad real, con el costo congelado al momento de la venta',
        'Demanda no atendida: qué buscaron y no tenías',
        'Avisos de llegada de pieza a los clientes que la pidieron',
        'Equipo con permisos por rol: el vendedor no ve costos',
      ],
    },
  ];

  return (
    <section id="capacidades" className="border-b border-[var(--border)]">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.6vw,2rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
          Lo que el sistema resuelve
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-[var(--foreground-muted)]">
          Sin módulos de relleno. Cada punto de esta lista existe porque una bodega pierde plata cuando falta.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {groups.map((g) => (
            <div
              key={g.title}
              className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <h3 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.05em] text-[var(--foreground)]">
                <span aria-hidden className="h-3 w-0.5 rounded-full bg-[var(--accent)]" />
                {g.title}
              </h3>
              <ul className="mt-3 space-y-2">
                {g.items.map((i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-[12.5px] leading-snug text-[var(--foreground-muted)]"
                  >
                    <span
                      aria-hidden
                      className="mt-[6px] size-1 shrink-0 rounded-full bg-[var(--border-strong)]"
                    />
                    {i}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Details() {
  return (
    <section id="detalles" className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.6vw,2rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
              Detalles que solo se notan cuando faltan
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-[var(--foreground-muted)]">
              Un repuesto no es un producto de tienda: tiene número de fabricante, aplica a ciertos años, y
              una pieza equivocada regresa. El sistema está construido alrededor de eso.
            </p>

            <div className="mt-6 space-y-3">
              <VehicleBreadcrumb brand="Toyota" model="Corolla" year={2009} />
              <div className="flex flex-wrap gap-1.5">
                <CodeChip label="SKU">CAP-COR-0913</CodeChip>
                <CodeChip label="OEM">53301-02310</CodeChip>
                <CodeChip label="EAN">7501234567890</CodeChip>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <StatTile label="Piezas distintas" value="4,812" hint="catálogo de una bodega mediana" />
            <StatTile label="Aplicaciones" value="18,940" hint="vehículo · años · motor" />
            <DetailCard
              title="El costo no cambia hacia atrás"
              body="Cada línea de venta guarda el costo del momento. Si el proveedor sube el precio mañana, la utilidad del mes pasado sigue siendo la verdadera."
            />
            <DetailCard
              title="Una venta, dos bodegas"
              body="Tres piezas salen de la central y dos esperan traslado. Cada línea avanza por su lado; el pedido se marca parcial, no se queda trabado."
            />
            <DetailCard
              title="La demanda que no atendiste"
              body="Cada búsqueda sin resultado queda registrada. Al final del mes sabes exactamente qué comprar y a quién avisarle cuando llegue."
            />
            <DetailCard
              title="Permisos de verdad"
              body="El vendedor no ve el costo ni puede ajustar existencias. El bodeguero despacha pero no vende. El propietario lo ve todo."
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function DetailCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--background)] p-4">
      <h3 className="text-[13px] font-semibold text-[var(--foreground)]">{title}</h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--foreground-muted)]">{body}</p>
    </div>
  );
}

function ClosingNote() {
  return (
    <section className="border-b border-[var(--border)]">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <div className="partops-hatch overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)]">
          <div className="bg-[var(--surface)]/94 px-6 py-10 sm:px-10">
            <h2 className="max-w-2xl font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.8vw,2.1rem)] font-bold leading-tight tracking-[-0.022em] text-[var(--foreground)]">
              Si su bodega ya funciona con Excel, no le vamos a pedir que lo tire el primer día.
            </h2>
            <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-[var(--foreground-muted)]">
              Se importa el archivo tal como está, se revisa lo que el sistema entendió y se corrige lo que
              haga falta antes de guardar nada. El catálogo arranca con lo que ya tenía.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/registro">
                <Button size="lg">Crear mi cuenta</Button>
              </Link>
              <a href="mailto:partopsgt@gmail.com">
                <Button size="lg" variant="secondary">
                  Hablar con alguien
                </Button>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="mx-auto max-w-6xl px-5 py-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <PartOpsLogo size={16} variant="color" />
          <span className="text-[11.5px] text-[var(--foreground-muted)]">
            Guatemala · Quetzales · IVA incluido
          </span>
        </div>
        <div className="flex items-center gap-4 text-[11.5px] text-[var(--foreground-muted)]">
          <a href="/terminos" className="hover:text-[var(--foreground)]">
            Términos
          </a>
          <a href="/privacidad" className="hover:text-[var(--foreground)]">
            Privacidad
          </a>
          <span>partopsgt@gmail.com</span>
        </div>
      </div>
    </footer>
  );
}
