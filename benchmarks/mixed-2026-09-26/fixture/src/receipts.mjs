export function parseReceiptId(value) {
  const match = /^RCPT-(\d{4})-(\d{5})$/.exec(value);
  return match ? { year: Number(match[1]), serial: Number(match[2]) } : null;
}

export function formatReceiptId(year, serial) {
  return `RCPT-${year}-${String(serial).padStart(5, '0')}`;
}
