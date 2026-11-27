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

### Routing and timeouts

| Path | Backend | Request timeout |
|---|---|---|
| `/` | frontend:8080 | 30s |
| `/api` (including `/api/mcp`) | backend:3001 | 300s |
| `/api/backups` | backend:3001 | 660s |
| `/api/platform-backup` | backend:3001 | 3600s |
| `/.well-known/oauth-protected-resource/api/mcp` | backend:3001 | 300s |
| `/socket.io` | backend:3001 | 0s (unbounded) |

The timeouts are explicit because Envoy's default is 15 seconds. A Change Guard
run on a slow device, a device backup, and a platform restore all take longer.
The Gateway does not buffer request bodies unless configured to, so the platform
restore streams.

Socket.IO is long-lived. The route disables the overall request timeout;
Socket.IO's pings keep a healthy connection active. The reference backend runs
one replica. If you scale it, the Gateway needs session affinity for the
WebSocket connections (or move live updates to a broadcasting design).

## Trusted proxies

The API trusts one proxy hop by default, which is correct when the Gateway is
the only proxy in front of it: `req.ip` is the client address the Gateway saw,
and `req.secure` follows its `X-Forwarded-Proto`.

Set `BACKEND_TRUSTED_PROXIES` in `k8s/backend-configmap.yaml` when another proxy
sits in front of the Gateway, or to restrict which pods may supply forwarded
headers:

```yaml
BACKEND_TRUSTED_PROXIES: 10.244.0.0/16   # your Gateway/proxy pod range
```

The API walks the forwarded chain from the socket peer and stops at the first
address outside the list, so a client cannot claim an address by adding its own
`X-Forwarded-For` entries. A malformed value stops the backend at startup.

## Backend, data and NetFlow

- The backend Deployment runs **one replica** with `Recreate`: it owns the
  schedule, migrations and most background jobs. Extra poll workers are a
  separate Deployment with `POLLER_ROLE=worker` (see [Polling and scaling](scaling.md)).
- `/app/data` (generated secrets) and `/app/backups` are persistent claims. Size
  them for your fleet and set a storage class if the default is not the one you
  want.
- The backend container runs read-only. Its `/tmp` is an emptyDir and it has only
  `NET_RAW` for server-side ARP discovery, with privilege escalation disabled.
- **NetFlow** is UDP 2055 straight to the backend. The Gateway does not carry
  it; expose it with a UDP Service or a host port if you collect flows.
- `CORS_ORIGIN` is in the backend ConfigMap. When the external-TLS mode
  (`TLS_MODE=http`) is available, set it there too so the Settings UI shows that
  TLS is managed externally.

## Network policy

Restrict ingress to the frontend and backend Services to the Gateway
data-plane pods, and to the backend's API port only. The frontend and backend
do not need to reach each other. The backend needs its data stores, devices,
and (if configured) an OIDC provider.

The backend needs `NET_RAW`, so it cannot run in a namespace that enforces the
`baseline` or `restricted` Pod Security Standard. Use a namespace without those
enforcement labels, and restrict who can reach the API with NetworkPolicy and
RBAC instead.

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
