import { describe, expect, it } from 'vitest';
import type { DecodeError, ParseError, ParseResult, PrintResult } from '../../src/core/types';

/**
 * The result and error unions are the mechanism behind the totality properties (Req 4.10, 8.2): a
 * caller must be able to handle every outcome, and the compiler must say so. These describers are
 * as much a compile-time assertion as a runtime one — the `never` bindings stop compiling the moment
 * a variant is added to a union without every consumer being updated, which is exactly the failure
 * mode a hand-written `if (result.ok)` chain would hide.
 */

function describeParseResult(result: ParseResult): string {
  switch (result.ok) {
    case true:
      return `parsed ${String(result.records.length)}`;
    case false:
      return describeParseError(result.error);
  }
}

function describeParseError(error: ParseError): string {
  switch (error.kind) {
    case 'MALFORMED':
      return `malformed line ${String(error.line)}: expected ${error.expected}`;
    case 'TOO_MANY_COMMITS':
      return `limit ${String(error.limit)} exceeded at line ${String(error.line)}`;
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

function describePrintResult(result: PrintResult): string {
  if (result.ok) {
    return `printed ${String(result.text.length)}`;
  }
  switch (result.error.kind) {
    case 'INVALID_HASH':
    case 'INVALID_NAME':
    case 'INVALID_DATE':
    case 'INVALID_SUBJECT':
      return `${result.error.kind} at ${String(result.error.index)}`;
    case 'TOO_MANY_COMMITS':
      return `limit ${String(result.error.limit)}`;
    default: {
      const exhaustive: never = result.error;
      return exhaustive;
    }
  }
}

function describeDecodeError(error: DecodeError): string {
  switch (error.kind) {
    case 'MISSING_ATTRIBUTE':
    case 'WRONG_TYPE':
    case 'OUT_OF_RANGE':
      return `${error.kind}: ${error.attribute}`;
    case 'UNKNOWN_SCHEMA':
      return `UNKNOWN_SCHEMA: ${String(error.version)}`;
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

describe('core result unions', () => {
  it('narrows a ParseResult on its ok tag', () => {
    expect(describeParseResult({ ok: true, records: [] })).toBe('parsed 0');
    expect(
      describeParseResult({ ok: false, error: { kind: 'MALFORMED', line: 7, expected: 'commit' } }),
    ).toBe('malformed line 7: expected commit');
    expect(
      describeParseResult({
        ok: false,
        error: { kind: 'TOO_MANY_COMMITS', line: 3001, limit: 500 },
      }),
    ).toBe('limit 500 exceeded at line 3001');
  });

  it('narrows a PrintResult on its ok tag and its error kind', () => {
    expect(describePrintResult({ ok: true, text: 'abc' })).toBe('printed 3');
    expect(describePrintResult({ ok: false, error: { kind: 'INVALID_HASH', index: 2 } })).toBe(
      'INVALID_HASH at 2',
    );
    expect(
      describePrintResult({ ok: false, error: { kind: 'TOO_MANY_COMMITS', limit: 500 } }),
    ).toBe('limit 500');
  });

  it('narrows a DecodeError to the attribute it names, never its value', () => {
    expect(describeDecodeError({ kind: 'WRONG_TYPE', attribute: 'generationFailed' })).toBe(
      'WRONG_TYPE: generationFailed',
    );
    expect(describeDecodeError({ kind: 'UNKNOWN_SCHEMA', version: 2 })).toBe('UNKNOWN_SCHEMA: 2');
  });
});
