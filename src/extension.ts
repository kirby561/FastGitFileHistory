import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';

function getConfigGitPath(): string {
    const cfg = vscode.workspace.getConfiguration('FastGitFileHistory');
    let gitPath: string = cfg.get('gitPath') || '';
    if (!gitPath) {
        // Assume first git in path
        gitPath = 'git';
    }
    return gitPath;
}

// Run a git command, returns stdout as string
async function runGit(args: string[], cwd: string): Promise<string> {
    const gitPath = getConfigGitPath();
    return new Promise((resolve, reject) => {
        cp.execFile(gitPath, args, { cwd }, (err, stdout, stderr) => {
            if (err) reject(stderr || err.message);
            else resolve(stdout);
        });
    });
}

function getFileRootUri(uri: vscode.Uri): vscode.Uri {
    if (vscode.workspace.workspaceFolders) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) return folder.uri;
    }
    return uri;
}

export function activate(context: vscode.ExtensionContext) {
    // Register the main command
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

    // Context menu command in explorer and editor
    context.subscriptions.push(
        vscode.commands.registerCommand('FastGitFileHistory.openCommitFiles', (commitSha: string, repoPath: string) => {
            GitCommitFilesPanel.createOrShow(context, commitSha, repoPath);
        })
    );

    // Register settings for gitPath (not shown: package.json settings; see note)
}

// --- Webview panels ---

class GitFileHistoryPanel {
    static currentPanel: GitFileHistoryPanel | undefined;
    static readonly viewType = 'fastGitFileHistory.main';

    readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private fileUri: vscode.Uri;
    private context: vscode.ExtensionContext;

    static createOrShow(ctx: vscode.ExtensionContext, fileUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (GitFileHistoryPanel.currentPanel) {
            GitFileHistoryPanel.currentPanel.panel.reveal(column);
            GitFileHistoryPanel.currentPanel.update(fileUri);
        } else {
            const panel = vscode.window.createWebviewPanel(
                GitFileHistoryPanel.viewType,
                'File Git History',
                column || vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                }
            );
            GitFileHistoryPanel.currentPanel = new GitFileHistoryPanel(panel, ctx, fileUri);
        }
    }

    private constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, fileUri: vscode.Uri) {
        this.panel = panel;
        this.context = ctx;
        this.fileUri = fileUri;

        this.panel.webview.html = this.getHtml({ commits: [], diffs: '', repoPath: '', relFile: '' });
        this.update(fileUri);

        this.panel.onDidDispose(() => {
            GitFileHistoryPanel.currentPanel = undefined;
            this.dispose();
        }, null, this.disposables);

        this.panel.webview.onDidReceiveMessage(this.onMessage.bind(this), null, this.disposables);
    }

    private async update(fileUri: vscode.Uri) {
        let repoPath = '';
        let relFile = '';
        try {
            repoPath = (await runGit(['rev-parse', '--show-toplevel'], path.dirname(fileUri.fsPath))).trim();
            relFile = path.relative(repoPath, fileUri.fsPath).replace(/\\/g,'/');
        } catch (err) {
            vscode.window.showErrorMessage('Not a git repo: ' + err);
            return;
        }

        const commits = await this.getFileCommits(repoPath, relFile);
        const uncommitted = await this.getWorkingDiff(repoPath, relFile);

        // always show "Uncommitted changes" on top
        const commitList = [
            {
                special: 'uncommitted',
                date: '',
                hash: '',
                desc: 'Uncommitted changes',
                relFile: relFile,
                diff: uncommitted
            },
            ...commits
        ];

        let initialDiff = uncommitted;

        this.panel.webview.html = this.getHtml({
            commits: commitList,
            diffs: initialDiff,
            repoPath,
            relFile
        });
    }

    private async getFileCommits(repoPath: string, relFile: string) {
        // git log with date, short hash, subject, for the file
        const log = await runGit(
            [
                'log',
                '--pretty=format:%H%x09%ad%x09%s',
                '--date=short',
                '--',
                relFile
            ],
            repoPath
        );
        const commits = log.split('\n').filter(Boolean).map(l => {
            const [hash, date, ...rest] = l.split('\t');
            const desc = rest.join('\t');
            return {
                hash: hash,
                date: date,
                desc: desc,
                relFile: relFile,
                special: '',
            };
        });
        return commits;
    }

    private async getWorkingDiff(repoPath: string, relFile: string) {
        try {
            const diff = await runGit(['diff', relFile], repoPath);
            return diff;
        } catch {
            return '';
        }
    }

    private async getCommitDiff(repoPath: string, relFile: string, hash: string) {
        // Get previous commit
        const stdout = await runGit(['log', '--pretty=%H', '-n', '2', '--', relFile], repoPath);
        const hashes = stdout.split('\n').filter(Boolean);
        let refA = '';
        let refB = '';
        if (hashes.length === 1) { // File added
            refA = `${hash}^`;
            refB = hash;
        } else {
            refA = hashes[1];
            refB = hash;
        }
        let diff = '';
        try {
            diff = await runGit(['diff', `${refA}`, `${refB}`, '--', relFile], repoPath);
        } catch {
            diff = '';
        }
        return diff;
    }

    private async onMessage(msg: any) {
        if (msg.type === 'showDiff') {
            const { commit, repoPath, relFile } = msg;
            let diff = '';
            if (commit.special === 'uncommitted') {
                diff = await this.getWorkingDiff(repoPath, relFile);
            } else {
                diff = await this.getCommitDiff(repoPath, relFile, commit.hash);
            }
            this.panel.webview.postMessage({ type: 'renderDiff', diff });
        } else if (msg.type === 'openCommitFiles') {
            vscode.commands.executeCommand('FastGitFileHistory.openCommitFiles', msg.hash, msg.repoPath);
        } else if (msg.type === 'openFileHistory') {
            // Open this same panel with the given relFile
            const fullUri = vscode.Uri.file(path.join(msg.repoPath, msg.relFile));
            GitFileHistoryPanel.createOrShow(this.context, fullUri);
        }
    }

    private getHtml({ commits, diffs, repoPath, relFile }: any): string {
        // Generate HTML with 2 panes and message passing
        const escapeHtml = (str: string | undefined) => (str ?? '').replace(/[&<>"']/g, (m) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[m] || m));  // <- fallback to m itself if no mapping found

        function commitEntry(commit: any) {
            let title = '';
            if (commit.special === 'uncommitted') {
                title = `<span style="font-weight:bold;">Uncommitted changes</span>`;
            } else {
                const desc = escapeHtml(commit.desc.length > 40 ? commit.desc.slice(0,37) + '…' : commit.desc);
                title = `<span style="color:#888;">${commit.date}</span>
                <span class="commit-hash" data-commit="${commit.hash}" style="cursor:pointer;color:#25F;">${commit.hash?.slice(0,7)}</span>
                <span style="margin-left:6px;">${desc}</span>`;
            }
            return `<div class="commit-entry" data-special="${commit.special||''}" data-hash="${commit.hash||''}">${title}</div>`;
        }

        return /*html*/`
            <style>
            body { font-family: var(--vscode-font-family, Arial); margin:0; }
            .container { display: flex; height: 100vh; }
            .left-pane { width: 35%; background:var(--vscode-editorGutter-background, #24282F); overflow-y: auto; border-right: 1px solid #666; }
            .right-pane { flex:1; background:var(--vscode-editor-background, #1E1E1E); padding:10px; color:var(--vscode-editor-foreground, #EEE); overflow:auto;}
            .commit-entry { padding:8px 12px; border-bottom: 1px solid #333; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; height:40px; line-height:1.3; display: flex; align-items: center;}
            .commit-entry.selected { background-color: var(--vscode-list-hoverBackground, #444); }
            .commit-hash { font-weight:bold; }
            </style>
            <div class="container">
                <div class="left-pane" id="commits">
                    ${commits.map(commitEntry).join('')}
                </div>
                <div class="right-pane" id="diffview">
                    <pre style="white-space: pre-wrap;">${escapeHtml(diffs)}</pre>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                let lastSelected = null;
                function selectEntry(el) {
                    if (lastSelected) lastSelected.classList.remove('selected');
                    el.classList.add('selected');
                    lastSelected = el;
                }

                document.getElementById('commits').addEventListener('click', e => {
                    const hashBtn = e.target.closest('.commit-hash');
                    if (hashBtn) {
                        vscode.postMessage({
                            type: 'openCommitFiles',
                            hash: hashBtn.dataset.commit,
                            repoPath: ${JSON.stringify(repoPath)}
                        });
                        return;
                    }
                    const entry = e.target.closest('.commit-entry');
                    if (!entry) return;
                    selectEntry(entry);

                    const special = entry.dataset.special;
                    const hash = entry.dataset.hash;
                    const commit = { special, hash };
                    vscode.postMessage({
                        type: 'showDiff',
                        commit,
                        repoPath: ${JSON.stringify(repoPath)},
                        relFile: ${JSON.stringify(relFile)}
                    });
                });

                // Select the first entry initially
                const entries = document.querySelectorAll('.commit-entry');
                if (entries.length) selectEntry(entries[0]);

                window.addEventListener('message', event => {
                    if (event.data.type === 'renderDiff') {
                        document.getElementById('diffview').innerHTML =
                            "<pre style='white-space: pre-wrap;'>" + 
                            (event.data.diff||'') 
                                .replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])) 
                            + "</pre>";
                    }
                });
            </script>
        `;
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}

class GitCommitFilesPanel {
    static viewType = 'fastGitFileHistory.commitFiles';
    static currentPanels: Map<string, GitCommitFilesPanel> = new Map();

    readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private commitSha: string;
    private repoPath: string;
    private context: vscode.ExtensionContext;

    static createOrShow(ctx: vscode.ExtensionContext, commitSha: string, repoPath: string) {
        let id = `${commitSha}@${repoPath}`;
        if (GitCommitFilesPanel.currentPanels.has(id)) {
            let p = GitCommitFilesPanel.currentPanels.get(id)!;
            p.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            GitCommitFilesPanel.viewType,
            `Files in ${commitSha.slice(0,7)}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        let cp = new GitCommitFilesPanel(panel, ctx, commitSha, repoPath);
        GitCommitFilesPanel.currentPanels.set(id, cp);
    }

    private constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, commitSha: string, repoPath: string) {
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

    private async update() {
        // git show --name-status commitSha
        const out = await runGit(['show', '--pretty=format:', '--name-status', this.commitSha], this.repoPath);
        const files = out.split('\n').filter(Boolean).map(line => {
            const [status, ...ff] = line.split('\t');
            return { status, file: ff.join('\t') };
        });

        const html = /*html*/`
            <style>
            body { font-family: var(--vscode-font-family, Arial); margin:0;}
            h2 { margin: 12px 0 10px 8px; }
            .file-item { padding:8px 12px; border-bottom: 1px solid #333; cursor:pointer; }
            .stat-A {color:#0F4;}
            .stat-M {color:#DDD;}
            .stat-D {color:#F44;}
            </style>
            <h2>Files for commit <span style="font-family:monospace;">${this.commitSha.slice(0,7)}</span></h2>
            ${files.map(f => `
              <div class="file-item stat-${f.status}" data-file="${encodeURIComponent(f.file)}">${f.status} ${f.file}</div>
            `).join('')}
            <script>
            const vscode = acquireVsCodeApi();
            document.body.addEventListener('click', e => {
                const item = e.target.closest('.file-item');
                if (!item) return;
                const relFile = decodeURIComponent(item.dataset.file);
                vscode.postMessage({
                    type: 'openFileHistory',
                    relFile: relFile,
                    repoPath: ${JSON.stringify(this.repoPath)}
                });
            });
            </script>
        `;
        this.panel.webview.html = html;
    }

    private onMessage(msg: any) {
        if (msg.type === 'openFileHistory') {
            const fullUri = vscode.Uri.file(path.join(msg.repoPath, msg.relFile));
            GitFileHistoryPanel.createOrShow(this.context, fullUri);
        }
    }
    public dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}

export function deactivate() {}
