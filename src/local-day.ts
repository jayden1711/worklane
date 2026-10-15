/**
 * The calendar day (YYYY-MM-DD) of a moment in this machine's own time zone: what the dashboard's "today" means
 * (runs today, spend today, landed today). Event timestamps stay in UTC; only the day they fall on is read locally,
 * so an evening in a time zone west of UTC doesn't count as tomorrow.
 */
export function localDay(at: number | string | Date = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
