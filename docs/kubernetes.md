# Kubernetes

The reference manifests in [`k8s/`](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/tree/dev/k8s)
run the frontend and backend Deployments, their Services, persistent claims and
the Gateway route. PostgreSQL, Redis, InfluxDB and the credentials Secret are
supplied by the operator, with the settings from [Configuration](configuration.md).

The frontend is an ordinary static Deployment. It does not terminate TLS, run
ACME, proxy the API, or hold a certificate volume. In Compose those jobs belong
to the nginx edge; in Kubernetes they belong to the Gateway and cert-manager.

## Images

| Image | Purpose |
|---|---|
| `ghcr.io/2gt-media-group-llc/mikrotik-manager-frontend` | The SPA, nginx unprivileged on port 8080 |
| `ghcr.io/2gt-media-group-llc/mikrotik-manager-backend` | The API, scheduler and poll workers on port 3001 |

The Gateway replaces the Compose nginx edge, so no edge image is deployed here.
Pin the frontend and backend images to the same release tag in the kustomization.

## Apply the deployment

Create the namespace and the backend Secret first (skip the namespace if it
already exists):

```sh
kubectl create namespace mikrotik-manager
kubectl -n mikrotik-manager create secret generic mikrotik-manager-backend \
  --from-literal=DB_PASSWORD='...' \
  --from-literal=INFLUXDB_TOKEN='...'
```

Add `REDIS_PASSWORD`, `JWT_SECRET` and `ENCRYPTION_KEY` to the same Secret if
you pin them; otherwise the JWT and encryption keys are generated into
`/app/data` on first start. `DB_PASSWORD` is combined with `DATABASE_URL`, and
`INFLUXDB_TOKEN` is required.

Edit `k8s/backend-configmap.yaml` for your database, Redis and InfluxDB
addresses, `CORS_ORIGIN`, and the Gateway pod range for
`BACKEND_TRUSTED_PROXIES`. Then pin both images in `k8s/kustomization.yaml`:

```yaml
images:
  - name: ghcr.io/2gt-media-group-llc/mikrotik-manager-frontend
    newTag: "1.1.0"
  - name: ghcr.io/2gt-media-group-llc/mikrotik-manager-backend
    newTag: "1.1.0"
```

Change the placeholders in `k8s/httproute.yaml`: the Gateway `parentRefs`, its
`sectionName`, and the hostname. Then apply:

```sh
kubectl apply -k k8s
```

This creates two frontend replicas, the backend Deployment, the backend
ConfigMap, the `mikrotik-manager-data` and `mikrotik-manager-backups` claims,
and both Services.

## Gateway

The reference route assumes:

- **Gateway API** `v1` and an existing `Gateway` with an HTTPS listener named
  `https`. Remove `sectionName` to attach to every listener.
- **cert-manager** (or your own certificate automation) on the Gateway. The
  manager's Settings → Certificate card manages the Compose nginx certificate;
  do not mount an application certificate volume here. The external-TLS mode
  (`TLS_MODE=http`, issue #508 PR 1) hides the upload and regeneration controls;
  until it lands, leave that card alone. Device certificate management is
  unaffected.
- **Envoy Gateway v1.10 or later** for `requestBuffer.mode: LimitOnly` in
  `k8s/policies.yaml`. On an earlier controller, drop that policy; Envoy streams
  request bodies by default.

### Routing and timeouts

| Path | Backend | Request timeout |
|---|---|---|
| `/` | frontend:8080 | 30s |
| `/api` | backend:3001 | 300s |
| `/api/backups` | backend:3001 | 660s |
| `/api/platform-backup` | backend:3001 | 3600s |
| `/api/mcp` | backend:3001 | 60s |
| `/.well-known/oauth-protected-resource/api/mcp` | backend:3001 | 60s |
| `/socket.io` | backend:3001 | 0s (unbounded) |

The timeouts are explicit because Envoy's default is 15 seconds. A Change Guard
run on a slow device, a device backup, and a platform restore all take longer.
Platform restore also needs the `LimitOnly` request-buffer policy so the upload
streams instead of being buffered.

Socket.IO is long-lived. The route disables the overall request timeout and the
policy reclaims a stream after an hour without data; Socket.IO's pings keep a
healthy connection active. The reference backend runs one replica. If you scale
it, the Gateway needs session affinity for the WebSocket connections (or move
live updates to a broadcasting design).

## Trusted proxies

The API must only believe `X-Forwarded-For` and `X-Forwarded-Proto` from the
Gateway. Set in `k8s/backend-configmap.yaml`:

```yaml
BACKEND_TRUSTED_PROXIES: 10.244.0.0/16   # your Gateway data-plane pod range
```

Without it the API trusts one hop (the Compose behaviour), so `req.ip` is the
Gateway pod and `req.secure` is false. With it, sign-in rate limits per address,
the audit log IP, and HTTPS-only cookies and OIDC callbacks work. A malformed
value stops the backend at startup rather than silently widening what it
believes.

## Backend, data and NetFlow

- The backend Deployment runs **one replica** with `Recreate`: it owns the
  schedule, migrations and most background jobs. Extra poll workers are a
  separate Deployment with `POLLER_ROLE=worker` (see [Polling and scaling](scaling.md)).
- `/app/data` (generated secrets) and `/app/backups` are persistent claims. Size
  them for your fleet and set a storage class if the default is not the one you
  want.
- The backend container runs read-only. Its `/tmp` is an emptyDir and it keeps
  `NET_RAW` for server-side ARP discovery.
- **NetFlow** is UDP 2055 straight to the backend. The Gateway does not carry
  it; expose it with a UDP Service or a host port if you collect flows.
- `CORS_ORIGIN` is in the backend ConfigMap. When the external-TLS mode
  (`TLS_MODE=http`) is available, set it there too so the Settings UI shows that
  TLS is managed externally.
- To import an OIDC configuration once, create the optional Secret
  `mikrotik-manager-oidc` with key `oidc.json`; it is mounted read-only at
  `/etc/mikrotik-manager/oidc.json`.

## Network policy

Restrict ingress to the frontend and backend Services to the Gateway
data-plane pods, and to the backend's API port only. The frontend and backend
do not need to reach each other. The backend needs its data stores, devices,
and (if configured) an OIDC provider.

## Verify

1. `kubectl get pods -n mikrotik-manager` shows both frontend replicas and the
   backend Ready.
2. `curl -I https://<hostname>/` returns the SPA with the CSP and immutable
   asset caching; a deep link such as `/devices/1` returns `index.html`.
3. `curl https://<hostname>/api/health` reaches the backend, and
   `/api/health` on the frontend Service alone is a 404.
4. Sign in, open a device, and watch live updates reconnect after a Gateway pod
   restart.
5. Start a platform backup download and a restore upload; both complete.
6. Send a request with a forged `X-Forwarded-For` from a pod outside the
   Gateway range and confirm the audit log shows the real address.
