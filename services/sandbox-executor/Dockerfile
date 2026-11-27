FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
COPY index.js .
COPY profiles.mjs .
COPY repository.mjs .
EXPOSE 18788
CMD ["node", "index.js"]
