import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { accentPalette, accentTokens, channels, normalizeHex, STEPS, DEFAULT_CUSTOM, PALETTES, type AccentChoice } from '../theme/palette';

type Theme = 'light' | 'dark';
/** What the user chose; System follows the operating system, live (#329). */
export type ThemeMode = Theme | 'system';
/** Dark surfaces: the usual slate, or near-black. */
export type DarkScheme = 'slate' | 'midnight';
/** How the faceplate draws ports: drawn jacks and cages (#412), or the plain tiles from before. */
export type PortStyle = 'ports' | 'tiles';

interface ThemeState {
  mode: ThemeMode;
  /** The theme in use: `mode`, with System resolved. */
  theme: Theme;
  accent: AccentChoice;
  customAccent: string;
  darkScheme: DarkScheme;
  portStyle: PortStyle;
  setMode: (mode: ThemeMode) => void;
  /** Light or dark, explicitly. */
  setTheme: (theme: Theme) => void;
  /** The top bar's switch: the other one of light and dark, explicitly. */
  toggleTheme: () => void;
  setAccent: (accent: AccentChoice) => void;
  setCustomAccent: (hex: string) => void;
  setDarkScheme: (scheme: DarkScheme) => void;
  setPortStyle: (style: PortStyle) => void;
}

const darkQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

const resolve = (mode: ThemeMode): Theme => (mode === 'system' ? (darkQuery()?.matches ? 'dark' : 'light') : mode);

const isAccent = (v: unknown): v is AccentChoice => v === 'custom' || (typeof v === 'string' && v in PALETTES);

/** Classes and variables on <html> for a state. Blue writes no variables at all. */
export function applyTheme(s: Pick<ThemeState, 'theme' | 'accent' | 'customAccent' | 'darkScheme'>): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const dark = s.theme === 'dark';
  root.classList.toggle('dark', dark);
  if (dark && s.darkScheme === 'midnight') root.dataset.scheme = 'midnight';
  else delete root.dataset.scheme;
  const palette = accentPalette(s.accent, s.customAccent);
  STEPS.forEach((step, i) => {
    if (palette) root.style.setProperty(`--blue-${step}`, channels(palette[i]));
    else root.style.removeProperty(`--blue-${step}`);
  });
  for (const [k, v] of Object.entries(palette ? accentTokens(palette, dark) : {})) root.style.setProperty(k, v);
  if (!palette) for (const k of ['--accent', '--accent-2', '--accent-soft', '--accent-fg']) root.style.removeProperty(k);
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => {
      const update = (patch: Partial<ThemeState>) => { set(patch); applyTheme(get()); };
      return {
        mode: 'light',
        theme: 'light',
        accent: 'blue',
        customAccent: DEFAULT_CUSTOM,
        darkScheme: 'slate',
        portStyle: 'ports',
        setMode: (mode) => update({ mode, theme: resolve(mode) }),
        setTheme: (theme) => update({ mode: theme, theme }),
        toggleTheme: () => { const next = get().theme === 'light' ? 'dark' : 'light'; update({ mode: next, theme: next }); },
        setAccent: (accent) => update({ accent: isAccent(accent) ? accent : 'blue' }),
        setCustomAccent: (hex) => { const c = normalizeHex(hex); if (c) update({ accent: 'custom', customAccent: c }); },
        setDarkScheme: (darkScheme) => update({ darkScheme: darkScheme === 'midnight' ? 'midnight' : 'slate' }),
        setPortStyle: (portStyle) => set({ portStyle: portStyle === 'tiles' ? 'tiles' : 'ports' }),
      };
    },
    {
      name: 'mikrotik-theme',
      version: 1,
      partialize: (s) => ({ mode: s.mode, accent: s.accent, customAccent: s.customAccent, darkScheme: s.darkScheme, portStyle: s.portStyle }),
      // Before 1.1 only `theme` (light or dark) was kept.
      migrate: (old) => {
        const o = (old ?? {}) as { theme?: unknown };
        return { mode: o.theme === 'dark' ? 'dark' : 'light', accent: 'blue', customAccent: DEFAULT_CUSTOM, darkScheme: 'slate', portStyle: 'ports' } as
          Pick<ThemeState, 'mode' | 'accent' | 'customAccent' | 'darkScheme' | 'portStyle'>;
      },
      // Whatever was stored, only known values reach the page.
      merge: (stored, current) => {
        const s = (stored ?? {}) as Partial<ThemeState>;
        const mode: ThemeMode = s.mode === 'dark' || s.mode === 'system' ? s.mode : 'light';
        return {
          ...current, mode, theme: resolve(mode),
          accent: isAccent(s.accent) ? s.accent : 'blue',
          customAccent: normalizeHex(s.customAccent) ?? DEFAULT_CUSTOM,
          darkScheme: s.darkScheme === 'midnight' ? 'midnight' : 'slate',
          portStyle: s.portStyle === 'tiles' ? 'tiles' : 'ports',
        };
      },
      onRehydrateStorage: () => (state) => { if (state) applyTheme(state); },
    }
  )
);

// System mode follows the operating system as it changes (sunset, a manual switch).
darkQuery()?.addEventListener?.('change', () => {
  const s = useThemeStore.getState();
  if (s.mode !== 'system') return;
  useThemeStore.setState({ theme: resolve('system') });
  applyTheme(useThemeStore.getState());
});
