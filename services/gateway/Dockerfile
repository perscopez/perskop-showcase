FROM node:20-bookworm-slim AS build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787
CMD ["node", "dist/index.js"]
