import { useEffect, useState } from 'react';

/**
 * Trails `value` by `delayMs` of stillness. Search boxes use it so typing a
 * word does not fire one request per keystroke — each Event page request also
 * asks for the table-wide totals, which is exactly the query that gets
 * expensive on a large install.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
