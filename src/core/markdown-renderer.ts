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

/** The heading level of the Entry title, which owns the page's only h1 (Req 7.3). */
const TITLE_HEADING_LEVEL = 1;

/** The deepest heading level HTML offers; deeper nesting collapses onto it. */
const MAX_HEADING_LEVEL = 6;

/** Matches the `tag` of a `heading_open` or `heading_close` token and captures its level. */
const HEADING_TAG_PATTERN = /^h([1-6])$/;

/** Rewrites a heading token's tag, keeping `markup` consistent with it. */
function setHeadingLevel(token: Token, level: number): void {
  // Mutating token properties rather than the `tokens` parameter is how every `markdown-it` core
  // rule works, and it keeps `no-param-reassign` satisfied.
  token.tag = `h${level}`;
  // After demotion `markup` no longer describes the source — the source said `#` for a token now
  // tagged `h2` — so it is kept consistent with `tag` instead of with the source. ATX is the only
  // spelling that covers all six levels, so setext headings acquire an ATX `markup` here. Nothing
  // in the renderer reads `markup` for headings; this keeps the stream internally coherent for any
  // future consumer that does.
  token.markup = '#'.repeat(level);
}

/**
 * Shifts body heading levels down so the page is single-rooted at the Entry title's h1 and the
 * sequence of heading levels never skips a level (Req 7.3, 7.7; Property 13).
 *
 * **Plain demotion is not enough, and this is the substantive point.** The design states the step as
 * a fixed mapping — h1→h2 … h5→h6, h6→h6 — which removes the second h1 but does *not* deliver Req
 * 7.7's "skipping no level" clause. Two counterexamples, both ordinary Author input:
 *
 * - A body whose only heading is `### Deep` maps to h4. The page is then h1, h4: h2 and h3 skipped.
 * - A body of `# A` then `### B` maps to h2, h4: h3 skipped.
 *
 * The fixed mapping is correct exactly when the body's own headings are already sequential from
 * level 1, because then source level *is* nesting depth. So the rule implemented here is the one the
 * mapping is a special case of: **render each heading at its nesting depth**, counted from the title.
 *
 * A stack holds the source levels of the current heading's ancestors. For each heading, ancestors at
 * the same or a deeper level are popped — a heading closes every section at least as deep as itself —
 * and the heading is pushed. Its rendered level is `depth + 1`, the `+ 1` being the title's h1,
 * clamped to {@link MAX_HEADING_LEVEL}.
 *
 * Why that satisfies both clauses of Req 7.7:
 *
 * - Every rendered level is at least 2, so the body contributes no h1 and the title's is the only one.
 * - Each heading pops zero or more entries and pushes exactly one, so depth grows by at most 1 from
 *   one heading to the next, and so does the rendered level. Decreases are unconstrained, which is
 *   what "skipping no level" permits — only *increases* can skip. Clamping can only lower a level, so
 *   it cannot introduce a skip either.
 *
 * On a body whose headings run `# … ######` sequentially this reproduces the design's mapping exactly,
 * including the h6→h6 collapse: two originally distinct source levels then render at the same level,
 * losing that one level of visible hierarchy past the sixth. That is the design's instruction and HTML
 * offers nothing deeper; the alternative, emitting `h7`, is not an HTML heading at all.
 *
 * The ancestor stack is local to the call, so nothing carries between renders.
 */
function demoteHeadings(tokens: Token[]): void {
  /** Source levels of the ancestors of the heading being visited, outermost first. */
  const ancestorSourceLevels: number[] = [];
  /** The rendered level assigned to the open heading, so its `heading_close` can match it. */
  let openHeadingLevel: number | undefined;

  for (const token of tokens) {
    if (token.type === 'heading_close') {
      if (openHeadingLevel !== undefined) {
        setHeadingLevel(token, openHeadingLevel);
        openHeadingLevel = undefined;
      }
      continue;
    }
    if (token.type !== 'heading_open') {
      continue;
    }

    const level = HEADING_TAG_PATTERN.exec(token.tag)?.[1];
    if (level === undefined) {
      // Not a heading level this module recognizes: leave the pair untouched rather than guess.
      continue;
    }
    const sourceLevel = Number(level);

    let deepestAncestor = ancestorSourceLevels.at(-1);
    while (deepestAncestor !== undefined && deepestAncestor >= sourceLevel) {
      ancestorSourceLevels.pop();
      deepestAncestor = ancestorSourceLevels.at(-1);
    }
    ancestorSourceLevels.push(sourceLevel);

    const renderedLevel = Math.min(
      ancestorSourceLevels.length + TITLE_HEADING_LEVEL,
      MAX_HEADING_LEVEL,
    );
    setHeadingLevel(token, renderedLevel);
    openHeadingLevel = renderedLevel;
  }
}

/**
 * Builds the `text` token that carries an href as a link's visible name.
 *
 * `markdown-it` exports `Token` as a type only; the class is reachable as a static on the default
 * export, which is the documented way to construct tokens outside a parser state.
 */
function createTextToken(content: string): Token {
  const token = new MarkdownIt.Token('text', '', 0);
  token.content = content;
  return token;
}

/**
 * The visible text a run of inline tokens contributes.
 *
 * Only self-closing tokens carry text: `text` holds its characters and `code_inline` holds its code.
 * Tag-opening and tag-closing tokens (`em_open`, `strong_close`, …) have an empty `content`, so
 * concatenating `content` across the run yields exactly the characters a Reader sees, with no
 * per-type special casing to keep in step with the enabled rule set.
 */
function visibleText(tokens: Token[]): string {
  let text = '';
  for (const token of tokens) {
    text += token.content;
  }
  return text;
}

/**
 * Gives every rendered anchor an accessible name stating its destination (Req 7.7).
 *
 * The rule, from the design: use the link text when present and non-empty, otherwise use the href as
 * the visible text. Three readings that the design leaves to the implementation:
 *
 * - **"Non-empty" means non-blank.** A label of `[   ]`, or of a single non-breaking space, names
 *   nothing to a Reader or to a screen reader, so it is treated as absent. `String#trim` strips
 *   Unicode `White_Space`, which is what makes the NBSP case fall out rather than need a special case.
 * - **A label that renders to markup with no text counts as absent too.** `` [` `](url) `` produces a
 *   `code` element holding one space. Because the whole label is replaced — not just its text tokens —
 *   the empty wrapper goes with it, rather than leaving `<a><code></code></a>` behind.
 * - **An empty href has no destination to state.** `[]()` would render `<a href=""></a>`: no name and
 *   no destination, an anchor that cannot be described at all. The href is the only fallback the
 *   design gives and it is empty, so the anchor is unwrapped and the label's content is rendered on
 *   its own. That keeps the invariant worth having — *every* anchor this module emits has a non-blank
 *   visible name — total, with no invented text. An empty href with a usable label keeps its anchor.
 *
 * The href used as the name is the attribute value, after `normalizeLink`, so the text a Reader sees
 * is the destination the browser will follow, character for character. The renderer escapes it as it
 * escapes any text token, so an `&` or `<` in a URL reaches the page as literal text (Req 7.5).
 */
function nameLinks(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type === 'inline' && token.children !== null) {
      nameLinksInChildren(token.children);
    }
  }
}

function nameLinksInChildren(children: Token[]): void {
  let index = 0;
  while (index < children.length) {
    const open = children[index];
    if (open?.type !== 'link_open') {
      index += 1;
      continue;
    }

    const closeIndex = children.findIndex(
      (token, candidate) => candidate > index && token.type === 'link_close',
    );
    if (closeIndex < 0) {
      // Unbalanced stream: the `link` rule cannot produce one, and guessing is worse than leaving it.
      break;
    }

    const label = children.slice(index + 1, closeIndex);
    if (visibleText(label).trim() !== '') {
      index = closeIndex + 1;
      continue;
    }

    const href = open.attrGet('href');
    const destination = typeof href === 'string' ? href : '';
    if (destination.trim() === '') {
      // No name and no destination: drop the anchor, keep whatever the label held.
      children.splice(closeIndex, 1);
      children.splice(index, 1);
      index += label.length;
      continue;
    }

    children.splice(index + 1, label.length, createTextToken(destination));
    index += 3;
  }
}

/**
 * The token-stream post-processing pipeline, run in order as the last core rule.
 *
 * The two steps are independent: {@link demoteHeadings} touches only `heading_open` and
 * `heading_close` tokens in the block stream, {@link nameLinks} only the children of `inline` tokens.
 */
const TOKEN_STREAM_TRANSFORMS: readonly TokenStreamTransform[] = [demoteHeadings, nameLinks];

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
