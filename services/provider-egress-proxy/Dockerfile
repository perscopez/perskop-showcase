FROM node:22-alpine

RUN addgroup -S -g 10001 perskop \
  && adduser -S -D -H -u 10001 -G perskop perskop

WORKDIR /app
COPY --chown=10001:10001 src ./src

ENV NODE_ENV=production \
    PORT=18888

USER 10001:10001
EXPOSE 18888

CMD ["node", "src/server.mjs"]
