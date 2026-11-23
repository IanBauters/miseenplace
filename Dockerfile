FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TZ=Europe/Brussels
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
LABEL org.opencontainers.image.source="https://github.com/IanBauters/miseenplace" \
      org.opencontainers.image.description="Household pantry, weekly menu, shopping list and emergency stock" \
      org.opencontainers.image.licenses="MIT" \
      com.centurylinklabs.watchtower.enable="true"
CMD ["node", "src/server.js"]
