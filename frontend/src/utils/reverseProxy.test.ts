import { describe, it, expect } from 'vitest';
import { sniError, certCovers, ruleErrors, movePortError, acmeNameError, ISSUE_FROM_CA, LETS_ENCRYPT, type RuleForm } from './reverseProxy';

const certs = [
  { name: 'nas', commonName: 'nas.example.com', subjectAltName: 'DNS:nas.example.com', privateKey: true, expired: false },
  { name: 'wild', commonName: 'x', subjectAltName: 'DNS:*.example.com', privateKey: true, expired: false },
  { name: 'old', commonName: 'nas.example.com', privateKey: true, expired: true },
];
const form = (over: Partial<RuleForm> = {}): RuleForm => ({ sni: 'nas.example.com', ip: '192.168.88.10', port: '8080', certificate: 'nas', vrf: '', comment: '', enabled: true, ...over });
const ctx = { certs, vrfs: ['main'], others: [] as { sni: string; disabled: boolean }[] };

describe('reverse proxy rule form', () => {
  it('matches the server on names and certificates', () => {
    expect(sniError('*.example.com')).toMatch(/exactly/);
    expect(sniError('10.0.0.1')).toMatch(/not an IP/);
    expect(certCovers('cam.example.com', 'x', 'DNS:*.example.com')).toBe(true);
    expect(certCovers('a.cam.example.com', 'x', 'DNS:*.example.com')).toBe(false);
  });

  it('accepts a good rule, and the CA or service certificate for any name', () => {
    expect(ruleErrors(form(), ctx)).toEqual({});
    expect(ruleErrors(form({ sni: 'cam.example.com', certificate: 'wild' }), ctx)).toEqual({});
    expect(ruleErrors(form({ sni: 'cam.example.com', certificate: ISSUE_FROM_CA }), ctx)).toEqual({});
    expect(ruleErrors(form({ sni: 'cam.example.com', certificate: 'none' }), ctx)).toEqual({});
  });

  it('says what\'s wrong', () => {
    const e = ruleErrors(form({ sni: 'cam.example.com', ip: 'nas', port: '0', certificate: 'nas', vrf: 'red', comment: 'a\nb' }), ctx);
    expect(Object.keys(e).sort()).toEqual(['certificate', 'comment', 'ip', 'port', 'vrf']);
    expect(ruleErrors(form({ certificate: 'old' }), ctx).certificate).toMatch(/expired/);
    expect(ruleErrors(form(), { ...ctx, others: [{ sni: 'nas.example.com', disabled: false }] }).sni).toMatch(/already/);
    expect(ruleErrors(form({ enabled: false }), { ...ctx, others: [{ sni: 'nas.example.com', disabled: false }] }).sni).toBeUndefined();
  });

  it('checks a port move', () => {
    const services = [{ name: 'api-ssl', port: 8729, disabled: false }, { name: 'www', port: 80, disabled: true }];
    expect(movePortError(services, 'www-ssl', '8443')).toBeNull();
    expect(movePortError(services, 'www-ssl', '8729')).toMatch(/api-ssl/);
    expect(movePortError(services, 'www-ssl', '80')).toBeNull();
    const both = [...services, { name: 'www-ssl', port: 443, disabled: false }, { name: 'reverse-proxy', port: 8443, disabled: false }];
    expect(movePortError(both, 'reverse-proxy', '443', false)).toBeNull();
    expect(movePortError(both, 'reverse-proxy', '443', true)).toMatch(/www-ssl/);
  });
});

describe('Let\'s Encrypt on a rule', () => {
  it('needs a public name', () => {
    expect(acmeNameError('nas.example.org')).toBeNull();
    expect(ruleErrors(form({ sni: 'nas.lan', certificate: LETS_ENCRYPT }), ctx).sni).toMatch(/internal/);
    expect(ruleErrors(form({ sni: 'nas.example.org', certificate: LETS_ENCRYPT }), ctx)).toEqual({});
  });
});
