import type { Metadata } from 'next';
import { RegistroForm } from './registro-form';

export const metadata: Metadata = { title: 'Crear cuenta' };

export default async function RegistroPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Solo rutas internas: si no, el registro sirve para mandar a cualquiera a un sitio ajeno.
  const safe = next?.startsWith('/') && !next.startsWith('//') ? next : null;
  return <RegistroForm next={safe} />;
}
