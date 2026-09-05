import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCanvas, joinSession } from '@github/copilot-sdk/extension';

const execFileAsync = promisify(execFile);
const servers = new Map();
const boards = new Map();
let session;

async function loadIssues() {
    const { stdout } = await execFileAsync('gh', [
        'issue', 'list', '--state', 'open', '--limit', '50',
        '--json', 'number,title,body,url,labels,updatedAt,comments',
    ], { cwd: process.cwd(), windowsHide: true });
    const issues = JSON.parse(stdout);
    return issues.map((issue) => ({
        ...issue,
        labels: issue.labels.map((label) => label.name),
        score: scoreIssue(issue),
    })).sort((a, b) => b.score - a.score);
}

function scoreIssue(issue) {
    const labels = issue.labels.map((label) => label.name.toLowerCase());
    let score = issue.comments * 2;
    if (labels.some((label) => /critical|urgent|blocker|bug/.test(label))) score += 12;
    if (labels.some((label) => /high|priority/.test(label))) score += 8;
    const ageInDays = (Date.now() - Date.parse(issue.updatedAt)) / 86400000;
    return score + Math.max(0, 14 - ageInDays);
}

function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function renderCard(issue, featured) {
    const why = featured
        ? `Ranked in the top three because it has ${issue.comments} comment${issue.comments === 1 ? '' : 's'}, recent activity, and ${issue.labels.length ? `the ${issue.labels.join(', ')} label signal` : 'an active issue signal'}.`
        : '';
    return `<article class="card ${featured ? 'featured' : ''}">
        <div class="card-top"><span class="number">#${issue.number}</span><span class="labels">${issue.labels.map((label) => `<span>${escapeHtml(label)}</span>`).join('')}</span></div>
        <h3>${escapeHtml(issue.title)}</h3><p>${escapeHtml(issue.body || 'No description provided.')}</p>
        ${why ? `<p class="why"><strong>Why now:</strong> ${escapeHtml(why)}</p>` : ''}
        <div class="card-actions"><a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">View issue</a><button data-issue="${issue.number}">Add to current context</button></div>
    </article>`;
}

function renderHtml(issues) {
    const featured = issues.slice(0, 3);
    const remainder = issues.slice(3);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Issue triage board</title>
    <style>
    body{margin:0;padding:24px;background:var(--background-color-default,#fff);color:var(--text-color-default,#1f2328);font-family:var(--font-sans,system-ui,sans-serif);line-height:1.45}h1{margin:0 0 4px;font-size:26px}h2{margin:28px 0 12px;font-size:18px}.muted{color:var(--text-color-muted,#656d76);margin-top:0}.grid{display:grid;gap:12px}.card{border:1px solid var(--border-color-default,#d0d7de);border-radius:10px;padding:16px;background:var(--background-color-default,#fff)}.featured{border-color:var(--true-color-blue,#0969da);box-shadow:0 0 0 1px var(--true-color-blue,#0969da)}.card-top,.card-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.number{font-weight:700}.labels{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}.labels span{border-radius:999px;padding:2px 8px;font-size:11px;background:var(--true-color-blue-muted,#ddf4ff)}h3{margin:12px 0 6px;font-size:16px}p{margin:6px 0 14px;white-space:pre-line}.why{padding:10px;border-left:3px solid var(--true-color-blue,#0969da);background:var(--true-color-blue-muted,#ddf4ff)}a,button{font:inherit}a{color:var(--true-color-blue,#0969da)}button{border:0;border-radius:6px;padding:8px 12px;color:var(--color-white,#fff);background:var(--true-color-blue,#0969da);cursor:pointer}button:disabled{opacity:.65}button:focus-visible{outline:2px solid var(--color-focus-outline,#0969da);outline-offset:2px}.empty{color:var(--text-color-muted,#656d76)}
    </style></head><body><h1>Issue triage board</h1><p class="muted">The three issues most likely to need attention now, followed by the rest of the open queue.</p>
    <h2>Needs attention now</h2><div class="grid">${featured.length ? featured.map((issue) => renderCard(issue, true)).join('') : '<p class="empty">No open issues found.</p>'}</div>
    <h2>Remaining open issues</h2><div class="grid">${remainder.length ? remainder.map((issue) => renderCard(issue, false)).join('') : '<p class="empty">There are no additional open issues.</p>'}</div>
    <script>document.querySelectorAll('button[data-issue]').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;button.textContent='Adding...';const response=await fetch('/context',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:button.dataset.issue})});button.textContent=response.ok?'Added to context':'Could not add';if(!response.ok)button.disabled=false;}));</script></body></html>`;
}

async function startServer(instanceId) {
    const server = createServer((req, res) => {
        const issues = boards.get(instanceId) || [];
        if (req.method === 'POST' && req.url === '/context') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const issue = issues.find((candidate) => String(candidate.number) === JSON.parse(body).number);
                    if (!issue) {
                        res.writeHead(404);
                        res.end('Issue not found');
                        return;
                    }
                    await session.send({ prompt: `Add GitHub issue #${issue.number} to the current working context. Issue: ${issue.title} (${issue.url})` });
                    res.writeHead(204);
                    res.end();
                } catch (error) {
                    await session.log(`Could not add issue to context: ${error.message}`, { level: 'error' });
                    res.writeHead(500);
                    res.end('Could not add issue to context');
                }
            });
            return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderHtml(issues));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return { server, url: `http://127.0.0.1:${address.port}/` };
}

session = await joinSession({
    canvases: [createCanvas({
        id: 'triage-board',
        displayName: 'Issue triage board',
        description: 'Kanban board showing the three most urgent open GitHub issues and the remaining queue.',
        actions: [{
            name: 'refresh_issues',
            description: "Refresh the board from the repository's current open GitHub issues.",
            handler: async (ctx) => {
                const issues = await loadIssues();
                boards.set(ctx.instanceId, issues);
                return { issueCount: issues.length, topIssues: issues.slice(0, 3).map((issue) => issue.number) };
            },
        }],
        open: async (ctx) => {
            boards.set(ctx.instanceId, await loadIssues());
            let entry = servers.get(ctx.instanceId);
            if (!entry) {
                entry = await startServer(ctx.instanceId);
                servers.set(ctx.instanceId, entry);
            }
            return { title: 'Issue triage board', url: entry.url };
        },
        onClose: async (ctx) => {
            boards.delete(ctx.instanceId);
            const entry = servers.get(ctx.instanceId);
            if (entry) {
                servers.delete(ctx.instanceId);
                await new Promise((resolve) => entry.server.close(() => resolve()));
            }
        },
    })],
});
