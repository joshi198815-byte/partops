import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // El `.env` de la raíz se carga antes de que cualquier test importe la app: los que tocan la
    // base necesitan la conexión y el secreto de auth igual que el servidor.
    setupFiles: ['./vitest.setup.ts'],
    // Los tests tocan la misma base: en serie para que los saldos no se pisen entre archivos.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
