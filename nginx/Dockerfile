# Stage 1: Build the React frontend
# Base images pinned by digest (outside review O2); Dependabot updates them.
FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS frontend-builder

WORKDIR /frontend

# Copy package files and install dependencies
COPY frontend/package*.json ./
RUN npm ci

# Copy source and build
COPY frontend/ ./
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine@sha256:892bb2152464f0c5d8972593a5f5afaf8054552580b699d95f8ff4af08c2d33d

# Install openssl for self-signed certificate generation
RUN apk add --no-cache openssl

# Copy built frontend
COPY --from=frontend-builder /frontend/dist /usr/share/nginx/html

# Copy nginx config: the listeners, and the app they serve (#256)
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/mtm-app.conf /etc/nginx/mtm-app.conf

# Remove default nginx config backup
RUN rm -f /etc/nginx/conf.d/default.conf.bak

# Copy and prepare entrypoint script
COPY nginx/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
