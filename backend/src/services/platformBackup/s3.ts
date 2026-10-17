/**
 * A small S3 client for platform backups: PUT, LIST and DELETE with AWS
 * Signature V4. Works with AWS and S3-compatible storage (Backblaze B2,
 * Wasabi, MinIO, Cloudflare R2). Uploads stream from disk with an unsigned
 * payload (allowed over HTTPS), so a large backup never sits in memory.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';

export interface S3Config {
  /** e.g. https://s3.us-east-1.amazonaws.com, https://s3.us-west-004.backblazeb2.com */
  endpoint: string;
  region: string;
  bucket: string;
  /** Folder within the bucket, e.g. "mtm/". */
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** bucket in the path (MinIO and most self-hosted) rather than the host name. */
  pathStyle?: boolean;
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 wants it; `/` kept in paths. */
export function uriEncode(s: string, keepSlash = false): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, '/');
}

export interface SignInput {
  method: string; host: string; path: string; query?: Record<string, string>;
  headers?: Record<string, string>; payloadHash: string; region: string; service?: string;
  accessKeyId: string; secretAccessKey: string; now?: Date;
}

/** SigV4 headers for a request (exported for tests against AWS's published examples). */
export function signV4(i: SignInput): Record<string, string> {
  const now = i.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const service = i.service ?? 's3';
  const headers: Record<string, string> = { ...i.headers, host: i.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': i.payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.entries(i.query ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
  const canonicalRequest = [i.method, i.path, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function target(cfg: S3Config, key: string): { url: URL; host: string; path: string } {
  const base = new URL(cfg.endpoint.replace(/\/+$/, ''));
  const encodedKey = uriEncode(key, true);
  if (cfg.pathStyle) {
    // The bucket itself (a list) is "/bucket"; an object is "/bucket/key".
    return { url: base, host: base.host, path: key ? `/${uriEncode(cfg.bucket)}/${encodedKey}` : `/${uriEncode(cfg.bucket)}` };
  }
  return { url: base, host: `${cfg.bucket}.${base.host}`, path: `/${encodedKey}` };
}

async function request(
  cfg: S3Config, method: string, key: string, opts: { query?: Record<string, string>; body?: fs.ReadStream | Buffer; length?: number } = {},
): Promise<{ status: number; body: string }> {
  const { url, host, path } = target(cfg, key);
  const payloadHash = Buffer.isBuffer(opts.body) ? sha256(opts.body) : opts.body ? 'UNSIGNED-PAYLOAD' : sha256('');
  const extra: Record<string, string> = {};
  if (opts.length !== undefined) extra['content-length'] = String(opts.length);
  const headers = signV4({ method, host, path, query: opts.query, headers: extra, payloadHash, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  const qs = Object.entries(opts.query ?? {}).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
  const lib = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: url.protocol, hostname: cfg.pathStyle ? url.hostname : `${cfg.bucket}.${url.hostname}`, port: url.port || undefined,
      method, path: `${path}${qs ? `?${qs}` : ''}`, headers, timeout: 60_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('S3 request timed out')));
    req.on('error', reject);
    const body = opts.body;
    if (Buffer.isBuffer(body)) req.end(body);
    else if (body) (body as fs.ReadStream).pipe(req);
    else req.end();
  });
}

function s3Error(op: string, r: { status: number; body: string }): Error {
  const code = r.body.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const msg = r.body.match(/<Message>([^<]+)<\/Message>/)?.[1];
  return new Error(`S3 ${op} failed (HTTP ${r.status}${code ? `, ${code}` : ''})${msg ? `: ${msg}` : ''}`);
}

const keyFor = (cfg: S3Config, name: string) => `${(cfg.prefix ?? '').replace(/^\/+/, '')}${name}`;

export async function s3Put(cfg: S3Config, name: string, file: string): Promise<void> {
  const size = (await fs.promises.stat(file)).size;
  const r = await request(cfg, 'PUT', keyFor(cfg, name), { body: fs.createReadStream(file), length: size });
  if (r.status < 200 || r.status >= 300) throw s3Error('upload', r);
}

export async function s3PutBuffer(cfg: S3Config, name: string, data: Buffer): Promise<void> {
  const r = await request(cfg, 'PUT', keyFor(cfg, name), { body: data, length: data.length });
  if (r.status < 200 || r.status >= 300) throw s3Error('upload', r);
}

export async function s3Delete(cfg: S3Config, name: string): Promise<void> {
  const r = await request(cfg, 'DELETE', keyFor(cfg, name));
  if (r.status !== 204 && (r.status < 200 || r.status >= 300)) throw s3Error('delete', r);
}

/** Object names under the prefix that start with `startsWith`. */
export async function s3List(cfg: S3Config, startsWith: string): Promise<string[]> {
  const prefix = keyFor(cfg, startsWith);
  const out: string[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const r = await request(cfg, 'GET', '', { query });
    if (r.status !== 200) throw s3Error('list', r);
    for (const m of r.body.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const key = m[1].replace(/&amp;/g, '&');
      out.push(key.slice((cfg.prefix ?? '').replace(/^\/+/, '').length));
    }
    token = r.body.includes('<IsTruncated>true</IsTruncated>') ? r.body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : undefined;
  } while (token);
  return out;
}
