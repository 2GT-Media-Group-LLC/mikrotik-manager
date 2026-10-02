import { spreadsheetSafe } from '../csvSafe';

// Outside review U9: device output must not run as a spreadsheet formula.
describe('spreadsheetSafe', () => {
  it.each(['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@SUM(A1)', '\tx'])('neutralises %s', (v) =>
    expect(spreadsheetSafe(v).startsWith("'")).toBe(true));
  it.each(['/system identity print', 'name: rtr1', ''])('leaves %s alone', (v) => expect(spreadsheetSafe(v)).toBe(v));
});
