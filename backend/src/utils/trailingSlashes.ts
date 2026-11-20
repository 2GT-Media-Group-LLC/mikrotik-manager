/**
 * The text without any slashes at its end. A loop rather than
 * `replace(/\/+$/, '')`, which backtracks over every run of slashes not at the
 * end: quadratic on a long one, and these are URLs and paths people type
 * (CodeQL js/polynomial-redos).
 */
export function stripTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x2f) end--;
  return text.slice(0, end);
}
