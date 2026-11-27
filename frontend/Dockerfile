# The static frontend: the Vite bundle served by the non-root nginx image.
#
# This image has no TLS, ACME, or API proxy. In Kubernetes a Gateway terminates
# TLS and routes /api and /socket.io to the backend, and / here. Compose does
# not use this image; its nginx container serves the SPA directly.
#
# Base images are pinned by digest; Dependabot updates them.

FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS builder

WORKDIR /frontend

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx/nginx-unprivileged:1.30-alpine@sha256:637c35e46af7bc0dd3d3bcf7162e004e13ab3b370fde7cd416e2ac410b5a985a

COPY --from=builder /frontend/dist /usr/share/nginx/html
COPY default.conf /etc/nginx/conf.d/default.conf
COPY static-app.conf /etc/nginx/static-app.conf

# The image's entrypoint scripts edit /etc/nginx and worker settings at startup,
# which needs a writable root filesystem. This configuration is complete, so
# start nginx directly and keep the container compatible with read_only: true.
RUN nginx -t

# The image already runs as UID 101; state it so the Kubernetes securityContext
# can match it. The port is unprivileged (the nginx-unprivileged default).
USER 101
EXPOSE 8080

ENTRYPOINT []
CMD ["nginx", "-g", "daemon off;"]
