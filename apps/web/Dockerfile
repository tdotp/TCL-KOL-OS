# Aplicación web — TCL KOL OS
# El contexto de build es la raíz del monorepo: la app consume packages/domain.
FROM node:20-slim

WORKDIR /repo

# Manifiestos primero, para aprovechar la caché de capas.
COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/
COPY packages/domain/package.json ./packages/domain/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

WORKDIR /repo/apps/web

EXPOSE 3000

CMD ["npm", "run", "dev"]
