export function lineLabel(item) {
  return `${item.name} — $${(item.price * item.qty).toFixed(2)}`;
}
