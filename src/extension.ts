// src/extension.ts
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = util.promisify(execFile);

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('fastGitFileHistory.view', async (uri?: vscode.Uri) => {
      const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!fileUri) {
        vscode.window.showErrorMessage('No file selected.');
        return;
      }
      await openFileHistory(context, fileUri.fsPath);
    })
  );
}

export function deactivate() {}

// ------------------ Helpers ------------------

async function findGitRepoRoot(filePath: string): Promise<string | null> {
  let dir = path.dirname(filePath);
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function normalizeGitPath(p: string) {
  return p.replace(/\\/g, '/');
}

function getGitPath(): string {
  const cfg = vscode.workspace.getConfiguration('fastGitFileHistory');
  return cfg.get<string>('gitPath') || 'git';
}

// ------------------ Git operations ------------------

async function getFileCommits(filePath: string, repoPath: string) {
  const git = getGitPath();
  const rel = normalizeGitPath(path.relative(repoPath, filePath));
  try {
    const { stdout } = await execFileAsync(git, ['log', '--pretty=format:%H|%ad|%s', '--date=short', '--', rel], { cwd: repoPath });
    const lines = stdout.split('\n').filter(Boolean);
    const commits = lines.map(line => {
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
  const git = getGitPath();
  try {
    const { stdout } = await execFileAsync(git, ['diff-tree', '--no-commit-id', '--name-only', '-r', commitHash], { cwd: repoPath });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ------------------ LCS diff (line-based) ------------------

function buildMergedLines(oldText: string, newText: string) {
  const oldLines = oldText.length ? oldText.split('\n') : [];
  const newLines = newText.length ? newText.split('\n') : [];

  const m = oldLines.length;
  const n = newLines.length;
  // DP table (m+1) x (n+1)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = 1 + dp[i + 1][j + 1];
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Reconstruct matches
  let i = 0, j = 0;
  const mergedLines: { type: 'same' | 'del' | 'add'; text: string }[] = [];
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      mergedLines.push({ type: 'same', text: newLines[j] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      mergedLines.push({ type: 'del', text: oldLines[i] });
      i++;
    } else {
      mergedLines.push({ type: 'add', text: newLines[j] });
      j++;
    }
  }
  while (i < m) {
    mergedLines.push({ type: 'del', text: oldLines[i++] });
  }
  while (j < n) {
    mergedLines.push({ type: 'add', text: newLines[j++] });
  }

  return mergedLines;
}

// ------------------ Build diff payload ------------------

async function getFullFileDiffPayload(filePath: string, commit: string, repoPath: string) {
  const git = getGitPath();
  const rel = normalizeGitPath(path.relative(repoPath, filePath));

  let oldContent = '';
  let newContent = '';

  if (commit === 'WORKING') {
    // working copy vs HEAD
    try {
      newContent = fs.readFileSync(filePath, 'utf8');
    } catch {
      newContent = '';
    }
    try {
      const { stdout } = await execFileAsync(git, ['show', `HEAD:${rel}`], { cwd: repoPath });
      oldContent = stdout || '';
    } catch {
      oldContent = '';
    }
  } else {
    // committed file: parent vs commit
    try {
      const { stdout } = await execFileAsync(git, ['show', `${commit}^:${rel}`], { cwd: repoPath });
      oldContent = stdout || '';
    } catch {
      oldContent = '';
    }
    try {
      const { stdout } = await execFileAsync(git, ['show', `${commit}:${rel}`], { cwd: repoPath });
      newContent = stdout || '';
    } catch {
      newContent = '';
    }
  }

  // Build merged lines with LCS
  const merged = buildMergedLines(oldContent, newContent);

  // Build combined plain-text (for highlighting) and types array
  const linesText = merged.map(l => l.text);
  const types = merged.map(l => l.type); // 'same' | 'del' | 'add'

  const combinedText = linesText.join('\n');

  return { text: combinedText, types };
}

// ------------------ Webview HTML ------------------

function getFileHistoryHtml(filename: string, commits: any[], languageClass: string) {
  const escName = escapeHtml(filename);
  const commitJson = JSON.stringify(commits);
  // languageClass is e.g. 'cpp' or 'javascript'
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css">
<style>
:root {
  --bg: #1e1e1e;
  --left-bg: #151515;
  --border: #333;
  --text: #dddddd;
}
html,body { margin:0; padding:0; height:100%; background:var(--bg); color:var(--text); font-family: var(--vscode-font-family); }
.container { display:flex; height:100vh; }
.left { width:320px; background:var(--left-bg); border-right:1px solid var(--border); overflow:auto; }
.right { flex:1; overflow:auto; padding:0; }
.header { padding:8px; font-weight:bold; }
.commit { padding:8px; border-bottom:1px solid rgba(255,255,255,0.04); cursor:pointer; }
.commit:hover { background: rgba(255,255,255,0.02); }
.commit.selected { background: #094771; }
.hash { color:#5fb3ff; font-family: monospace; cursor:pointer; }
.date { color:#9fb3c8; margin-left:8px; }
.msg { display:block; color:#ddd; margin-top:6px; max-height:3.6em; overflow:hidden; text-overflow:ellipsis; }
#diff { padding:12px 16px; }
.line { display:block; width:100%; box-sizing:border-box; white-space:pre; font-family: monospace; font-size:13px; line-height:1.4; }
.add { background-color: rgba(64, 160, 64, 0.10); }
.del { background-color: rgba(160, 64, 64, 0.11); }
</style>
</head>
<body>
<div class="container">
  <div class="left">
    <div class="header">${escName}</div>
    <div id="commits">${commitJson.split(',').length ? '' : ''}</div>
  </div>
  <div class="right">
    <div id="diff"><em style="padding:12px;display:block;color:#999;">Loading…</em></div>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
const vscode = acquireVsCodeApi();
const commits = ${commitJson};

const commitsContainer = document.getElementById('commits');
commits.forEach(c => {
  const el = document.createElement('div');
  el.className = 'commit';
  el.dataset.hash = c.hash;
  el.innerHTML = '<span class="hash">'+c.hash.substring(0,7)+'</span><span class="date">'+(c.date||'')+'</span>'
               +'<div class="msg">'+escapeHtml(c.message||'')+'</div>';
  el.addEventListener('click', () => {
    document.querySelectorAll('.commit').forEach(x=>x.classList.remove('selected'));
    el.classList.add('selected');
    vscode.postMessage({ command: 'showDiff', commit: c.hash });
  });
  el.querySelector('.hash').addEventListener('click', (ev) => {
    ev.stopPropagation();
    vscode.postMessage({ command: 'openCommitFiles', hash: c.hash });
  });
  commitsContainer.appendChild(el);
});

// helper to render combined highlighted HTML + per-line wrappers
function renderCombinedHighlighted(combinedText, types, lang) {
  // create a temporary code element and let highlight.js do syntax coloring
  const tempPre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'hljs ' + (lang || '');
  // set textContent so highlight.js parses text (not HTML)
  code.textContent = combinedText;
  tempPre.appendChild(code);

  // run highlight
  try {
    hljs.highlightElement(code);
  } catch (e) {
    try { hljs.highlightAll(); } catch {}
  }

  // code.innerHTML contains highlighted markup. Split by newline and wrap
  const highlightedLines = code.innerHTML.split('\\n');

  // build final DOM
  const frag = document.createDocumentFragment();
  for (let i = 0; i < Math.max(highlightedLines.length, types.length); i++) {
    const lineHtml = highlightedLines[i] ?? '';
    const type = types[i] ?? 'same';
    const wrapper = document.createElement('div');
    wrapper.className = 'line' + (type === 'add' ? ' add' : type === 'del' ? ' del' : '');
    // if empty line, ensure there is visible placeholder to preserve height
    wrapper.innerHTML = lineHtml.length ? lineHtml : '&nbsp;';
    frag.appendChild(wrapper);
  }
  return frag;
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'updateDiff') {
    // msg.text = combined plain text; msg.types = array of 'same'|'add'|'del'; msg.language = 'cpp' etc
    const diffEl = document.getElementById('diff');
    diffEl.innerHTML = '';
    const frag = renderCombinedHighlighted(msg.text, msg.types, msg.language);
    diffEl.appendChild(frag);
    // scroll to top
    diffEl.scrollTop = 0;
  }
});

// send initial selection (WORKING)
vscode.postMessage({ command: 'showDiff', commit: 'WORKING' });

function escapeHtml(s) {
  return (s+'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
</script>
</body>
</html>
`;
}

// ------------------ Main flow ------------------

async function openFileHistory(context: vscode.ExtensionContext, filePath: string) {
  const repoPath = await findGitRepoRoot(filePath);
  if (!repoPath) {
    vscode.window.showErrorMessage('Could not find git repository root for file.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'fastGitFileHistory',
    `Git History — ${path.basename(filePath)}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const commits = await getFileCommits(filePath, repoPath);
  const languageClass = getHighlightJsLanguageClass(filePath);

  panel.webview.html = getFileHistoryHtml(filePath, commits, languageClass);

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg.command === 'showDiff') {
        const payload = await getFullFileDiffPayload(filePath, msg.commit, repoPath);
        panel.webview.postMessage({ command: 'updateDiff', text: payload.text, types: payload.types, language: languageClass });
      } else if (msg.command === 'openCommitFiles' || msg.command === 'openCommitFiles2') {
        // show commit files panel
        const commitHash = msg.hash ?? msg.commit;
        const files = await getCommitFiles(commitHash, repoPath);
        const filesPanel = vscode.window.createWebviewPanel(
          'fastGitCommitFiles',
          `Commit ${commitHash.substring(0,7)} — files`,
          vscode.ViewColumn.One,
          { enableScripts: true }
        );
        filesPanel.webview.html = getCommitFilesHtml(commitHash, files);
        filesPanel.webview.onDidReceiveMessage(inner => {
          if (inner.command === 'openFileHistory') {
            // open history for that file path relative to repo
            const absolute = path.join(repoPath, inner.file);
            openFileHistory(context, absolute);
          }
        });
      }
    } catch (e: any) {
      vscode.window.showErrorMessage('FastGitFileHistory error: ' + (e?.message ?? String(e)));
      console.error(e);
    }
  });
}

function getCommitFilesHtml(commitHash: string, files: string[]) {
  const items = files.map(f => `<div class="file" data-path="${escapeHtml(f)}">${escapeHtml(f)}</div>`).join('');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
body { background:#1e1e1e; color:#ddd; font-family: var(--vscode-font-family); padding:12px; }
.file { padding:6px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.03); }
.file:hover { background: rgba(255,255,255,0.02); }
</style>
</head>
<body>
<h3>Commit ${escapeHtml(commitHash.substring(0,7))}</h3>
${items}
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('.file').forEach(f => f.addEventListener('click', () => {
  vscode.postMessage({ command: 'openFileHistory', file: f.dataset.path });
}));
</script>
</body>
</html>`;
}

// ------------------ Lighter utilities ------------------

function escapeHtml(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/[&<>"]/g, (c: string): string => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return c;
    }
  });
}

function getHighlightJsLanguageClass(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string,string> = {
    '.c':'cpp','.h':'cpp','.cpp':'cpp','.hpp':'cpp','.cc':'cpp','.hh':'cpp',
    '.js':'javascript','.ts':'typescript','.json':'json','.py':'python','.java':'java',
    '.cs':'cs','.go':'go','.rb':'ruby','.rs':'rust','.php':'php','.html':'xml','.css':'css'
  };
  return map[ext] || '';
}
