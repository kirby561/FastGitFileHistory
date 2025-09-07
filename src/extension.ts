// src/extension.ts
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import * as util from 'util';

const execFileAsync = util.promisify(execFile);

type CommitInfo = {
    hash: string;
    shortHash: string;
    date: string;
    desc: string;
};

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('fastGitFileHistory.view', async (uri?: vscode.Uri) => {
        try {
            const fileUri = await resolveFileUriFromContext(uri);
            if (!fileUri) {
                vscode.window.showErrorMessage('No file selected.');
                return;
            }
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('File is not inside a workspace folder.');
                return;
            }
            const cwd = workspaceFolder.uri.fsPath;
            const gitPath = getGitPath();

            const panel = vscode.window.createWebviewPanel(
                'fastGitFileHistory',
                `Git History — ${path.basename(fileUri.fsPath)}`,
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            await showFileHistory(panel, fileUri, cwd, gitPath, context);

        } catch (err: any) {
            vscode.window.showErrorMessage(`FastGitFileHistory: ${err?.message ?? String(err)}`);
            console.error(err);
        }
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}

// ---------------- Helper functions ----------------

async function resolveFileUriFromContext(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (uri && uri.fsPath) return uri;
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document && editor.document.uri.scheme === 'file') {
        return editor.document.uri;
    }
    return undefined;
}

function getGitPath(): string {
    const cfg = vscode.workspace.getConfiguration('fastGitFileHistory');
    let p = cfg.get<string>('gitPath', 'git');
    if (!p || p.trim().length === 0) p = 'git';
    return p;
}

async function runGit(cwd: string, gitPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const opts = { cwd, maxBuffer: 20 * 1024 * 1024 };
    const { stdout, stderr } = await execFileAsync(gitPath, args, opts);
    return { stdout: stdout.toString(), stderr: stderr?.toString() ?? '' };
}

// ---------------- File history view ----------------

async function showFileHistory(panel: vscode.WebviewPanel, fileUri: vscode.Uri, cwd: string, gitPath: string, context: vscode.ExtensionContext) {
    const relPath = path.relative(cwd, fileUri.fsPath).replace(/\\/g, '/');
    panel.title = `Git History — ${path.basename(fileUri.fsPath)}`;

    let commits: CommitInfo[] = [];
    try {
        const res = await runGit(cwd, gitPath, ['log', '--pretty=format:%H%x09%ci%x09%s', '--', relPath]);
        commits = res.stdout.split('\n').filter(Boolean).map(line => {
            const [hash, date, ...descParts] = line.split('\t');
            return {
                hash,
                shortHash: hash.substring(0, 7),
                date,
                desc: descParts.join('\t')
            };
        });
    } catch {
        // no commits or not a git repo
    }

    let hasUncommitted = false;
    try {
        const res = await runGit(cwd, gitPath, ['status', '--porcelain', '--', relPath]);
        hasUncommitted = res.stdout.trim().length > 0;
    } catch { }

    const langClass = getHighlightJsLanguageClass(fileUri.fsPath);
    panel.webview.html = getWebviewContent(fileUri.fsPath, commits, hasUncommitted, langClass);

    panel.webview.onDidReceiveMessage(async (message) => {
        try {
            if (message.command === 'showUncommittedDiff') {
                const diff = await getUncommittedDiff(fileUri, cwd, gitPath);
                panel.webview.postMessage({ command: 'updateDiff', diff });
            } else if (message.command === 'showCommitDiff') {
                const diff = await getCommitVsParentDiff(fileUri, cwd, gitPath, message.hash);
                panel.webview.postMessage({ command: 'updateDiff', diff });
            } else if (message.command === 'openCommitFiles') {
                await showCommitFilesPanel(message.hash, cwd, gitPath, context);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`FastGitFileHistory: ${err?.message ?? String(err)}`);
        }
    }, undefined, context.subscriptions);

    // Auto-select the top entry and show diff immediately
    const diff = await getUncommittedDiff(fileUri, cwd, gitPath);
    panel.webview.postMessage({ command: 'updateDiff', diff });
}

// ---------------- Diff helpers ----------------

async function getUncommittedDiff(fileUri: vscode.Uri, cwd: string, gitPath: string): Promise<string> {
    const relPath = path.relative(cwd, fileUri.fsPath).replace(/\\/g, '/');
    try {
        // full-file unified diff (big context) with no prefixes for cleaner parsing
        const res = await runGit(cwd, gitPath, ['diff', '--no-prefix', '-U999999', '--', relPath]);
        return res.stdout || '';
    } catch {
        return '';
    }
}

async function getCommitVsParentDiff(fileUri: vscode.Uri, cwd: string, gitPath: string, hash: string): Promise<string> {
    const relPath = path.relative(cwd, fileUri.fsPath).replace(/\\/g, '/');
    try {
        const res = await runGit(cwd, gitPath, ['diff', '--no-prefix', '-U999999', `${hash}^`, hash, '--', relPath]);
        return res.stdout || '';
    } catch {
        return '';
    }
}

// ---------------- Commit files view ----------------

async function showCommitFilesPanel(hash: string, cwd: string, gitPath: string, context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'fastGitCommitFiles',
        `Commit ${hash.substring(0,7)} — Files`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    let rows: { status: string; path: string }[] = [];
    try {
        const res = await runGit(cwd, gitPath, ['show', '--pretty=format:', '--name-status', hash]);
        const lines = res.stdout.split('\n').map(l => l.trim()).filter(Boolean);
        for (const l of lines) {
            // name-status is tab-separated:
            //  A<TAB>path
            //  M<TAB>path
            //  D<TAB>path
            //  R100<TAB>old<TAB>new  (rename), also C* (copy)
            const parts = l.split('\t');
            const status = parts[0];
            let filePath = '';
            if (parts.length >= 3) {
                // rename/copy — take the NEW path (last token)
                filePath = parts[parts.length - 1];
            } else if (parts.length === 2) {
                filePath = parts[1];
            }
            if (filePath) {
                rows.push({ status, path: filePath });
            }
        }
    } catch { }

    panel.webview.html = getCommitFilesContent(hash, rows);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'openFileHistory') {
            // message.file is repo-relative
            const fsPath = path.join(cwd, message.file).replace(/\\/g, '/');
            const fileUri = vscode.Uri.file(fsPath);
            const historyPanel = vscode.window.createWebviewPanel(
                'fastGitFileHistory',
                `Git History — ${path.basename(fileUri.fsPath)}`,
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            await showFileHistory(historyPanel, fileUri, cwd, gitPath, context);
        }
    }, undefined, context.subscriptions);
}

// ---------------- Webview HTML ----------------

function getWebviewContent(filename: string, commits: CommitInfo[], hasUncommitted: boolean, languageClass: string) {
    const commitJson = JSON.stringify(commits);
    const escFilename = escapeHtml(filename);
    const langClassAttr = languageClass ? ` ${languageClass}` : '';

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet"
      href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>
body { margin:0; font-family: var(--vscode-font-family); }
.container { display:flex; height:100vh; }
.left { width:360px; border-right:1px solid var(--vscode-editorWidget-border); overflow:auto; }
.right { flex:1; overflow:auto; padding:8px; }
.entry { padding:8px; border-bottom:1px solid rgba(128,128,128,0.2); cursor:pointer; }
.entry:hover { background: var(--vscode-list-hoverBackground); }
.hash { font-family: monospace; cursor:pointer; color: var(--vscode-textLink-foreground); }
.selected { background: var(--vscode-list-activeSelectionBackground); }
.hljs { background: transparent; } /* use editor background */
.add { background-color: rgba(0,128,0,0.15); }
.del { background-color: rgba(255,0,0,0.15); }
.codewrap { white-space: pre-wrap; word-break: break-word; }
.fixed { max-height: 2.6em; overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
<div class="container">
  <div class="left">
    <div style="padding:8px;font-weight:bold">${escFilename}</div>
    <div id="topEntry" class="entry">Uncommitted changes ${hasUncommitted ? '(modified)' : '(no changes)'}</div>
    <ul id="commitList" style="list-style:none;padding:0;margin:0"></ul>
  </div>
  <div class="right">
    <pre class="codewrap"><code id="diffView" class="hljs${langClassAttr}">Loading…</code></pre>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const commits = ${commitJson};

const list = document.getElementById('commitList');
const topEntry = document.getElementById('topEntry');
const diffView = document.getElementById('diffView');

function clearSelection() {
  document.querySelectorAll('.entry').forEach(e => e.classList.remove('selected'));
}

topEntry.addEventListener('click', () => {
  clearSelection();
  topEntry.classList.add('selected');
  vscode.postMessage({ command: 'showUncommittedDiff' });
});

// auto-select top entry
topEntry.classList.add('selected');

for (const c of commits) {
  const li = document.createElement('li');
  li.className = 'entry';
  li.innerHTML = '<div class="fixed">' + c.date +
    ' <span class="hash" data-hash="' + c.hash + '">' + c.shortHash + '</span></div>'
    + '<div class="fixed">' + escapeHtml(c.desc) + '</div>';
  li.addEventListener('click', (ev) => {
    if (ev.target.classList && ev.target.classList.contains('hash')) return;
    clearSelection();
    li.classList.add('selected');
    vscode.postMessage({ command: 'showCommitDiff', hash: c.hash });
  });
  li.querySelector('.hash').addEventListener('click', (ev) => {
    ev.stopPropagation();
    vscode.postMessage({ command: 'openCommitFiles', hash: c.hash });
  });
  list.appendChild(li);
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'updateDiff') {
    showDiff(msg.diff || '');
  }
});

// Render a full-file inline diff:
// - Keep headers (diff --git / index / --- / +++).
// - Add a blank line after headers before content.
// - For content: remove +/- markers, color with .add/.del.
// - No hunk headers.
function showDiff(raw) {
  const lines = raw.split('\\n');
  let html = '';
  let inHeader = true;
  let addedBlankAfterHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      html += escapeHtml(line) + '<br/>';
      inHeader = true;
      if (line.startsWith('+++')) {
        // next iteration we’ll drop a blank line (once)
        addedBlankAfterHeader = false;
      }
      continue;
    }

    if (line.startsWith('@@')) {
      // skip hunk headers entirely
      continue;
    }

    if (inHeader && addedBlankAfterHeader === false) {
      html += '<br/>';
      inHeader = false;
      addedBlankAfterHeader = true;
    }

    if (line.startsWith('+')) {
      html += '<span class="add">' + escapeHtml(line.substring(1)) + '</span><br/>';
    } else if (line.startsWith('-')) {
      html += '<span class="del">' + escapeHtml(line.substring(1)) + '</span><br/>';
    } else {
      // context lines start with space in unified diff; strip it if present
      html += escapeHtml(line.replace(/^ /, '')) + '<br/>';
    }
  }

  if (html.trim() === '') {
    html = '<em>No changes to show.</em>';
  }

  diffView.innerHTML = html;
  try { window.hljs && window.hljs.highlightElement(diffView); } catch {}
}

function escapeHtml(s) {
  return s.replace(/[&<>\"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}
</script>
</body>
</html>`;
}

function getCommitFilesContent(hash: string, files: { status: string; path: string }[]) {
    const rows = files.map(f => {
        const label = `${f.status}\t${f.path}`;
        return `<li class="file" data-file="${escapeHtmlAttr(f.path)}">${escapeHtml(label)}</li>`;
    }).join('');

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
body { font-family: var(--vscode-font-family); padding:8px; }
.file { padding:4px; cursor:pointer; }
.file:hover { background: var(--vscode-list-hoverBackground); }
small { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h3>Commit ${hash.substring(0,7)}</h3>
<p><small>Click a file to view its history.</small></p>
<ul>
${rows}
</ul>
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('.file').forEach(el => {
  el.addEventListener('click', () => {
    const f = el.getAttribute('data-file');
    vscode.postMessage({ command: 'openFileHistory', file: f });
  });
});
function escapeHtml(s) {
  return s.replace(/[&<>\"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}
</script>
</body>
</html>`;
}

// ---------------- Utils ----------------

function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return c;
        }
    });
}

function escapeHtmlAttr(s: string) {
    return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Map filename to a Highlight.js language class (best-effort)
function getHighlightJsLanguageClass(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const map: Record<string, string> = {
        '.js': 'language-javascript',
        '.jsx': 'language-javascript',
        '.ts': 'language-typescript',
        '.tsx': 'language-typescript',
        '.json': 'language-json',
        '.md': 'language-markdown',
        '.yml': 'language-yaml',
        '.yaml': 'language-yaml',
        '.xml': 'language-xml',
        '.html': 'language-xml',
        '.css': 'language-css',
        '.scss': 'language-css',
        '.less': 'language-css',
        '.c': 'language-c',
        '.h': 'language-c',
        '.cpp': 'language-cpp',
        '.cc': 'language-cpp',
        '.hpp': 'language-cpp',
        '.hh': 'language-cpp',
        '.m': 'language-objectivec',
        '.mm': 'language-objectivec',
        '.cs': 'language-cs',
        '.java': 'language-java',
        '.kt': 'language-kotlin',
        '.kts': 'language-kotlin',
        '.swift': 'language-swift',
        '.py': 'language-python',
        '.rb': 'language-ruby',
        '.go': 'language-go',
        '.rs': 'language-rust',
        '.php': 'language-php',
        '.sh': 'language-bash',
        '.bash': 'language-bash',
        '.ps1': 'language-powershell',
        '.toml': 'language-ini',
        '.ini': 'language-ini',
        '.lua': 'language-lua',
        '.dart': 'language-dart',
        '.scala': 'language-scala'
    };
    return map[ext] || '';
}
