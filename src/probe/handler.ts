/**
 * Availability probe Lambda entry point (design "Availability probing without Synthetics").
 *
 * Scaffold only. The health request through the Public_URL, the latency measurement, and the single
 * custom metric arrive with task 21.1. This module exists so `scripts/build.ts` has a stable entry
 * point to bundle, which is what makes the byte-identical-output obligation of Req 12.8 checkable
 * from the first commit. It deliberately carries no behaviour; a later task replaces the body
 * entirely.
 */
export function handler(_event: unknown): never {
  throw new Error('Availability probe handler is not implemented yet (task 21.1).');
}
