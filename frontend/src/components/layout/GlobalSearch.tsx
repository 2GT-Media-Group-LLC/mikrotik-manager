import { useDateTimeFormat } from '../../hooks/useDateTimeFormat';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Router, Wifi, AlertTriangle, X } from 'lucide-react';
import { searchApi } from '../../services/api';
import clsx from 'clsx';

type SearchDevice = {
  id: number; name: string; ip_address: string;
  model?: string; device_type: string; status: string;
};
type SearchClient = {
  mac_address: string; hostname?: string; ip_address?: string;
  device_id: number; device_name?: string; active: boolean;
};
type SearchEvent = {
  id: number; message: string; severity: string;
  event_time: string; topic?: string; device_name?: string;
};
type SearchResults = { devices: SearchDevice[]; clients: SearchClient[]; events: SearchEvent[] };

const SEVERITY_ICON_CLS: Record<string, string> = {
  error:    'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  critical: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  warning:  'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400',
  info:     'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
};

export default function GlobalSearch() {
  const { formatDateTime } = useDateTimeFormat();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounce the query input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 280);
    return () => clearTimeout(t);
  }, [query]);

  // Fetch when debounced query is long enough
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (debouncedQuery.length < 2) { setResults(null); return; }
    setLoading(true);
    searchApi.search(debouncedQuery)
      .then((r) => { setResults(r.data); setHighlighted(0); })
      .catch(() => setResults(null))
      .finally(() => setLoading(false));
  }, [debouncedQuery]);

  // Ctrl+K / Cmd+K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Flat list for keyboard navigation index tracking
  const deviceCount = results?.devices.length ?? 0;
  const clientCount = results?.clients.length ?? 0;
  const eventCount  = results?.events.length ?? 0;
  const totalCount  = deviceCount + clientCount + eventCount;

  const goToResult = useCallback((kind: 'device' | 'client' | 'event', id: string | number) => {
    setOpen(false);
    setQuery('');
    setResults(null);
    if (kind === 'device') navigate(`/devices/${id}`);
    else if (kind === 'client') navigate(`/clients/${encodeURIComponent(String(id))}`);
    else navigate('/events');
  }, [navigate]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || totalCount === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % totalCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + totalCount) % totalCount);
    } else if (e.key === 'Enter' && results) {
      e.preventDefault();
      if (highlighted < deviceCount) {
        goToResult('device', results.devices[highlighted].id);
      } else if (highlighted < deviceCount + clientCount) {
        goToResult('client', results.clients[highlighted - deviceCount].mac_address);
      } else {
        goToResult('event', results.events[highlighted - deviceCount - clientCount].id);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  };

  const hasResults = totalCount > 0;
  const showDropdown = open && query.length >= 2;

  return (
    <div ref={containerRef} className="relative flex-1 max-w-lg">
      {/* Input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-slate-500 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search devices, clients, events… (Ctrl+K)"
          className="w-full pl-9 pr-8 py-1.5 text-sm bg-gray-100 dark:bg-slate-700/80 border border-transparent focus:border-blue-500 focus:bg-white dark:focus:bg-slate-800 rounded-lg outline-none transition-colors text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-slate-500"
        />
        {query && (
          <button
            onClick={() => { setQuery(''); setResults(null); inputRef.current?.focus(); }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden max-h-[500px] flex flex-col">
          <div className="overflow-y-auto flex-1">
            {loading && (
              <div className="px-4 py-6 text-sm text-center text-gray-400 dark:text-slate-500">
                Searching…
              </div>
            )}

            {!loading && !hasResults && (
              <div className="px-4 py-8 text-sm text-center text-gray-400 dark:text-slate-500">
                No results for <span className="font-medium text-gray-600 dark:text-slate-300">&quot;{query}&quot;</span>
              </div>
            )}

            {!loading && hasResults && results && (
              <>
                {/* ── Devices ── */}
                {results.devices.length > 0 && (
                  <div>
                    <div className="px-3 pt-3 pb-1.5 text-xs font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider">
                      Devices
                    </div>
                    {results.devices.map((d, i) => (
                      <button
                        key={d.id}
                        className={clsx(
                          'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors',
                          highlighted === i
                            ? 'bg-blue-50 dark:bg-blue-900/20'
                            : 'hover:bg-gray-50 dark:hover:bg-slate-700/50'
                        )}
                        onMouseEnter={() => setHighlighted(i)}
                        onClick={() => goToResult('device', d.id)}
                      >
                        <div className={clsx(
                          'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0',
                          d.status === 'online'
                            ? 'bg-green-100 dark:bg-green-900/30'
                            : 'bg-gray-100 dark:bg-slate-700'
                        )}>
                          <Router className={clsx(
                            'w-3.5 h-3.5',
                            d.status === 'online' ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-slate-500'
                          )} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{d.name}</div>
                          <div className="text-xs text-gray-400 dark:text-slate-500 font-mono">
                            {d.ip_address}{d.model ? ` · ${d.model}` : ''}
                          </div>
                        </div>
                        <span className={clsx(
                          'text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0',
                          d.status === 'online'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400'
                        )}>
                          {d.status}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {/* ── Clients ── */}
                {results.clients.length > 0 && (
                  <div>
                    <div className="px-3 pt-3 pb-1.5 text-xs font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider">
                      Clients
                    </div>
                    {results.clients.map((c, i) => (
                      <button
                        key={c.mac_address}
                        className={clsx(
                          'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors',
                          highlighted === deviceCount + i
                            ? 'bg-blue-50 dark:bg-blue-900/20'
                            : 'hover:bg-gray-50 dark:hover:bg-slate-700/50'
                        )}
                        onMouseEnter={() => setHighlighted(deviceCount + i)}
                        onClick={() => goToResult('client', c.mac_address)}
                      >
                        <div className="w-7 h-7 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                          <Wifi className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {c.hostname || c.mac_address}
                          </div>
                          <div className="text-xs text-gray-400 dark:text-slate-500 font-mono">
                            {c.hostname ? `${c.mac_address} · ` : ''}
                            {c.ip_address ? `${c.ip_address} · ` : ''}
                            {c.device_name || ''}
                          </div>
                        </div>
                        {!c.active && (
                          <span className="text-xs text-gray-400 dark:text-slate-500 flex-shrink-0">inactive</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {/* ── Events ── */}
                {results.events.length > 0 && (
                  <div>
                    <div className="px-3 pt-3 pb-1.5 text-xs font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider">
                      Events
                    </div>
                    {results.events.map((ev, i) => (
                      <button
                        key={ev.id}
                        className={clsx(
                          'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors',
                          highlighted === deviceCount + clientCount + i
                            ? 'bg-blue-50 dark:bg-blue-900/20'
                            : 'hover:bg-gray-50 dark:hover:bg-slate-700/50'
                        )}
                        onMouseEnter={() => setHighlighted(deviceCount + clientCount + i)}
                        onClick={() => goToResult('event', ev.id)}
                      >
                        <div className={clsx(
                          'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0',
                          SEVERITY_ICON_CLS[ev.severity] || SEVERITY_ICON_CLS.info
                        )}>
                          <AlertTriangle className="w-3.5 h-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{ev.message}</div>
                          <div className="text-xs text-gray-400 dark:text-slate-500">
                            {ev.device_name ? `${ev.device_name} · ` : ''}
                            {formatDateTime(new Date(ev.event_time), { year: undefined })}
                          </div>
                        </div>
                        <span className={clsx(
                          'text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0',
                          SEVERITY_ICON_CLS[ev.severity] || SEVERITY_ICON_CLS.info
                        )}>
                          {ev.severity}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer keyboard hints */}
          {hasResults && (
            <div className="flex-shrink-0 px-3 py-2 border-t border-gray-100 dark:border-slate-700 flex items-center gap-4 text-xs text-gray-400 dark:text-slate-500">
              <span><kbd className="px-1 py-0.5 bg-gray-100 dark:bg-slate-700 rounded text-xs font-sans">↑↓</kbd> navigate</span>
              <span><kbd className="px-1 py-0.5 bg-gray-100 dark:bg-slate-700 rounded text-xs font-sans">↵</kbd> open</span>
              <span><kbd className="px-1 py-0.5 bg-gray-100 dark:bg-slate-700 rounded text-xs font-sans">Esc</kbd> close</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
