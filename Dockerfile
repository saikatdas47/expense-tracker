FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js storage.js schema.sql schema-postgres.sql ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV PORT=3000 DB_PATH=/app/data/expenses.db
EXPOSE 3000
CMD ["node", "server.js"]
