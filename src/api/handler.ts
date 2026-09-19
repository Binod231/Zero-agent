/**
 * Devlog_API Lambda entry point.
 *
 * Scaffold only. The middleware pipeline, routing table, and route handlers arrive with tasks 10
 * through 17. This module exists so `scripts/build.ts` has a stable entry point to bundle, which is
 * what makes the byte-identical-output obligation of Req 12.8 checkable from the first commit.
 * It deliberately carries no behaviour; a later task replaces the body entirely.
 */
export function handler(_event: unknown): never {
  throw new Error('Devlog_API handler is not implemented yet (tasks 10 through 17).');
}
