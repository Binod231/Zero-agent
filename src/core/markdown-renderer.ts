/**
 * Markdown_Renderer: the only sanctioned way to turn an Entry body into HTML.
 *
 * Two obligations shape this module, and they pull in the same direction.
 *
 * Req 7.3 names the Markdown constructs a Published_Entry page supports — ATX and setext headings,
 * `strong` and `em`, ordered and unordered lists, links, inline code, fenced code blocks, and block
 * quotes — and closes by requiring that *any other* construct render as its literal source text.
 *
 * Req 7.5 is a security obligation, not a formatting preference: every HTML tag present in a
 * Markdown body must reach the Reader as literal visible text rather than as markup, so that no
 * script in a body can execute in a Reader's browser. The CSP on public responses
 * (`script-src 'none'`) is defence in depth *behind* this module, not a substitute for it.
 *
 * The configuration therefore starts from `markdown-it`'s `zero` preset — which enables nothing but
 * the paragraph/text machinery — and turns on exactly the eight rules Req 7.3's list maps to. A
 * denylist built by disabling rules on the `default` or `commonmark` preset would silently regain
 * every construct a future `markdown-it` minor release adds to those presets; an allowlist built on
 * `zero` cannot.
 *
 * The renderer is a pure, total, deterministic function of its input string: no I/O, no clock, no
 * shared mutable state between calls, no throw for any input, including lone surrogates and bodies
 * far longer than the 20000-code-point cap Req 6.2 imposes.
 */

import MarkdownIt from 'markdown-it';
// The default export is the callable constructor; the instance type is a separate named export.
import type { MarkdownIt as MarkdownItInstance, StateCore, StateInline, Token } from 'markdown-it';

/**
 * The `markdown-it` rules that realize Req 7.3's construct list, and nothing else.
 *
 * | Req 7.3 construct | rule(s) |
 * | --- | --- |
 * | ATX headings (`# h1` … `###### h6`) | `heading` (block) |
 * | setext headings (`===` / `---` underlines) | `lheading` (block) |
 * | `strong` and `em` | `emphasis` (inline + inline ruler2) |
 * | ordered and unordered lists | `list` (block) |
 * | links | `link` (inline) |
 * | inline code | `backticks` (inline) |
 * | fenced code blocks | `fence` (block) |
 * | block quotes | `blockquote` (block) |
 *
 * `MarkdownIt#enable` searches the core, block, and inline rulers plus the inline `ruler2` chain, so
 * `emphasis` — which is registered in both inline chains — is enabled in both by the single name.
 *
 * Deliberately absent, each of which the closing clause of Req 7.3 wants rendered literally:
 * `table`, `code` (four-space-indented code blocks; Req 7.3 names *fenced* code blocks only),
 * `reference` (link reference definitions), `hr`, `html_block`, `html_inline`, `image`, `autolink`,
 * `strikethrough`, `linkify`, `newline` (hard line breaks), `escape` (backslash escapes), `entity`
 * (HTML entity decoding), `replacements`, and `smartquotes`.
 */
const ENABLED_RULES: readonly string[] = [
  'heading',
  'lheading',
  'emphasis',
  'list',
  'link',
  'backticks',
  'fence',
  'blockquote',
];

/**
 * URL schemes permitted in a rendered `href`.
 *
 * `markdown-it`'s stock `validateLink` is a *denylist* — it rejects `javascript:`, `vbscript:`,
 * `file:`, and most `data:` URLs. A denylist is the wrong shape for this check: it has to enumerate
 * every scheme a browser might treat as executable, now and in future. This allowlist inverts it, so
 * an unrecognized scheme is rejected by default and the link falls back to literal source text.
 */
const ALLOWED_URL_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];

/** Matches a scheme name drawn only from the allowlist, anchored and case-insensitive. */
const ALLOWED_SCHEME_PATTERN = new RegExp(`^(?:${ALLOWED_URL_SCHEMES.join('|')})$`, 'i');

/** Characters that end the scheme-shaped prefix of a URL reference: a colon before any of these is
 * not a scheme separator but an ordinary character inside a path, query, or fragment. */
const PATH_QUERY_OR_FRAGMENT = /[/?#]/;

const EXCLAMATION_MARK = 0x21;
const LEFT_SQUARE_BRACKET = 0x5b;

/**
 * True when `url` is safe to emit as an `href`.
 *
 * The test is structural rather than a scheme denylist. A URL reference carries a scheme only when a
 * colon appears before the first `/`, `?`, or `#`; when it does, the text before that colon must be
 * one of {@link ALLOWED_URL_SCHEMES}. Consequences worth stating:
 *
 * - `javascript:alert(1)`, `vbscript:…`, `data:…`, and `file:…` are all rejected, so the `link` rule
 *   declines the construct and the whole `[text](url)` renders as literal source text.
 * - Obfuscated spellings are rejected too, because they do not match the allowlist rather than
 *   because they were individually anticipated. `%6aavascript:alert(1)` has the scheme-shaped prefix
 *   `%6aavascript`; `java\tscript:…` reaches this function as `java%09script:…` because
 *   `normalizeLink` percent-encodes the tab first. Neither is an allowed scheme.
 * - Relative references keep working: `/entry/x`, `#section`, `?page=2`, `../sibling`, and
 *   `//example.com/x` carry no scheme and are accepted.
 * - A colon after a path separator is not a scheme: `images/a:b.png` is accepted.
 *
 * `String#trim` strips Unicode `White_Space` and line terminators, so a leading NBSP or newline
 * cannot smuggle a scheme past the prefix comparison.
 */
function isAllowedHref(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') {
    // An empty destination — `[text]()` — produces `href=""`, a same-document reference.
    return true;
  }

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex < 0) {
    return true;
  }

  const schemeCandidate = trimmed.slice(0, colonIndex);
  if (PATH_QUERY_OR_FRAGMENT.test(schemeCandidate)) {
    return true;
  }

  return ALLOWED_SCHEME_PATTERN.test(schemeCandidate);
}

/**
 * Renders the image construct as its literal source text.
 *
 * Disabling the `image` rule is not sufficient on its own. Image syntax is link syntax with a
 * leading `!`, so with `image` off and `link` on, `![alt](url)` would parse as a literal `!`
 * followed by a *link* to the image URL — not the literal source text Req 7.3 requires. This rule
 * sits ahead of `link` in the inline chain and consumes the `![` pair as text, which both emits the
 * marker literally and denies the `link` rule the `[` it would otherwise open a label on. The
 * remainder, `alt](url)`, is ordinary inline text, so the rendered output reproduces the source
 * byte for byte.
 *
 * The rule declines in `silent` mode on purpose. Silent mode is the look-ahead pass `skipToken` runs
 * for `parseLinkLabel`, which counts `[`/`]` nesting to find where a link label ends. Consuming the
 * `[` of `![` during that pass would make the label of `[![alt](u)](v)` close at the image's `]`,
 * and the outer link would render with a truncated label — a mangling, not literal source text.
 * Declining instead makes `parseLinkLabel` see a bracket-balanced nested link inside a link, which
 * CommonMark forbids, so it rejects the whole construct and `[![alt](u)](v)` renders as literal
 * source text end to end. A link whose entire label is an image therefore renders literally rather
 * than as a link. That is a deliberate divergence from CommonMark, it is pinned by unit test, and it
 * errs on the side of Req 7.3's literal-source-text clause. Nothing active is emitted either way.
 */
function literalImageMarker(state: StateInline, silent: boolean): boolean {
  if (silent) {
    return false;
  }
  if (state.src.charCodeAt(state.pos) !== EXCLAMATION_MARK) {
    return false;
  }
  if (state.src.charCodeAt(state.pos + 1) !== LEFT_SQUARE_BRACKET) {
    return false;
  }

  // `pending` is flushed into a `text` token, which the renderer HTML-escapes.
  state.pending += '![';
  state.pos += 2;
  return true;
}

/**
 * A transform over the parsed token stream, applied after the core chain has produced block tokens
 * and expanded `inline` tokens into `children`.
 *
 * Transforms mutate `tokens` in place, which is how every `markdown-it` core rule works. A transform
 * that needs inline tokens walks `token.children` for tokens whose `type` is `'inline'`.
 */
type TokenStreamTransform = (tokens: Token[]) => void;

/**
 * The token-stream post-processing pipeline, run in order as the last core rule.
 *
 * Task 7.2 adds its two steps here — heading demotion (h1→h2 … h5→h6, h6→h6, so the page carries
 * exactly one h1, the Entry title, with no skipped level, Req 7.7) and accessible link naming — by
 * writing each as a `TokenStreamTransform` and appending it to this array. No other part of this
 * module changes.
 */
const TOKEN_STREAM_TRANSFORMS: readonly TokenStreamTransform[] = [];

function applyTokenStreamTransforms(state: StateCore): void {
  for (const transform of TOKEN_STREAM_TRANSFORMS) {
    transform(state.tokens);
  }
}

/**
 * Builds the restricted `markdown-it` instance.
 *
 * Exported for tests, which assert the enabled rule set directly rather than inferring it from
 * rendered output.
 */
export function createRestrictedMarkdownIt(): MarkdownItInstance {
  const md = new MarkdownIt('zero', {
    // Req 7.5: the parser never emits raw HTML. Source tags become escaped text.
    html: false,
    // Req 7.3 names links, meaning the `[text](url)` construct. Bare URLs stay literal.
    linkify: false,
    // No smart quotes, dashes, or ellipses: those rewrite the Author's text.
    typographer: false,
    // No `<br>` for a single newline; the `newline` rule is off in any case.
    breaks: false,
  });

  md.enable([...ENABLED_RULES]);
  md.inline.ruler.before('link', 'literal_image_marker', literalImageMarker);
  md.core.ruler.push('devlog_token_stream_transforms', applyTokenStreamTransforms);

  // Scheme allowlist, replacing the stock denylist. See `isAllowedHref`.
  md.validateLink = isAllowedHref;

  return md;
}

/**
 * The process-wide renderer instance.
 *
 * `markdown-it` holds no state across `render` calls — parse state lives in a `StateCore` created
 * per call — so one instance is safe to share and avoids rebuilding the rule chains on every request
 * on a warm Lambda.
 */
const restrictedMarkdownIt = createRestrictedMarkdownIt();

/**
 * Renders an Entry Markdown body to HTML.
 *
 * Total: returns a string for every input, including the empty string, lone surrogates, NUL, and
 * bodies far past the 20000-code-point cap. Deterministic: equal inputs yield equal output on every
 * call, in any order. Pure: no I/O, no clock, no shared mutable state.
 *
 * The returned HTML is a document fragment, not a full page; the Public_Site templates embed it.
 */
export function renderMarkdown(body: string): string {
  // A fresh `env` per call keeps the reference/link bookkeeping from leaking between renders.
  return restrictedMarkdownIt.render(body, {});
}
