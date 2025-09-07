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
                { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
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
                await openUncommittedDiff(fileUri, cwd, gitPath);
            } else if (message.command === 'showCommitDiff') {
                await openCommitVsParentDiff(fileUri, cwd, gitPath, message.hash);
            } else if (message.command === 'showCommitDetails') {
                await openCommitDetailsPanel(message.hash, cwd, gitPath, context, fileUri);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`FastGitFileHistory: ${err?.message ?? String(err)}`);
        }
    }, undefined, context.subscriptions);
}

// ---------------- Diff helpers ----------------

async function openUncommittedDiff(fileUri: vscode.Uri, cwd: string, gitPath: string) {
    const relPath = path.relative(cwd, fileUri.fsPath).replace(/\\/g, '/');
    let headContents = '';
    try {
        const res = await runGit(cwd, gitPath, ['show', `HEAD:${relPath}`]);
        headContents = res.stdout;
    } catch { }

    const rightDoc = await vscode.workspace.openTextDocument(fileUri);
    const leftDoc = await vscode.workspace.openTextDocument({ content: headContents, language: rightDoc.languageId });

    await vscode.commands.executeCommand(
        'vscode.diff',
        leftDoc.uri,
        rightDoc.uri,
        `${path.basename(fileUri.fsPath)} — Uncommitted changes`,
        { viewColumn: vscode.ViewColumn.Beside }
    );
}

async function openCommitVsParentDiff(fileUri: vscode.Uri, cwd: string, gitPath: string, hash: string) {
    const relPath = path.relative(cwd, fileUri.fsPath).replace(/\\/g, '/');
    let commitContents = '';
    let parentContents = '';

    try {
        const res = await runGit(cwd, gitPath, ['show', `${hash}:${relPath}`]);
        commitContents = res.stdout;
    } catch { }

    try {
        const res = await runGit(cwd, gitPath, ['show', `${hash}^:${relPath}`]);
        parentContents = res.stdout;
    } catch { }

    const leftDoc = await vscode.workspace.openTextDocument({ content: parentContents });
    const rightDoc = await vscode.workspace.openTextDocument({ content: commitContents });

    await vscode.commands.executeCommand(
        'vscode.diff',
        leftDoc.uri,
        rightDoc.uri,
        `${path.basename(fileUri.fsPath)} — ${hash.substring(0, 7)}`,
        { viewColumn: vscode.ViewColumn.Beside }
    );
}

// ---------------- Commit details ----------------

async function openCommitDetailsPanel(hash: string, cwd: string, gitPath: string, context: vscode.ExtensionContext, fileInContext?: vscode.Uri) {
    const res = await runGit(cwd, gitPath, ['show', '--name-status', '--pretty=format:', hash]);
    const files = res.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [status, ...rest] = l.split(/\s+/);
        return { status, path: rest.join(' ') };
    });

    const panel = vscode.window.createWebviewPanel(
        'fastGitFileCommitDetails',
        `Commit ${hash.substring(0, 7)}`,
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    panel.webview.html = getCommitDetailsHtml(hash, files);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'openFile') {
            const abs = path.resolve(cwd, message.file);
            const uri = vscode.Uri.file(abs);
            const newPanel = vscode.window.createWebviewPanel(
                'fastGitFileHistory',
                `Git History — ${path.basename(uri.fsPath)}`,
                vscode.ViewColumn.One,
                { enableScripts: true }
            );
            await showFileHistory(newPanel, uri, cwd, gitPath, context);
            panel.dispose();
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
.entry { padding:8px; border-bottom:1px solid rgba(128,128,128,0.2); cursor:pointer; }
.entry:hover { background: var(--vscode-list-hoverBackground); }
.hash { font-family: monospace; cursor:pointer; color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
<div class="container">
  <div class="left">
    <div style="padding:8px;font-weight:bold">${escFilename}</div>
    <div id="topEntry" class="entry">Uncommitted changes ${hasUncommitted ? '(modified)' : '(no changes)'}</div>
    <ul id="commitList" style="list-style:none;padding:0;margin:0"></ul>
  </div>
  <div style="flex:1;padding:8px;color:var(--vscode-descriptionForeground)">Select an entry to open a diff beside.</div>
</div>
<script>
const vscode = acquireVsCodeApi();
const commits = ${commitJson};

const list = document.getElementById('commitList');
const topEntry = document.getElementById('topEntry');

topEntry.addEventListener('click', () => {
  vscode.postMessage({ command: 'showUncommittedDiff' });
});

for (const c of commits) {
  const li = document.createElement('li');
  li.className = 'entry';
  li.innerHTML = '<div>' + c.date + ' <span class="hash" data-hash="' + c.hash + '">' + c.shortHash + '</span></div>'
    + '<div>' + escapeHtml(c.desc) + '</div>';
  li.addEventListener('click', (ev) => {
    if (ev.target.classList.contains('hash')) return;
    vscode.postMessage({ command: 'showCommitDiff', hash: c.hash });
  });
  li.querySelector('.hash').addEventListener('click', (ev) => {
    ev.stopPropagation();
    vscode.postMessage({ command: 'showCommitDetails', hash: c.hash });
  });
  list.appendChild(li);
}

function escapeHtml(s) {
  return s.replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
</body>
</html>`;
}

function getCommitDetailsHtml(hash: string, files: { status: string; path: string }[]) {
    const rows = files.map(f =>
        `<tr><td>${escapeHtml(f.status)}</td><td><a href="#" data-file="${escapeHtmlAttr(f.path)}">${escapeHtml(f.path)}</a></td></tr>`
    ).join('');
    return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
<h3>Commit ${hash.substring(0,7)}</h3>
<table>${rows}</table>
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    vscode.postMessage({ command: 'openFile', file: a.dataset.file });
  });
});
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
