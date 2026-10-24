import { escapeHtml } from '../html';

describe('escapeHtml (GHSA-28hr-v457-cc6g)', () => {
  it('turns markup in device and client text into plain text', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('a & b "c" \'d\'')).toBe('a &amp; b &quot;c&quot; &#39;d&#39;');
    expect(escapeHtml('<a href="https://evil.example">Click to log in</a>')).not.toContain('<a');
  });
  it('handles non-strings', () => {
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});
