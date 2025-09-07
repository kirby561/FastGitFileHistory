import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = util.promisify(execFile);
let navigationHistory: (() => void)[] = [];

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('fastGitFileHistory.view', async (uri?: vscode.Uri) => {
        let fileUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
            vscode.window.showErrorMessage('No file selected.');
            return;
        }
        openFileHistory(context, fileUri.fsPath);
    }));

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
        panel.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'openFileHistory' && context) {
                navigationHistory.push(() => vscode.commands.executeCommand('fastGitFileHistory.openCommitFiles', commitHash, repoPath, context));
                openFileHistory(context, path.join(repoPath, msg.filePath));
            }
        });
    }));
}

async function openFileHistory(context: vscode.ExtensionContext, filePath: string) {
    const repoPath = await findGitRepoRoot(filePath);
    if (!repoPath) {
        vscode.window.showErrorMessage('Unable to determine Git repo root.');
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'fastGitFileHistory',
        `History: ${path.basename(filePath)}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    const commits = await getFileCommits(filePath, repoPath);
    const languageClass = getHighlightJsLanguageClass(filePath);

    panel.webview.html = getFileHistoryHtml(filePath, commits, languageClass);

    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'showDiff') {
            const diffHtml = await getFullFileDiffHtml(filePath, msg.commit, repoPath);
            panel.webview.postMessage({ command: 'updateDiff', diff: diffHtml, language: languageClass });
        } else if (msg.command === 'showCommitFiles') {
            navigationHistory.push(() => openFileHistory(context, filePath));
            vscode.commands.executeCommand('fastGitFileHistory.openCommitFiles', msg.commit, repoPath, context);
        }
    });

    // Initially show WORKING diff
    const diffHtml = await getFullFileDiffHtml(filePath, 'WORKING', repoPath);
    panel.webview.postMessage({ command: 'updateDiff', diff: diffHtml, language: languageClass });
}

async function findGitRepoRoot(filePath: string): Promise<string | null> {
    let dir = path.dirname(filePath);
    while (dir) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

async function getFileCommits(filePath: string, repoPath: string) {
    const gitPath = vscode.workspace.getConfiguration('fastGitFileHistory').get<string>('gitPath') || 'git';
    try {
        const relativePath = path.relative(repoPath, filePath);
        const { stdout } = await execFileAsync(gitPath, ['log', '--pretty=format:%H|%ad|%s', '--date=short', '--', relativePath], { cwd: repoPath });
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

async function getCommitFiles(commitHash: string, repoPath: string) {
    const gitPath = vscode.workspace.getConfiguration('fastGitFileHistory').get<string>('gitPath') || 'git';
    try {
        const { stdout } = await execFileAsync(gitPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', commitHash], { cwd: repoPath });
        return stdout.split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

// ---------------- Full File + Inline Diff ----------------

async function getFullFileDiffHtml(filePath: string, commit: string, repoPath: string) {
    const gitPath = vscode.workspace.getConfiguration('fastGitFileHistory').get<string>('gitPath') || 'git';
    const relativePath = path.relative(repoPath, filePath);

    let oldContent = '';
    let newContent = '';
    try {
        if (commit === 'WORKING') {
            newContent = fs.readFileSync(filePath, 'utf-8');
            try {
                const { stdout } = await execFileAsync(gitPath, ['show', `HEAD:${relativePath}`], { cwd: repoPath });
                oldContent = stdout;
            } catch {}
        } else {
            try {
                const { stdout } = await execFileAsync(gitPath, ['show', `${commit}^:${relativePath}`], { cwd: repoPath });
                oldContent = stdout;
            } catch {}
            try {
                const { stdout } = await execFileAsync(gitPath, ['show', `${commit}:${relativePath}`], { cwd: repoPath });
                newContent = stdout;
            } catch {}
        }
    } catch {
        return '// Unable to load file/diff';
    }

    // Compute inline diff line by line
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const maxLines = Math.max(oldLines.length, newLines.length);
    let htmlLines: string[] = [];

    for (let i = 0; i < maxLines; i++) {
        const oldLine = oldLines[i] ?? '';
        const newLine = newLines[i] ?? '';
        if (!oldLine && newLine) {
            htmlLines.push(`<span class="add">${escapeHtml(newLine)}</span>`);
        } else if (oldLine && !newLine) {
            htmlLines.push(`<span class="del">${escapeHtml(oldLine)}</span>`);
        } else if (oldLine !== newLine) {
            htmlLines.push(`<span class="del">${escapeHtml(oldLine)}</span>`);
            htmlLines.push(`<span class="add">${escapeHtml(newLine)}</span>`);
        } else {
            htmlLines.push(escapeHtml(newLine));
        }
    }

    return htmlLines.join('\n');
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
function clearSelection() { commitEls.forEach(c=>c.classList.remove('selected')); }
commitEls.forEach(c=>{
    c.addEventListener('click', ()=>{
        clearSelection(); c.classList.add('selected');
        vscode.postMessage({command:'showDiff', commit:c.dataset.hash});
    });
    c.querySelector('.hash').addEventListener('click', e=>{
        e.stopPropagation();
        vscode.postMessage({command:'showCommitFiles', commit:c.dataset.hash});
    });
});
window.addEventListener('message', e=>{
    const msg = e.data;
    if(msg.command==='updateDiff'){
        const codeEl = document.createElement('pre');
        codeEl.innerHTML = '<code class="hljs '+msg.language+'">'+msg.diff+'</code>';
        const diffDiv = document.getElementById('diff');
        diffDiv.innerHTML='';
        diffDiv.appendChild(codeEl);
        hljs.highlightElement(codeEl.querySelector('code'));
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
document.querySelectorAll('.file').forEach(f=>f.addEventListener('click', ()=>{
    vscode.postMessage({command:'openFileHistory', filePath:f.dataset.path});
}));
</script>
</body>
</html>`;
}

function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]||c));
}

function getHighlightJsLanguageClass(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string,string> = {
        '.c':'cpp','.h':'cpp','.cpp':'cpp','.hpp':'cpp','.cc':'cpp','.hh':'cpp',
        '.js':'javascript','.ts':'typescript','.json':'json','.py':'python','.java':'java',
        '.cs':'cs','.go':'go','.rb':'ruby','.rs':'rust','.php':'php','.html':'xml','.css':'css'
    };
    return map[ext]||'';
}

export function deactivate() {}
