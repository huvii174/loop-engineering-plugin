/** The one place a price becomes text. */
export function formatPrice(n) {
  return `$${n.toFixed(2)}`;
}
