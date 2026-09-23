// Renders a stored cost for the dashboard. Display only — never writes a row.
export function formatCost(cost) {
  return '$' + (cost || 0).toFixed(2);
}
