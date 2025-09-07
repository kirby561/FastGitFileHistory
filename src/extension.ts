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

    context.subscriptions.push(vscode.commands.registerCommand('fastGitFileHistory.back', () => {
        const last = navigationHistory.pop();
        if (last) last();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('fastGitFileHistory.openCommitFiles', async (commitHash: string, repoPath: string, context?: vscode.ExtensionContext) => {
        const files = await getCommitFiles(commitHash, repoPath);
        const panel = vscode.window.createWebviewPanel(
            'fastGitFileHistoryCommitFiles',
            `Commit ${commitHash}`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = getCommitFilesHtml(files, commitHash);
        panel.webview.onDidReceiveMessage((msg) => {
            if (msg.command === 'openFileHistory' && context) {
                navigationHistory.push(() => vscode.commands.executeCommand('fastGitFileHistory.openCommitFiles', commitHash, repoPath));
                openFileHistory(context, path.join(repoPath, msg.filePath));
            }
        });
    }));
}

async function openFileHistory(context: vscode.ExtensionContext, filePath: string) {
    const repoPath = path.dirname(filePath);
    const panel = vscode.window.createWebviewPanel(
        'fastGitFileHistory',
        `History: ${path.basename(filePath)}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    const commits = await getFileCommits(filePath, repoPath);
    const languageClass = getHighlightJsLanguageClass(filePath);

    panel.webview.html = getFileHistoryHtml(filePath, commits, languageClass);

    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'showDiff') {
            const diff = await getDiffForCommit(filePath, msg.commit, repoPath);
            panel.webview.postMessage({ command: 'updateDiff', diff, commit: msg.commit });
        } else if (msg.command === 'showCommitFiles') {
            navigationHistory.push(() => openFileHistory(context, filePath));
            vscode.commands.executeCommand('fastGitFileHistory.openCommitFiles', msg.commit, repoPath, context);
        }
    });

    // Auto-show top entry diff
    const diff = await getDiffForCommit(filePath, commits[0].hash, repoPath);
    panel.webview.postMessage({ command: 'updateDiff', diff, commit: commits[0].hash });
}

async function getFileCommits(filePath: string, repoPath: string) {
    const gitPath = vscode.workspace.getConfiguration('fastGitFileHistory').get<string>('gitPath') || 'git';
    try {
        const { stdout } = await execFileAsync(gitPath, ['log', '--pretty=format:%H|%ad|%s', '--date=short', '--', filePath], { cwd: repoPath });
        const commits = stdout.split('\n').filter(Boolean).map(line => {
            const [hash, date, ...rest] = line.split('|');
            return { hash, date, message: rest.join('|') };
        });
        commits.unshift({ hash: 'WORKING', date: '', message: 'Uncommitted changes' });
        return commits;
    } catch {
        return [{ hash: 'WORKING', date: '', message: 'Uncommitted changes' }];
    }
}

async function getDiffForCommit(filePath: string, commit: string, repoPath: string) {
    const gitPath = vscode.workspace.getConfiguration('fastGitFileHistory').get<string>('gitPath') || 'git';
    try {
        const args = commit === 'WORKING' ? ['diff', '--', filePath] : ['diff', `${commit}^`, commit, '--', filePath];
        const { stdout } = await execFileAsync(gitPath, args, { cwd: repoPath });
        return stdout;
    } catch {
        return '// No diff available';
    }
}

async function getCommitFiles(commitHash: string, repoPath: string) {
    const gitPath = vscode.workspace.getConfiguration('fastGitFileHistory').get<string>('gitPath') || 'git';
    try {
        const { stdout } = await execFileAsync(gitPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', commitHash], { cwd: repoPath });
        return stdout.split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

// ---------------- HTML ----------------

function getFileHistoryHtml(filePath: string, commits: any[], languageClass: string) {
    const commitItems = commits.map(c => `
        <div class="commit" data-hash="${c.hash}">
            <span class="hash" data-hash="${c.hash}">${c.hash.substring(0,7)}</span>
            <span class="date">${c.date}</span>
            <span class="message" title="${escapeHtml(c.message)}">${escapeHtml(c.message)}</span>
        </div>
    `).join('');

    return `<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css">
    <style>
        body { margin:0; display:flex; font-family: var(--vscode-font-family); height:100vh; }
        #commits { width: 300px; border-right:1px solid #333; overflow-y:auto; background-color:#1e1e1e; color:white; }
        #diff { flex:1; padding:10px; overflow:auto; background-color:#1e1e1e; color:white; }
        .commit { padding:5px; border-bottom:1px solid #333; cursor:pointer; }
        .commit.selected { background-color:#094771; }
        .commit:hover { background-color:#2a2a2a; }
        .hash { color:#3794ff; font-weight:bold; cursor:pointer; }
        .date { color:#cccccc; margin-left:5px; }
        .message { margin-left:5px; }
        .add { background-color: rgba(0,255,0,0.15); display:block; }
        .del { background-color: rgba(255,0,0,0.15); display:block; }
        pre { white-space: pre-wrap; }
    </style>
</head>
<body>
    <div id="commits">${commitItems}</div>
    <div id="diff"><em>Loading...</em></div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <script>
        const vscode = acquireVsCodeApi();
        const commitEls = document.querySelectorAll('.commit');
        function clearSelection() { commitEls.forEach(c => c.classList.remove('selected')); }
        commitEls.forEach(c => {
            c.addEventListener('click', () => {
                clearSelection(); c.classList.add('selected');
                vscode.postMessage({ command:'showDiff', commit:c.dataset.hash });
            });
            c.querySelector('.hash').addEventListener('click', e => {
                e.stopPropagation();
                vscode.postMessage({ command:'showCommitFiles', commit:c.dataset.hash });
            });
        });

        window.addEventListener('message', e => {
            const msg = e.data;
            if(msg.command==='updateDiff') {
                const raw = msg.diff.split('\\n').map(l=>{
                    if(l.startsWith('+')) return '<span class="add">'+l.substring(1)+'</span>';
                    if(l.startsWith('-')) return '<span class="del">'+l.substring(1)+'</span>';
                    return l;
                }).join('\\n');
                document.getElementById('diff').innerHTML='<pre><code class="hljs ${languageClass}">'+raw+'</code></pre>';
                hljs.highlightAll();
            }
        });
    </script>
</body>
</html>`;
}

function getCommitFilesHtml(files: string[], commitHash: string) {
    const items = files.map(f => `<div class="file" data-path="${f}">${f}</div>`).join('');
    return `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: var(--vscode-font-family); margin:10px; color:white; background-color:#1e1e1e; }
.file { padding:5px; cursor:pointer; }
.file:hover { background-color:#2a2a2a; }
</style>
</head>
<body>
<h3>Commit ${commitHash.substring(0,7)}</h3>
${items}
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('.file').forEach(f => f.addEventListener('click', () => {
    vscode.postMessage({ command:'openFileHistory', filePath:f.dataset.path });
}));
</script>
</body>
</html>`;
}

function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c] || c));
}

function getHighlightJsLanguageClass(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string,string> = {
        '.c':'cpp', '.h':'cpp', '.cpp':'cpp', '.hpp':'cpp', '.cc':'cpp', '.hh':'cpp',
        '.js':'javascript','.ts':'typescript','.json':'json','.py':'python','.java':'java',
        '.cs':'cs','.go':'go','.rb':'ruby','.rs':'rust','.php':'php','.html':'xml','.css':'css'
    };
    return map[ext]||'';
}

export function deactivate() {}
