'use client';

import { COMMAND_LABELS, type CommandHit, type CommandResponse } from '@partops/contracts';
import { CodeChip } from '@partops/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { canScan, scanCode } from '@/lib/scanner';

/**
 * Paleta de comandos (⌘K / Ctrl+K).
 *
 * El vendedor con el cliente al teléfono no navega menús: escribe cuatro letras o escanea el código
 * que tiene en la mano. Lo que encuentra son piezas, pedidos y clientes del negocio activo —nunca
 * de otro, eso lo garantiza el servidor— y las acciones que sus permisos le permiten.
 *
 * Detalles que importan en bodega:
 *
 *  - **El foco nunca se va del input.** Alguien teclea un SKU con una mano y sostiene la pieza con la
 *    otra; si el foco se pierde, lo que sigue se escribe en la nada.
 *  - **El escaneo rellena el input y busca**, no cierra la paleta: el bodeguero quiere ver qué es la
 *    pieza antes de saltar.
 *  - **Escape cierra sin navegar.** Un Esc de más no debe llevar a otra pantalla.
 */
const DEBOUNCE_MS = 180;

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [data, setData] = useState<CommandResponse | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const flat = useMemo(() => data?.groups.flatMap((g) => g.hits) ?? [], [data]);

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    setData(null);
    setActive(0);
  }, []);

  // Atajo global. `metaKey` en Mac, `ctrlKey` en Windows: el dueño de la bodega usa las dos cosas
  // según la computadora que tenga en el mostrador.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        close();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Al abrir, el foco va al input. Sin esto hay que pulsar dos veces para escribir.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(timer);
  }, [open]);

  // Debounce contra la API. La paleta dispara una consulta por pulsación sin esto, y en una conexión
  // de bodega eso es medio segundo de lag por letra.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await api<CommandResponse>(`/api/command?q=${encodeURIComponent(q)}`);
        if (!cancelled) {
          setData(res);
          setActive(0);
        }
      } catch {
        if (!cancelled) setData({ query: q, groups: [] });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, open]);

  function go(hit: CommandHit) {
    close();
    router.push(hit.href as never);
  }

  function onInputKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = flat[active];
      if (hit) go(hit);
    }
  }

  async function onScan() {
    setBusy(true);
    try {
      const code = await scanCode();
      if (code) {
        setQ(code);
        inputRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[11.5px] text-[var(--foreground-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--foreground)] sm:inline-flex"
        aria-label="Abrir búsqueda rápida"
      >
        <span aria-hidden>⌘K</span>
        <span>Buscar</span>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[oklch(20%_0.02_245_/_0.28)] p-4 pt-[12vh]">
      {/* El fondo es un botón de verdad, no un div con `onClick`: así se cierra con teclado, los
          lectores de pantalla lo anuncian y el clic fuera no depende de comparar coordenadas. */}
      <button
        type="button"
        aria-label="Cerrar búsqueda rápida"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Búsqueda rápida"
        className="relative w-full max-w-xl overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3">
          <input
            ref={inputRef}
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={onInputKey}
            placeholder="Pieza, OEM, folio o cliente…"
            className="min-w-0 flex-1 bg-transparent py-3 text-[14px] text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-muted)]"
            aria-controls="command-results"
            aria-activedescendant={
              flat[active] ? `command-hit-${flat[active].kind}-${flat[active].id}` : undefined
            }
          />
          {canScan() ? (
            <button
              type="button"
              onClick={onScan}
              disabled={busy}
              className="rounded-[var(--radius-sm)] px-2 py-1 text-[11.5px] font-medium text-[var(--color-copper-700)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
            >
              {busy ? 'Leyendo…' : 'Escanear'}
            </button>
          ) : null}
          <span className="hidden font-mono text-[10.5px] text-[var(--foreground-muted)] sm:inline">esc</span>
        </div>

        <div id="command-results" className="max-h-[52vh] overflow-y-auto">
          {flat.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-[var(--foreground-muted)]">
              {q.trim()
                ? 'Nada con ese texto. Prueba con el número OEM o el nombre.'
                : 'Escribe para buscar.'}
            </p>
          ) : (
            data?.groups.map((group) => (
              <section key={group.kind} aria-label={COMMAND_LABELS[group.kind]}>
                <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--foreground-muted)]">
                  {group.label}
                </p>
                <ul>
                  {group.hits.map((hit) => {
                    const index = flat.findIndex((h) => h.kind === hit.kind && h.id === hit.id);
                    const isActive = index === active;
                    return (
                      <li key={`${hit.kind}-${hit.id}`}>
                        <button
                          type="button"
                          id={`command-hit-${hit.kind}-${hit.id}`}
                          onClick={() => go(hit)}
                          onMouseEnter={() => setActive(index)}
                          className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors ${
                            isActive ? 'bg-[var(--surface-sunken)]' : ''
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] text-[var(--foreground)]">
                              {hit.title}
                            </span>
                            {hit.subtitle ? (
                              <span className="block truncate text-[11.5px] text-[var(--foreground-muted)]">
                                {hit.subtitle}
                              </span>
                            ) : null}
                          </span>
                          {hit.code ? <CodeChip tone="muted">{hit.code}</CodeChip> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-1.5 text-[10.5px] text-[var(--foreground-muted)]">
          <span>↑↓ moverse · Enter abrir</span>
          <span>{flat.length > 0 ? `${flat.length} resultados` : null}</span>
        </div>
      </div>
    </div>
  );
}
