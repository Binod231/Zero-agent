/**
 * Code-point primitives. Every length rule in the System goes through this module.
 *
 * The requirements state their bounds in "Unicode characters" (Req 3.1, 3.3, 6.7, 8.2) and Req 8.4
 * demands that read-back preserve code points above U+FFFF exactly. JavaScript's `String#length`
 * counts UTF-16 code units, so a body of emoji would be rejected at half its stated limit and a
 * naive `slice` would cut a surrogate pair in half and produce a replacement character. These three
 * functions are the only sanctioned way to measure or shorten user text.
 */

/**
 * Matches any code point that does **not** carry the Unicode `White_Space` property.
 *
 * The property, not the ASCII subset: U+3000 IDEOGRAPHIC SPACE, U+00A0 NO-BREAK SPACE, and
 * U+2028 LINE SEPARATOR are whitespace here, so note text made of ideographic spaces is correctly
 * treated as whitespace-only and rejected (Req 3.2). The pattern carries no `g` flag, so it holds
 * no `lastIndex` state between calls and is safe as a module-level constant.
 */
const NON_WHITESPACE_CODE_POINT = /\P{White_Space}/u;

/**
 * Counts Unicode code points, so an astral-plane character counts once rather than twice.
 *
 * Iterating the string uses its well-known string iterator, which yields whole code points. No
 * intermediate array is allocated, which keeps this cheap enough to sit on the request path for a
 * 20000-character bound check.
 */
export function codePointLength(text: string): number {
  const iterator = text[Symbol.iterator]();
  let count = 0;
  while (!iterator.next().done) {
    count += 1;
  }
  return count;
}

/**
 * Returns the longest prefix of `text` holding at most `maxCodePoints` code points.
 *
 * Truncation happens on a code-point boundary, never inside a surrogate pair, so the result is
 * always well-formed UTF-16 and contains no lone surrogate the original did not already hold. When
 * `text` is already within the limit it is returned unchanged, which makes the function the identity
 * on every in-bounds input.
 *
 * @throws RangeError when `maxCodePoints` is not a non-negative integer. That is a caller bug, not
 * a data condition: every call site passes a fixed bound from the design.
 */
export function truncateAtCodePoint(text: string, maxCodePoints: number): string {
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 0) {
    throw new RangeError('maxCodePoints must be a non-negative integer');
  }
  if (maxCodePoints === 0) {
    return '';
  }

  // `end` advances by the UTF-16 width of each code point, so it only ever lands on a boundary.
  let end = 0;
  let taken = 0;
  for (const codePoint of text) {
    if (taken === maxCodePoints) {
      break;
    }
    end += codePoint.length;
    taken += 1;
  }

  return end === text.length ? text : text.slice(0, end);
}

/**
 * True when `text` holds at least one code point without the Unicode `White_Space` property.
 *
 * This is the "at least 1 non-whitespace character" test of Req 3.1 and the rejection test of
 * Req 3.2. An empty string has no such code point and so returns false.
 */
export function hasNonWhitespaceCodePoint(text: string): boolean {
  return NON_WHITESPACE_CODE_POINT.test(text);
}
