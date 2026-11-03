/**
 * Times the phases of a request for a Server-Timing header, so the browser's
 * network panel shows where a slow response spent its time (#368).
 */
export function phaseTimer(now: () => number = () => performance.now()) {
  let last = now();
  const phases: [string, number][] = [];
  return {
    /** Ends the current phase under this name. */
    mark(name: string): void {
      const t = now();
      phases.push([name, t - last]);
      last = t;
    },
    /** `db;dur=12.3, metrics;dur=4.0` */
    header(): string {
      return phases.map(([n, d]) => `${n.replace(/[^A-Za-z0-9_-]/g, '_')};dur=${d.toFixed(1)}`).join(', ');
    },
  };
}
