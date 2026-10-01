FROM node:22-alpine

WORKDIR /app

# Install only production deps - embedded-postgres (a devDependency) and its
# multi-hundred-MB platform binaries never need to ship in the image; the
# container always talks to a real DATABASE_URL.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY migrations ./migrations
COPY src ./src
COPY scripts/burst.js ./scripts/burst.js

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

RUN addgroup -S app && adduser -S app -G app
USER app

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
