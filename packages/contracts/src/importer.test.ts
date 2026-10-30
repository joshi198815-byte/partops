import { describe, expect, it } from 'vitest';
import { applyMapping, autoMapColumns, buildPreview, rowSignature, validateImportRow } from './importer.js';

describe('autoMapColumns', () => {
  it('reconoce encabezados del Excel real de una bodega', () => {
    const { mapping, unmapped } = autoMapColumns([
      'Código',
      'Descripción',
      'Marca Carro',
      'Modelo',
      'Año',
      'Precio Venta',
      'Existencia',
      'Bodega',
      'Pasillo',
      'Costo',
    ]);
    expect(mapping.sku).toBe('Código');
    expect(mapping.name).toBe('Descripción');
    expect(mapping.price).toBe('Precio Venta');
    expect(mapping.stock).toBe('Existencia');
    expect(mapping.warehouse).toBe('Bodega');
    expect(mapping.binLocation).toBe('Pasillo');
    expect(mapping.cost).toBe('Costo');
    expect(unmapped).toEqual([]);
  });

  it('no confunde la marca del vehículo con la marca de la pieza', () => {
    const { mapping } = autoMapColumns(['SKU', 'Nombre', 'Marca Vehículo', 'Modelo', 'Años', 'Precio']);
    expect(mapping.vehicleBrand).toBe('Marca Vehículo');
    expect(mapping.brand).toBeUndefined();
    expect(mapping.vehicleModel).toBe('Modelo');
    expect(mapping.vehicleYears).toBe('Años');
  });

  it('reporta encabezados que no entiende en lugar de ignorarlos', () => {
    const { unmapped } = autoMapColumns(['SKU', 'Nombre', 'Precio', 'Observaciones internas']);
    expect(unmapped).toEqual(['Observaciones internas']);
  });

  it('no asigna dos campos a la misma columna', () => {
    const { mapping } = autoMapColumns(['SKU', 'Nombre', 'Precio', 'Costo']);
    expect(Object.values(mapping).filter(Boolean)).toHaveLength(
      new Set(Object.values(mapping).filter(Boolean)).size,
    );
  });
});

describe('validateImportRow', () => {
  const base = { sku: 'CAP-001', name: 'Capó', price: '1,250.00' };

  it('acepta una fila mínima', () => {
    const v = validateImportRow(base, 2);
    expect(v.ok).toBe(true);
    expect(v.data?.priceCents).toBe(125000);
    expect(v.data?.stock).toBe(0);
    expect(v.data?.condition).toBe('NUEVO');
  });

  it('normaliza el SKU a mayúsculas sin espacios', () => {
    const v = validateImportRow({ ...base, sku: 'cap 001' }, 2);
    expect(v.data?.sku).toBe('CAP-001');
  });

  it('rechaza precio vacío, cero o no numérico', () => {
    expect(validateImportRow({ ...base, price: '' }, 2).ok).toBe(false);
    expect(validateImportRow({ ...base, price: '0' }, 2).ok).toBe(false);
    expect(validateImportRow({ ...base, price: 'gratis' }, 2).ok).toBe(false);
  });

  it('exige SKU y nombre', () => {
    expect(validateImportRow({ name: 'Capó', price: '10' }, 2).errors.map((e) => e.field)).toContain('sku');
    expect(validateImportRow({ sku: 'X', price: '10' }, 2).errors.map((e) => e.field)).toContain('name');
  });

  it('avisa (no rechaza) cuando el costo supera el precio', () => {
    const v = validateImportRow({ ...base, price: '100', cost: '150' }, 2);
    expect(v.ok).toBe(true);
    expect(v.warnings[0]?.message).toContain('pérdida');
  });

  it('separa varios OEM', () => {
    const v = validateImportRow({ ...base, oemNumbers: '12345, ABC-99 / X1' }, 2);
    expect(v.data?.oemNumbers).toEqual(['12345', 'ABC-99', 'X1']);
  });

  it('exige años cuando hay vehículo', () => {
    const v = validateImportRow({ ...base, vehicleBrand: 'Toyota', vehicleModel: 'Corolla' }, 2);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.field)).toContain('vehicleYears');
  });

  it('acepta varias aplicaciones separadas por punto y coma', () => {
    const v = validateImportRow(
      { ...base, vehicleBrand: 'Toyota', vehicleModel: 'Corolla', vehicleYears: '2003-2008; 2009-2013' },
      2,
    );
    expect(v.ok).toBe(true);
    expect(v.data?.vehicles[0]?.years).toEqual([
      { start: 2003, end: 2008 },
      { start: 2009, end: 2013 },
    ]);
  });

  it('rechaza años imposibles', () => {
    const v = validateImportRow(
      { ...base, vehicleBrand: 'Toyota', vehicleModel: 'Corolla', vehicleYears: 'varios' },
      2,
    );
    expect(v.ok).toBe(false);
  });

  it('ignora años sin vehículo, pero avisa', () => {
    const v = validateImportRow({ ...base, vehicleYears: '2009' }, 2);
    expect(v.ok).toBe(true);
    expect(v.data?.vehicles).toEqual([]);
    expect(v.warnings.some((w) => w.field === 'vehicleYears')).toBe(true);
  });

  it('mapea condiciones del habla común', () => {
    expect(validateImportRow({ ...base, condition: 'Usado' }, 2).data?.condition).toBe('USADO');
    expect(validateImportRow({ ...base, condition: 'reconstruido' }, 2).data?.condition).toBe(
      'REMANUFACTURADO',
    );
  });

  it('rechaza existencia negativa o fraccionaria', () => {
    expect(validateImportRow({ ...base, stock: '-3' }, 2).ok).toBe(false);
    expect(validateImportRow({ ...base, stock: '2.5' }, 2).ok).toBe(false);
  });
});

describe('buildPreview', () => {
  const mapping = {
    sku: 'SKU',
    name: 'Nombre',
    price: 'Precio',
    vehicleBrand: 'Marca',
    vehicleModel: 'Modelo',
    vehicleYears: 'Años',
  };
  const row = (o: Record<string, string>) => ({
    SKU: '',
    Nombre: '',
    Precio: '',
    Marca: '',
    Modelo: '',
    Años: '',
    ...o,
  });

  it('cuenta válidas, inválidas y duplicadas', () => {
    const preview = buildPreview(
      [
        row({ SKU: 'A-1', Nombre: 'Capó', Precio: '100', Marca: 'Toyota', Modelo: 'Corolla', Años: '2009' }),
        row({ SKU: 'A-1', Nombre: 'Capó', Precio: '100', Marca: 'Toyota', Modelo: 'Corolla', Años: '2009' }),
        row({ SKU: 'A-2', Nombre: 'Faro', Precio: '' }),
      ],
      mapping,
    );
    expect(preview.totalRows).toBe(3);
    expect(preview.validRows).toBe(1);
    expect(preview.invalidRows).toBe(2);
    expect(preview.duplicateRows).toBe(1);
    expect(preview.errors[0]?.rowNumber).toBe(3);
  });

  it('el mismo SKU con otra aplicación no es duplicado: suma compatibilidad', () => {
    const preview = buildPreview(
      [
        row({ SKU: 'A-1', Nombre: 'Capó', Precio: '100', Marca: 'Toyota', Modelo: 'Corolla', Años: '2009' }),
        row({ SKU: 'A-1', Nombre: 'Capó', Precio: '100', Marca: 'Toyota', Modelo: 'Hilux', Años: '2015' }),
      ],
      mapping,
    );
    expect(preview.validRows).toBe(2);
    expect(preview.duplicateRows).toBe(0);
    expect(preview.compatibilities).toBe(2);
  });

  it('numera las filas como las ve el usuario en Excel', () => {
    const preview = buildPreview([row({ SKU: '', Nombre: 'X', Precio: '1' })], mapping);
    expect(preview.errors[0]?.rowNumber).toBe(2);
  });

  it('cuenta compatibilidades, no filas', () => {
    const preview = buildPreview(
      [
        row({
          SKU: 'A-1',
          Nombre: 'Capó',
          Precio: '100',
          Marca: 'Toyota',
          Modelo: 'Corolla',
          Años: '2003-2008;2009-2013',
        }),
        row({ SKU: 'A-2', Nombre: 'Faro', Precio: '100', Marca: 'Toyota', Modelo: 'Hilux', Años: '2015' }),
      ],
      mapping,
    );
    expect(preview.validRows).toBe(2);
    expect(preview.compatibilities).toBe(3);
  });

  it('propaga encabezados sin mapear', () => {
    const preview = buildPreview([row({ SKU: 'A', Nombre: 'X', Precio: '1' })], mapping, ['Notas']);
    expect(preview.unmappedHeaders).toEqual(['Notas']);
  });
});

describe('applyMapping y firma', () => {
  it('aplica el mapeo a la fila cruda', () => {
    const mapped = applyMapping({ Codigo: 'A-1', Precio: '10' }, { sku: 'Codigo', price: 'Precio' });
    expect(mapped).toEqual({ sku: 'A-1', price: '10' });
  });

  it('la firma usa SKU cuando existe', () => {
    const v = validateImportRow({ sku: 'A-1', name: 'Capó', price: '10' }, 2);
    expect(rowSignature(v.data!)).toBe('sku:A-1');
  });

  it('la firma distingue aplicaciones del mismo SKU', () => {
    const v = validateImportRow(
      {
        sku: 'A-1',
        name: 'Capó',
        price: '10',
        vehicleBrand: 'Toyota',
        vehicleModel: 'Corolla',
        vehicleYears: '2009',
      },
      2,
    );
    expect(rowSignature(v.data!)).toContain('toyota|corolla|2009-2009');
  });

  it('acepta existencias con separador de miles y rechaza fracciones', () => {
    expect(validateImportRow({ sku: 'A', name: 'X', price: '1', stock: '1,500' }, 2).data?.stock).toBe(1500);
    expect(validateImportRow({ sku: 'A', name: 'X', price: '1', stock: '2.5' }, 2).ok).toBe(false);
  });
});
