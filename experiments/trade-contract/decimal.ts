/**
 * Canonical decimals are bounded ASCII strings: no floats, exponents or rounding.
 * Original tokens may use English or German punctuation; a token that has both
 * readings is ambiguous and is not coerced.
 */
type Decimal = { coefficient: bigint; scale: number };

export type NumericToken =
  | { status: 'exact'; canonical: string; percent: boolean }
  | { status: 'ambiguous' }
  | { status: 'invalid' };

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

function fromGroups(head: string, groups: string[], fraction: string | null): string | null {
  if (!/^(?:0|[1-9]\d{0,2})$/.test(head) || (head.length > 1 && head.startsWith('0'))) return null;
  if (!groups.every(group => /^\d{3}$/.test(group))) return null;
  const integer = (head + groups.join('')).replace(/^0+(?=\d)/, '');
  if (!/^(?:0|[1-9]\d*)$/.test(integer)) return null;
  return fraction === null ? integer : `${integer}.${fraction}`;
}

/** English dot-decimal, including comma thousands. */
function english(digits: string): string | null {
  if (/^(?:0|[1-9]\d*)$/.test(digits)) return digits;
  const plain = /^(0|[1-9]\d*)\.(\d+)$/.exec(digits);
  if (plain) return `${plain[1]}.${plain[2]}`;
  const groupedDecimal = /^(\d{1,3})((?:,\d{3})+)\.(\d+)$/.exec(digits);
  if (groupedDecimal) return fromGroups(groupedDecimal[1], groupedDecimal[2].slice(1).split(','), groupedDecimal[3]);
  const groupedInteger = /^(\d{1,3})((?:,\d{3})+)$/.exec(digits);
  if (groupedInteger) return fromGroups(groupedInteger[1], groupedInteger[2].slice(1).split(','), null);
  return null;
}

/** German comma-decimal, including dot thousands. */
function german(digits: string): string | null {
  const groupedDecimal = /^(\d{1,3})((?:\.\d{3})+),(\d+)$/.exec(digits);
  if (groupedDecimal) return fromGroups(groupedDecimal[1], groupedDecimal[2].slice(1).split('.'), groupedDecimal[3]);
  const plainDecimal = /^(0|[1-9]\d*),(\d+)$/.exec(digits);
  if (plainDecimal) return `${plainDecimal[1]}.${plainDecimal[2]}`;
  const groupedInteger = /^(\d{1,3})((?:\.\d{3})+)$/.exec(digits);
  if (groupedInteger) return fromGroups(groupedInteger[1], groupedInteger[2].slice(1).split('.'), null);
  return null;
}

/**
 * Read one original numeric token.
 * A single space before a trailing `%` is the only permitted whitespace.
 * `1.234` and `1,234` have both an English and a German reading and stay ambiguous.
 */
export function readNumericToken(token: string): NumericToken {
  if (token.length === 0 || token.length > 128) return { status: 'invalid' };
  let body = token;
  let percent = false;
  if (body.endsWith(' %')) {
    body = body.slice(0, -2);
    percent = true;
  } else if (body.endsWith('%')) {
    body = body.slice(0, -1);
    percent = true;
  }
  if (body.length === 0 || /\s/u.test(body)) return { status: 'invalid' };
  let sign: '' | '-' = '';
  if (body.startsWith('-')) {
    sign = '-';
    body = body.slice(1);
  } else if (body.startsWith('+')) return { status: 'invalid' };
  const en = english(body);
  const de = german(body);
  if (en && de) return { status: 'ambiguous' };
  const canonical = sign + (en ?? de ?? '');
  if (!en && !de) return { status: 'invalid' };
  if (canonical.length > 128) return { status: 'invalid' };
  return { status: 'exact', canonical, percent };
}
