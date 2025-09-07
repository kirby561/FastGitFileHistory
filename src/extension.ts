import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';

function getConfigGitPath(): string {
    const cfg = vscode.workspace.getConfiguration('FastGitFileHistory');
    let gitPath: string = cfg.get('gitPath') || '';
    if (!gitPath) {
        gitPath = 'git';
    }
    return gitPath;
}

async function runGit(args: string[], cwd: string): Promise<string> {
    const gitPath = getConfigGitPath();
    return new Promise((resolve, reject) => {
        cp.execFile(gitPath, args, { cwd }, (err, stdout, stderr) => {
            if (err) reject(stderr || err.message);
            else resolve(stdout);
        });
    });
}

function escapeHtml(str: string | undefined): string {
    return (str ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[m] || m));
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('FastGitFileHistory.viewHistory', async (fileUri?: vscode.Uri) => {
            if (!fileUri) {
                const editor = vscode.window.activeTextEditor;
                fileUri = editor?.document.uri;
            }
            if (!fileUri) {
                vscode.window.showErrorMessage('No file selected.');
                return;
            }
            GitFileHistoryPanel.createOrShow(context, fileUri);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('FastGitFileHistory.openCommitFiles', (commitSha: string, repoPath: string) => {
            GitCommitFilesPanel.createOrShow(context, commitSha, repoPath);
        })
    );
}

class GitFileHistoryPanel {
    static currentPanel: GitFileHistoryPanel | undefined;
    static readonly viewType = 'fastGitFileHistory.main';

    panel: vscode.WebviewPanel;
    disposables: vscode.Disposable[] = [];
    fileUri: vscode.Uri;
    context: vscode.ExtensionContext;

    static createOrShow(ctx: vscode.ExtensionContext, fileUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (GitFileHistoryPanel.currentPanel) {
            GitFileHistoryPanel.currentPanel.panel.reveal(column);
            GitFileHistoryPanel.currentPanel.update(fileUri);
        } else {
            const panel = vscode.window.createWebviewPanel(
                GitFileHistoryPanel.viewType,
                `Git History: ${path.basename(fileUri.fsPath)}`,
                column,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            GitFileHistoryPanel.currentPanel = new GitFileHistoryPanel(panel, ctx, fileUri);
        }
    }

    constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, fileUri: vscode.Uri) {
        this.panel = panel;
        this.context = ctx;
        this.fileUri = fileUri;

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(this.onMessage.bind(this), null, this.disposables);

        this.update(fileUri);
    }

    async update(fileUri: vscode.Uri) {
        this.fileUri = fileUri;

        let repoPath = '';
        let relFile = '';
        try {
            repoPath = (await runGit(['rev-parse', '--show-toplevel'], path.dirname(fileUri.fsPath))).trim();
            relFile = path.relative(repoPath, fileUri.fsPath).replace(/\\/g, '/');
        } catch (err) {
            vscode.window.showErrorMessage('Not a git repository: ' + err);
            return;
        }

        const commits = await this.getFileCommits(repoPath, relFile);
        const commitList = [
            { special: 'uncommitted', hash: '', date: '', desc: 'Uncommitted changes', relFile, repoPath },
            ...commits
        ];

        const initialCommit = commitList[0];
        const initialDiff = await this.getDiffForCommit(initialCommit);

        this.panel.webview.html = this.getHtml(commitList, initialDiff, true);
    }

    async getFileCommits(repoPath: string, relFile: string) {
        const log = await runGit(
            ['log', '--pretty=format:%H%x09%ad%x09%s', '--date=short', '--', relFile],
            repoPath
        );
        return log.split('\n').filter(Boolean).map(line => {
            const [hash, date, ...descParts] = line.split('\t');
            return {
                hash,
                date,
                desc: descParts.join('\t'),
                relFile,
                repoPath,
                special: '',
            };
        });
    }

    async getDiffForCommit(commit: any): Promise<string> {
        if (commit.special === 'uncommitted') {
            try {
                // Diff unstaged changes (compare working tree to HEAD)
                const diff = await runGit(['diff', '--', commit.relFile], commit.repoPath);
                if (!diff.trim()) return "No uncommitted changes";
                return diff;
            } catch {
                return 'Failed to get uncommitted changes diff';
            }
        } else {
            try {
                // Get previous commit (to diff against)
                const prevCommit = await this.findPreviousCommit(commit.repoPath, commit.relFile, commit.hash);
                if (!prevCommit) return 'No previous commit for diff';

                // Git diff between previous and current commit for given file
                const diff = await runGit(
                    ['diff', `${prevCommit}`, `${commit.hash}`, '--', commit.relFile],
                    commit.repoPath
                );
                if (!diff.trim()) return "No changes in this commit";
                return diff;
            } catch {
                return 'Failed to get commit diff';
            }
        }
    }

    private async findPreviousCommit(repoPath: string, relFile: string, commit: string): Promise<string | null> {
        const log = await runGit(
            ['log', '--pretty=format:%H', '-n', '2', commit, '--', relFile],
            repoPath
        );
        const commits = log.split('\n').filter(Boolean);
        if (commits.length < 2) return null;
        return commits[1];
    }

    onMessage = async (msg: any) => {
        if (msg.type === 'openCommitFiles') {
            vscode.commands.executeCommand('FastGitFileHistory.openCommitFiles', msg.hash, msg.repoPath);
        } else if (msg.type === 'openFileHistory') {
            const fullUri = vscode.Uri.file(path.join(msg.repoPath, msg.relFile));
            GitFileHistoryPanel.createOrShow(this.context, fullUri);
        } else if (msg.type === 'showDiff') {
            // User requests diff for commit
            const commit = msg.commit;
            const repoPath = msg.repoPath;
            const relFile = msg.relFile;

            const diff = await this.getDiffForCommit({ ...commit, repoPath, relFile });
            // Send sideBySide preference to client
            this.panel.webview.postMessage({ type: 'renderDiff', diff, sideBySide: msg.sideBySide });
        }
    };

    getHtml(commits: any[], initialDiff: string, initialSideBySide: boolean) {
        // Use CDN for diff2html css/js, or embed locally for offline
        // For simplicity use unpkg CDN. If extension is offline, host locally.
        const nonce = getNonce();
        const commitEntries = commits.map(c => `
            <div class="commit-entry" data-special="${c.special}" data-hash="${c.hash}" data-repo="${escapeHtml(c.repoPath)}" data-relfile="${escapeHtml(c.relFile)}" role="listitem" tabindex="0" aria-label="${escapeHtml(c.desc)} commit on ${escapeHtml(c.date)}">
                ${c.special === 'uncommitted' 
                    ? `<span class="commit-desc uncommitted">${escapeHtml(c.desc)}</span>`
                    : `<span class="commit-date">${escapeHtml(c.date)}</span>
                       <span class="commit-hash" title="Click to show changed files">${escapeHtml(c.hash.substring(0,7))}</span>
                       <span class="commit-desc" title="${escapeHtml(c.desc)}">${escapeHtml(c.desc.length > 40 ? c.desc.slice(0,37) + '…' : c.desc)}</span>`
                }
            </div>
        `).join('');

        return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; img-src https: data:;" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Git File History</title>
<link nonce="${nonce}" rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css" />
<style nonce="${nonce}">
    body { font-family: var(--vscode-font-family), sans-serif; margin:0; height:100vh; display:flex; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    .left-pane { width: 300px; border-right: 1px solid var(--vscode-editorWidget-border); overflow-y: auto; }
    .right-pane { flex-grow:1; overflow-y: auto; padding: 10px; background-color: var(--vscode-editor-background); }
    .commit-entry {
        cursor: pointer;
        border-bottom: 1px solid var(--vscode-editorWidget-border);
        padding: 10px 10px;
        user-select: none;
        display: flex;
        align-items: center;
    }
    .commit-entry:focus, .commit-entry.selected {
        background-color: var(--vscode-list-focusBackground);
        outline: none;
    }
    .commit-date {
        flex-shrink: 0;
        width: 90px;
        color: var(--vscode-editorHint-foreground);
        margin-right: 5px;
        font-family: monospace;
        font-size: 0.9em;
    }
    .commit-hash {
        flex-shrink: 0;
        font-family: monospace;
        font-weight: bold;
        color: var(--vscode-button-background);
        margin-right: 8px;
        user-select: all;
    }
    .commit-desc {
        flex-grow: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 0.9em;
    }
    .commit-desc.uncommitted {
        font-weight: bold;
        color: var(--vscode-editorWarning-foreground);
    }
    .diff-container {
        height: 100%;
    }
    .toggle-buttons {
        padding: 5px 8px;
        background: var(--vscode-editorWidget-background);
        border-bottom: 1px solid var(--vscode-editorWidget-border);
        display: flex;
        gap: 10px;
    }
    .toggle-buttons button {
        border: none;
        padding: 6px 10px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
        border-radius: 3px;
    }
    .toggle-buttons button.selected {
        font-weight: bold;
        cursor: default;
    }
</style>
</head>
<body>
    <div class="left-pane" role="list" aria-label="Commit history list">
        ${commitEntries}
    </div>
    <div class="right-pane">
        <div class="toggle-buttons" role="toolbar" aria-label="Toggle diff view">
            <button id="sideBySideBtn" aria-pressed="${initialSideBySide}" class="${initialSideBySide ? 'selected' : ''}">Side by Side</button>
            <button id="inlineBtn" aria-pressed="${!initialSideBySide}" class="${!initialSideBySide ? 'selected' : ''}">Inline</button>
        </div>
        <div id="diffContainer" class="diff-container" aria-live="polite" aria-atomic="true"></div>
    </div>
    <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html.min.js"></script>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let sideBySide = ${initialSideBySide};
        const commits = document.querySelectorAll('.commit-entry');
        let selectedIndex = 0;

        function selectCommit(index) {
            commits.forEach((c, i) => {
                c.classList.toggle('selected', i === index);
            });
            selectedIndex = index;
            const c = commits[index];
            vscode.postMessage({
                type: 'showDiff',
                commit: {
                    special: c.dataset.special,
                    hash: c.dataset.hash
                },
                repoPath: c.dataset.repo,
                relFile: c.dataset.relfile,
                sideBySide
            });
        }

        commits.forEach((c, i) => {
            c.addEventListener('click', () => selectCommit(i));
            c.addEventListener('keydown', e => {
                if(e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectCommit(i);
                }
            });
            // If clicking the commit hash span, open commit files view
            c.querySelector('.commit-hash')?.addEventListener('click', e => {
                e.stopPropagation();
                vscode.postMessage({
                    type: 'openCommitFiles',
                    hash: c.dataset.hash,
                    repoPath: c.dataset.repo
                });
            });
        });

        document.getElementById('sideBySideBtn').addEventListener('click', () => {
            if (!sideBySide) {
                sideBySide = true;
                document.getElementById('sideBySideBtn').classList.add('selected');
                document.getElementById('inlineBtn').classList.remove('selected');
                selectCommit(selectedIndex);
            }
        });
        document.getElementById('inlineBtn').addEventListener('click', () => {
            if (sideBySide) {
                sideBySide = false;
                document.getElementById('inlineBtn').classList.add('selected');
                document.getElementById('sideBySideBtn').classList.remove('selected');
                selectCommit(selectedIndex);
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'renderDiff') {
                const diffHtml = Diff2Html.html(message.diff, {
                    drawFileList: false,
                    matching: 'lines',
                    outputFormat: message.sideBySide ? 'side-by-side' : 'line-by-line',
                    highlight: true,
                });
                document.getElementById('diffContainer').innerHTML = diffHtml || '<p>No differences</p>';
            }
        });

        // Select first commit initially
        selectCommit(0);
    </script>
</body>
</html>
        `;
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}

class GitCommitFilesPanel {
    static viewType = 'fastGitFileHistory.commitFiles';
    static currentPanels: Map<string, GitCommitFilesPanel> = new Map();

    panel: vscode.WebviewPanel;
    disposables: vscode.Disposable[] = [];
    commitSha: string;
    repoPath: string;
    context: vscode.ExtensionContext;

    static createOrShow(ctx: vscode.ExtensionContext, commitSha: string, repoPath: string) {
        const id = `${commitSha}@${repoPath}`;
        if (GitCommitFilesPanel.currentPanels.has(id)) {
            GitCommitFilesPanel.currentPanels.get(id)?.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            GitCommitFilesPanel.viewType,
            `Files changed in ${commitSha.slice(0,7)}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        const cp = new GitCommitFilesPanel(panel, ctx, commitSha, repoPath);
        GitCommitFilesPanel.currentPanels.set(id, cp);
    }

    constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, commitSha: string, repoPath: string) {
        this.panel = panel;
        this.context = ctx;
        this.commitSha = commitSha;
        this.repoPath = repoPath;

        this.panel.webview.html = 'Loading...';
        this.update();

        this.panel.onDidDispose(() => {
            GitCommitFilesPanel.currentPanels.delete(`${this.commitSha}@${this.repoPath}`);
            this.dispose();
        }, null, this.disposables);

        this.panel.webview.onDidReceiveMessage(this.onMessage.bind(this), null, this.disposables);
    }

    async update() {
        const out = await runGit(['show', '--pretty=format:', '--name-status', this.commitSha], this.repoPath);
        const files = out.split('\n').filter(Boolean).map(line => {
            const [status, ...fileParts] = line.split('\t');
            return { status, file: fileParts.join('\t') };
        });

        this.panel.webview.html = `
            <style>
                body { font-family: var(--vscode-font-family), sans-serif; margin: 0; padding: 0; }
                .file-item {
                    padding: 8px 12px;
                    border-bottom: 1px solid var(--vscode-editorWidget-border);
                    cursor: pointer;
                }
                .file-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .stat-A { color: #0F4; }
                .stat-M { color: var(--vscode-editor-foreground); }
                .stat-D { color: #F44; }
            </style>
            <h2>Files changed in commit ${escapeHtml(this.commitSha.slice(0,7))}</h2>
            ${files.map(f => `<div class="file-item stat-${escapeHtml(f.status)}" data-file="${encodeURIComponent(f.file)}">${escapeHtml(f.status)} ${escapeHtml(f.file)}</div>`).join('')}
            <script>
                const vscode = acquireVsCodeApi();
                document.body.addEventListener('click', e => {
                    const item = e.target.closest('.file-item');
                    if (!item) return;
                    vscode.postMessage({
                        type: 'openFileHistory',
                        relFile: decodeURIComponent(item.dataset.file),
                        repoPath: ${JSON.stringify(this.repoPath)}
                    });
                });
            </script>
        `;
    }

    onMessage(msg: any) {
        if (msg.type === 'openFileHistory') {
            const fullUri = vscode.Uri.file(path.join(msg.repoPath, msg.relFile));
            GitFileHistoryPanel.createOrShow(this.context, fullUri);
        }
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}

export function deactivate() {}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
}
