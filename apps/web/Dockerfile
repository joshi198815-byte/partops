# ─────────────────────────────────────────────────────────────────────────────
# PartOps Web — imagen de la app Next.js.
#
# Se construye con `output: 'standalone'`: Next emite `server.js` y solo las dependencias que el
# trazado de imports encontró, así que la imagen final no copia `node_modules` completo.
#
# El contexto de build es la RAÍZ del monorepo. La web importa `@partops/ui` y
# `@partops/contracts` por workspace; con el contexto en `apps/web` el build no las resuelve.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.0.9 --activate
WORKDIR /repo

# ── Dependencias ─────────────────────────────────────────────────────────────
# Solo manifiestos: mientras el lockfile no cambie, cambiar un componente no reinstala nada.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @partops/web...

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build
# Estas tres entran como ARG porque Next las evalúa **al construir**:
#  - `API_URL`: el rewrite `/api/*` se hornea en la tabla de rutas del build.
#  - `NEXT_PUBLIC_APP_URL`: `metadataBase` de los metadatos de la portada.
#  - `NEXT_PUBLIC_SENTRY_DSN`: viaja al bundle de cliente. El DSN es público por diseño.
#
# Render traduce cada variable de entorno del servicio a un build arg del mismo nombre, así que
# estos `ARG` se llenan solos desde `render.yaml`. En local hay que pasarlos con `--build-arg`.
# Ningún valor sensible va aquí: un ARG queda grabado en el historial de la imagen.
ARG API_URL=http://localhost:4000
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_SENTRY_DSN=
# Render lo inyecta en build; se hornea en la cabecera `x-partops-commit` para que `deploy.yml`
# verifique que la web nueva está sirviendo, no solo que el deploy fue disparado.
ARG RENDER_GIT_COMMIT=dev
ENV API_URL=$API_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    RENDER_GIT_COMMIT=$RENDER_GIT_COMMIT

COPY tsconfig.base.json ./
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/ui packages/ui
COPY apps/web apps/web

# `contracts` se compila antes: su `main` apunta a `dist/`, y `@partops/ui` se transpila desde
# fuente (`transpilePackages`), por eso no tiene paso de build.
RUN pnpm --filter @partops/contracts build \
 && pnpm --filter @partops/web build

# ── Runtime ──────────────────────────────────────────────────────────────────
# Node puro y no `base`: en runtime no hace falta pnpm ni corepack, y son ~40 MB de imagen que
# Render guarda y vuelve a descargar en cada deploy.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# El `standalone` de un monorepo conserva la ruta relativa del paquete: el servidor queda en
# `apps/web/server.js` y las dependencias en `node_modules/` de la raíz del artefacto.
# Los enlaces de pnpm se copian como enlaces (COPY no los sigue); sus destinos viajan dentro del
# mismo artefacto, así que resuelven igual en Linux que en el build.
COPY --from=build /repo/apps/web/.next/standalone ./
# `static` y `public` no los copia el trazado de imports: sin ellos no hay JS de cliente ni marca.
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

USER node

EXPOSE 3000

# `/entrar` y no `/api/health/live`: el healthcheck responde por la salud *de esta imagen*. Si
# apuntara a la API, una caída del backend sacaría de rotación a la web, que seguiría sirviendo
# perfectamente el login y los assets.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/entrar').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
