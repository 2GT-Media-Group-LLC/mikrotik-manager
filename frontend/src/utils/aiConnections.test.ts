import { describe, it, expect } from 'vitest';
import { aiSettingsProblem, endpointBase, usesTokens } from './aiConnections';
import type { AiSettingsView } from '../services/api';

const base: AiSettingsView = {
  enabled: true, mcp_enabled: true, mcp_auth: 'oauth', openapi_enabled: false, public_url: 'https://manager.example',
  oauth_issuer: 'https://id.example/realms/x', oauth_client_id: 'mtm', has_oauth_secret: true,
};

describe('aiSettingsProblem', () => {
  it('accepts complete OAuth settings, or a secret typed but not yet saved', () => {
    expect(aiSettingsProblem(base, '')).toBeNull();
    expect(aiSettingsProblem({ ...base, has_oauth_secret: false }, 'typed')).toBeNull();
    expect(aiSettingsProblem({ ...base, public_url: 'https://manager.example/' }, '')).toBeNull();
  });
  it('says what OAuth is missing', () => {
    expect(aiSettingsProblem({ ...base, public_url: '' }, '')).toMatch(/public address/);
    expect(aiSettingsProblem({ ...base, oauth_issuer: 'http://id.example' }, '')).toMatch(/issuer/);
    expect(aiSettingsProblem({ ...base, oauth_client_id: ' ' }, '')).toMatch(/client ID/);
    expect(aiSettingsProblem({ ...base, has_oauth_secret: false }, '')).toMatch(/secret/);
  });
  it('refuses a public address with a path or plain http, whatever the sign-in', () => {
    expect(aiSettingsProblem({ ...base, mcp_auth: 'token', public_url: 'https://manager.example/mtm' }, '')).toMatch(/nothing after/);
    expect(aiSettingsProblem({ ...base, mcp_auth: 'token', public_url: 'http://manager.example' }, '')).toMatch(/https/);
  });
  it('needs nothing for tokens, or with MCP off', () => {
    expect(aiSettingsProblem({ ...base, mcp_auth: 'token', public_url: '', oauth_issuer: '' }, '')).toBeNull();
    expect(aiSettingsProblem({ ...base, mcp_enabled: false, oauth_issuer: '' }, '')).toBeNull();
  });
});

describe('endpointBase and usesTokens', () => {
  it('prefers the public address over this browser’s', () => {
    expect(endpointBase('https://manager.example/', 'https://localhost')).toBe('https://manager.example');
    expect(endpointBase(' ', 'https://localhost')).toBe('https://localhost');
  });
  it('knows when tokens are in use', () => {
    expect(usesTokens(base)).toBe(false);
    expect(usesTokens({ ...base, mcp_auth: 'token' })).toBe(true);
    expect(usesTokens({ ...base, openapi_enabled: true })).toBe(true);
    expect(usesTokens({ ...base, enabled: false, openapi_enabled: true })).toBe(false);
  });
});
