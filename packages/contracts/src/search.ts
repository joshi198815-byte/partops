/**
 * Parser de búsqueda de repuestos.
 *
 * El vendedor escribe "capo toyota corola 2009" y el sistema tiene que sacar de ahí: qué pieza,
 * qué vehículo y qué año. Se hace en dos capas a propósito:
 *
 *  1. Esta función (pura, sin base de datos) normaliza, separa el año y detecta marcas/modelos
 *     contra un vocabulario que le entrega el llamador (`VehicleVocabulary`), que la API arma una
 *     vez desde `vehicle_brand` / `vehicle_model` y cachea 10 minutos.
 *  2. El servicio de catálogo arma el SQL de ranking con el resultado.
 *
 * Sin la capa 1 en un módulo probado, cada endpoint reinventa su propio `split(' ')` y "corolla"
 * deja de encontrar "Corolla" en cuanto alguien escribe con acento o de más.
 */

/**
 * Sinónimos del habla guatemalteca para autopartes. La clave es lo que la gente escribe;
 * el valor, el término canónico que vive en `part_category` y en `part.searchText`.
 * Se amplía con datos reales de `search_event`, no con intuición.
 */
export const PART_SYNONYMS: Record<string, string> = {
  capo: 'capo',
  cubierta: 'capo',
  capot: 'capo',
  hood: 'capo',
  faro: 'faro',
  focos: 'faro',
  foco: 'faro',
  optica: 'faro',
  opticas: 'faro',
  lampara: 'faro',
  headlight: 'faro',
  defensa: 'defensa',
  bumper: 'defensa',
  parachoques: 'defensa',
  guardafango: 'guardafango',
  aleta: 'guardafango',
  fender: 'guardafango',
  parrilla: 'parrilla',
  malla: 'parrilla',
  grille: 'parrilla',
  retrovisor: 'retrovisor',
  espejo: 'retrovisor',
  espejos: 'retrovisor',
  mirror: 'retrovisor',
  puerta: 'puerta',
  vidrio: 'vidrio',
  parabrisas: 'parabrisas',
  windshield: 'parabrisas',
  maletero: 'compuerta',
  compuerta: 'compuerta',
  amortiguador: 'amortiguador',
  amortiguadores: 'amortiguador',
  shock: 'amortiguador',
  resorte: 'resorte',
  muelle: 'resorte',
  rotula: 'rotula',
  terminal: 'terminal',
  buje: 'buje',
  bujes: 'buje',
  soporte: 'soporte',
  cremallera: 'cremallera',
  direccion: 'cremallera',
  pastilla: 'pastillas',
  pastillas: 'pastillas',
  balata: 'pastillas',
  balatas: 'pastillas',
  brake: 'pastillas',
  disco: 'discos',
  discos: 'discos',
  caliper: 'caliper',
  mordaza: 'caliper',
  tambor: 'tambor',
  bomba: 'bomba',
  bombas: 'bomba',
  pump: 'bomba',
  radiador: 'radiador',
  condensador: 'condensador',
  evaporador: 'evaporador',
  compresor: 'compresor',
  alternador: 'alternador',
  marcha: 'marcha',
  arranque: 'marcha',
  starter: 'marcha',
  bujia: 'bujia',
  bujias: 'bujia',
  filtro: 'filtro',
  filtros: 'filtro',
  aceite: 'aceite',
  clutch: 'clutch',
  embrague: 'clutch',
  collar: 'collar',
  manguera: 'manguera',
  mangueras: 'manguera',
  empaque: 'empaque',
  empaques: 'empaque',
  junta: 'empaque',
  gasket: 'empaque',
  banda: 'banda',
  correa: 'banda',
  belt: 'banda',
  inyector: 'inyector',
  inyectores: 'inyector',
  sensor: 'sensor',
  sensores: 'sensor',
  valvula: 'valvula',
  valvulas: 'valvula',
  culata: 'culata',
  piston: 'piston',
  pistones: 'piston',
  biela: 'biela',
  ciguenal: 'ciguenal',
  eje: 'eje',
  maza: 'maza',
  rodamiento: 'rodamiento',
  balero: 'rodamiento',
  ruleman: 'rodamiento',
  bearing: 'rodamiento',
  bateria: 'bateria',
  baterias: 'bateria',
  turbo: 'turbo',
  intercooler: 'intercooler',
  catalizador: 'catalizador',
  escape: 'escape',
  muffler: 'escape',
  silenciador: 'silenciador',
  multiple: 'multiple',
  tapiceria: 'tapiceria',
  asiento: 'asiento',
  asientos: 'asiento',
  timon: 'timon',
  volante: 'timon',
  tablero: 'tablero',
  consola: 'consola',
  manija: 'manija',
  chapa: 'chapa',
  cerradura: 'chapa',
  antena: 'antena',
  plumillas: 'plumillas',
  plumilla: 'plumillas',
  wiper: 'plumillas',
  limpiador: 'plumillas',
};

/** Quita acentos, pasa a minúsculas, colapsa espacios y convierte signos en espacio. */
export function normalizeQuery(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(raw: string): string[] {
  const n = normalizeQuery(raw);
  return n ? n.split(' ') : [];
}

/** Distancia de edición acotada: sirve para decidir si "corola" es "corolla". */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

/**
 * Año de 4 dígitos, o 2 dígitos ("09", "98") resueltos al siglo razonable para un vehículo.
 * 80–99 → 1980s/1990s; 00–79 → 2000s en adelante. Nadie busca un carro de 1929 en un catálogo.
 */
export function normalizeYear(token: string): number | null {
  if (!/^\d{2,4}$/.test(token)) return null;
  const y = Number(token);
  if (token.length === 4) return y >= 1950 && y <= new Date().getFullYear() + 1 ? y : null;
  return y >= 80 ? 1900 + y : 2000 + y;
}

export interface VehicleVocabulary {
  brands: string[];
  /** Modelos con la marca a la que pertenecen, para no casar "corolla" con la marca equivocada. */
  models: { name: string; brand: string }[];
  /** Categorías de pieza conocidas, para corregir erratas y no confundirlas con modelos. */
  categories?: string[];
}

export interface ParsedQuery {
  /** Texto normalizado completo, tal como llegó (sin tildes ni signos). */
  normalized: string;
  /** Término de pieza ya canonizado con sinónimos, sin marca/modelo/año. */
  term: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  /** Tokens que no se clasificaron: se usan como texto libre con trigram. */
  free: string[];
  /** Verdadero cuando el término de pieza se reconoció por sinónimo ("cubierta" → "capo"). */
  termFromSynonym: boolean;
  /** Candidatos de corrección ortográfica, para sugerir "quizá quisiste decir". */
  suggestions: string[];
  /**
   * De qué palabra salió cada sugerencia, para poder reescribir solo esa palabra en la interfaz.
   *
   * Se devuelve aquí y no se recalcula en la web porque solo el parser sabe cuál de los tokens era
   * el vehículo mal escrito; adivinarlo otra vez en el cliente duplicaría la lógica y podría
   * reemplazar la palabra equivocada.
   */
  suggestionFixes: { from: string; to: string }[];
}

function bestFuzzy(token: string, candidates: string[], maxDistance = 2): string | null {
  let best: { value: string; d: number } | null = null;
  for (const c of candidates) {
    const d = editDistance(token, c, maxDistance);
    if (d <= maxDistance && (!best || d < best.d)) best = { value: c, d };
  }
  return best?.value ?? null;
}

interface Span {
  start: number;
  length: number;
}

/** Búsqueda con varias palabras que además carga la marca a la que pertenece el modelo. */
interface VocabEntry {
  raw: string;
  norm: string;
  brand?: string;
}

/**
 * Busca la frase más larga (hasta `maxLen` tokens) que coincida exactamente con el vocabulario.
 * Frase completa antes que palabra suelta: sin esto "gran cherokee" se parte en dos y no casa.
 */
function findSpan(
  tokens: string[],
  used: boolean[],
  vocab: VocabEntry[],
  maxLen: number,
): { span: Span; match: VocabEntry } | null {
  for (let len = Math.min(maxLen, tokens.length); len >= 1; len--) {
    for (let start = 0; start + len <= tokens.length; start++) {
      if (used.slice(start, start + len).some(Boolean)) continue;
      const joined = tokens.slice(start, start + len).join(' ');
      const hit = vocab.find((v) => v.norm === joined);
      if (hit) return { span: { start, length: len }, match: hit };
    }
  }
  return null;
}

function mark(used: boolean[], span: Span) {
  for (let i = span.start; i < span.start + span.length; i++) used[i] = true;
}

/**
 * Clasifica la consulta. El orden importa: el año se saca primero (un número en medio del texto
 * rompe cualquier comparación de frases), después la marca, después el modelo condicionado a esa
 * marca, y lo que sobra es el término de pieza.
 */
export function parsePartQuery(raw: string, vocab: VehicleVocabulary): ParsedQuery {
  const tokens = tokenize(raw);
  const normalized = tokens.join(' ');
  const used = Array.from({ length: tokens.length }, () => false);

  const brands: VocabEntry[] = vocab.brands.map((b) => ({ raw: b, norm: normalizeQuery(b) }));
  const models: VocabEntry[] = vocab.models.map((m) => ({
    raw: m.name,
    norm: normalizeQuery(m.name),
    brand: m.brand,
  }));
  const categories = (vocab.categories ?? []).map((c) => ({ raw: c, norm: normalizeQuery(c) }));

  // 1. Año: solo al final, o un número de 4 dígitos en cualquier posición.
  let year: number | null = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i] ?? '';
    const y = normalizeYear(t);
    if (y === null) continue;
    if (t.length === 4 || i === tokens.length - 1) {
      year = y;
      used[i] = true;
      break;
    }
  }

  // 2. Marca, con frase completa antes de palabra suelta ("alfa romeo", "gran cherokee").
  let brand: string | null = null;
  const brandHit = findSpan(tokens, used, brands, 3);
  if (brandHit) {
    brand = brandHit.match.raw;
    mark(used, brandHit.span);
  }

  // 3. Modelo: solo si pertenece a la marca detectada. Sin marca, se acepta el modelo solo
  //    (la gente escribe "corolla 2009" y espera que funcione), y la marca se infiere de él.
  let model: string | null = null;
  const modelCandidates = brand
    ? models.filter((m) => normalizeQuery(m.brand ?? '') === normalizeQuery(brand ?? ''))
    : models;
  const modelHit = findSpan(tokens, used, modelCandidates, 3);
  if (modelHit) {
    model = modelHit.match.raw;
    mark(used, modelHit.span);
    if (brand === null) brand = modelHit.match.brand ?? null;
  }

  /**
   * 4. Erratas de vehículo. "capo corola 2009" no debe buscar la pieza llamada "capo corola":
   * el token que casi es una marca/modelo se saca del término y se ofrece como sugerencia.
   * Una sola edición para marcas/modelos de 5+ letras; dos para los largos (corolla, sportage).
   */
  const suggestions = new Set<string>();
  /** Se llena junto con `suggestions`: el cliente reescribe solo el token que el parser identificó. */
  const suggestionFixes: { from: string; to: string }[] = [];
  const brandNorms = brands.map((b) => b.norm);
  const modelNorms = models.map((m) => m.norm);

  const isVehicleTypo = (t: string): boolean => {
    const maxD = t.length >= 7 ? 2 : 1;
    if (brand === null && t.length >= 4) {
      const guess = bestFuzzy(t, brandNorms, maxD);
      if (guess) {
        suggestions.add(guess);
        suggestionFixes.push({ from: t, to: guess });
        return true;
      }
    }
    if (model === null && t.length >= 4) {
      const guess = bestFuzzy(t, modelNorms, maxD);
      if (guess) {
        suggestions.add(guess);
        suggestionFixes.push({ from: t, to: guess });
        return true;
      }
    }
    return false;
  };

  const leftover = tokens.filter((t, i) => !used[i] && !isVehicleTypo(t));

  // 5. Sinónimos: si alguna palabra es una forma conocida, el término se canoniza.
  //    "cubierta nissan sentra" → término "capo", para que el trigram case con la categoría real.
  //    Solo cuenta como sinónimo cuando CAMBIA la palabra: "capo" está en el diccionario como sí
  //    misma, y marcarlo así haría que la interfaz dijera "sinónimo del mostrador" en cada búsqueda.
  const termFromSynonym = leftover.some((t) => {
    const canonical = PART_SYNONYMS[t];
    return Boolean(canonical) && canonical !== t;
  });

  // 6. Sin sinónimo, se corrigen erratas contra las categorías conocidas (una sola edición:
  //    "amortiguadro" → "amortiguador" sí; "pastilla" → "defensa" no).
  const categoryNorms = categories.map((c) => c.norm);
  const term = leftover
    .map((t) => {
      const syn = PART_SYNONYMS[t];
      if (syn) return syn;
      const exact = categories.find((c) => c.norm === t);
      if (exact) return exact.norm;
      if (t.length < 6) return t;
      return bestFuzzy(t, categoryNorms, 1) ?? t;
    })
    .join(' ');

  return {
    normalized,
    term,
    brand,
    model,
    year,
    free: leftover,
    termFromSynonym,
    suggestions: [...suggestions],
    suggestionFixes,
  };
}

/**
 * tsquery de prefijo para `to_tsvector('spanish', ...)`: cada token se vuelve `tok:*` y se unen
 * con AND. Se escapan los operadores que romperían el tsquery; nunca se interpola texto crudo
 * del usuario en SQL.
 */
export function toTsQuery(term: string): string | null {
  const tokens = tokenize(term).filter((t) => t.length >= 2);
  if (!tokens.length) return null;
  return tokens.map((t) => `${t.replace(/[&|!():*<>]/g, '')}:*`).join(' & ');
}

/**
 * Candidatos a código (OEM, SKU, número de parte) dentro de la consulta.
 *
 * El vendedor teclea "04465-0K290" o "04465 0k290": en los dos casos tiene que encontrar la pieza.
 * Por eso se compara sin signos y en mayúsculas, y por eso se descartan los años —"2009" es un año,
 * no un código— para no meter ruido en el `ANY(...)` del SQL.
 */
export function extractPartCodes(raw: string): string[] {
  const out = new Set<string>();
  const keep = (value: string) => {
    // Cinco caracteres como mínimo: un código de fabricante tiene siempre al menos eso, y con
    // menos se empieza a capturar basura ("2009", "12v") que ensucia el comparador.
    if (value.length < 5) return;
    if (!/\d/.test(value)) return;
    const asYear = /^\d{4}$/.test(value) ? Number(value) : 0;
    if (asYear >= 1900 && asYear <= 2100) return;
    out.add(value);
  };

  const tokens = raw.split(/\s+/).filter(Boolean);
  for (const token of tokens) keep(token.replace(/[^A-Za-z0-9]/g, '').toUpperCase());

  /**
   * El OEM se teclea partido: "04465 0k290". Solo se une cuando las dos partes llevan dígitos;
   * unir "capo corolla 2009" produciría un pseudo-código de quince caracteres que nunca casa.
   */
  if (tokens.length === 2 && tokens.every((t) => /\d/.test(t))) {
    keep(
      tokens
        .join('')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase(),
    );
  }

  // Seis bastan: una consulta con más códigos distintos no es una búsqueda, es un pegado.
  return [...out].slice(0, 6);
}

// ───────────────────── Contrato de la búsqueda (API ↔ web) ─────────────────────

export interface SearchAvailability {
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  /** `onHand - reserved`: lo que se puede prometer hoy. */
  available: number;
  binLocation: string | null;
  reorderPoint: number | null;
}

export interface SearchVariant {
  id: string;
  sku: string;
  title: string;
  partNumber: string | null;
  oemNumbers: string[];
  priceCents: number;
  /** `null` cuando la persona no tiene permiso de ver costos: no se manda y no se filtra en la UI. */
  costCents: number | null;
  totalAvailable: number;
  availability: SearchAvailability[];
}

export interface SearchVehicle {
  brand: string;
  model: string;
  yearStart: number;
  yearEnd: number;
  engine: string | null;
}

export interface SearchHit {
  partId: string;
  name: string;
  brand: string | null;
  category: string | null;
  condition: 'NUEVO' | 'USADO' | 'REMANUFACTURADO';
  unit: string;
  warrantyDays: number | null;
  imageUrl: string | null;
  /** 1 cuando algún código de la consulta coincide exacto: es el orden que espera la bodega. */
  codeMatch: boolean;
  totalAvailable: number;
  variants: SearchVariant[];
  vehicles: SearchVehicle[];
}

export interface SearchFacet {
  name: string;
  /** Solo en modelos: la marca a la que pertenecen. */
  brand?: string;
  count: number;
}

export interface SearchResponse {
  query: string;
  parsed: {
    term: string;
    brand: string | null;
    model: string | null;
    year: number | null;
    /** Correcciones ortográficas de vehículo: "corola" → "corolla". */
    suggestions: string[];
    /** Verdadero si el término salió de un sinónimo ("cubierta" → "capo"). */
    synonym: boolean;
  };
  hits: SearchHit[];
  facets: { brands: SearchFacet[]; models: SearchFacet[] };
  total: number;
  truncated: boolean;
  tookMs: number;
}

/** Fila de "búsquedas sin existencia": qué pedir en la próxima compra. */
export interface DemandRow {
  term: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  searches: number;
  withResults: number;
  missedCount: number;
  lastSeenAt: string | null;
}

/** Texto plano que se guarda en `part.searchText` para trigram y tsvector. */
export function buildSearchText(parts: {
  name: string;
  brand?: string | null;
  category?: string | null;
  partNumber?: string | null;
  oemNumbers?: string[];
  vehicles?: string[];
  tags?: string[];
}): string {
  return [
    parts.name,
    parts.brand,
    parts.category,
    parts.partNumber,
    ...(parts.oemNumbers ?? []),
    ...(parts.vehicles ?? []),
    ...(parts.tags ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
