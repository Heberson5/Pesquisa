# Imagem de produção: Node 22 (Alpine), sem ferramentas de build, rodando como usuário sem privilégios.
# O docker-compose usa "init: true" para repassar sinais de parada corretamente.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    TRUST_PROXY=1 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
RUN mkdir -p /data /backups && chown node:node /data /backups
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json server.js ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public
COPY --chown=root:root scripts ./scripts
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
