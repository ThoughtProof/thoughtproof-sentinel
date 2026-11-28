/**
 * Exact product of two canonical ASCII decimals. No binary floating point.
 * The scale is the sum of the input scales. Trailing fractional zeros are
 * removed. 25 * 40.00 is 1000, which compares equal to 1000.00.
 */
export function multiplyDecimal(left: string, right: string): string | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(left) || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(right)) return null;
  const [li, lf = ''] = left.split('.');
  const [ri, rf = ''] = right.split('.');
  const product = BigInt(li + lf) * BigInt(ri + rf);
  const scale = lf.length + rf.length;
  const digits = product.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits.replace(/^0+(?=\d)/, '');
  const head = digits.slice(0, -scale).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction.length === 0 ? head : `${head}.${fraction}`;
}
