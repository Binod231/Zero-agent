import { describe, expect, it } from 'vitest';
import { createRestrictedMarkdownIt, renderMarkdown } from '../../src/core/markdown-renderer';

/**
 * Intent-carrying examples for the restricted Markdown_Renderer.
 *
 * Three things are pinned here:
 *
 * 1. Every construct Req 7.3 names renders as the element it names.
 * 2. Every other construct renders as its literal source text, verified construct by construct
 *    rather than assumed from the choice of preset.
 * 3. The Req 7.5 escaping obligation holds for the adversarial shapes that matter: `<script>`
 *    payloads, event-handler attributes, and `javascript:` hrefs including obfuscated spellings.
 * 4. The two token-stream post-processing steps: heading demotion and accessible link naming, each
 *    with the edge cases the design leaves to the implementation (Req 7.7).
 *
 * These are worked examples. The universal statements live in the property tests: Property 12
 * quantifies inert output over arbitrary bodies (task 7.3) and Property 13 quantifies heading
 * structure over arbitrary heading sequences (task 7.4).
 */

/** Renders `source` and strips the trailing newline `markdown-it` appends to block output. */
function render(source: string): string {
  return renderMarkdown(source).trimEnd();
}

describe('enabled rule set', () => {
  it('enables exactly the rules Req 7.3 maps to, and nothing else', () => {
    const md = createRestrictedMarkdownIt();
    const enabled = (rules: { name: string; enabled: boolean }[]): string[] =>
      rules.filter((rule) => rule.enabled).map((rule) => rule.name);

    // Infrastructure rules from the `zero` preset, plus the task 7.2 transform hook.
    expect(enabled(md.core.ruler.__rules__)).toStrictEqual([
      'normalize',
      'block',
      'strip_references',
      'inline',
      'text_join',
      'devlog_token_stream_transforms',
    ]);
    // `paragraph` is the `zero` preset's fallback; `table`, `code`, `hr`, `reference`, and
    // `html_block` stay off.
    expect(enabled(md.block.ruler.__rules__)).toStrictEqual([
      'fence',
      'blockquote',
      'list',
      'heading',
      'lheading',
      'paragraph',
    ]);
    // `linkify`, `newline`, `escape`, `strikethrough`, `image`, `autolink`, `html_inline`, and
    // `entity` stay off.
    expect(enabled(md.inline.ruler.__rules__)).toStrictEqual([
      'text',
      'backticks',
      'emphasis',
      'literal_image_marker',
      'link',
    ]);
    expect(enabled(md.inline.ruler2.__rules__)).toStrictEqual([
      'balance_pairs',
      'emphasis',
      'fragments_join',
    ]);
  });

  it('turns raw HTML, linkification, and typographic rewriting off at the option level', () => {
    const md = createRestrictedMarkdownIt();
    expect(md.options.html).toBe(false);
    expect(md.options.linkify).toBe(false);
    expect(md.options.typographer).toBe(false);
  });
});

describe('constructs Req 7.3 supports', () => {
  it('renders ATX headings at every level', () => {
    // Heading demotion renders each body heading at its nesting depth below the Entry title's h1, so
    // a lone heading opens at h2 whatever its source level, and a body whose headings run 1 through 6
    // lands on h2 through h6. What is asserted here is that all six ATX levels are *recognized* as
    // headings; the demotion rule itself is pinned in the heading-structure block below.
    expect(render('# One')).toBe('<h2>One</h2>');
    expect(render('## Two')).toBe('<h2>Two</h2>');
    expect(render('### Three')).toBe('<h2>Three</h2>');
    expect(render('#### Four')).toBe('<h2>Four</h2>');
    expect(render('##### Five')).toBe('<h2>Five</h2>');
    expect(render('###### Six')).toBe('<h2>Six</h2>');
    expect(render('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six')).toBe(
      '<h2>One</h2>\n<h3>Two</h3>\n<h4>Three</h4>\n<h5>Four</h5>\n<h6>Five</h6>\n<h6>Six</h6>',
    );
  });

  it('renders setext headings', () => {
    expect(render('Title\n=====')).toBe('<h2>Title</h2>');
    expect(render('Title\n-----')).toBe('<h2>Title</h2>');
    // The two underline styles stay one level apart when both appear.
    expect(render('A\n=====\n\nB\n-----')).toBe('<h2>A</h2>\n<h3>B</h3>');
  });

  it('renders strong and em emphasis in both marker styles', () => {
    expect(render('**a** __b__')).toBe('<p><strong>a</strong> <strong>b</strong></p>');
    expect(render('*a* _b_')).toBe('<p><em>a</em> <em>b</em></p>');
  });

  it('renders unordered and ordered lists, including nesting and a start offset', () => {
    expect(render('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    expect(render('1. a\n2. b')).toBe('<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
    expect(render('3. a')).toBe('<ol start="3">\n<li>a</li>\n</ol>');
    expect(render('- a\n  - b')).toBe('<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n</ul>');
  });

  it('renders inline links, preserving query and fragment', () => {
    expect(render('[text](https://example.com/p?q=1#f)')).toBe(
      '<p><a href="https://example.com/p?q=1#f">text</a></p>',
    );
  });

  it('renders inline code with its content escaped', () => {
    expect(render('use `a < b & c`')).toBe('<p>use <code>a &lt; b &amp; c</code></p>');
  });

  it('renders fenced code blocks with the info string as a language class', () => {
    expect(render('```ts\nconst a = 1;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1;\n</code></pre>',
    );
    expect(render('```\nplain\n```')).toBe('<pre><code>plain\n</code></pre>');
    expect(render('~~~\ntilde\n~~~')).toBe('<pre><code>tilde\n</code></pre>');
  });

  it('renders block quotes and the constructs nested inside them', () => {
    expect(render('> quoted **bold**')).toBe(
      '<blockquote>\n<p>quoted <strong>bold</strong></p>\n</blockquote>',
    );
  });
});

describe('constructs Req 7.3 excludes render as literal source text', () => {
  // Each case asserts the visible text equals the source. Where the source contains `<`, `>`, `&`,
  // or `"`, the expectation carries the escaped form, which is the same visible text.
  const literalCases: [name: string, source: string, expected: string][] = [
    ['table', '| a | b |\n| - | - |\n| 1 | 2 |', '<p>| a | b |\n| - | - |\n| 1 | 2 |</p>'],
    ['footnote reference', 'note[^1]', '<p>note[^1]</p>'],
    ['footnote definition', '[^1]: the note', '<p>[^1]: the note</p>'],
    ['definition list', 'Term\n: Definition', '<p>Term\n: Definition</p>'],
    [
      'raw HTML block',
      '<div class="x">hi</div>',
      '<p>&lt;div class=&quot;x&quot;&gt;hi&lt;/div&gt;</p>',
    ],
    ['raw HTML inline', 'a <b>bold</b> c', '<p>a &lt;b&gt;bold&lt;/b&gt; c</p>'],
    ['HTML comment', '<!-- hidden -->', '<p>&lt;!-- hidden --&gt;</p>'],
    ['processing instruction', '<?php echo 1; ?>', '<p>&lt;?php echo 1; ?&gt;</p>'],
    ['doctype', '<!DOCTYPE html>', '<p>&lt;!DOCTYPE html&gt;</p>'],
    ['CDATA section', '<![CDATA[x]]>', '<p>&lt;![CDATA[x]]&gt;</p>'],
    ['image', '![alt](https://example.com/i.png)', '<p>![alt](https://example.com/i.png)</p>'],
    ['image with empty alt', '![](i.png)', '<p>![](i.png)</p>'],
    ['URI autolink', '<https://example.com>', '<p>&lt;https://example.com&gt;</p>'],
    ['email autolink', '<user@example.com>', '<p>&lt;user@example.com&gt;</p>'],
    ['bare URL (linkify off)', 'see https://example.com now', '<p>see https://example.com now</p>'],
    ['strikethrough', '~~gone~~', '<p>~~gone~~</p>'],
    ['task list marker', '- [ ] todo', '<ul>\n<li>[ ] todo</li>\n</ul>'],
    ['thematic break', 'a\n\n***\n\nb', '<p>a</p>\n<p>***</p>\n<p>b</p>'],
    ['reference link', '[foo][bar]', '<p>[foo][bar]</p>'],
    [
      'link reference definition',
      '[bar]: https://example.com',
      '<p>[bar]: https://example.com</p>',
    ],
    ['HTML entity', 'AT&amp;T', '<p>AT&amp;amp;T</p>'],
    ['numeric character reference', '&#x3C;script&#x3E;', '<p>&amp;#x3C;script&amp;#x3E;</p>'],
    ['typographic quotes and dashes', '"q" -- x ...', '<p>&quot;q&quot; -- x ...</p>'],
  ];

  it.each(literalCases)('renders %s literally', (_name, source, expected) => {
    expect(render(source)).toBe(expected);
  });

  it('renders an indented code block as paragraph text rather than a code block', () => {
    // Req 7.3 names *fenced* code blocks, so the four-space form is not a construct here. HTML
    // collapses the leading indent, so the visible text is the source text.
    expect(render('    indented\n')).toBe('<p>indented</p>');
  });

  it('does not emit a hard line break for two trailing spaces', () => {
    expect(render('a  \nb')).toBe('<p>a  \nb</p>');
    expect(render('a\nb')).toBe('<p>a\nb</p>');
  });

  it('leaves a backslash escape visible because escapes are not an enabled construct', () => {
    // The backslash itself is literal. `*` still belongs to the enabled emphasis construct, so it
    // is consumed as markup; the escape does not suppress it.
    expect(render(String.raw`\*text\*`)).toBe('<p>\\<em>text\\</em></p>');
  });

  it('renders a link whose whole label is an image as literal source text', () => {
    // Declining the image marker during link-label look-ahead makes CommonMark's no-links-in-links
    // rule reject the construct, so nothing is rendered as markup. See `literalImageMarker`.
    expect(render('[![alt](i.png)](https://example.com)')).toBe(
      '<p>[![alt](i.png)](https://example.com)</p>',
    );
  });

  it('still renders a link that merely contains an image among other label text', () => {
    expect(render('![[inner](https://example.com)](i.png)')).toBe(
      '<p>![<a href="https://example.com">inner</a>](i.png)</p>',
    );
  });
});

describe('Req 7.5: HTML in a body is escaped, never emitted as markup', () => {
  it('escapes a script payload rather than stripping it', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n');
    // Escaped, not stripped: the source text is still visible to the Reader.
    expect(html).toContain('alert(1)');
    expect(html).not.toContain('<script');
  });

  it('escapes an event-handler attribute', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).toBe('<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>\n');
    expect(html).not.toContain('<img');
  });

  it('escapes tag soup that tries to break out of the surrounding element', () => {
    expect(render('</p><svg onload=alert(1)>')).toBe(
      '<p>&lt;/p&gt;&lt;svg onload=alert(1)&gt;</p>',
    );
  });

  it('escapes HTML inside inline code and fenced code blocks', () => {
    expect(render('`<script>x</script>`')).toBe(
      '<p><code>&lt;script&gt;x&lt;/script&gt;</code></p>',
    );
    expect(render('```\n<script>x</script>\n```')).toBe(
      '<pre><code>&lt;script&gt;x&lt;/script&gt;\n</code></pre>',
    );
  });

  it('escapes HTML inside a link label and a link title', () => {
    expect(render('[<b>x</b>](https://example.com "a\\" onmouseover=\\"alert(1)")')).toBe(
      '<p><a href="https://example.com" title="a&quot; onmouseover=&quot;alert(1)">&lt;b&gt;x&lt;/b&gt;</a></p>',
    );
  });

  it('escapes a quote smuggled through a fenced code block info string', () => {
    expect(render('```js" onload="alert(1)\nx\n```')).toBe(
      '<pre><code class="language-js&quot;">x\n</code></pre>',
    );
  });
});

describe('Req 7.5: no href can carry an executable URL', () => {
  const rejectedDestinations = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'jAvAsCrIpT:alert(1)',
    // Percent-encoded first letter: `%6a` decodes to `j`, so the scheme spells `javascript`.
    '%6aavascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
  ];

  it.each(rejectedDestinations)('renders [x](%s) as literal source text', (destination) => {
    const html = renderMarkdown(`[x](${destination})`);
    expect(html).not.toContain('<a');
    expect(html).not.toContain('href');
  });

  it('rejects a scheme split by whitespace that URL parsing would rejoin', () => {
    // `normalizeLink` percent-encodes the tab, leaving the scheme-shaped prefix `java%09script`,
    // which is not on the allowlist.
    for (const source of ['[x](<java\tscript:alert(1)>)', '[x](<\u00a0javascript:alert(1)>)']) {
      expect(renderMarkdown(source)).not.toContain('<a');
    }
  });

  it('accepts the allowed schemes', () => {
    expect(render('[x](http://example.com/a)')).toBe('<p><a href="http://example.com/a">x</a></p>');
    expect(render('[x](https://example.com/a)')).toBe(
      '<p><a href="https://example.com/a">x</a></p>',
    );
    expect(render('[x](mailto:a@example.com)')).toBe('<p><a href="mailto:a@example.com">x</a></p>');
    expect(render('[x](MAILTO:a@example.com)')).toBe('<p><a href="MAILTO:a@example.com">x</a></p>');
  });

  it('accepts relative references, which carry no scheme', () => {
    expect(render('[x](/entry/01H)')).toBe('<p><a href="/entry/01H">x</a></p>');
    expect(render('[x](#section)')).toBe('<p><a href="#section">x</a></p>');
    expect(render('[x](?page=2)')).toBe('<p><a href="?page=2">x</a></p>');
    expect(render('[x](../sibling)')).toBe('<p><a href="../sibling">x</a></p>');
    expect(render('[x](//example.com/a)')).toBe('<p><a href="//example.com/a">x</a></p>');
    // A colon after a path separator is not a scheme separator.
    expect(render('[x](images/a:b.png)')).toBe('<p><a href="images/a:b.png">x</a></p>');
  });
});

describe('Req 7.7: heading structure is single-rooted and sequential', () => {
  /** The heading levels a rendered fragment carries, in document order. */
  function headingLevels(html: string): number[] {
    const levels: number[] = [];
    for (const match of html.matchAll(/<h([1-6])>/g)) {
      const [, level] = match;
      if (level !== undefined) {
        levels.push(Number(level));
      }
    }
    return levels;
  }

  it('renders no h1, so the Entry title owns the only h1 on the page', () => {
    for (const source of ['# a', '## a', '### a', '#### a', '##### a', '###### a', 'a\n===']) {
      const html = renderMarkdown(source);
      expect(html).not.toContain('<h1');
      expect(headingLevels(html)).toStrictEqual([2]);
    }
  });

  it('reproduces the design mapping on a body whose headings are already sequential', () => {
    // h1→h2 … h5→h6 and h6→h6. The last step collapses two distinct source levels onto h6: past the
    // sixth level HTML has nothing deeper, so that one level of visible hierarchy is lost.
    const body = '# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n\n###### 6';
    expect(headingLevels(renderMarkdown(body))).toStrictEqual([2, 3, 4, 5, 6, 6]);
  });

  it('skips no level when a body starts deep or jumps levels', () => {
    // Fixed-mapping demotion would render these as [4], [2, 4], [4, 5] and [6, 2] — each a skip after
    // the title's h1, or between consecutive body headings. Rendering at nesting depth avoids that.
    const cases: [source: string, levels: number[]][] = [
      ['### Deep', [2]],
      ['###### Deepest', [2]],
      ['# A\n\n### B\n\n###### C', [2, 3, 4]],
      ['### a\n\n#### b', [2, 3]],
      ['###### a\n\n# b', [2, 2]],
      ['### a\n\n#### b\n\n## c\n\n# d', [2, 3, 2, 2]],
    ];

    for (const [source, expected] of cases) {
      const levels = headingLevels(renderMarkdown(source));
      expect(levels).toStrictEqual(expected);
      // The title's h1 precedes the body, so the walk starts at 1: no increase exceeds one step.
      let previous = 1;
      for (const level of levels) {
        expect(level).toBeLessThanOrEqual(previous + 1);
        previous = level;
      }
    }
  });

  it('demotes headings nested in block quotes and list items', () => {
    expect(render('> # q\n\n- ## li')).toBe(
      '<blockquote>\n<h2>q</h2>\n</blockquote>\n<ul>\n<li>\n<h3>li</h3>\n</li>\n</ul>',
    );
  });

  it('keeps the heading token markup consistent with the demoted tag', () => {
    const tokens = createRestrictedMarkdownIt().parse('# a', {});
    const headings = tokens.filter((token) => token.type.startsWith('heading_'));
    expect(headings.map((token) => token.tag)).toStrictEqual(['h2', 'h2']);
    expect(headings.map((token) => token.markup)).toStrictEqual(['##', '##']);
  });

  it('carries no heading state between renders', () => {
    // The ancestor stack is per call; were it shared, a deep body would change how the next renders.
    const lone = renderMarkdown('### Deep');
    renderMarkdown('# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n\n###### 6');
    expect(renderMarkdown('### Deep')).toBe(lone);
    expect(renderMarkdown('### Deep')).toBe(lone);
  });
});

describe('Req 7.7: every rendered anchor carries a name stating its destination', () => {
  it('uses the link text when the label has text', () => {
    expect(render('[text](https://example.com/a)')).toBe(
      '<p><a href="https://example.com/a">text</a></p>',
    );
    expect(render('[**bold** text](https://example.com/a)')).toBe(
      '<p><a href="https://example.com/a"><strong>bold</strong> text</a></p>',
    );
  });

  it('uses the href when the label is absent, blank, or whitespace only', () => {
    const named = '<p><a href="https://example.com/a">https://example.com/a</a></p>';
    expect(render('[](https://example.com/a)')).toBe(named);
    expect(render('[   ](https://example.com/a)')).toBe(named);
    // A non-breaking space names nothing a Reader can perceive, so it counts as blank.
    expect(render('[\u00a0](https://example.com/a)')).toBe(named);
    expect(render('[\n](https://example.com/a)')).toBe(named);
  });

  it('replaces a label that renders markup carrying no text, wrapper included', () => {
    // An inline code span holding a single space: text-only replacement would leave `<code></code>`.
    const html = render('[` `](https://example.com/a)');
    expect(html).toBe('<p><a href="https://example.com/a">https://example.com/a</a></p>');
    expect(html).not.toContain('<code>');
  });

  it('names every anchor when a paragraph holds several links', () => {
    expect(render('[a](https://e.com/1), [](https://e.com/2), [](https://e.com/3)')).toBe(
      '<p><a href="https://e.com/1">a</a>, <a href="https://e.com/2">https://e.com/2</a>, ' +
        '<a href="https://e.com/3">https://e.com/3</a></p>',
    );
  });

  it('escapes an href used as visible text', () => {
    expect(render('[](https://example.com/?a=1&b=2)')).toBe(
      '<p><a href="https://example.com/?a=1&amp;b=2">https://example.com/?a=1&amp;b=2</a></p>',
    );
  });

  it('names a link inside a heading and inside a list item', () => {
    expect(render('## [](https://e.com/x)')).toBe(
      '<h2><a href="https://e.com/x">https://e.com/x</a></h2>',
    );
    expect(render('- [](https://e.com/x)')).toBe(
      '<ul>\n<li><a href="https://e.com/x">https://e.com/x</a></li>\n</ul>',
    );
  });

  it('keeps an anchor whose href is empty when the label names it', () => {
    expect(render('[home]()')).toBe('<p><a href="">home</a></p>');
  });

  it('drops the anchor when neither the label nor the href can name it', () => {
    // No name and no destination: an unnamed anchor is an accessibility defect, and the href the
    // design falls back to is empty, so nothing is left to render as a link.
    for (const source of ['[]()', '[ ]()', '[](  )', '[` `]()']) {
      const html = renderMarkdown(source);
      expect(html).not.toContain('<a');
      expect(html).not.toContain('href');
    }
    expect(render('[]()')).toBe('<p></p>');
    // The label's own content survives; only the anchor around it goes.
    expect(render('[ ]()')).toBe('<p> </p>');
  });

  it('renders the same output on repeated calls for bodies exercising both transforms', () => {
    const body = '### Deep\n\n[](https://e.com/1)\n\n# Top\n\n[x](https://e.com/2)\n\n[]()';
    const first = renderMarkdown(body);
    renderMarkdown('# other\n\n[](https://e.com/3)');
    expect(renderMarkdown(body)).toBe(first);
    expect(renderMarkdown(body)).toBe(first);
  });
});

describe('purity', () => {
  const inputs = [
    '',
    '# h\n\ntext **b** `c`\n\n- a\n- b\n\n> q\n\n```js\nx\n```',
    '<script>alert(1)</script>[x](javascript:alert(1))',
    // Lone high surrogate, lone low surrogate, and NUL.
    '\uD800',
    'a\uDFFFb',
    '\u0000',
    // Unbalanced brackets and emphasis markers past the nesting limit.
    '['.repeat(2000) + ']'.repeat(2000),
    '*'.repeat(5000),
    '> '.repeat(3000) + 'deep',
    // Well past the 20000-code-point body cap of Req 6.2.
    'word '.repeat(20000),
  ];

  it.each(inputs.map((input, index) => [index, input]))(
    'returns the identical string on repeated calls (case %i)',
    (_index, input) => {
      const first = renderMarkdown(input);
      const second = renderMarkdown(input);
      const third = renderMarkdown(input);
      expect(second).toBe(first);
      expect(third).toBe(first);
    },
  );

  it('is total: every input returns a string and nothing throws', () => {
    for (const input of inputs) {
      expect(typeof renderMarkdown(input)).toBe('string');
    }
  });

  it('does not leak state between renders of different bodies', () => {
    const a = renderMarkdown('[bar]: https://example.com\n\n[foo][bar]');
    renderMarkdown('# unrelated');
    expect(renderMarkdown('[bar]: https://example.com\n\n[foo][bar]')).toBe(a);
  });
});
