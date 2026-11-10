import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AcmeCaBundleCard from './AcmeCaBundleCard';

const state = vi.hoisted(() => ({ installed: false, readOnly: false }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state, isLoading: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

describe('ACME CA bundle input', () => {
  beforeEach(() => {
    state.installed = false;
    state.readOnly = false;
  });

  it('offers a PEM text area and file picker for an editable bundle', () => {
    const markup = renderToStaticMarkup(createElement(AcmeCaBundleCard));
    expect(markup).toContain('<textarea');
    expect(markup).toContain('id="acme-ca-bundle"');
    expect(markup).toContain('Load from file...');
    expect(markup).toContain('type="file"');
    expect(markup).toContain('Upload CA Bundle');
    expect(markup).not.toContain('Private Key (PEM)');
  });

  it('offers replacement and removal for an installed bundle', () => {
    state.installed = true;
    const markup = renderToStaticMarkup(createElement(AcmeCaBundleCard));
    expect(markup).toContain('Replace CA Bundle');
    expect(markup).toContain('Remove CA Bundle');
  });

  it('shows editing controls even if the status reports read-only', () => {
    state.installed = true;
    state.readOnly = true;
    const markup = renderToStaticMarkup(createElement(AcmeCaBundleCard));
    expect(markup).toContain('<textarea');
    expect(markup).toContain('Load from file...');
    expect(markup).toContain('Replace CA Bundle');
    expect(markup).toContain('Remove CA Bundle');
    expect(markup).not.toContain('read-only');
  });
});
