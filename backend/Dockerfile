# Base images are pinned by digest so a moved tag can't change what's built
# (outside review O2); Dependabot proposes digest updates.

# Stage 1: Build
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS builder

WORKDIR /app

# npm ci installs exactly the audited lockfile, and fails if it's out of
# step with package.json (outside review O2).
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS production

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Install arp-scan for server-side MAC→IP ARP discovery.
# libcap is needed to set file capabilities so it runs without root.
# openssl is needed for self-signed certificate generation.
RUN apk add --no-cache arp-scan libcap openssl \
  && setcap cap_net_raw+ep /usr/bin/arp-scan

# Copy built files
COPY --from=builder /app/dist ./dist

# Create writable data directories. Pre-creating them (owned by appuser after
# the chown below) means a fresh named volume mounted here inherits appuser
# ownership, so the non-root process can persist backups and secrets.
RUN mkdir -p /app/backups /app/data

# Create non-root user. The IDs are pinned to what `adduser -S` has always
# picked here (100:101), so existing volumes stay owned by this user, and so
# the nginx container can hand the shared /certs volume to it (see
# nginx/entrypoint.sh): the certificate upload in Settings writes there.
RUN addgroup -S -g 101 appgroup && adduser -S -u 100 -G appgroup appuser
# Only the data directories are the app's to write (outside review O4). The
# code stays root-owned, so a compromised process can't rewrite /app/dist to
# persist.
RUN chown -R appuser:appgroup /app/backups /app/data
USER appuser

EXPOSE 3001

CMD ["node", "dist/index.js"]
