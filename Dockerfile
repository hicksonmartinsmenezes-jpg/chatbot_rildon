# Estágio 1: build do frontend (precisa de devDependencies, ex. esbuild)
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY frontend ./frontend
COPY scripts ./scripts
RUN npm run build:frontend

# Estágio 2: imagem de produção (só dependencies de runtime)
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY --from=builder /app/frontend ./frontend
COPY .env.example ./env.example

EXPOSE 3000
CMD ["node", "src/server.js"]
