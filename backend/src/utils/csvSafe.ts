/**
 * A text value made safe to open in a spreadsheet (outside review U9). A cell
 * starting with = + - @ (or a tab or carriage return) is run as a formula by
 * Excel and others, and command output comes from devices. Such cells are
 * prefixed with an apostrophe, which spreadsheets treat as "this is text".
 */
export function spreadsheetSafe(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
