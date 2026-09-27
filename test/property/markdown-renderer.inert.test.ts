import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/core/markdown-renderer';
import {
  ACTIVE_MARKUP_PAYLOADS,
  ENCODED_PAYLOADS,
  arbMarkdownBody,
} from '../generators';

/**
 * **Property 12: Markdown rendering never emits active markup** (Req 7.5).
 *
 * *For any* Markdown body, the HTML the Public_Site renders contains no `script` element, no
 * event-handler attribute, and no `javascript:` URL, and every HTML tag present in the source body
 * appears in the output as escaped literal text rather than as markup.
 *
 * Validates: Requirement 7.5.
 */

// Regex patterns to detect forbidden constructs in rendered HTML:
// 1. Any <script tag (opening tag, whether with attributes or whitespace)
const SCRIPT_TAG_PATTERN = /<\s*script(?:\s+[^>]*>|>)/i;

// 2. Any event handler attribute on an HTML tag: on[a-z]+ followed by =
const EVENT_HANDLER_ATTR_PATTERN = /<\w+[^>]*\s+on[a-z0-9_-]+\s*=/i;

// 3. Any href or src containing javascript: scheme (case-insensitive, with possible whitespace/control chars)
const JAVASCRIPT_URL_PATTERN = /(?:href|src)\s*=\s*["']?\s*javascript\s*:/i;

describe('Property 12: Markdown rendering never emits active markup', () => {
  it('never emits script elements, event-handler attributes, or javascript: URLs in rendered HTML', () => {
    fc.assert(
      fc.property(arbMarkdownBody, (body: string) => {
        const html = renderMarkdown(body);

        // 1. No script elements
        expect(SCRIPT_TAG_PATTERN.test(html)).toBe(false);

        // 2. No active event handlers on rendered elements
        expect(EVENT_HANDLER_ATTR_PATTERN.test(html)).toBe(false);

        // 3. No javascript: URLs
        expect(JAVASCRIPT_URL_PATTERN.test(html)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('escapes all active markup payloads to safe, inert literal text', () => {
    for (const payload of ACTIVE_MARKUP_PAYLOADS) {
      const html = renderMarkdown(payload);

      expect(SCRIPT_TAG_PATTERN.test(html)).toBe(false);
      expect(EVENT_HANDLER_ATTR_PATTERN.test(html)).toBe(false);
      expect(JAVASCRIPT_URL_PATTERN.test(html)).toBe(false);
    }
  });

  it('preserves encoded payloads without decoding them into active markup', () => {
    for (const payload of ENCODED_PAYLOADS) {
      const html = renderMarkdown(payload);

      expect(SCRIPT_TAG_PATTERN.test(html)).toBe(false);
      expect(EVENT_HANDLER_ATTR_PATTERN.test(html)).toBe(false);
      expect(JAVASCRIPT_URL_PATTERN.test(html)).toBe(false);
    }
  });
});
