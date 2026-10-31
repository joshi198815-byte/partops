import { z } from 'zod';

/**
 * Paleta de comandos.
 *
 * El vendedor con el cliente al teléfono no navega menús: escribe cuatro letras o escanea el código
 * que tiene en la mano. La paleta busca en las tres cosas que se consultan con alguien esperando
 * —piezas, pedidos y clientes— y en las acciones que ya tiene permiso de hacer.
 *
 * Reglas que se ven al usarla:
 *
 *  1. **El código exacto gana.** Quien escribe `TY-100` no está adivinando: quiere esa pieza, no la
 *     que tiene "TY-100" en la descripción. Ese orden lo decide `rankHits`, no la base.
 *  2. **Nada de otro negocio.** La paleta es la pantalla con más consultas libres del sistema y por
 *     eso la que más fácil filtra: el servicio consulta siempre bajo el tenant del contexto, y hay
 *     una prueba que lo fija.
 *  3. **Sin resultados no es un error.** La paleta se vacía y el vendedor sigue escribiendo; nunca
 *     un mensaje rojo por no encontrar un cliente.
 */
export const commandQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
});
export type CommandQuery = z.output<typeof commandQuerySchema>;

export const COMMAND_KINDS = ['action', 'part', 'order', 'customer'] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export interface CommandHit {
  id: string;
  kind: CommandKind;
  title: string;
  subtitle: string | null;
  /** SKU, OEM o folio: lo que se lee en mono y se dicta por teléfono. */
  code: string | null;
  /** Ruta interna a la que lleva. Siempre empieza con `/app` — nunca una URL externa. */
  href: string;
}

export interface CommandGroup {
  kind: CommandKind;
  label: string;
  hits: CommandHit[];
}

export interface CommandResponse {
  query: string;
  groups: CommandGroup[];
}

export const COMMAND_LABELS: Record<CommandKind, string> = {
  action: 'Acciones',
  part: 'Piezas',
  order: 'Pedidos',
  customer: 'Clientes',
};

/** Compara códigos como los compara una persona: sin guiones, sin espacios, sin mayúsculas. */
function comparable(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Ordena y recorta los resultados de la paleta.
 *
 * El orden es el que espera alguien escribiendo con prisa:
 *
 *  1. código exacto (`TY-100` → `TY-100`);
 *  2. código que empieza igual (`TY-1` → `TY-100`);
 *  3. título que empieza igual;
 *  4. el resto, en el orden en que llegó (la relevancia ya la resolvió la búsqueda del servidor).
 *
 * Deduplica por `kind:id` porque la misma pieza puede entrar por dos consultas (nombre y OEM) y
 * aparecer dos veces en la lista es la forma más rápida de que alguien pulse la fila equivocada.
 */
export function rankHits(hits: readonly CommandHit[], query: string, limit = 5): CommandHit[] {
  const q = comparable(query);
  const seen = new Set<string>();
  const unique: CommandHit[] = [];
  for (const hit of hits) {
    const key = `${hit.kind}:${hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }

  if (!q) return unique.slice(0, limit);

  /** 0 = código exacto, 1 = código que empieza igual, 2 = título que empieza igual, 3 = el resto. */
  const score = (hit: CommandHit): number => {
    const code = hit.code ? comparable(hit.code) : '';
    if (code === q) return 0;
    if (code.startsWith(q)) return 1;
    if (hit.title.toUpperCase().startsWith(query.trim().toUpperCase())) return 2;
    return 3;
  };

  return (
    unique
      .map((hit, index) => ({ hit, index, score: score(hit) }))
      // `index` desempata: dos piezas con la misma puntuación conservan el orden del servidor, que es
      // el orden en que las devolvió la búsqueda. Sin él, la lista bailaría entre pulsaciones.
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .slice(0, limit)
      .map((entry) => entry.hit)
  );
}

/**
 * Agrupa por tipo respetando el orden de los tipos.
 *
 * Se agrupa al final y no por tipo antes de ordenar: primero se ordena todo junto —así un pedido
 * puede ganarle a una pieza si su folio coincide exacto— y luego se reparte. Agrupar primero haría
 * que el grupo "Piezas" siempre fuera el primero aunque la coincidencia exacta fuera un pedido.
 */
export function groupHits(hits: readonly CommandHit[], limitPerGroup = 5): CommandGroup[] {
  const groups: CommandGroup[] = [];
  for (const kind of COMMAND_KINDS) {
    const ofKind = hits.filter((hit) => hit.kind === kind).slice(0, limitPerGroup);
    if (ofKind.length) groups.push({ kind, label: COMMAND_LABELS[kind], hits: ofKind });
  }
  return groups;
}
