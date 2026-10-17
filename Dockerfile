FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATABASE_PATH=/app/data/knowledge.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node knowledge/seed.json ./knowledge/seed.json
COPY --chown=node:node catalogs ./catalogs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
