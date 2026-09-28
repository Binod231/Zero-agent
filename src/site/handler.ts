import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoEntryRepository } from '../core/entry-repository';
import { renderMarkdown } from '../core/markdown-renderer';
import type { EntrySummary, HttpResponse } from '../core/types';

const tableName = process.env.TABLE_NAME ?? '';
const ddbClient = new DynamoDBClient({});
const repository = new DynamoEntryRepository({ client: ddbClient, tableName });

const PAGE_SIZE = 20;

const BASE_CSS = `
:root {
  --bg: #0d1117;
  --card-bg: #161b22;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --border: #30363d;
  --link: #58a6ff;
  --link-hover: #79c0ff;
  --accent: #238636;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --card-bg: #f6f8fa;
    --text: #1f2328;
    --text-muted: #656d76;
    --border: #d0d7de;
    --link: #0969da;
    --link-hover: #1a7f37;
    --accent: #1a7f37;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background-color: var(--bg);
  color: var(--text);
  line-height: 1.6;
  padding: 2rem 1rem;
}
.container {
  max-width: 72ch;
  margin: 0 auto;
}
header {
  margin-bottom: 3rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 1.5rem;
}
.site-title {
  font-size: 1.8rem;
  font-weight: 700;
  text-decoration: none;
  color: var(--text);
}
.site-tagline {
  color: var(--text-muted);
  font-size: 0.95rem;
  margin-top: 0.35rem;
}
.nav-links {
  margin-top: 0.75rem;
  display: flex;
  gap: 1.25rem;
  font-size: 0.9rem;
}
a {
  color: var(--link);
  text-decoration: underline;
  text-underline-offset: 3px;
}
a:hover {
  color: var(--link-hover);
}
a:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 3px;
}
.entry-card {
  padding: 1.5rem;
  margin-bottom: 1.5rem;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.entry-title {
  font-size: 1.35rem;
  margin-bottom: 0.4rem;
}
.entry-title a {
  text-decoration: none;
  color: var(--text);
}
.entry-title a:hover {
  color: var(--link);
}
.entry-date {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
.entry-body {
  margin-top: 1.5rem;
}
.entry-body h2 { font-size: 1.4rem; margin: 1.5rem 0 0.75rem; }
.entry-body h3 { font-size: 1.2rem; margin: 1.25rem 0 0.5rem; }
.entry-body p { margin-bottom: 1rem; }
.entry-body ul, .entry-body ol { margin: 0 0 1rem 1.5rem; }
.entry-body li { margin-bottom: 0.25rem; }
.entry-body blockquote {
  border-left: 4px solid var(--border);
  padding-left: 1rem;
  color: var(--text-muted);
  margin: 1rem 0;
}
.entry-body pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1rem;
  overflow-x: auto;
  margin-bottom: 1rem;
}
.entry-body code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
}
.pagination {
  display: flex;
  justify-content: space-between;
  margin-top: 2.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
}
footer {
  margin-top: 4rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.85rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
`;

function htmlShell(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="Devlog Narrator — A build-in-public devlog powered by Amazon Bedrock on AWS.">
  <link rel="alternate" type="application/rss+xml" title="Devlog Narrator RSS Feed" href="/feed.xml">
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="container">
    <header>
      <a href="/" class="site-title">Devlog Narrator</a>
      <div class="site-tagline">Autonomous build-in-public devlog on AWS • Built for Zero to Shipped</div>
      <nav class="nav-links">
        <a href="/">Timeline</a>
        <a href="/feed.xml">RSS Feed</a>
        <a href="/console/index.html">Author Console</a>
      </nav>
    </header>
    <main>
      ${content}
    </main>
    <footer>
      <div>Shipped live on AWS • Bedrock & CDK</div>
      <div><a href="/feed.xml">RSS Feed</a></div>
    </footer>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COMMON_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; script-src 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cache-control': 'public, max-age=0, s-maxage=30',
};

export async function renderTimeline(pageNumber: number): Promise<HttpResponse> {
  const page = Math.max(1, pageNumber);
  const fetchLimit = page * PAGE_SIZE + 1;

  try {
    const res = await repository.queryTimeline({ limit: fetchLimit });
    if (!res.ok) {
      return renderDegraded();
    }

    const all = res.value;
    const offset = (page - 1) * PAGE_SIZE;
    const entries = all.slice(offset, offset + PAGE_SIZE);
    const hasNext = all.length > offset + PAGE_SIZE;
    const hasPrev = page > 1;

    let content = '';
    if (entries.length === 0) {
      content = `
        <div class="entry-card">
          <h2>No devlog entries published yet</h2>
          <p style="margin-top: 0.5rem; color: var(--text-muted);">
            The builder has not published any devlog entries yet. Check back soon!
          </p>
        </div>`;
    } else {
      content = entries
        .map(
          (entry: EntrySummary) => `
        <article class="entry-card">
          <div class="entry-date">${escapeHtml(entry.sessionDate)}</div>
          <h2 class="entry-title"><a href="/entry/${escapeHtml(entry.entryId)}">${escapeHtml(entry.title)}</a></h2>
        </article>`,
        )
        .join('\n');

      content += `
        <nav class="pagination">
          <div>${hasPrev ? `<a href="${page === 2 ? '/' : `/page/${page - 1}`}">← Preceding Page</a>` : ''}</div>
          <div>Page ${page}</div>
          <div>${hasNext ? `<a href="/page/${page + 1}">Following Page →</a>` : ''}</div>
        </nav>`;
    }

    return {
      statusCode: 200,
      headers: COMMON_HEADERS,
      body: htmlShell('Devlog Narrator — Timeline', content),
    };
  } catch {
    return renderDegraded();
  }
}

export async function renderEntry(entryId: string): Promise<HttpResponse> {
  try {
    const res = await repository.getEntry(entryId);
    if (!res.ok) {
      return renderDegraded();
    }
    const entry = res.value;
    if (!entry || entry.status !== 'published') {
      return {
        statusCode: 404,
        headers: COMMON_HEADERS,
        body: htmlShell(
          'Entry Not Found — Devlog Narrator',
          `<div class="entry-card">
            <h2>Entry Not Found</h2>
            <p style="margin-top: 0.5rem; color: var(--text-muted);">The requested devlog entry does not exist or has not been published.</p>
            <p style="margin-top: 1rem;"><a href="/">← Return to Timeline</a></p>
          </div>`,
        ),
      };
    }

    const renderedBody = renderMarkdown(entry.body);
    const content = `
      <article>
        <p style="margin-bottom: 1rem;"><a href="/">← Back to Timeline</a></p>
        <div class="entry-date">${escapeHtml(entry.sessionDate)} • Created ${escapeHtml(entry.createdAt.slice(0, 10))}</div>
        <h1 style="font-size: 2rem; margin-bottom: 1rem;">${escapeHtml(entry.title)}</h1>
        <div class="entry-body">
          ${renderedBody}
        </div>
      </article>`;

    return {
      statusCode: 200,
      headers: COMMON_HEADERS,
      body: htmlShell(`${entry.title} — Devlog Narrator`, content),
    };
  } catch {
    return renderDegraded();
  }
}

export async function renderFeed(baseUrl: string = 'https://d1ulthnylvky08.cloudfront.net'): Promise<HttpResponse> {
  try {
    const res = await repository.queryTimeline({ limit: 20 });
    const items = res.ok ? res.value : [];

    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<?xml-stylesheet type="text/xsl" href="/feed.xsl"?>
<rss version="2.0">
<channel>
  <title>Devlog Narrator</title>
  <link>${baseUrl}</link>
  <description>Single-Author build-in-public devlog powered by Amazon Bedrock on AWS</description>
  <language>en-us</language>
  ${items
    .map(
      (entry: EntrySummary) => `
  <item>
    <title>${escapeXml(entry.title)}</title>
    <link>${baseUrl}/entry/${escapeXml(entry.entryId)}</link>
    <guid isPermaLink="true">${baseUrl}/entry/${escapeXml(entry.entryId)}</guid>
    <pubDate>${new Date(entry.createdAt).toUTCString()}</pubDate>
  </item>`,
    )
    .join('\n')}
</channel>
</rss>`;

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': 'public, max-age=0, s-maxage=30',
      },
      body: xml,
    };
  } catch {
    return renderDegraded();
  }
}

export function renderFeedXsl(): HttpResponse {
  const xsl = `<?xml version="1.0" encoding="utf-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:output method="html" version="5.0" encoding="UTF-8" indent="yes"/>
<xsl:template match="/">
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title><xsl:value-of select="/rss/channel/title"/> — RSS Feed</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #6366f1;
      --primary-hover: #818cf8;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f9fafb;
        --card-bg: #ffffff;
        --border: #e5e7eb;
        --text: #111827;
        --text-muted: #6b7280;
        --primary: #4f46e5;
        --primary-hover: #6366f1;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem 1rem;
    }
    .container {
      max-width: 48rem;
      margin: 0 auto;
    }
    .banner {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 2rem;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }
    .banner h1 {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
      color: var(--text);
    }
    .banner p {
      color: var(--text-muted);
      font-size: 0.95rem;
      margin-bottom: 0.75rem;
    }
    .banner code {
      background: rgba(99, 102, 241, 0.15);
      color: var(--primary);
      padding: 0.2rem 0.4rem;
      border-radius: 0.25rem;
      font-size: 0.9em;
      word-break: break-all;
    }
    .nav-link {
      display: inline-block;
      color: var(--primary);
      text-decoration: none;
      font-weight: 500;
      margin-top: 0.5rem;
    }
    .nav-link:hover { text-decoration: underline; }
    .entries-title {
      font-size: 1.25rem;
      margin-bottom: 1rem;
      color: var(--text);
    }
    .item-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
      margin-bottom: 1rem;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .item-card:hover {
      border-color: var(--primary);
      transform: translateY(-1px);
    }
    .item-title {
      font-size: 1.15rem;
      margin-bottom: 0.4rem;
    }
    .item-title a {
      color: var(--text);
      text-decoration: none;
    }
    .item-title a:hover {
      color: var(--primary);
      text-decoration: underline;
    }
    .item-date {
      font-size: 0.85rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="banner">
      <h1>📡 <xsl:value-of select="/rss/channel/title"/> RSS Feed</h1>
      <p><xsl:value-of select="/rss/channel/description"/></p>
      <p>
        This is an XML RSS syndication feed. Copy this URL (<code><xsl:value-of select="/rss/channel/link"/>/feed.xml</code>) into your RSS feed reader (such as Feedly, Inoreader, or NetNewsWire) to subscribe to automatic devlog updates.
      </p>
      <a class="nav-link" href="/">← Return to Public Timeline</a>
    </div>

    <h2 class="entries-title">Recent Devlog Entries</h2>
    <xsl:for-each select="/rss/channel/item">
      <div class="item-card">
        <h3 class="item-title">
          <a href="{link}"><xsl:value-of select="title"/></a>
        </h3>
        <div class="item-date">
          Published: <xsl:value-of select="pubDate"/>
        </div>
      </div>
    </xsl:for-each>
  </div>
</body>
</html>
</xsl:template>
</xsl:stylesheet>`;

  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/xsl; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
    body: xsl,
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderDegraded(): HttpResponse {
  return {
    statusCode: 200,
    headers: COMMON_HEADERS,
    body: htmlShell(
      'Temporarily Unavailable — Devlog Narrator',
      `<div class="entry-card">
        <h2>Entries Temporarily Unavailable</h2>
        <p style="margin-top: 0.5rem; color: var(--text-muted);">
          Devlog entries are temporarily unavailable while the system connects to data storage. Please reload in a moment.
        </p>
      </div>`,
    ),
  };
}

export interface SiteGatewayEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
}

export async function handler(event: SiteGatewayEvent): Promise<HttpResponse> {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? '/';

  if (path === '/console') {
    return {
      statusCode: 301,
      headers: {
        location: '/console/index.html',
      },
      body: '',
    };
  }

  if (path === '/feed.xsl') {
    return renderFeedXsl();
  }

  if (path === '/feed.xml') {
    const host =
      event.headers?.['x-forwarded-host'] ??
      event.headers?.['host'] ??
      'd1ulthnylvky08.cloudfront.net';
    const baseUrl = `https://${host}`;
    return renderFeed(baseUrl);
  }

  if (path.startsWith('/entry/')) {
    const entryId = path.slice('/entry/'.length).replace(/\/$/, '');
    return renderEntry(entryId);
  }

  if (path.startsWith('/page/')) {
    const pageStr = path.slice('/page/'.length).replace(/\/$/, '');
    const pageNum = Number.parseInt(pageStr, 10);
    return renderTimeline(Number.isFinite(pageNum) ? pageNum : 1);
  }

  return renderTimeline(1);
}
