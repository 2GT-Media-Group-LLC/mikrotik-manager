import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimeFormatPreferences } from '../../types/timeFormat';
import { timeFormatQueryKey } from '../../hooks/useTimeFormatPreferences';
import TimeFormatSetting from './TimeFormatSetting';

const state = vi.hoisted(() => ({ user: { id: 7, role: 'viewer', siteRoles: undefined as Record<string, string> | undefined } }));
vi.mock('../../store/authStore', () => ({ useAuthStore: (selector: (s: typeof state) => unknown) => selector(state) }));
vi.mock('../../services/api', () => ({ authApi: { timeFormat: vi.fn(), setTimeFormat: vi.fn() }, settingsApi: { update: vi.fn() } }));

function render(preferences: TimeFormatPreferences, userId = 7) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(timeFormatQueryKey(userId), preferences);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TimeFormatSetting)));
  client.clear();
  return html;
}

describe('time format settings card', () => {
  beforeEach(() => { state.user = { id: 7, role: 'viewer', siteRoles: undefined }; });
  it.each(['viewer', 'operator'])('offers %s a personal override without fleet controls', role => {
    state.user.role = role;
    const html = render({ preference: 'system', system_default: '24h' });
    expect(html).toContain('My time format');
    expect(html).toContain('Saved to your account across browsers');
    expect(html).not.toContain('Save system default');
    expect(html).toContain('14:30');
  });
  it('offers fleet admins a separate default control', () => {
    state.user.role = 'admin';
    const html = render({ preference: 'system', system_default: '24h' });
    expect(html).toContain('Save system default');
    expect(html).toContain('system-time-format');
    expect(html).toContain('My time format');
  });
  it('keeps site and group admins limited to their own preference', () => {
    state.user.role = 'admin';
    state.user.siteRoles = { '1': 'admin' };
    const html = render({ preference: 'system', system_default: '24h' });
    expect(html).toContain('My time format');
    expect(html).not.toContain('Save system default');
  });
  it('lets an account override the global hour cycle', () => {
    const html = render({ preference: '12h', system_default: '24h' });
    expect(html).toContain('02:30 PM');
  });
  it('keeps cached personal preferences separate between accounts', () => {
    state.user.id = 8;
    const html = render({ preference: '12h', system_default: '24h' }, 7);
    expect(html).toContain('value="system" selected=""');
    expect(html).not.toContain('value="12h" selected=""');
  });
});
