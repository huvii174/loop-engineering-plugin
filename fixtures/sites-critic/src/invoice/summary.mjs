export function invoiceSummary(inv) {
  return `Invoice ${inv.id}: $${inv.total.toFixed(2)}`;
}
