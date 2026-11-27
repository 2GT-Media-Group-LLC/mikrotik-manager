import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Issuer } from 'openid-client';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { idTokenAlg } from '../OidcService';

// validateIdToken is public in openid-client 5 but missing from its types.
type Validates = { validateIdToken(token: string): Promise<unknown> };

describe('idTokenAlg (#511)', () => {
  it('leaves the default when the provider offers RS256 or says nothing', () => {
    expect(idTokenAlg(['RS256', 'ES256'], false)).toEqual({});
    expect(idTokenAlg(undefined, false)).toEqual({});
    expect(idTokenAlg([], false)).toEqual({});
  });
  it("takes the provider's algorithm otherwise", () => {
    expect(idTokenAlg(['ES256'], false)).toEqual({ id_token_signed_response_alg: 'ES256' });
    expect(idTokenAlg(['none', 'PS256'], false)).toEqual({ id_token_signed_response_alg: 'PS256' });
  });
  it("never 'none', and HS* only with a client secret", () => {
    expect(idTokenAlg(['none'], true)).toEqual({});
    expect(idTokenAlg(['HS256'], false)).toEqual({});
    expect(idTokenAlg(['HS256'], true)).toEqual({ id_token_signed_response_alg: 'HS256' });
  });
});

// The real library against a provider that signs only with ES256, as Kanidm does.
describe('an ES256-only provider (#511)', () => {
  let server: Server;
  let base = '';
  let sign: () => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: 'k1' };
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/.well-known/openid-configuration') {
        res.end(JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          jwks_uri: `${base}/jwks`,
          id_token_signing_alg_values_supported: ['ES256'],
        }));
      } else if (req.url === '/jwks') {
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sign = () => new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(base).setAudience('mtm').setSubject('user-1')
      .setIssuedAt().setExpirationTime('5m')
      .sign(privateKey);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('accepts its ID tokens', async () => {
    const issuer = await Issuer.discover(base);
    const client = new issuer.Client({
      client_id: 'mtm',
      redirect_uris: [`${base}/cb`],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...idTokenAlg(issuer.metadata.id_token_signing_alg_values_supported, false),
    });
    await expect((client as unknown as Validates).validateIdToken(await sign())).resolves.toBeDefined();
  });

  it('was refused without it, as reported', async () => {
    const issuer = await Issuer.discover(base);
    const client = new issuer.Client({ client_id: 'mtm', redirect_uris: [`${base}/cb`], token_endpoint_auth_method: 'none' });
    await expect((client as unknown as Validates).validateIdToken(await sign())).rejects.toThrow(/expected RS256, got: ES256/);
  });
});
