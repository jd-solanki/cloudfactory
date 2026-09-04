FROM node:24-slim

WORKDIR /app

# Install first so the dependency layer is cached across server.mjs edits.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.mjs ./

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
