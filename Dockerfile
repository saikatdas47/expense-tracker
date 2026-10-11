FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.js schema.sql ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV PORT=3000 DB_PATH=/app/data/expenses.db
EXPOSE 3000
CMD ["node", "server.js"]
