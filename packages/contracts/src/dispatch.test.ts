import { describe, expect, it } from 'vitest';
import {
  compactOps,
  cueFor,
  type DispatchLine,
  type DispatchOp,
  dispatchScanSchema,
  dispatchSyncSchema,
  isPriority,
  newOrderNotice,
  normalizeScanCode,
  scanVerdict,
  sortByBinWalk,
  sortDispatchOrders,
} from './dispatch.js';

const line = (over: Partial<DispatchLine> & Pick<DispatchLine, 'itemId' | 'name'>): DispatchLine => ({
  variantId: 'v-1',
  sku: 'SKU-1',
  barcode: null,
  partNumber: null,
  oemNumbers: [],
  variantTitle: 'Variante',
  unit: 'UNIDAD',
  quantity: 1,
  status: 'PENDIENTE',
  binLocation: null,
  warehouseId: 'w-1',
  warehouseCode: 'CENTRAL',
  reservedUntil: null,
  ...over,
});

const op = (over: Partial<DispatchOp>): DispatchOp => ({
  opId: '00000000-0000-4000-8000-000000000001',
  orderId: '00000000-0000-4000-8000-0000000000aa',
  itemId: '00000000-0000-4000-8000-0000000000bb',
  status: 'LISTO',
  scannedCode: null,
  ...over,
});

describe('escaneo: qué código cuenta como la pieza correcta', () => {
  it('ignora guiones, espacios y minúsculas', () => {
    expect(normalizeScanCode('90080-17187')).toBe('9008017187');
    expect(normalizeScanCode(' 90080 17187 ')).toBe('9008017187');
  });

  it('acepta el SKU interno, el de barras, el número de parte y el OEM', () => {
    const target = line({
      itemId: 'i',
      name: 'Filtro',
      sku: 'FP-001',
      barcode: '7501234567890',
      partNumber: '90919-01253',
      oemNumbers: ['04152-YZZA1'],
    });
    expect(scanVerdict(target, 'FP-001')).toBe('COINCIDE');
    expect(scanVerdict(target, '7501234567890')).toBe('COINCIDE');
    expect(scanVerdict(target, '90919 01253')).toBe('COINCIDE');
    expect(scanVerdict(target, '04152yzza1')).toBe('COINCIDE');
  });

  it('rechaza el código de otra pieza, aunque se parezca', () => {
    const target = line({ itemId: 'i', name: 'Filtro', sku: 'FP-001', oemNumbers: ['04152-YZZA1'] });
    expect(scanVerdict(target, 'FP-002')).toBe('NO_COINCIDE');
    // Mismo proveedor, un dígito distinto: es la pieza vecina del estante.
    expect(scanVerdict(target, '04152-YZZA2')).toBe('NO_COINCIDE');
  });

  it('un código vacío no marca nada', () => {
    const target = line({ itemId: 'i', name: 'Filtro', sku: 'FP-001' });
    expect(scanVerdict(target, '   ')).toBe('VACIO');
    expect(scanVerdict(target, '---')).toBe('VACIO');
  });
});

describe('orden de la caminata', () => {
  it('ordena por pasillo y deja lo sin ubicar al final', () => {
    const sorted = sortByBinWalk([
      line({ itemId: '3', name: 'Bomba', binLocation: null }),
      line({ itemId: '2', name: 'Pastillas', binLocation: 'A-10' }),
      line({ itemId: '1', name: 'Filtro', binLocation: 'A-2' }),
    ]);
    expect(sorted.map((l) => l.itemId)).toEqual(['1', '2', '3']);
  });

  it('dentro del mismo estante ordena por nombre y es estable', () => {
    const first = sortByBinWalk([
      line({ itemId: 'b', name: 'Bujía', binLocation: 'B-1' }),
      line({ itemId: 'a', name: 'Aceite', binLocation: 'B-1' }),
      line({ itemId: 'c', name: 'Aceite', binLocation: 'B-1' }),
    ]);
    expect(first.map((l) => l.itemId)).toEqual(['a', 'c', 'b']);
    expect(sortByBinWalk(first).map((l) => l.itemId)).toEqual(['a', 'c', 'b']);
  });

  it('compara los pasillos por número, no carácter a carácter', () => {
    const sorted = sortByBinWalk([
      line({ itemId: '2', name: 'X', binLocation: 'A-10' }),
      line({ itemId: '1', name: 'X', binLocation: 'A-9' }),
    ]);
    expect(sorted.map((l) => l.itemId)).toEqual(['1', '2']);
  });
});

describe('orden de la cola', () => {
  it('lo más viejo primero y lo urgente arriba', () => {
    const sorted = sortDispatchOrders([
      { orderId: 'c', createdAt: '2026-10-30T10:00:00Z', priority: false },
      { orderId: 'b', createdAt: '2026-10-30T11:00:00Z', priority: false },
      { orderId: 'a', createdAt: '2026-10-30T09:30:00Z', priority: true },
    ]);
    expect(sorted.map((o) => o.orderId)).toEqual(['a', 'c', 'b']);
  });

  it('un pedido sin piezas pendientes nunca es urgente', () => {
    expect(isPriority(120, 0)).toBe(false);
    expect(isPriority(19, 3)).toBe(false);
    expect(isPriority(20, 3)).toBe(true);
  });
});

describe('cola offline', () => {
  it('un lote compactado deja solo el último estado de cada línea', () => {
    const ops = [
      op({ opId: '00000000-0000-4000-8000-000000000001', status: 'EN_PREPARACION' }),
      op({ opId: '00000000-0000-4000-8000-000000000002', status: 'LISTO' }),
      op({
        opId: '00000000-0000-4000-8000-000000000003',
        orderId: '00000000-0000-4000-8000-0000000000cc',
        itemId: '00000000-0000-4000-8000-0000000000dd',
        status: 'SIN_STOCK',
      }),
    ];
    const compacted = compactOps(ops);
    expect(compacted).toHaveLength(2);
    expect(compacted[0]?.opId).toBe('00000000-0000-4000-8000-000000000002');
    expect(compacted[1]?.status).toBe('SIN_STOCK');
  });

  it('el formulario no acepta estados que no son del bodeguero', () => {
    const base = {
      opId: '00000000-0000-4000-8000-000000000001',
      orderId: '00000000-0000-4000-8000-0000000000aa',
      itemId: '00000000-0000-4000-8000-0000000000bb',
    };
    expect(dispatchSyncSchema.safeParse({ ops: [{ ...base, status: 'CANCELADO' }] }).success).toBe(false);
    expect(dispatchSyncSchema.safeParse({ ops: [{ ...base, status: 'PENDIENTE' }] }).success).toBe(false);
    expect(dispatchSyncSchema.safeParse({ ops: [{ ...base, status: 'LISTO' }] }).success).toBe(true);
  });

  it('el escaneo por omisión marca listo y no exige código de operación', () => {
    const parsed = dispatchScanSchema.parse({ code: 'FP-001' });
    expect(parsed.status).toBe('LISTO');
    expect(parsed.opId).toBeUndefined();
  });

  it('un lote vacío se rechaza con mensaje, no con 500', () => {
    const result = dispatchSyncSchema.safeParse({ ops: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('nada que sincronizar');
    }
  });
});

describe('eventos', () => {
  it('cada desenlace tiene su pista', () => {
    expect(cueFor('LISTO', 'LISTO')).toBe('LISTO');
    expect(cueFor('ENTREGADO', 'ENTREGADO')).toBe('ENTREGADO');
    expect(cueFor('CANCELADO', 'CANCELADO')).toBe('CANCELADO');
    expect(cueFor('ABIERTO', 'SIN_STOCK')).toBe('SIN_STOCK');
    expect(cueFor('EN_PREPARACION', null)).toBe('NINGUNA');
  });

  it('el aviso dice cuántas piezas y para quién', () => {
    expect(newOrderNotice({ code: 'PD-0007', customerName: 'Marta', pendingUnits: 1 })).toEqual({
      title: 'Pedido PD-0007 en bodega',
      body: '1 pieza para Marta. Toca para prepararlo.',
    });
    expect(newOrderNotice({ code: 'PD-0008', customerName: 'Luis', pendingUnits: 3 }).body).toContain(
      '3 piezas',
    );
  });
});
