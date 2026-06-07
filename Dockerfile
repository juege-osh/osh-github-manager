FROM node:20-bookworm-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY server ./server
COPY README.md ./

ENV NODE_ENV=production
EXPOSE 4173
CMD ["npm", "start"]
