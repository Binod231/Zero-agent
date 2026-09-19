/**
 * Public_Site renderer Lambda entry point.
 *
 * Scaffold only. The templates, the timeline and entry routes, the feed, and the degraded read path
 * arrive with tasks 19 and 20. This module exists so `scripts/build.ts` has a stable entry point to
 * bundle, which is what makes the byte-identical-output obligation of Req 12.8 checkable from the
 * first commit. It deliberately carries no behaviour; a later task replaces the body entirely.
 */
export function handler(_event: unknown): never {
  throw new Error('Public_Site renderer is not implemented yet (tasks 19 and 20).');
}
