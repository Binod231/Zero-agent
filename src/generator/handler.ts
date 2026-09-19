/**
 * Entry_Generator Lambda entry point.
 *
 * Scaffold only. The prompt builder, the Bedrock client, and the invocation budget state machine
 * arrive with task 15. This module exists so `scripts/build.ts` has a stable entry point to bundle,
 * which is what makes the byte-identical-output obligation of Req 12.8 checkable from the first
 * commit. It deliberately carries no behaviour; a later task replaces the body entirely.
 */
export function handler(_event: unknown): never {
  throw new Error('Entry_Generator handler is not implemented yet (task 15).');
}
