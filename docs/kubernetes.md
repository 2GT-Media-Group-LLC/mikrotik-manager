# Kubernetes

The manifests in [`k8s/`](https://github.com/2GT-Media-Group-LLC/mikrotik-manager/tree/dev/k8s)
run the frontend and backend Deployments and the Gateway route. PostgreSQL,
Redis and InfluxDB are yours, along with the backend credentials Secret.

The Gateway handles TLS and routing. The frontend is just static files; there is
no nginx edge container as in Compose.

## Before you start

- **Gateway API v1.2 or later**, with an implementation that supports
  `HTTPRouteRequestTimeout` (Envoy Gateway does). The route sets per-path
  timeouts; older CRDs drop the field and the Gateway's default applies.
- An existing `Gateway` with an HTTPS listener. The example points at `eg` in
  the `default` namespace and an `https` listener; change those in
  `k8s/httproute.yaml`.
- TLS managed by the Gateway (cert-manager or your own). Do not mount the app
  certificate volume; the Settings → Certificate card is for Compose. Until the
  external-TLS mode lands, leave that card alone. Device certificates are
  unaffected.

## Configure

Create the namespace and the backend credentials Secret:

```sh
kubectl create namespace mikrotik-manager
kubectl -n mikrotik-manager create secret generic mikrotik-manager-backend \
  --from-literal=DB_PASSWORD='...' \
  --from-literal=INFLUXDB_TOKEN='...'
```

`DB_PASSWORD` is combined with `DATABASE_URL`; `INFLUXDB_TOKEN` is required.
Add `REDIS_PASSWORD`, `JWT_SECRET` or `ENCRYPTION_KEY` to the same Secret if you
want to pin them. Otherwise the JWT and encryption keys are generated into
`/app/data` on first start.

Edit `k8s/backend-configmap.yaml` for your database, Redis and InfluxDB
addresses and `CORS_ORIGIN`. Then set the image tags in
`k8s/kustomization.yaml` to the release you want:

```yaml
images:
  - name: ghcr.io/2gt-media-group-llc/mikrotik-manager-frontend
    newTag: "1.1.0"
  - name: ghcr.io/2gt-media-group-llc/mikrotik-manager-backend
    newTag: "1.1.0"
```

Finally set the Gateway parent and hostname in `k8s/httproute.yaml`, then apply:

```sh
kubectl apply -k k8s
```

## Routing

| Path | Goes to | Timeout |
|---|---|---|
| `/` | frontend:8080 | 30s |
| `/api` (including `/api/mcp`) | backend:3001 | 300s |
| `/api/backups` | backend:3001 | 660s |
| `/api/platform-backup` | backend:3001 | 3600s |
| `/.well-known/oauth-protected-resource/api/mcp` | backend:3001 | 300s |
| `/socket.io` | backend:3001 | none |

The timeouts are explicit because Envoy's default is 15 seconds; Change Guard,
device backups and platform restores need longer. Envoy Gateway does not buffer
request bodies unless asked, so the restore streams.

Socket.IO is long-lived. Its pings keep the connection active, so the route
leaves it unbounded. Keep the backend at one replica; if you scale it, give the
Gateway session affinity for `/socket.io`.

## Trusted proxies

With a single Gateway, the backend's default one-hop trust is correct: it uses
the address and scheme the Gateway forwards.

Set `BACKEND_TRUSTED_PROXIES` in `k8s/backend-configmap.yaml` only when another
proxy sits in front of the Gateway, or to restrict which pods may supply those
headers:

```yaml
BACKEND_TRUSTED_PROXIES: 10.244.0.0/16   # your Gateway/proxy pod range
```

The backend walks the forwarded chain and stops at the first untrusted address.
A malformed value stops it at startup.

## Backend and storage

- One backend replica with `Recreate`: it owns the schedule, migrations and
  background jobs. Extra poll workers are a separate Deployment with
  `POLLER_ROLE=worker` (see [Polling and scaling](scaling.md)).
- `/app/data` and `/app/backups` are PVCs (1 GiB and 10 GiB by default). Size
  them for your fleet and set a storage class if needed.
- The backend runs read-only with only `NET_RAW`, for server-side ARP discovery.
- NetFlow is UDP 2055 straight to the backend. Expose it with a UDP Service or a
  host port if you collect flows.

## Network

Allow the Gateway pods to reach the frontend and backend Services, and the
backend's API port only. The frontend and backend do not need to reach each
other. The backend needs its data stores, devices, and any OIDC provider.

Because the backend needs `NET_RAW`, it cannot run under the `baseline` or
`restricted` Pod Security Standard. Restrict access with NetworkPolicy and RBAC
instead.

## Verify

1. `kubectl get pods -n mikrotik-manager` shows both frontend replicas and the
   backend Ready.
2. `https://<hostname>/` loads, a deep link such as `/devices/1` works, and
   hashed assets carry `immutable`.
3. `/api/health` works through the Gateway; the frontend Service alone returns
   404 for `/api/health`.
4. Sign in, open a device, and watch live updates reconnect after a Gateway pod
   restart.
5. Download a platform backup and upload a restore.
6. Send a forged `X-Forwarded-For` from a pod outside the Gateway range and
   confirm the audit log shows the real address.

## Upgrading

Update the two image tags in `k8s/kustomization.yaml`, then run
`kubectl apply -k k8s`. Migrations run on backend start. The backend uses
`Recreate`, so expect a short API outage during the rollout; the frontend keeps
serving its static files.
