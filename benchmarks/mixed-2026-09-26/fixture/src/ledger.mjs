export function normalizeSku(value) {
  return value.trim().toUpperCase();
}

export function eligibleForFreeShipping(subtotalCents, region) {
  return region === 'domestic' && subtotalCents >= 5000;
}

export function shippingCents(subtotalCents, region) {
  if (eligibleForFreeShipping(subtotalCents, region)) return 0;
  return region === 'domestic' ? 700 : 1800;
}

export function totalCents(lines, region) {
  const subtotal = lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
  return subtotal + shippingCents(subtotal, region);
}
