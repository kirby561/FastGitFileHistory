// extension.ts
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import * as util from 'util';
import * as os from 'os';

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

            // initial populate
            await showFileHistory(panel, fileUri, cwd, gitPath, context);

        } catch (err: any) {
            vscode.window.showErrorMessage(`FastGitFileHistory: ${err?.message ?? String(err)}`);
            console.error(err);
        }
    });

    context.subscriptions.push(disposable);

    // (optional) expose a programmatic API in the extension exports (not required)
    return {
        // could add exported functions
    };
}

export function deactivate() {
    // nothing to clean up explicitly
}

// -------------------------- Helper functions --------------------------

async function resolveFileUriFromContext(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    // If user invoked from Explorer, uri is the clicked resource.
    if (uri && uri.fsPath) {
        return uri;
    }
    // Otherwise use active editor
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document && editor.document.uri.scheme === 'file') {
        return editor.document.uri;
    }
    return undefined;
}

function getGitPath(): string {
    // uses configuration: fastGitFileHistory.gitPath
    const cfg = vscode.workspace.getConfiguration('fastGitFileHistory');
    let p = cfg.get<string>('gitPath', 'git'); // default 'git' (first git in PATH)
    if (!p || p.trim().length === 0) p = 'git';
    return p;
}

async function runGit(cwd: string, gitPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
        const opts = { cwd, maxBuffer: 10 * 1024 * 1024 }; // 10MB buffer
        const { stdout, stderr } = await execFileAsync(gitPath, args, opts);
        return { stdout: stdout.toString(), stderr: stderr?.toString() ?? '' };
    } catch (err: any) {
        // execFile throws on nonzero exit; capture stdout/stderr if present
        if (err && typeof err === 'object' && ('stdout' in err || 'stderr' in err)) {
            return { stdout: (err.stdout || '').toString(), stderr: (err.stderr || '').toString() };
        }
        throw err;
    }
}

async function showFileHistory(panel: vscode.WebviewPanel, fileUri: vscode.Uri, cwd: string, gitPath: string, context: vscode.ExtensionContext) {
    const filePathRelative = path.relative(cwd, fileUri.fsPath).replace(/\\/g, '/'); // git expects forward slashes on Windows too
    panel.title = `Git History — ${path.basename(fileUri.fsPath)}`;

    // Gather commits that touched the file
    // Format: <hash>\t<date ISO>\t<description>
    // We'll use ISO date for consistent parsing.
    const logArgs = ['log', '--pretty=format:%H%x09%ci%x09%s', '--', filePathRelative];
    let commitsRaw = '';
    try {
        const res = await runGit(cwd, gitPath, logArgs);
        commitsRaw = res.stdout;
    } catch (err) {
        // if file not tracked or other issues, still continue (commitsRaw stays empty)
        commitsRaw = '';
    }

    const commits: CommitInfo[] = [];
    if (commitsRaw.trim().length > 0) {
        const lines = commitsRaw.split('\n');
        for (const l of lines) {
            const parts = l.split('\t');
            if (parts.length >= 3) {
                const hash = parts[0];
                const date = parts[1];
                const desc = parts.slice(2).join('\t');
                commits.push({
                    hash,
                    shortHash: hash.substring(0, 7),
                    date,
                    desc
                });
            }
        }
    }

    // Detect uncommitted changes for the file (show entry even if none)
    const statusArgs = ['status', '--porcelain', '--', filePathRelative];
    let statusOut = '';
    try {
        const res = await runGit(cwd, gitPath, statusArgs);
        statusOut = res.stdout;
    } catch (err) {
        statusOut = '';
    }
    const hasUncommitted = statusOut.trim().length > 0;

    // Create URIs for diffs. We'll create virtual document Uris (vscode.Uri.parse with scheme)
    // For uncommitted "left" version we want the HEAD version and "right" being working tree.
    // But to show diff using vscode.diff we need two URIs. Use git: scheme? Simpler: create
    // temporary files in-memory via the 'untitled:' scheme or use TextDocuments created via workspace.openTextDocument({content})
    // Simpler approach: when user selects something, query git to get the blob contents and create a virtual document via a custom scheme.
    // We'll implement on-demand diff generation when webview posts message.

    // Build initial webview html
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri, fileUri.fsPath, commits, hasUncommitted);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
        async (message) => {
            try {
                switch (message.command) {
                    case 'showUncommittedDiff':
                        {
                            // produce left (HEAD version if exists) and right (working tree) and open diff beside
                            await openUncommittedDiff(fileUri, cwd, gitPath);
                        }
                        break;
                    case 'showCommitDiff':
                        {
                            // message.hash provided
                            const hash = message.hash as string;
                            await openCommitVsParentDiff(fileUri, cwd, gitPath, hash);
                        }
                        break;
                    case 'showCommitDetails':
                        {
                            const hash = message.hash as string;
                            await openCommitDetailsPanel(hash, cwd, gitPath, context, fileUri);
                        }
                        break;
                    case 'openFileFromCommitDetails':
                        {
                            const clickedFile = message.file as string;
                            // close commit details panel and open history for clicked file
                            // We will open the file's history by invoking the view command programmatically with the file Uri.
                            const newFilePath = path.resolve(cwd, clickedFile);
                            const newUri = vscode.Uri.file(newFilePath);
                            // If file exists in workspace, call the same show logic by reusing this panel (replace content)
                            // For simplicity, create a new panel:
                            const newPanel = vscode.window.createWebviewPanel(
                                'fastGitFileHistory',
                                `Git History — ${path.basename(newUri.fsPath)}`,
                                { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
                                { enableScripts: true, retainContextWhenHidden: true }
                            );
                            await showFileHistory(newPanel, newUri, cwd, gitPath, context);
                        }
                        break;
                    default:
                        console.warn('Unknown message from webview', message);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`FastGitFileHistory: ${err?.message ?? String(err)}`);
                console.error(err);
            }
        },
        undefined,
        context.subscriptions
    );
}

// -------------------------- Diff open utilities --------------------------

async function openUncommittedDiff(fileUri: vscode.Uri, cwd: string, gitPath: string) {
    const relPath = path.relative(cwd, fileUri.fsPath).replace(/\\/g, '/');

    // Prepare two temporary URI contents:
    // left: HEAD version if exists else empty; right: working tree (current file contents)
    let headContents = '';
    try {
        // 'git show HEAD:<path>' may fail if file is untracked. We'll try and catch.
        const res = await runGit(cwd, gitPath, ['show', `HEAD:${relPath}`]);
        headContents = res.stdout;
    } catch (err) {
        headContents = ''; // untracked or no HEAD version
    }

    // Get working tree contents directly from disk
    const rightDoc = await vscode.workspace.openTextDocument(fileUri);
    const rightUri = rightDoc.uri;

    // Create a left untitled document with headContents
    // We will create an untitled file with a custom query so it doesn't conflict.
    const leftUntitled = await vscode.workspace.openTextDocument({ content: headContents, language: rightDoc.languageId });
    // Use custom label
    const leftUri = leftUntitled.uri;

    // Show diff: leftUri vs rightUri
    const title = `${path.basename(fileUri.fsPath)} — Uncommitted changes`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { viewColumn: vscode.ViewColumn.Beside });
}

async function openCommitVsParentDiff(fileUri: vscode.Uri, cwd: string, gitPath: string, hash: string) {
    const relPath = path.relative(cwd, fileUri.fsPath).replace(/\\/g, '/');

    // Get contents for commit version
    let commitContents = '';
    try {
        const res = await runGit(cwd, gitPath, ['show', `${hash}:${relPath}`]);
        commitContents = res.stdout;
    } catch (err) {
        commitContents = ''; // file may not exist in that commit
    }

    // Get contents for parent version (hash^). If parent doesn't exist, parentContents = ''
    let parentContents = '';
    try {
        const res = await runGit(cwd, gitPath, ['show', `${hash}^:${relPath}`]);
        parentContents = res.stdout;
    } catch (err) {
        parentContents = '';
    }

    // Open two untitled docs with commit and parent contents then call vscode.diff
    const leftDoc = await vscode.workspace.openTextDocument({ content: parentContents, language: detectLanguageFromPath(fileUri.fsPath) });
    const rightDoc = await vscode.workspace.openTextDocument({ content: commitContents, language: detectLanguageFromPath(fileUri.fsPath) });

    const title = `${path.basename(fileUri.fsPath)} — ${hash.substring(0, 7)}`;
    await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, title, { viewColumn: vscode.ViewColumn.Beside });
}

function detectLanguageFromPath(filename: string): string | undefined {
    // crude detection: rely on vscode to infer from filename by opening as untitled with filename? But openTextDocument({content}) does not accept a path.
    // Instead, return undefined and let vscode determine. For better results you could map extensions to languages.
    return undefined;
}

// -------------------------- Commit details panel --------------------------

async function openCommitDetailsPanel(hash: string, cwd: string, gitPath: string, context: vscode.ExtensionContext, fileInContext?: vscode.Uri) {
    // get commit details: name-status listing
    // Use: git show --name-status --pretty=format:%B <hash>
    let out = '';
    try {
        const res = await runGit(cwd, gitPath, ['show', '--name-status', '--pretty=format:%B', hash]);
        out = res.stdout;
    } catch (err) {
        out = '';
    }

    // parse --name-status lines (format: A|M|D<tab>path)
    // After the commit body, git show prints lines like:
    // M\tpath1
    // A\tpath2
    // etc.
    const lines = out.split('\n');
    const files: { status: string; path: string }[] = [];
    for (const l of lines) {
        const trimmed = l.trim();
        if (trimmed.length === 0) continue;
        // status letter at start if matches pattern
        const m = trimmed.match(/^([AMDCRUXT])\s+(.*)/);
        if (m) {
            files.push({ status: m[1], path: m[2] });
        }
    }

    const panel = vscode.window.createWebviewPanel('fastGitFileCommitDetails', `Commit ${hash.substring(0, 7)}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = getCommitDetailsHtml(panel.webview, hash, files);

    panel.webview.onDidReceiveMessage(
        async (message) => {
            if (message.command === 'openFile') {
                const clicked = message.file as string;
                // The user clicked a file inside commit details; we need to open the file history view for that file.
                // We will post message back to caller via a simple mechanism: fire the fastGitFileHistory.view command with the full path.
                // But we need to resolve absolute path: assume cwd is the repo root.
                const abs = path.resolve(cwd, clicked);
                const uri = vscode.Uri.file(abs);
                // create new history panel for this file
                const newPanel = vscode.window.createWebviewPanel(
                    'fastGitFileHistory',
                    `Git History — ${path.basename(uri.fsPath)}`,
                    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
                    { enableScripts: true, retainContextWhenHidden: true }
                );
                await showFileHistory(newPanel, uri, cwd, gitPath, context);
                // close commit details panel
                panel.dispose();
            } else if (message.command === 'close') {
                panel.dispose();
            }
        },
        undefined,
        context.subscriptions
    );
}

// -------------------------- Webview HTML builders --------------------------

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, filename: string, commits: CommitInfo[], hasUncommitted: boolean) {
    // Build left pane commit list including top "Uncommitted Changes" entry
    // We'll pass the commit data to the webview via JSON (escape it)
    const commitJson = JSON.stringify(commits);
    const escFilename = escapeHtml(filename);

    // Basic styling with fixed height entries and ellipsis for description
    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval';">
<title>FastGitFileHistory</title>
<style>
    body, html { margin:0; padding:0; height:100%; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .container { display:flex; height:100vh; }
    .left { width:360px; border-right:1px solid var(--vscode-editorWidget-border); overflow:auto; }
    .right { flex:1; padding:12px; overflow:auto; }
    .entry { padding:10px; border-bottom:1px solid rgba(128,128,128,0.08); cursor:pointer; display:flex; flex-direction:column; height:76px; box-sizing:border-box; }
    .entry:hover { background: var(--vscode-list-hoverBackground); }
    .entry.selected { background: var(--vscode-list-focusBackground); }
    .meta { display:flex; justify-content:space-between; font-size:12px; color: var(--vscode-descriptionForeground); }
    .desc { margin-top:6px; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; font-size:13px; }
    .hash { font-family: monospace; color: var(--vscode-editor-foreground); cursor:pointer; padding-left:6px; }
    .topEntryHeader { padding:10px; border-bottom:1px solid var(--vscode-editorWidget-border); font-weight:600; }
    .commit-list { padding:0; margin:0; list-style:none; }
    .no-commits { padding:10px; color: var(--vscode-descriptionForeground); }
    .controls { padding:8px; border-bottom:1px solid var(--vscode-editorWidget-border); display:flex; gap:8px; }
    button { padding:6px 10px; border-radius:4px; border: none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor:pointer; }
    button:hover { filter:brightness(0.95); }
    .file-title { padding:8px; border-bottom:1px solid var(--vscode-editorWidget-border); font-weight:600; }
</style>
</head>
<body>
<div class="container">
    <div class="left">
        <div class="file-title">${escFilename}</div>
        <div class="controls">
            <button id="showUncommittedBtn">Show Uncommitted Diff</button>
        </div>
        <div class="topEntryHeader">Uncommitted changes ${hasUncommitted ? '(modified)' : '(no changes)'}</div>
        <div id="topEntry" class="entry" data-type="uncommitted">
            <div class="meta"><div>Working Tree</div><div class="hash">—</div></div>
            <div class="desc">Current uncommitted changes for this file (even if none).</div>
        </div>
        <ul id="commitList" class="commit-list"></ul>
    </div>
    <div class="right" id="rightPane">
        <div style="color:var(--vscode-descriptionForeground)">Select an entry on the left and a diff will open to the right (editor area). Click the commit hash to open commit-details.</div>
        <div id="rightContent"></div>
    </div>
</div>

<script>
    const vscode = acquireVsCodeApi();
    const commits = ${commitJson};

    const commitList = document.getElementById('commitList');
    const topEntry = document.getElementById('topEntry');
    const showUncommittedBtn = document.getElementById('showUncommittedBtn');

    function renderCommits() {
        if (!commits || commits.length === 0) {
            const li = document.createElement('div');
            li.className = 'no-commits';
            li.textContent = 'No commits found for this file.';
            commitList.appendChild(li);
            return;
        }

        for (const c of commits) {
            const li = document.createElement('li');
            li.className = 'entry';
            li.dataset.hash = c.hash;
            li.innerHTML = \`
                <div class="meta"><div>\${escapeHtml(c.date)}</div><div><span class="hash" data-hash="\${c.hash}">\${c.shortHash}</span></div></div>
                <div class="desc">\${escapeHtml(c.desc)}</div>
            \`;
            // click whole entry -> show commit diff
            li.addEventListener('click', (ev) => {
                // if click was on the hash element specifically, let that handler run
                const target = ev.target;
                if (target && target.classList && target.classList.contains('hash')) {
                    return;
                }
                setSelectedEntry(li);
                vscode.postMessage({ command: 'showCommitDiff', hash: c.hash });
            });

            // hash click -> open commit details
            li.querySelector('.hash').addEventListener('click', (ev) => {
                ev.stopPropagation();
                vscode.postMessage({ command: 'showCommitDetails', hash: c.hash });
            });

            commitList.appendChild(li);
        }
    }

    function escapeHtml(unsafe) {
        if (!unsafe) return '';
        return unsafe.replace(/[&<>"'`]/g, function (m) {
            return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'}[m];
        });
    }

    function setSelectedEntry(el) {
        document.querySelectorAll('.entry').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
    }

    topEntry.addEventListener('click', () => {
        setSelectedEntry(topEntry);
        vscode.postMessage({ command: 'showUncommittedDiff' });
    });

    showUncommittedBtn.addEventListener('click', () => {
        setSelectedEntry(topEntry);
        vscode.postMessage({ command: 'showUncommittedDiff' });
    });

    renderCommits();
</script>
</body>
</html>`;

    return html;
}

function getCommitDetailsHtml(webview: vscode.Webview, hash: string, files: { status: string; path: string }[]) {
    const fileListHtml = files
        .map((f) => `<tr><td style="width:80px">${escapeHtml(f.status)}</td><td><a href="#" class="fileLink" data-file="${escapeHtmlAttr(f.path)}">${escapeHtml(f.path)}</a></td></tr>`)
        .join('\n') || '<tr><td colspan="2" style="color:var(--vscode-descriptionForeground)">No files listed for this commit.</td></tr>';

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval';">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding:12px; background: var(--vscode-editor-background); }
    table { width:100%; border-collapse:collapse; }
    td { padding:8px; border-bottom:1px solid var(--vscode-editorWidget-border); }
    a.fileLink { color: var(--vscode-textLink-foreground); text-decoration:none; cursor:pointer; }
</style>
</head>
<body>
    <h2>Commit ${escapeHtml(hash.substring(0,7))} — Files</h2>
    <table>
        ${fileListHtml}
    </table>
    <div style="margin-top:12px;"><button id="closeBtn">Close</button></div>
<script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.fileLink').forEach(el => {
        el.addEventListener('click', (ev) => {
            ev.preventDefault();
            const f = el.dataset.file;
            vscode.postMessage({ command: 'openFile', file: f });
        });
    });
    document.getElementById('closeBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'close' });
    });
</script>
</body>
</html>`;
}

// -------------------------- Utilities --------------------------

function escapeHtml(s: string) {
    if (!s) return '';
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
