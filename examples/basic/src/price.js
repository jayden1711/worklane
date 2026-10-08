// Prices are integer cents; never floats.
export function totalCents(items) {
  return items.reduce((sum, { cents, qty }) => sum + cents * qty, 0);
}

export function applyDiscount(cents, pct) {
  if (pct < 0 || pct > 100) throw new RangeError('pct must be 0-100');
  return Math.round(cents * (100 - pct) / 100);
}
