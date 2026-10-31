import { describe, expect, it } from 'vitest';
import { type CommandHit, groupHits, rankHits } from './command.js';

function hit(over: Partial<CommandHit> & Pick<CommandHit, 'id' | 'kind'>): CommandHit {
  return {
    title: 'Pieza',
    subtitle: null,
    code: null,
    href: '/app/buscar',
    ...over,
  };
}

describe('paleta: orden y agrupación', () => {
  it('el código exacto gana sobre el nombre y no se duplica', () => {
    const hits = [
      hit({ id: '1', kind: 'part', title: 'Faro delantero', code: 'TY-100', subtitle: 'TY-100' }),
      hit({ id: '1', kind: 'part', title: 'Faro delantero', code: 'TY-100', subtitle: 'TY-100' }),
      hit({ id: '2', kind: 'part', title: 'TY-100 reforzado' }),
    ];
    expect(rankHits(hits, 'ty100').map((h) => h.id)).toEqual(['1', '2']);
  });

  it('un pedido con folio exacto gana sobre una pieza con el nombre parecido', () => {
    const hits = [
      hit({ id: 'p1', kind: 'part', title: 'PD 42 delantero' }),
      hit({ id: 'o42', kind: 'order', title: 'Pedido PD-0042', code: 'PD-0042' }),
    ];
    expect(rankHits(hits, 'PD-0042').map((h) => h.id)).toEqual(['o42', 'p1']);
  });

  it('el empate conserva el orden del servidor', () => {
    const hits = [
      hit({ id: 'a', kind: 'part', title: 'Faro izquierdo' }),
      hit({ id: 'b', kind: 'part', title: 'Faro derecho' }),
    ];
    expect(rankHits(hits, 'faro').map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('sin consulta devuelve los primeros tal cual', () => {
    const hits = [hit({ id: 'a', kind: 'action' }), hit({ id: 'b', kind: 'action' })];
    expect(rankHits(hits, '', 1).map((h) => h.id)).toEqual(['a']);
  });

  it('agrupa después de ordenar, para que el folio exacto no quede enterrado', () => {
    const ordered = [
      hit({ id: 'o1', kind: 'order', title: 'PD-1' }),
      hit({ id: 'p1', kind: 'part', title: 'Faro' }),
    ];
    const groups = groupHits(ordered);
    expect(groups.map((g) => g.kind)).toEqual(['part', 'order']);
    expect(groups.flatMap((g) => g.hits).map((h) => h.id)).toEqual(['p1', 'o1']);
  });

  it('no devuelve grupos vacíos', () => {
    expect(groupHits([hit({ id: 'a', kind: 'customer' })])).toHaveLength(1);
    expect(groupHits([])).toEqual([]);
  });
});
