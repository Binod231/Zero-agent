import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRestrictedMarkdownIt, renderMarkdown } from '../../src/core/markdown-renderer';
import { arbMarkdownBody, arbMarkdownHeadingBody } from '../generators';

/**
 * **Property 13: Rendered heading structure is single-rooted and sequential** (Req 7.3, 7.7).
 *
 * ## What this file can and cannot assert today
 *
 * The property speaks about the rendered **Published_Entry page**: exactly one level-1 heading — the
 * Entry title — and a heading sequence that never skips a level. `renderMarkdown` renders the Entry
 * **body only**; the title's `h1` is emitted by the Public_Site page template, which is task 19.3 and
 * does not exist yet. There is nothing here to count the page's `h1` elements on, and standing up a
 * throwaway template would assert this file's own HTML rather than the System's.
 *
 * So the page-level clause is asserted in the two halves that the body is responsible for, which
 * together with a template emitting a single title `h1` ahead of the body give the clause in full:
 *
 * 1. **The body contributes zero `h1` elements.** A page whose template emits one title `h1` then has
 *    exactly one, whatever the Author wrote.
 * 2. **The body's first heading is at level 2 or deeper, and at most 2.** Deeper than 1 keeps the
 *    title's `h1` the only one; at most 2 means the step from the title's `h1` to the body's first
 *    heading skips nothing. The no-skip walk below therefore starts at level 1, the title's level,
 *    rather than at the body's first heading.
 *
 * **The remaining half of the clause — that the page template emits exactly one `h1`, carrying the
 * Entry title — is asserted in task 19.3**, against the template, where the `h1` exists. This file
 * does not weaken Property 13; it asserts the part of it that the Markdown_Renderer decides, and
 * names the part it cannot yet reach.
 *
 * ## Why this property bites
 *
 * The design originally specified heading demotion as a fixed one-level shift (`h1`→`h2` … `h6`→`h6`).
 * That satisfies the single-`h1` clause and **fails** the no-skip clause: a body whose only heading is
 * `### Deep` shifts to `h4`, so the page runs `h1`, `h4`. The implementation instead renders each
 * heading at its nesting depth below the title, and the design has been corrected to match. This
 * property is what makes that difference observable, so it counts — per body — whether the fixed
 * mapping *would* have skipped a level, and asserts that the count is not zero. A property that never
 * separates the two implementations would be green against either one and would prove nothing.
 *
 * ## Scope
 *
 * `test/unit/markdown-renderer.test.ts` pins the demotion mapping on named shapes, including headings
 * inside block quotes and list items. This file adds the universal quantification and nothing else.
 */

// ---------------------------------------------------------------------------------------------
// Reading heading levels out of the rendered HTML
// ---------------------------------------------------------------------------------------------

/** The heading level of the Entry title, which the page template owns (Req 7.3). */
const TITLE_HEADING_LEVEL = 1;

/** The deepest level HTML offers, and the level the renderer clamps to. */
const MAX_HEADING_LEVEL = 6;

/**
 * An opening heading tag in rendered output.
 *
 * A regex is the right parser here and not a shortcut: `lib` is `es2023` with no `dom`, so there is no
 * browser parser available, and there is no ambiguity to resolve. Req 7.5 guarantees every `<` in the
 * Author's body reaches the output as `&lt;`, so a raw `<h2>` in the HTML can only have come from a
 * heading token the renderer emitted — never from body text, a fenced code block, or tag soup. The
 * leading `<h` excludes closing tags, whose `<` is followed by `/`.
 */
const HEADING_OPEN_TAG = /<h([1-6])\b[^>]*>/gu;

/** The rendered heading levels of `html`, in document order. */
function renderedHeadingLevels(html: string): number[] {
  const levels: number[] = [];
  for (const match of html.matchAll(HEADING_OPEN_TAG)) {
    const digit = match[1];
    if (digit === undefined) {
      throw new Error(`heading tag matched without a level: ${match[0]}`);
    }
    levels.push(Number(digit));
  }
  return levels;
}

/**
 * The **source** heading levels of `body`, in document order.
 *
 * Built from the restricted parser with the post-processing core rule switched off, so it is the same
 * Markdown dialect the renderer parses — same enabled rules, same literal-image rule, same link
 * validation — with demotion alone removed. Re-deriving heading positions with a hand-written scanner
 * would answer a different question: `#` inside a fenced code block or a lazy block-quote
 * continuation is not a heading, and only the parser knows which.
 *
 * The instance is local to this module and is never used to render, so nothing about the renderer's
 * own behaviour changes.
 */
const undemotedMarkdownIt = createRestrictedMarkdownIt().disable([
  'devlog_token_stream_transforms',
]);

const HEADING_TAG = /^h([1-6])$/u;

function sourceHeadingLevels(body: string): number[] {
  const levels: number[] = [];
  for (const token of undemotedMarkdownIt.parse(body, {})) {
    if (token.type !== 'heading_open') {
      continue;
    }
    const digit = HEADING_TAG.exec(token.tag)?.[1];
    if (digit === undefined) {
      throw new Error(`heading_open token with an unreadable tag: ${token.tag}`);
    }
    levels.push(Number(digit));
  }
  return levels;
}

// ---------------------------------------------------------------------------------------------
// The no-skip predicate, and the fixed-mapping counterfactual
// ---------------------------------------------------------------------------------------------

/**
 * The first index at which `levels` skips a level, or `-1` when none does.
 *
 * The comparison is against the **immediately preceding** level, not against the deepest level seen so
 * far. That distinction is the substance of Req 7.7's "sequential order skipping no level": a
 * *decrease* is unconstrained — closing three sections at once and opening a sibling skips nothing —
 * while an *increase* of more than one leaves a level unused. So a sequence that descends and then
 * jumps back up is judged on the level it jumped from: `2, 3, 4, 2, 4` skips at the final step,
 * because 2 is followed by 4, even though 4 appeared earlier.
 *
 * `previous` starts at the title's level, so the step from the title into the body is checked by the
 * same rule as every other step.
 */
function firstSkipIndex(levels: readonly number[]): number {
  let previous = TITLE_HEADING_LEVEL;
  for (const [index, level] of levels.entries()) {
    if (level - previous > 1) {
      return index;
    }
    previous = level;
  }
  return -1;
}

/**
 * The levels a fixed one-level shift — the design's original wording — would have rendered.
 *
 * Kept here, in the test, precisely because it is *not* in the implementation: it is the counterfactual
 * this property exists to rule out.
 */
function fixedMappingLevels(levels: readonly number[]): number[] {
  return levels.map((level) => Math.min(level + 1, MAX_HEADING_LEVEL));
}

// ---------------------------------------------------------------------------------------------
// The input space
// ---------------------------------------------------------------------------------------------

/**
 * Bodies seeded with headings of every level in random order, tag soup, and script payloads
 * ({@link arbMarkdownBody}), mixed with bodies that reach all six source levels in a shuffled order
 * ({@link arbMarkdownHeadingBody}). The second branch is what keeps deep source levels frequent: a
 * `arbMarkdownBody` draw holds ten blocks at most, so level coverage there is incidental rather than
 * guaranteed.
 */
const arbBody: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: arbMarkdownBody, weight: 3 },
  { arbitrary: arbMarkdownHeadingBody, weight: 1 },
);

/**
 * Shapes run on every execution rather than left to the random stream. The first four are exactly the
 * shapes a fixed one-level shift gets wrong, so the counterfactual count below is a guarantee and not
 * a statistical hope; the fifth is the no-heading base case.
 */
const EXAMPLES: [string][] = [
  // A body whose only heading is level 3. Fixed shift: h4 after the title's h1 — two levels skipped.
  ['### Deep'],
  // Level 1 then level 3. Fixed shift: h2 then h4 — h3 skipped.
  ['# A\n\nfirst section\n\n### B\n\nnested section'],
  // A body that starts at the deepest level. Fixed shift: h6 straight after the title's h1.
  ['###### Six\n\nonly a deep heading and this paragraph'],
  // Descends, then jumps back up, and reaches all six source levels on the way. Fixed shift:
  // 2, 3, 6, 5, 6, 4 — the step from 3 to 6 skips two levels.
  ['# 1\n\n## 2\n\n##### 5\n\n#### 4\n\n###### 6\n\n### 3'],
  // No headings at all: the body contributes nothing, and the page is the title's h1 alone.
  ['a paragraph, a [link](https://example.invalid/x), and `code`, but no heading'],
];

// ---------------------------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------------------------

describe('Markdown_Renderer heading structure (Property 13)', () => {
  it('emits no h1 and never skips a level, for any Markdown body', () => {
    /** Bodies by heading count, so the distribution can be asserted rather than assumed. */
    const bodiesByHeadingCount = new Map<number, number>();
    /** Bodies holding at least one heading at each source level 1 through 6. */
    const bodiesBySourceLevel = new Map<number, number>();
    let bodies = 0;
    let headings = 0;
    /** Bodies a fixed one-level shift would have rendered with a skipped level. */
    let fixedMappingFailures = 0;

    // Feature: devlog-narrator, Property 13: For any Markdown body, the rendered Published_Entry page
    // contains exactly one level-1 heading — the Entry title — and the sequence of heading levels in
    // document order never skips a level.
    fc.assert(
      fc.property(arbBody, (body) => {
        const html = renderMarkdown(body);
        const levels = renderedHeadingLevels(html);
        const sourceLevels = sourceHeadingLevels(body);

        bodies += 1;
        headings += levels.length;
        bodiesByHeadingCount.set(levels.length, (bodiesByHeadingCount.get(levels.length) ?? 0) + 1);
        for (const level of new Set(sourceLevels)) {
          bodiesBySourceLevel.set(level, (bodiesBySourceLevel.get(level) ?? 0) + 1);
        }
        if (firstSkipIndex(fixedMappingLevels(sourceLevels)) >= 0) {
          fixedMappingFailures += 1;
        }

        // Demotion changes levels, never the number of headings: every source heading is rendered as
        // one heading. Without this the two sequences above could drift apart and the counterfactual
        // would be computed from a different document than the one being asserted on.
        expect(levels).toHaveLength(sourceLevels.length);

        // Clause 1, the body's half: zero h1 elements, so a template emitting one title h1 leaves the
        // page with exactly one. Asserted on the raw HTML as well, which catches an `h1` carrying an
        // attribute that a level-extraction bug might have dropped.
        expect(html).not.toContain('<h1');
        expect(levels.filter((level) => level === TITLE_HEADING_LEVEL)).toStrictEqual([]);

        // Every rendered level is a real HTML heading level at or below the title.
        for (const level of levels) {
          expect(level).toBeGreaterThanOrEqual(TITLE_HEADING_LEVEL + 1);
          expect(level).toBeLessThanOrEqual(MAX_HEADING_LEVEL);
        }

        // Clause 1, continued: the first body heading is at most level 2, so the step down from the
        // title's h1 skips nothing.
        const first = levels[0];
        if (first !== undefined) {
          expect(first).toBeLessThanOrEqual(TITLE_HEADING_LEVEL + 1);
        }

        // Clause 2: no increase of more than one, measured against the immediately preceding level and
        // starting from the title's h1. Decreases are unconstrained.
        const skipAt = firstSkipIndex(levels);
        expect(
          skipAt,
          `heading level sequence ${JSON.stringify([TITLE_HEADING_LEVEL, ...levels])} skips a level at body heading ${String(skipAt)}; source levels ${JSON.stringify(sourceLevels)}`,
        ).toBe(-1);
      }),
      { numRuns: 100, examples: EXAMPLES },
    );

    // Non-vacuity. Every count below is guaranteed by the explicit examples, so none of it depends on
    // the seed: the property ran on bodies with no headings, with one, and with six; on source levels
    // 1 through 6; and on bodies the fixed one-level shift would have rendered with a skipped level.
    expect(bodies).toBeGreaterThanOrEqual(100);
    expect(headings).toBeGreaterThan(0);
    expect(bodiesByHeadingCount.get(0) ?? 0).toBeGreaterThan(0);
    expect(bodiesByHeadingCount.get(1) ?? 0).toBeGreaterThan(0);
    expect([...bodiesByHeadingCount.keys()].filter((count) => count >= 4).length).toBeGreaterThan(
      0,
    );
    for (let level = 1; level <= MAX_HEADING_LEVEL; level += 1) {
      expect(
        bodiesBySourceLevel.get(level) ?? 0,
        `no body carried a source h${String(level)}`,
      ).toBeGreaterThan(0);
    }
    // The evidence that the property separates depth-based rendering from the fixed shift the design
    // originally specified: these bodies pass above and would have failed under that shift.
    expect(fixedMappingFailures).toBeGreaterThanOrEqual(4);
  });
});
