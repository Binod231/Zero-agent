import { describe, expect, it } from 'vitest';
import {
  codePointLength,
  hasNonWhitespaceCodePoint,
  truncateAtCodePoint,
} from '../../src/core/code-points';

/**
 * Intent-carrying examples for the code-point primitives every length rule depends on
 * (Req 3.2, 3.3, 6.7, 8.4). The cases are the ones where a UTF-16 implementation silently differs:
 * astral-plane characters, combining marks, non-ASCII whitespace, and a cut that lands on a
 * surrogate-pair boundary.
 */

// U+1F600 GRINNING FACE: one code point, two UTF-16 code units.
const EMOJI = '\u{1F600}';
// U+1D11E MUSICAL SYMBOL G CLEF: another astral-plane character.
const G_CLEF = '\u{1D11E}';
// U+3000 IDEOGRAPHIC SPACE: whitespace by the Unicode property, not by the ASCII subset.
const IDEOGRAPHIC_SPACE = '\u3000';

describe('codePointLength', () => {
  it('returns 0 for the empty string', () => {
    expect(codePointLength('')).toBe(0);
  });

  it('counts an astral-plane character above U+FFFF once, not twice', () => {
    expect(EMOJI).toHaveLength(2); // UTF-16 code units
    expect(codePointLength(EMOJI)).toBe(1);
    expect(codePointLength(`a${EMOJI}${G_CLEF}b`)).toBe(4);
  });

  it('counts a combining mark as its own code point', () => {
    // "e" + U+0301 COMBINING ACUTE ACCENT renders as one grapheme but is two code points.
    const decomposed = 'e\u0301';
    expect(codePointLength(decomposed)).toBe(2);
    // The precomposed form U+00E9 is one, so the function measures code points, not graphemes.
    expect(codePointLength('\u00e9')).toBe(1);
  });

  it('counts non-ASCII whitespace and line breaks as code points', () => {
    expect(codePointLength(`${IDEOGRAPHIC_SPACE}\u00a0\r\n`)).toBe(4);
  });
});

describe('truncateAtCodePoint', () => {
  it('returns the input unchanged when it is within the limit', () => {
    const text = `notes ${EMOJI}`;
    expect(truncateAtCodePoint(text, 10)).toBe(text);
    expect(truncateAtCodePoint(text, codePointLength(text))).toBe(text);
  });

  it('returns the empty string for a limit of zero', () => {
    expect(truncateAtCodePoint(`${EMOJI}${EMOJI}`, 0)).toBe('');
  });

  it('cuts exactly at a surrogate-pair boundary rather than splitting the pair', () => {
    const text = `a${EMOJI}b`; // 4 UTF-16 units, 3 code points
    expect(truncateAtCodePoint(text, 1)).toBe('a');
    expect(truncateAtCodePoint(text, 2)).toBe(`a${EMOJI}`);
    expect(truncateAtCodePoint(text, 3)).toBe(text);
  });

  it('never leaves a lone surrogate behind', () => {
    const text = EMOJI.repeat(5);
    for (let limit = 0; limit <= 5; limit += 1) {
      const truncated = truncateAtCodePoint(text, limit);
      expect(codePointLength(truncated)).toBe(limit);
      expect(truncated).toBe(text.slice(0, limit * 2));
      // A split pair would make the iterator yield a single orphaned code unit here.
      for (const codePoint of truncated) {
        expect(codePoint).toHaveLength(2);
      }
    }
  });

  it('keeps a combining mark attached to the limit it falls inside', () => {
    // A limit of 1 keeps the base letter and drops the mark: the cut is by code point, and the
    // caller's bound is a code-point bound, so this is the defined behaviour rather than a bug.
    expect(truncateAtCodePoint('e\u0301x', 1)).toBe('e');
    expect(truncateAtCodePoint('e\u0301x', 2)).toBe('e\u0301');
  });

  it('rejects a limit that is not a non-negative integer', () => {
    expect(() => truncateAtCodePoint('abc', -1)).toThrow(RangeError);
    expect(() => truncateAtCodePoint('abc', 1.5)).toThrow(RangeError);
    expect(() => truncateAtCodePoint('abc', Number.NaN)).toThrow(RangeError);
  });
});

describe('hasNonWhitespaceCodePoint', () => {
  it('is false for the empty string', () => {
    expect(hasNonWhitespaceCodePoint('')).toBe(false);
  });

  it('is false for text made only of ideographic spaces', () => {
    expect(hasNonWhitespaceCodePoint(IDEOGRAPHIC_SPACE.repeat(4))).toBe(false);
  });

  it('is false for other Unicode whitespace outside the ASCII subset', () => {
    // NO-BREAK SPACE, OGHAM SPACE MARK, EN QUAD, THIN SPACE, LINE SEPARATOR, PARAGRAPH SEPARATOR,
    // IDEOGRAPHIC SPACE, plus the ASCII set for comparison.
    const whitespace = '\u00a0\u1680\u2000\u2009\u2028\u2029\u3000 \t\r\n\v\f';
    expect(hasNonWhitespaceCodePoint(whitespace)).toBe(false);
  });

  it('is true when a single non-whitespace code point appears anywhere', () => {
    expect(hasNonWhitespaceCodePoint(`${IDEOGRAPHIC_SPACE}a${IDEOGRAPHIC_SPACE}`)).toBe(true);
    expect(hasNonWhitespaceCodePoint('  .  ')).toBe(true);
  });

  it('is true for an astral-plane character and for a lone combining mark', () => {
    expect(hasNonWhitespaceCodePoint(EMOJI)).toBe(true);
    expect(hasNonWhitespaceCodePoint(G_CLEF)).toBe(true);
    expect(hasNonWhitespaceCodePoint('\u0301')).toBe(true);
  });

  it('treats a zero-width space as non-whitespace, matching the Unicode property', () => {
    // U+200B ZERO WIDTH SPACE is not in White_Space, so it is content. Stated as a test so the
    // boundary is a decision on the record rather than an accident.
    expect(hasNonWhitespaceCodePoint('\u200b')).toBe(true);
  });
});
