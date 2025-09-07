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

// ---------- Utilities ----------

function escapeHtml(input?: string): string {
  if (!input) return '';
  return input.replace(/[&<>"]/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function getGitPath(): string {
  const cfg = vscode.workspace.getConfiguration('fastGitFileHistory');
  return cfg.get<string>('gitPath') || 'git';
}

function normalizeGitPath(p: string) {
  return p.replace(/\\/g, '/');
}

async function findGitRepoRoot(filePath: string): Promise<string | null> {
  let dir = path.dirname(filePath);
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// ---------- Git operations ----------

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

// ---------- LCS-based merge for line alignment ----------

function buildMergedLines(oldText: string, newText: string) {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = 1 + dp[i + 1][j + 1];
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  const merged: { type: 'same' | 'del' | 'add'; text: string }[] = [];
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      merged.push({ type: 'same', text: newLines[j] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      merged.push({ type: 'del', text: oldLines[i] });
      i++;
    } else {
      merged.push({ type: 'add', text: newLines[j] });
      j++;
    }
  }
  while (i < m) {
    merged.push({ type: 'del', text: oldLines[i++] });
  }
  while (j < n) {
    merged.push({ type: 'add', text: newLines[j++] });
  }
  return merged;
}

// ---------- Build payload for webview: combined text + types ----------

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
  const types = merged.map(m => m.type);
  const text = merged.map(m => m.text).join('\n');
  return { text, types };
}

// ---------- Webview HTML ----------

function getFileHistoryHtml(filePath: string, commits: any[], languageClass: string) {
  const commitsJson = JSON.stringify(commits);
  const escFile = escapeHtml(filePath);
  // Left header removed per request; commits list will be stacked without the top file name
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
const commits = ${commitsJson};
const left = document.getElementById('leftPane');

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

// Convert highlighted HTML (which may contain tags spanning multiple lines) into line-safe pieces
function splitHighlightedHtmlToLines(highlightedHtml) {
  // Put highlighted HTML into a container and walk nodes to distribute into lines,
  // ensuring tags are properly opened/closed on each produced line.
  const container = document.createElement('div');
  container.innerHTML = highlightedHtml;

  const lines = [''];

  function appendToLine(idx, str) {
    while (lines.length <= idx) lines.push('');
    lines[idx] += str;
  }

  function walk(node, lineIndex) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = node.nodeValue.split('\\n');
      for (let i = 0; i < parts.length; i++) {
        appendToLine(lineIndex, escapeHtmlTextNode(parts[i]));
        if (i < parts.length - 1) {
          lineIndex++;
        }
      }
      return lineIndex;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      // build opening with attributes
      let open = '<' + tag;
      for (let a=0;a<node.attributes.length;a++){
        const at = node.attributes[a];
        open += ' ' + at.name + '="' + escapeAttr(at.value) + '"';
      }
      open += '>';
      const close = '</' + tag + '>';

      const startIndex = lineIndex;
      // add opening to startIndex
      appendToLine(lineIndex, open);

      // process children
      for (let c = 0; c < node.childNodes.length; c++) {
        lineIndex = walk(node.childNodes[c], lineIndex);
      }

      // ensure close tag appended to every line that had something inside this element
      for (let idx = startIndex; idx <= lineIndex; idx++) {
        appendToLine(idx, close);
      }
      return lineIndex;
    } else {
      return lineIndex;
    }
  }

  // helper to escape any stray '<' '>' in text nodes (should not usually be needed)
  function escapeHtmlTextNode(s) {
    return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  }
  function escapeAttr(s) {
    return s.replace(/"/g, '&quot;').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  for (let n = 0; n < container.childNodes.length; n++) {
    walk(container.childNodes[n], 0);
  }

  // trim trailing empty line if the last line is empty due to final newline handling
  if (lines.length > 1 && lines[lines.length-1] === '') lines.pop();
  return lines;
}

// Build final DOM fragment from highlighted combined text and types
function renderCombinedHighlighted(combinedText, types, lang) {
  // highlight the combined text using highlight.js
  const tempPre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'hljs ' + (lang || '');
  code.textContent = combinedText;
  tempPre.appendChild(code);

  try { hljs.highlightElement(code); } catch(e) { try { hljs.highlightAll(); } catch(e2) {} }

  // Now code.innerHTML contains highlighted HTML; split into per-line safe HTML
  const highlightedHtml = code.innerHTML;
  const hlLines = splitHighlightedHtmlToLines(highlightedHtml);

  // build fragment with per-line wrappers, applying add/del classes (types array aligns with lines)
  const frag = document.createDocumentFragment();
  const lineCount = Math.max(hlLines.length, types.length);
  for (let i = 0; i < lineCount; i++) {
    const wrapper = document.createElement('div');
    const t = types[i] || 'same';
    wrapper.className = 'line' + (t === 'add' ? ' add' : t === 'del' ? ' del' : '');
    wrapper.innerHTML = (hlLines[i] && hlLines[i].length) ? hlLines[i] : '&nbsp;';
    frag.appendChild(wrapper);
  }
  return frag;
}

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

// request initial working diff
vscode.postMessage({ command: 'showDiff', commit: 'WORKING' });

function escapeHtml(s) {
  return (s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
</script>
</body>
</html>
`;
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
        filesPanel.webview.html = getCommitFilesHtml(commitHash, files);
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

function getCommitFilesHtml(commitHash: string, files: string[]) {
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

// ---------- small utility ----------

function getHighlightJsLanguageClass(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string,string> = {
    '.c':'cpp','.h':'cpp','.cpp':'cpp','.hpp':'cpp','.cc':'cpp','.hh':'cpp',
    '.js':'javascript','.ts':'typescript','.json':'json','.py':'python','.java':'java',
    '.cs':'cs','.go':'go','.rb':'ruby','.rs':'rust','.php':'php','.html':'xml','.css':'css'
  };
  return map[ext] || '';
}
