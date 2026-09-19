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
 *
 * These are worked examples. The universal statements live in the property tests: Property 12
 * quantifies inert output over arbitrary bodies (task 7.3) and Property 13 quantifies heading
 * structure (task 7.4). Heading *demotion* is task 7.2 and is deliberately not asserted here — the
 * expectations below are the pre-demotion output of this module in isolation.
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
    expect(render('# One')).toBe('<h1>One</h1>');
    expect(render('## Two')).toBe('<h2>Two</h2>');
    expect(render('### Three')).toBe('<h3>Three</h3>');
    expect(render('#### Four')).toBe('<h4>Four</h4>');
    expect(render('##### Five')).toBe('<h5>Five</h5>');
    expect(render('###### Six')).toBe('<h6>Six</h6>');
  });

  it('renders setext headings', () => {
    expect(render('Title\n=====')).toBe('<h1>Title</h1>');
    expect(render('Title\n-----')).toBe('<h2>Title</h2>');
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
