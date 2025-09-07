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
    const opts = { cwd, maxBuffer: 10 * 1024 * 1024 };
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
    } catch { /* no commits */ }

    let hasUncommitted = false;
    try {
        const res = await runGit(cwd, gitPath, ['status', '--porcelain', '--', relPath]);
        hasUncommitted = res.stdout.trim().length > 0;
    } catch { }

    panel.webview.html = getWebviewContent(fileUri.fsPath, commits, hasUncommitted);

    panel.webview.onDidReceiveMessage(async (message) => {
        try {
            if (message.command === 'showUncommittedDiff') {
                const diff = await getUncommittedDiff(fileUri, cwd, gitPath);
                panel.webview.postMessage({ command: 'updateDiff', diff });
            } else if (message.command === 'showCommitDiff') {
                const diff = await getCommitVsParentDiff(fileUri, cwd, gitPath, message.hash);
                panel.webview.postMessage({ command: 'updateDiff', diff });
            } else if (message.command === 'openCommitFiles') {
                await showCommitFilesPanel(message.hash, cwd, gitPath, context, fileUri);
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
        const res = await runGit(cwd, gitPath, ['diff', '--no-prefix', '-U999999', '--', relPath]);
        return res.stdout || 'No uncommitted changes.';
    } catch {
        return 'No uncommitted changes.';
    }
}

async function getCommitVsParentDiff(fileUri: vscode.Uri, cwd: string, gitPath: string, hash: string): Promise<string> {
    const relPath = path.relative(cwd, fileUri.fsPath).replace(/\\/g, '/');
    try {
        const res = await runGit(cwd, gitPath, ['diff', '--no-prefix', '-U999999', `${hash}^`, hash, '--', relPath]);
        return res.stdout || `No diff available for ${hash}`;
    } catch {
        return `No diff available for ${hash}`;
    }
}

// ---------------- Commit files view ----------------

async function showCommitFilesPanel(hash: string, cwd: string, gitPath: string, context: vscode.ExtensionContext, originalFile: vscode.Uri) {
    const panel = vscode.window.createWebviewPanel(
        'fastGitCommitFiles',
        `Commit ${hash.substring(0,7)} — Files`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    let files: string[] = [];
    try {
        const res = await runGit(cwd, gitPath, ['show', '--pretty=format:', '--name-status', hash]);
        files = res.stdout.split('\n').filter(Boolean);
    } catch { }

    panel.webview.html = getCommitFilesContent(hash, files);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'openFileHistory') {
            const fileUri = vscode.Uri.file(path.join(cwd, message.file));
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

function getWebviewContent(filename: string, commits: CommitInfo[], hasUncommitted: boolean) {
    const commitJson = JSON.stringify(commits);
    const escFilename = escapeHtml(filename);

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
body { margin:0; font-family: var(--vscode-font-family); }
.container { display:flex; height:100vh; }
.left { width:360px; border-right:1px solid var(--vscode-editorWidget-border); overflow:auto; }
.right { flex:1; overflow:auto; padding:8px; white-space:pre; font-family:monospace; }
.entry { padding:8px; border-bottom:1px solid rgba(128,128,128,0.2); cursor:pointer; }
.entry:hover { background: var(--vscode-list-hoverBackground); }
.hash { font-family: monospace; cursor:pointer; color: var(--vscode-textLink-foreground); }
.add { background-color: rgba(0,128,0,0.15); }
.del { background-color: rgba(255,0,0,0.15); }
.selected { background: var(--vscode-list-activeSelectionBackground); }
</style>
</head>
<body>
<div class="container">
  <div class="left">
    <div style="padding:8px;font-weight:bold">${escFilename}</div>
    <div id="topEntry" class="entry">Uncommitted changes ${hasUncommitted ? '(modified)' : '(no changes)'}</div>
    <ul id="commitList" style="list-style:none;padding:0;margin:0"></ul>
  </div>
  <div class="right" id="diffView">Loading…</div>
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
  li.innerHTML = '<div>' + c.date + ' <span class="hash" data-hash="' + c.hash + '">' + c.shortHash + '</span></div>'
    + '<div>' + escapeHtml(c.desc) + '</div>';
  li.addEventListener('click', (ev) => {
    if (ev.target.classList.contains('hash')) return;
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
    showDiff(msg.diff);
  }
});

function showDiff(raw) {
  const lines = raw.split('\\n');
  diffView.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    if (line.startsWith('+') && !line.startsWith('+++')) {
      div.className = 'add';
      div.textContent = line.substring(1);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      div.className = 'del';
      div.textContent = line.substring(1);
    } else if (line.startsWith('@@')) {
      continue; // skip hunk headers
    } else {
      div.textContent = line.replace(/^ /,'');
    }
    diffView.appendChild(div);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
</body>
</html>`;
}

function getCommitFilesContent(hash: string, files: string[]) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
body { font-family: var(--vscode-font-family); padding:8px; }
.file { padding:4px; cursor:pointer; }
.file:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<h3>Commit ${hash.substring(0,7)}</h3>
<ul>
${files.map(f => `<li class="file" data-file="${f.split(/\\s+/).slice(1).join(' ')}">${escapeHtml(f)}</li>`).join('')}
</ul>
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('.file').forEach(el => {
  el.addEventListener('click', () => {
    vscode.postMessage({ command: 'openFileHistory', file: el.getAttribute('data-file') });
  });
});
function escapeHtml(s) {
  return s.replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
