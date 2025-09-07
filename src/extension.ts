// src/extension.ts
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = util.promisify(execFile);
let navigationHistory: (() => void)[] = [];

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('fastGitFileHistory.view', async (uri?: vscode.Uri) => {
    const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!fileUri) {
      vscode.window.showErrorMessage('No file selected.');
      return;
    }
    await openFileHistory(context, fileUri.fsPath);
  }));

  // optional back command if you used it earlier
  context.subscriptions.push(vscode.commands.registerCommand('fastGitFileHistory.back', () => {
    const last = navigationHistory.pop();
    if (last) last();
  }));

  // command used to open commit files view (from webview)
  context.subscriptions.push(vscode.commands.registerCommand('fastGitFileHistory.openCommitFiles', async (commitHash: string, repoPath: string, context?: vscode.ExtensionContext) => {
    const files = await getCommitFiles(commitHash, repoPath);
    const panel = vscode.window.createWebviewPanel(
      'fastGitFileHistoryCommitFiles',
      `Commit ${commitHash.substring(0,7)}`,
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

export function deactivate() {}

// ---------- Utilities ----------
function escapeHtml(s?: string): string {
  if (!s) return '';
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c] || c));
}

function normalizeGitPath(p: string) {
  return p.replace(/\\/g, '/');
}

function getGitPath(): string {
  const cfg = vscode.workspace.getConfiguration('fastGitFileHistory');
  return cfg.get<string>('gitPath') || 'git';
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

// ---------- Git helpers ----------
async function getFileCommits(filePath: string, repoPath: string) {
  const git = getGitPath();
  try {
    const rel = normalizeGitPath(path.relative(repoPath, filePath));
    const { stdout } = await execFileAsync(git, ['log', '--pretty=format:%H|%ad|%s', '--date=short', '--', rel], { cwd: repoPath });
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
  const git = getGitPath();
  try {
    const { stdout } = await execFileAsync(git, ['diff-tree', '--no-commit-id', '--name-only', '-r', commitHash], { cwd: repoPath });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- LCS line-merge ----------
function buildMergedLines(oldText: string, newText: string) {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = 1 + dp[i + 1][j + 1];
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  const merged: { type: 'same'|'del'|'add', text: string }[] = [];
  while (i < m && j < n) {
    if (a[i] === b[j]) { merged.push({ type: 'same', text: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { merged.push({ type: 'del', text: a[i] }); i++; }
    else { merged.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < m) { merged.push({ type: 'del', text: a[i++] }); }
  while (j < n) { merged.push({ type: 'add', text: b[j++] }); }
  return merged;
}

// ---------- Build payload for webview ----------
async function getFullFileDiffPayload(filePath: string, commit: string, repoPath: string) {
  const git = getGitPath();
  const rel = normalizeGitPath(path.relative(repoPath, filePath));
  let oldContent = '';
  let newContent = '';
  if (commit === 'WORKING') {
    try { newContent = fs.readFileSync(filePath, 'utf8'); } catch { newContent = ''; }
    try { const { stdout } = await execFileAsync(git, ['show', `HEAD:${rel}`], { cwd: repoPath }); oldContent = stdout || ''; } catch { oldContent = ''; }
  } else {
    try { const { stdout } = await execFileAsync(git, ['show', `${commit}^:${rel}`], { cwd: repoPath }); oldContent = stdout || ''; } catch { oldContent = ''; }
    try { const { stdout } = await execFileAsync(git, ['show', `${commit}:${rel}`], { cwd: repoPath }); newContent = stdout || ''; } catch { newContent = ''; }
  }
  const merged = buildMergedLines(oldContent, newContent);
  const types = merged.map(m => m.type === 'same' ? 'same' : m.type);
  const text = merged.map(m => m.text).join('\n');
  return { text, types };
}

// ---------- Webview HTML (client-side rendering fixes for block comments) ----------
function getFileHistoryHtml(filePath: string, commits: any[], languageClass: string) {
  const commitJson = JSON.stringify(commits);
  const escPath = escapeHtml(filePath);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css">
<style>
:root { --bg:#1e1e1e; --left:#151515; --border:#333; --text:#ddd; }
html,body{height:100%;margin:0;background:var(--bg);color:var(--text);font-family:var(--vscode-font-family);}
.container{display:flex;height:100vh;}
.left{width:320px;background:var(--left);border-right:1px solid var(--border);overflow:auto;}
.right{flex:1;overflow:auto;}
.commit{padding:10px;border-bottom:1px solid rgba(255,255,255,0.03);cursor:pointer;box-sizing:border-box;}
.commit:hover{background:rgba(255,255,255,0.02);}
.commit.selected{background:#094771;}
.hash{color:#61aeee;font-family:monospace;cursor:pointer;}
.date{color:#9fb3c8;margin-left:8px;}
.msg{color:#ddd;margin-top:6px;line-height:1.25em; max-height:calc(1.25em * 3); overflow:hidden; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; box-sizing:border-box;}
#diff{padding:12px 16px;}
.line{display:block;width:100%;box-sizing:border-box;white-space:pre;font-family:var(--vscode-editor-font-family, monospace);font-size:13px;line-height:1.45;}
.add{background-color: rgba(64,160,64,0.10);}
.del{background-color: rgba(160,64,64,0.11);}
</style>
</head>
<body>
<div class="container">
  <div class="left" id="leftPane"></div>
  <div class="right"><div id="diff"><em style="padding:12px;display:block;color:#999;">Loading…</em></div></div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
const vscode = acquireVsCodeApi();
const commits = ${commitJson};
const left = document.getElementById('leftPane');

// populate commits (left pane)
commits.forEach(c => {
  const el = document.createElement('div');
  el.className = 'commit';
  el.dataset.hash = c.hash;
  el.innerHTML = '<div><span class="hash">'+escapeHtml(c.hash.substring(0,7))+'</span><span class="date">'+(c.date||'')+'</span></div>'
               + '<div class="msg">'+escapeHtml(c.message||'')+'</div>';
  el.addEventListener('click', () => {
    document.querySelectorAll('.commit').forEach(x=>x.classList.remove('selected'));
    el.classList.add('selected');
    vscode.postMessage({ command: 'showDiff', commit: c.hash });
  });
  el.querySelector('.hash').addEventListener('click', (ev) => {
    ev.stopPropagation();
    vscode.postMessage({ command: 'openCommitFiles', hash: c.hash });
  });
  left.appendChild(el);
});

// ---- convert highlighted DOM into per-line HTML preserving nested tags ----
function nodeToLines(node) {
  // returns array of strings representing the node's content split into lines,
  // with internal markup retained but without outer wrappers.
  if (node.nodeType === Node.TEXT_NODE) {
    const txt = node.nodeValue || '';
    // split text node by newline
    return txt.split('\\n');
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    // build opening tag with attributes
    let open = '<' + tag;
    for (let a = 0; a < node.attributes.length; a++) {
      const at = node.attributes[a];
      open += ' ' + at.name + '="' + escapeAttr(at.value) + '"';
    }
    open += '>';
    const close = '</' + tag + '>';

    // combine children lines
    let lines = [''];
    for (let c = 0; c < node.childNodes.length; c++) {
      const child = node.childNodes[c];
      const childLines = nodeToLines(child);
      // append first child line to last line
      lines[lines.length - 1] += (childLines[0] ?? '');
      // push remaining child lines
      for (let k = 1; k < childLines.length; k++) {
        lines.push(childLines[k]);
      }
    }
    // wrap each produced line with the element's tag
    for (let i = 0; i < lines.length; i++) {
      lines[i] = open + (lines[i].length ? lines[i] : '') + close;
    }
    return lines;
  } else {
    return [''];
  }
}

function escapeAttr(s) {
  return (s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// render combined highlighted html per-line and apply diff classes
function renderCombinedHighlighted(combinedText, types, lang) {
  // create a temporary code element to get highlighted HTML for the whole file
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'hljs ' + (lang || '');
  code.textContent = combinedText; // set textContent so highlight.js parses raw text
  pre.appendChild(code);

  try { hljs.highlightElement(code); } catch (e) { try { hljs.highlightAll(); } catch(e2) {} }

  // parse highlighted DOM (code.innerHTML) into DOM nodes and then convert into per-line safe HTML
  const container = document.createElement('div');
  container.innerHTML = code.innerHTML;

  // accumulate lines by walking children
  let resultLines = [''];
  for (let n = 0; n < container.childNodes.length; n++) {
    const node = container.childNodes[n];
    const nodeLines = nodeToLines(node);
    // append nodeLines into resultLines sequentially
    resultLines[resultLines.length - 1] += (nodeLines[0] ?? '');
    for (let li = 1; li < nodeLines.length; li++) {
      resultLines.push(nodeLines[li]);
    }
  }

  // trim possible last empty trailing line that came from final newline
  if (resultLines.length > 1 && resultLines[resultLines.length - 1] === '') resultLines.pop();

  // build fragment
  const frag = document.createDocumentFragment();
  const containerOut = document.createElement('div');
  for (let i = 0; i < Math.max(resultLines.length, types.length); i++) {
    const wrapper = document.createElement('div');
    const t = types[i] || 'same';
    wrapper.className = 'line' + (t === 'add' ? ' add' : t === 'del' ? ' del' : '');
    wrapper.innerHTML = (resultLines[i] && resultLines[i].length) ? resultLines[i] : '&nbsp;';
    containerOut.appendChild(wrapper);
  }
  return containerOut;
}

// receive messages from extension
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'updateDiff') {
    const diffEl = document.getElementById('diff');
    diffEl.innerHTML = '';
    const frag = renderCombinedHighlighted(msg.text, msg.types || [], msg.language);
    diffEl.appendChild(frag);
    diffEl.scrollTop = 0;
  }
});

// request initial view (WORKING)
vscode.postMessage({ command: 'showDiff', commit: 'WORKING' });

function escapeHtml(s){ return (s??'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
</script>
</body>
</html>`;
}

// ---------- Main flow: open panel, wire messages ----------
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
      } else if (msg.command === 'openCommitFiles') {
        const commitHash = msg.hash || msg.commit;
        const files = await getCommitFiles(commitHash, repoPath);
        const filesPanel = vscode.window.createWebviewPanel(
          'fastGitCommitFiles',
          `Commit ${commitHash.substring(0,7)} — files`,
          vscode.ViewColumn.One,
          { enableScripts: true }
        );
        filesPanel.webview.html = getCommitFilesHtml(files, commitHash);
        filesPanel.webview.onDidReceiveMessage(inner => {
          if (inner.command === 'openFileHistory') {
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

function getCommitFilesHtml(files: string[], commitHash: string) {
  const items = files.map(f => `<div class="file" data-path="${escapeHtml(f)}">${escapeHtml(f)}</div>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{background:#1e1e1e;color:#ddd;font-family:var(--vscode-font-family);padding:12px;}
.file{padding:6px;border-bottom:1px solid rgba(255,255,255,0.03);cursor:pointer;}
.file:hover{background:rgba(255,255,255,0.02);}
</style></head><body>
<h3>Commit ${escapeHtml(commitHash.substring(0,7))}</h3>
${items}
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('.file').forEach(f=>f.addEventListener('click',()=> {
  vscode.postMessage({ command: 'openFileHistory', file: f.dataset.path });
}));
</script>
</body></html>`;
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
