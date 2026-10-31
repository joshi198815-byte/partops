# ─────────────────────────────────────────────────────────────────────────────
# PartOps API — una imagen, dos roles.
#
# El mismo artefacto corre como `api` (escucha) y como `worker` (mantenimiento). Se construye una
# sola vez y el rol se decide con `PROCESS_ROLE` al arrancar: dos Dockerfiles que se desincronizan
# es la forma más común de desplegar una API con un worker de hace tres semanas.
#
# El contexto de build es la RAÍZ del monorepo, no `apps/api`: sin el lockfile y los paquetes del
# workspace, el build no puede resolver `@partops/db` ni `@partops/contracts`.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@11.0.9 --activate
WORKDIR /repo

# ── Dependencias ─────────────────────────────────────────────────────────────
# Se copian solo los manifiestos primero: mientras el lockfile no cambie, esta capa se reutiliza y
# un cambio en `src/` no reinstala 900 paquetes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
# Solo el subárbol de la API: la web no se construye aquí y sus dependencias no viajan.
RUN pnpm install --frozen-lockfile --filter @partops/api...

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY apps/api apps/api
# Los paquetes del workspace se compilan en orden: la API importa los tipos ya emitidos de
# `@partops/db` y `@partops/contracts`, y `tsc` no compila dependencias por su cuenta.
#
# `db` se compila con `tsc` directo y no con su script `build`, que arranca con `prisma generate`:
# el cliente generado está versionado y regenerarlo en la imagen exige los motores de Prisma, que
# son 40 MB de binarios que el runtime no usa.
RUN pnpm --filter @partops/contracts build \
 && pnpm --filter @partops/db exec tsc -p tsconfig.build.json \
 && pnpm --filter @partops/api build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    PROCESS_ROLE=api

# Solo dependencias de producción y sin scripts: los artefactos ya están compilados, y `--prod`
# deja fuera vitest, tsc y demás peso muerto (la imagen baja de ~700 MB a ~250 MB).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @partops/api... \
 && pnpm store prune \
 && rm -rf /root/.cache /pnpm/store

# Artefactos compilados: el cliente Prisma generado viaja dentro de `packages/db/dist/generated`.
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/packages/db/dist packages/db/dist
COPY --from=build /repo/packages/contracts/dist packages/contracts/dist
# Las migraciones son el contrato con la base: se incluyen para poder correr `prisma migrate deploy`
# desde el mismo contenedor en una emergencia, sin esperar a un build del runner.
COPY --from=build /repo/packages/db/prisma packages/db/prisma
COPY --from=build /repo/packages/db/prisma.config.ts packages/db/prisma.config.ts

# Un proceso que no es dueño de nada no necesita escribir en su propio código.
USER node

EXPOSE 4000

# `node -e` y no `curl`: la imagen no trae curl y agregarlo por un healthcheck es un paquete más que
# hay que parchear. Se consulta `/live` y no `/ready` a propósito: Docker reinicia el contenedor por
# fallas del proceso, no porque Neon esté lento —para eso está el healthcheck del proveedor, que sí
# saca la instancia de rotación sin matarla.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
