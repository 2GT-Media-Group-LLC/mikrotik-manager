# Stage 1: Build
FROM node:25-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Stage 2: Production
FROM node:25-alpine AS production

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Install arp-scan for server-side MAC→IP ARP discovery.
# libcap is needed to set file capabilities so it runs without root.
# openssl is needed for self-signed certificate generation.
RUN apk add --no-cache arp-scan libcap openssl \
  && setcap cap_net_raw+ep /usr/bin/arp-scan

# Copy built files
COPY --from=builder /app/dist ./dist

# Create backups directory
RUN mkdir -p /app/backups

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3001

CMD ["node", "dist/index.js"]
