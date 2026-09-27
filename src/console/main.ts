/**
 * Author Console Single Page Application for Devlog Narrator
 */

interface SessionData {
  token: string;
  username: string;
}

const STORAGE_KEY = 'devlog_author_session';

function getSession(): SessionData | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

function setSession(data: SessionData | null): void {
  if (data) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

async function apiCall<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
  } = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  try {
    const fetchInit: RequestInit = {
      method,
      headers,
    };
    if (options.body !== undefined) {
      fetchInit.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, fetchInit);

    if (res.status === 204) {
      return { ok: true, data: {} as T };
    }

    const data = await res.json();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: data.error?.message ?? `Request failed with HTTP ${res.status}`,
      };
    }
    return { ok: true, data: data as T };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : 'Network error',
    };
  }
}

export function main(): void {
  const app = document.getElementById('app');
  if (!app) return;

  function render(): void {
    const session = getSession();
    if (!session) {
      renderSignIn();
    } else {
      renderDashboard(session);
    }
  }

  function renderSignIn(): void {
    if (!app) return;
    app.innerHTML = `
      <div class="auth-card">
        <h2>Devlog Narrator — Author Sign In</h2>
        <p class="subtitle">Access your private author console to create and review devlog entries.</p>
        <div id="error-box" class="error-msg" style="display:none;"></div>
        <form id="signin-form">
          <div class="form-group">
            <label for="username">Username</label>
            <input type="text" id="username" required autocomplete="username" />
          </div>
          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" required autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary" id="signin-btn">Sign In</button>
        </form>
      </div>
    `;

    const form = document.getElementById('signin-form') as HTMLFormElement;
    const errorBox = document.getElementById('error-box') as HTMLDivElement;
    const submitBtn = document.getElementById('signin-btn') as HTMLButtonElement;

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usernameInput = document.getElementById('username') as HTMLInputElement;
      const passwordInput = document.getElementById('password') as HTMLInputElement;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing in...';
      errorBox.style.display = 'none';

      const res = await apiCall<{ accessToken: string }>('/api/author/session', {
        method: 'POST',
        body: { username: usernameInput.value, password: passwordInput.value },
      });

      if (res.ok) {
        setSession({ token: res.data.accessToken, username: usernameInput.value });
        render();
      } else {
        errorBox.textContent = res.message || 'Invalid username or password';
        errorBox.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
      }
    });
  }

  function renderDashboard(session: SessionData): void {
    if (!app) return;
    app.innerHTML = `
      <div class="dashboard-layout">
        <header class="console-header">
          <div class="logo-area">
            <strong>Devlog Narrator</strong> • Author Console
          </div>
          <div class="user-area">
            <span>Signed in as <strong>${escapeHtml(session.username)}</strong></span>
            <button id="signout-btn" class="btn btn-secondary btn-sm">Sign Out</button>
          </div>
        </header>

        <div class="tabs">
          <button class="tab-btn active" id="tab-submit">New Session</button>
          <button class="tab-btn" id="tab-drafts">Drafts</button>
          <button class="tab-btn" id="tab-published">Published</button>
        </div>

        <div id="tab-content" class="tab-content"></div>
      </div>
    `;

    document.getElementById('signout-btn')?.addEventListener('click', async () => {
      await apiCall('/api/author/session', { method: 'DELETE', token: session.token });
      setSession(null);
      render();
    });

    const tabSubmit = document.getElementById('tab-submit');
    const tabDrafts = document.getElementById('tab-drafts');
    const tabPublished = document.getElementById('tab-published');

    function setActiveTab(btn: HTMLElement | null): void {
      [tabSubmit, tabDrafts, tabPublished].forEach((b) => b?.classList.remove('active'));
      btn?.classList.add('active');
    }

    tabSubmit?.addEventListener('click', () => {
      setActiveTab(tabSubmit);
      renderSubmitSession(session);
    });

    tabDrafts?.addEventListener('click', () => {
      setActiveTab(tabDrafts);
      renderDraftsList(session);
    });

    tabPublished?.addEventListener('click', () => {
      setActiveTab(tabPublished);
      renderPublishedList(session);
    });

    // Default to submit session
    renderSubmitSession(session);
  }

  function renderSubmitSession(session: SessionData): void {
    const container = document.getElementById('tab-content');
    if (!container) return;

    const today = new Date().toISOString().slice(0, 10);
    container.innerHTML = `
      <div class="section-card">
        <h3>Submit Work Session</h3>
        <p class="subtitle">Drop in raw notes and optional git log output. Amazon Bedrock will turn them into a devlog entry draft.</p>
        <div id="session-status-box" class="info-msg" style="display:none;"></div>
        <form id="session-form">
          <div class="form-group">
            <label for="sessionDate">Session Date</label>
            <input type="date" id="sessionDate" value="${today}" required />
          </div>
          <div class="form-group">
            <label for="noteText">Session Notes (required)</label>
            <textarea id="noteText" rows="6" placeholder="What did you build, fix, discover, or struggle with today?" required></textarea>
            <div class="counter" id="note-counter">0 / 20,000 code points</div>
          </div>
          <div class="form-group">
            <label for="commitLog">Pasted git log output (optional)</label>
            <textarea id="commitLog" rows="6" placeholder="commit 8ca9ab2...&#10;Author: ...&#10;Date: ...&#10;&#10;    Subject message..."></textarea>
          </div>
          <button type="submit" class="btn btn-primary" id="generate-btn">Generate Devlog Entry</button>
        </form>
      </div>
    `;

    const noteInput = document.getElementById('noteText') as HTMLTextAreaElement;
    const noteCounter = document.getElementById('note-counter') as HTMLDivElement;
    noteInput?.addEventListener('input', () => {
      noteCounter.textContent = `${[...noteInput.value].length.toLocaleString()} / 20,000 code points`;
    });

    const form = document.getElementById('session-form') as HTMLFormElement;
    const statusBox = document.getElementById('session-status-box') as HTMLDivElement;
    const btn = document.getElementById('generate-btn') as HTMLButtonElement;

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      statusBox.style.display = 'block';
      statusBox.className = 'info-msg';
      statusBox.textContent = 'Submitting session input to devlog pipeline...';

      const sessionDate = (document.getElementById('sessionDate') as HTMLInputElement).value;
      const noteText = noteInput.value;
      const commitLog = (document.getElementById('commitLog') as HTMLTextAreaElement).value;

      const res = await apiCall<{ entryId: string; sessionId: string }>('/api/author/sessions', {
        method: 'POST',
        token: session.token,
        body: { sessionDate, noteText, commitLog },
      });

      if (res.ok) {
        statusBox.className = 'success-msg';
        statusBox.innerHTML = `✓ Session accepted! Entry ID: <code>${res.data.entryId}</code>. Bedrock generator has been invoked. Check the <strong>Drafts</strong> tab in a few moments.`;
        btn.textContent = 'Submitted';
      } else {
        statusBox.className = 'error-msg';
        statusBox.textContent = `Error: ${res.message}`;
        btn.disabled = false;
        btn.textContent = 'Generate Devlog Entry';
      }
    });
  }

  async function renderDraftsList(session: SessionData): Promise<void> {
    const container = document.getElementById('tab-content');
    if (!container) return;

    container.innerHTML = `<div class="loading">Loading drafts...</div>`;

    const res = await apiCall<Array<{ entryId: string; title: string; sessionDate: string; generationFailed: boolean }>>(
      '/api/author/entries?status=draft',
      { token: session.token },
    );

    if (!res.ok) {
      container.innerHTML = `<div class="error-msg">Failed to load drafts: ${res.message}</div>`;
      return;
    }

    const drafts = res.data;
    if (drafts.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>No drafts waiting for review.</p>
          <button class="btn btn-secondary" onclick="document.getElementById('tab-submit').click()">Create One</button>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="drafts-layout">
        <div class="drafts-sidebar">
          <h4>Draft Entries (${drafts.length})</h4>
          <ul class="draft-items-list" id="drafts-list">
            ${drafts
              .map(
                (d, idx) => `
              <li class="draft-item ${idx === 0 ? 'selected' : ''}" data-id="${d.entryId}">
                <div class="draft-item-date">${escapeHtml(d.sessionDate)}</div>
                <div class="draft-item-title">${escapeHtml(d.title)}</div>
                ${d.generationFailed ? '<span class="badge badge-warn">Fallback</span>' : ''}
              </li>`,
              )
              .join('\n')}
          </ul>
        </div>
        <div class="draft-editor-pane" id="editor-pane">
          <div class="loading">Loading selected draft...</div>
        </div>
      </div>
    `;

    document.querySelectorAll('.draft-item').forEach((item) => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.draft-item').forEach((i) => i.classList.remove('selected'));
        item.classList.add('selected');
        const id = item.getAttribute('data-id');
        if (id) loadDraftEditor(session, id);
      });
    });

    if (drafts[0]?.entryId) {
      loadDraftEditor(session, drafts[0].entryId);
    }
  }

  async function loadDraftEditor(session: SessionData, entryId: string): Promise<void> {
    const pane = document.getElementById('editor-pane');
    if (!pane) return;

    pane.innerHTML = `<div class="loading">Loading entry ${entryId}...</div>`;

    const res = await apiCall<{ entryId: string; title: string; body: string; sessionDate: string }>(
      `/api/author/entries/${entryId}`,
      { token: session.token },
    );

    if (!res.ok) {
      pane.innerHTML = `<div class="error-msg">Failed to load entry: ${res.message}</div>`;
      return;
    }

    const entry = res.data;
    pane.innerHTML = `
      <div class="editor-header">
        <div>
          <h3>Review & Edit Draft</h3>
          <span class="subtitle">Session date: ${escapeHtml(entry.sessionDate)}</span>
        </div>
        <div class="editor-actions">
          <button id="delete-btn" class="btn btn-danger btn-sm">Delete</button>
          <button id="save-btn" class="btn btn-secondary btn-sm">Save</button>
          <button id="publish-btn" class="btn btn-primary btn-sm">Publish Live</button>
        </div>
      </div>
      <div id="editor-msg" class="info-msg" style="display:none;"></div>
      <div class="form-group" style="margin-top: 1rem;">
        <label for="edit-title">Title</label>
        <input type="text" id="edit-title" value="${escapeHtml(entry.title)}" maxlength="120" />
      </div>
      <div class="form-group">
        <label for="edit-body">Markdown Body</label>
        <textarea id="edit-body" rows="14">${escapeHtml(entry.body)}</textarea>
      </div>
    `;

    const titleInput = document.getElementById('edit-title') as HTMLInputElement;
    const bodyInput = document.getElementById('edit-body') as HTMLTextAreaElement;
    const msgBox = document.getElementById('editor-msg') as HTMLDivElement;

    document.getElementById('save-btn')?.addEventListener('click', async () => {
      const saveRes = await apiCall(`/api/author/entries/${entryId}`, {
        method: 'PATCH',
        token: session.token,
        body: { title: titleInput.value, body: bodyInput.value },
      });
      msgBox.style.display = 'block';
      if (saveRes.ok) {
        msgBox.className = 'success-msg';
        msgBox.textContent = 'Draft saved successfully.';
      } else {
        msgBox.className = 'error-msg';
        msgBox.textContent = `Save failed: ${saveRes.message}`;
      }
    });

    document.getElementById('publish-btn')?.addEventListener('click', async () => {
      const pubRes = await apiCall(`/api/author/entries/${entryId}/publish`, {
        method: 'POST',
        token: session.token,
      });
      msgBox.style.display = 'block';
      if (pubRes.ok) {
        msgBox.className = 'success-msg';
        msgBox.innerHTML = `✓ Published live to public timeline! <a href="/entry/${entryId}" target="_blank">View Live Entry →</a>`;
      } else {
        msgBox.className = 'error-msg';
        msgBox.textContent = `Publish failed: ${pubRes.message}`;
      }
    });

    document.getElementById('delete-btn')?.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to delete this draft?')) return;
      const delRes = await apiCall(`/api/author/entries/${entryId}`, {
        method: 'DELETE',
        token: session.token,
      });
      if (delRes.ok) {
        renderDraftsList(session);
      } else {
        alert(`Delete failed: ${delRes.message}`);
      }
    });
  }

  async function renderPublishedList(session: SessionData): Promise<void> {
    const container = document.getElementById('tab-content');
    if (!container) return;

    container.innerHTML = `<div class="loading">Loading published entries...</div>`;

    const res = await apiCall<Array<{ entryId: string; title: string; sessionDate: string; createdAt: string }>>(
      '/api/author/entries?status=published',
      { token: session.token },
    );

    if (!res.ok) {
      container.innerHTML = `<div class="error-msg">Failed to load entries: ${res.message}</div>`;
      return;
    }

    const entries = res.data;
    if (entries.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>No entries have been published yet.</p>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="section-card">
        <h3>Published Devlog Entries (${entries.length})</h3>
        <p class="subtitle">These entries are live on the public timeline at your Public URL.</p>
        <ul class="published-table">
          ${entries
            .map(
              (e) => `
            <li class="pub-row">
              <div class="pub-info">
                <strong>${escapeHtml(e.title)}</strong>
                <span class="pub-meta">Session: ${escapeHtml(e.sessionDate)} • ID: <code>${e.entryId}</code></span>
              </div>
              <div class="pub-actions">
                <a href="/entry/${e.entryId}" target="_blank" class="btn btn-secondary btn-sm">View</a>
                <button class="btn btn-warn btn-sm unpub-btn" data-id="${e.entryId}">Unpublish</button>
              </div>
            </li>`,
            )
            .join('\n')}
        </ul>
      </div>
    `;

    document.querySelectorAll('.unpub-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!id || !confirm('Unpublish this entry? It will return to drafts.')) return;
        const unpubRes = await apiCall(`/api/author/entries/${id}/unpublish`, {
          method: 'POST',
          token: session.token,
        });
        if (unpubRes.ok) {
          renderPublishedList(session);
        } else {
          alert(`Unpublish failed: ${unpubRes.message}`);
        }
      });
    });
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  render();
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
}

