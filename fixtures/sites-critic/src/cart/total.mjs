export function cartTotal(items) {
  const sum = items.reduce((s, i) => s + i.price * i.qty, 0);
  return `$${sum.toFixed(2)}`;
}
