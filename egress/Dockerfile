FROM node:24-alpine
WORKDIR /app
COPY egress/package*.json ./
RUN npm ci --omit=dev
COPY egress/server.mjs ./egress/server.mjs
COPY lib/calendar/callback-policy.ts lib/calendar/tunnel-protocol.ts ./lib/calendar/
ENV HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
CMD ["node", "egress/server.mjs"]
