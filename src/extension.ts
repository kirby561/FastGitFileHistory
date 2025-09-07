import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import * as util from 'util';

const execFileAsync = util.promisify(execFile);

let navigationHistory: (() => void)[] = [];

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('fastGitFileHistory.view', async (uri?: vscode.Uri) => {
        let fileUri = uri;
        if (!fileUri && vscode.window.activeTextEditor) {
            fileUri = vscode.window.activeTextEditor.document.uri;
        }
        if (!fileUri) {
            vscode.window.showErrorMessage('No file selected.');
            return;
        }
        openFileHistory(context, fileUri.fsPath);
    });

    context.subscriptions.push(disposable);

    // Handle back navigation
    context.subscriptions.push(vscode.commands.registerCommand('fastGitFileHistory.back', () => {
        const last = navigationHistory.pop();
        if (last) {
            last();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('fastGitFileHistory.openCommitFiles', async (commitHash: string, repoPath: string) => {
        const files = await getCommitFiles(commitHash, repoPath);
        const panel = vscode.window.createWebviewPanel(
            'fastGitFileHistoryCommitFiles',
            `Commit ${commitHash}`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = getCommitFilesHtml(files, commitHash);
        panel.webview.onDidReceiveMessage((msg) => {
            if (msg.command === 'openFileHistory') {
                navigationHistory.push(() => {
                    vscode.commands.executeCommand('fastGitFileHistory.openCommitFiles', commitHash, repoPath);
                });
                openFileHistory(context, path.join(repoPath, msg.filePath));
            }
        });
    }));

    // Bind mouse back button
    context.subscriptions.push(vscode.commands.registerCommand('workbench.action.navigateBack', () => {
        vscode.commands.executeCommand('fastGitFileHistory.back');
    }));
}

async function openFileHistory(context: vscode.ExtensionContext, filePath: string) {
    const repoPath = path.dirname(filePath);

    const panel = vscode.window.createWebviewPanel(
        'fastGitFileHistory',
        `History: ${path.basename(filePath)}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    const commits = await getFileCommits(filePath, repoPath);

    panel.webview.html = getFileHistoryHtml(filePath, commits, context);
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'showDiff') {
            const diff = await getDiffForCommit(filePath, msg.commit, repoPath);
            panel.webview.postMessage({ command: 'updateDiff', diff, commit: msg.commit, filePath });
        } else if (msg.command === 'showCommitFiles') {
            navigationHistory.push(() => openFileHistory(context, filePath));
            vscode.commands.executeCommand('fastGitFileHistory.openCommitFiles', msg.commit, repoPath);
        }
    });
}

async function getFileCommits(filePath: string, repoPath: string) {
    try {
        const gitPath = vscode.workspace.getConfiguration('fastGitFileHistory').get<string>('gitPath') || 'git';
        const { stdout } = await execFileAsync(gitPath, [
            'log',
            '--pretty=format:%H|%ad|%s',
            '--date=short',
            '--',
            filePath
        ], { cwd: repoPath });

        const commits = stdout.split('\n').filter(Boolean).map(line => {
            const [hash, date, ...messageParts] = line.split('|');
            return { hash, date, message: messageParts.join('|') };
        });

        // Add "Uncommitted changes" entry at top
        commits.unshift({ hash: 'WORKING', date: '', message: 'Uncommitted changes' });
        return commits;
    } catch {
        return [{ hash: 'WORKING', date: '', message: 'Uncommitted changes' }];
    }
}

async function getDiffForCommit(filePath: string, commit: string, repoPath: string) {
    const gitPath = vscode.workspace.getConfiguration('fastGitFileHistory').get<string>('gitPath') || 'git';
    try {
        let args: string[];
        if (commit === 'WORKING') {
            args = ['diff', '--', filePath];
        } else {
            args = ['diff', `${commit}~1`, commit, '--', filePath];
        }
        const { stdout } = await execFileAsync(gitPath, args, { cwd: repoPath });
        return stdout;
    } catch {
        return '// No diff available';
    }
}

async function getCommitFiles(commitHash: string, repoPath: string): Promise<string[]> {
    const gitPath = vscode.workspace.getConfiguration('fastGitFileHistory').get<string>('gitPath') || 'git';
    try {
        const { stdout } = await execFileAsync(gitPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', commitHash], { cwd: repoPath });
        return stdout.split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

function getFileHistoryHtml(filePath: string, commits: any[], context: vscode.ExtensionContext): string {
    const commitItems = commits.map(c => `
        <div class="commit" data-hash="${c.hash}">
            <span class="hash" data-hash="${c.hash}">${c.hash.substring(0, 7)}</span>
            <span class="date">${c.date}</span>
            <span class="message" title="${escapeHtml(c.message)}">${escapeHtml(c.message)}</span>
        </div>
    `).join('');

    return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { display: flex; height: 100vh; margin: 0; font-family: sans-serif; }
        #commits { width: 30%; border-right: 1px solid #ccc; overflow-y: auto; }
        #diff { flex-grow: 1; padding: 10px; overflow-y: auto; }
        .commit { padding: 5px; border-bottom: 1px solid #eee; cursor: pointer; }
        .commit:hover { background: #f0f0f0; }
        .hash { font-weight: bold; color: #007acc; margin-right: 5px; cursor: pointer; }
        .date { color: #999; margin-right: 5px; }
        pre { white-space: pre-wrap; }
        .hljs-addition { background-color: #e6ffed; display: block; }
        .hljs-deletion { background-color: #ffeef0; display: block; }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
</head>
<body>
    <div id="commits">${commitItems}</div>
    <div id="diff"><em>Select a commit to view diff</em></div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <script>
        const vscode = acquireVsCodeApi();
        const commits = document.querySelectorAll('.commit');
        commits.forEach(c => {
            c.addEventListener('click', () => {
                vscode.postMessage({ command: 'showDiff', commit: c.dataset.hash });
            });
        });
        const hashes = document.querySelectorAll('.hash');
        hashes.forEach(h => {
            h.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: 'showCommitFiles', commit: h.dataset.hash });
            });
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'updateDiff') {
                let diff = msg.diff
                    .replace(/^\\+\\+\\+.*$/gm, '')
                    .replace(/^---.*$/gm, '');
                diff = diff.split('\\n').map(line => {
                    if (line.startsWith('+')) return '<span class="hljs-addition">' + line.substring(1) + '</span>';
                    if (line.startsWith('-')) return '<span class="hljs-deletion">' + line.substring(1) + '</span>';
                    return line;
                }).join('\\n');
                document.getElementById('diff').innerHTML =
                    '<pre><code class="hljs cpp">' + diff + '</code></pre>';
                hljs.highlightAll();
            }
        });
    </script>
</body>
</html>`;
}

function getCommitFilesHtml(files: string[], commitHash: string): string {
    const items = files.map(f => `<div class="file" data-path="${f}">${f}</div>`).join('');
    return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: sans-serif; margin: 0; padding: 10px; }
        .file { padding: 5px; border-bottom: 1px solid #eee; cursor: pointer; }
        .file:hover { background: #f0f0f0; }
    </style>
</head>
<body>
    <h3>Files in commit ${commitHash.substring(0,7)}</h3>
    ${items}
    <script>
        const vscode = acquireVsCodeApi();
        const files = document.querySelectorAll('.file');
        files.forEach(f => {
            f.addEventListener('click', () => {
                vscode.postMessage({ command: 'openFileHistory', filePath: f.dataset.path });
            });
        });
    </script>
</body>
</html>`;
}

function escapeHtml(unsafe: string) {
    return unsafe.replace(/[&<>"'`]/g, m => {
        switch (m) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#039;';
            case '`': return '&#x60;';
            default: return m;
        }
    });
}

export function deactivate() {}
