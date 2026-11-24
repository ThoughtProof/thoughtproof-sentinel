/** Bounded decimal strings only: no floats, locale coercion, exponent or rounding. */
type Decimal = { coefficient: bigint; scale: number };

function parse(value: string): Decimal | null {
  if (value.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [integer, fraction = ''] = value.split('.');
  return { coefficient: BigInt(integer + fraction), scale: fraction.length };
}

function align(values: Decimal[]): bigint[] {
  const scale = Math.max(...values.map(value => value.scale));
  return values.map(value => value.coefficient * 10n ** BigInt(scale - value.scale));
}

export function compareDecimal(left: string, right: string): -1 | 0 | 1 | null {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  const [x, y] = align([a, b]);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function checkExactCalculation(
  operation: 'add' | 'subtract', left: string, right: string, result: string,
): boolean | null {
  const values = [parse(left), parse(right), parse(result)];
  if (values.some(value => value === null)) return null;
  const [a, b, c] = align(values as Decimal[]);
  return (operation === 'add' ? a + b : a - b) === c;
}
