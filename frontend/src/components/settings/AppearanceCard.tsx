import clsx from 'clsx';
import { Check } from 'lucide-react';
import { useThemeStore, type ThemeMode, type DarkScheme, type PortStyle } from '../../store/themeStore';
import { ACCENTS, PALETTES, accentPalette, paletteFrom } from '../../theme/palette';

/**
 * Theme, accent colour and dark surfaces, kept in this browser (#329, after
 * kraken-XIV's proposal). Blue on Slate is the look MTM has always had.
 */
export default function AppearanceCard() {
  const { mode, accent, customAccent, darkScheme, portStyle, setMode, setAccent, setCustomAccent, setDarkScheme, setPortStyle } = useThemeStore();

  const segmented = <T extends string>(value: T, options: { v: T; label: string }[], onPick: (v: T) => void, label: string) => (
    <div className="flex gap-2" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} role="radio" aria-checked={value === o.v} onClick={() => onPick(o.v)}
          className={clsx('px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
            value === o.v ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-slate-400')}>
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="card p-5 space-y-5">
      <div>
        <h3 className="font-semibold text-gray-900 dark:text-white">Appearance</h3>
        <p className="text-xs text-gray-400 dark:text-slate-500">Kept in this browser, for you only.</p>
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Theme</label>
          <p className="text-xs text-gray-400 dark:text-slate-500">System follows your computer&rsquo;s light or dark setting</p>
        </div>
        {segmented<ThemeMode>(mode, [{ v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }, { v: 'system', label: 'System' }], setMode, 'Theme')}
      </div>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Accent colour</label>
          <p className="text-xs text-gray-400 dark:text-slate-500">Buttons, links, selections and highlights</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button key={a.id} role="radio" aria-checked={accent === a.id} aria-label={a.label} title={a.label}
              onClick={() => setAccent(a.id)}
              className={clsx('w-7 h-7 rounded-full flex items-center justify-center ring-offset-2 ring-offset-white dark:ring-offset-slate-800',
                accent === a.id ? 'ring-2 ring-gray-400 dark:ring-slate-400' : 'hover:ring-2 hover:ring-gray-200 dark:hover:ring-slate-600')}
              style={{ backgroundColor: (accentPalette(a.id, customAccent) ?? PALETTES.blue)[6] }}>
              {accent === a.id && <Check className="w-3.5 h-3.5 text-white" />}
            </button>
          ))}
          <label title="Your own colour"
            className={clsx('relative w-7 h-7 rounded-full flex items-center justify-center cursor-pointer ring-offset-2 ring-offset-white dark:ring-offset-slate-800 overflow-hidden',
              accent === 'custom' ? 'ring-2 ring-gray-400 dark:ring-slate-400' : 'hover:ring-2 hover:ring-gray-200 dark:hover:ring-slate-600')}
            style={{ background: accent === 'custom' ? paletteFrom(customAccent)[6] : 'conic-gradient(#ef4444, #f59e0b, #22c55e, #06b6d4, #6366f1, #d946ef, #ef4444)' }}>
            {accent === 'custom' && <Check className="w-3.5 h-3.5 text-white" />}
            <input type="color" aria-label="Your own colour" value={customAccent}
              onChange={(e) => setCustomAccent(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer" />
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Dark surfaces</label>
          <p className="text-xs text-gray-400 dark:text-slate-500">Midnight is near-black, for dark rooms and OLED screens</p>
        </div>
        {segmented<DarkScheme>(darkScheme, [{ v: 'slate', label: 'Slate' }, { v: 'midnight', label: 'Midnight' }], setDarkScheme, 'Dark surfaces')}
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Faceplate ports</label>
          <p className="text-xs text-gray-400 dark:text-slate-500">Drawn jacks and cages, or the plain green and red tiles</p>
        </div>
        {segmented<PortStyle>(portStyle, [{ v: 'ports', label: 'Ports' }, { v: 'tiles', label: 'Tiles' }], setPortStyle, 'Faceplate ports')}
      </div>
    </div>
  );
}
