import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RunningSession {
  sessionId: string;
  pid: number;
  startedAt: number;
  cwd: string;
}

export interface SessionInfo {
  sessionId: string;
  title: string;
  startedAt: number;
  cwd: string;
}

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

export function projectKeyFor(workspaceDir: string): string {
  return workspaceDir.replace(/[:\\/]/g, '-');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err && err.code === 'EPERM';
  }
}

function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).toLowerCase();
  return norm(a) === norm(b);
}

export function findRunningSessions(workspaceDir: string): RunningSession[] {
  if (!fs.existsSync(SESSIONS_DIR)) { return []; }
  const out: RunningSession[] = [];
  for (const name of fs.readdirSync(SESSIONS_DIR)) {
    if (!name.endsWith('.json')) { continue; }
    const full = path.join(SESSIONS_DIR, name);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const j = JSON.parse(raw);
      if (!j.cwd || !j.sessionId || j.pid === undefined) { continue; }
      if (!pathsEqual(j.cwd, workspaceDir)) { continue; }
      if (!isPidAlive(Number(j.pid))) { continue; }
      out.push({
        sessionId: String(j.sessionId),
        pid: Number(j.pid),
        startedAt: Number(j.startedAt ?? 0),
        cwd: String(j.cwd)
      });
    } catch { /* skip malformed */ }
  }
  return out;
}

function firstUserText(transcriptPath: string, maxBytes = 1024 * 1024): string {
  if (!fs.existsSync(transcriptPath)) { return ''; }
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const stat = fs.fstatSync(fd);
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || !line.includes('"type":"user"')) { continue; }
      try {
        const rec = JSON.parse(line);
        if (rec.type !== 'user' || !rec.message || rec.isSidechain) { continue; }
        const content = rec.message.content;
        if (typeof content === 'string') { return content; }
        if (Array.isArray(content)) {
          for (const blk of content) {
            if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.trim()) {
              return blk.text;
            }
          }
        }
      } catch { /* skip malformed */ }
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function formatTitle(raw: string, fallbackTimestamp: number): string {
  const trimmed = (raw || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    const when = fallbackTimestamp ? new Date(fallbackTimestamp).toISOString().slice(0, 16).replace('T', ' ') : '?';
    return `(no text — image/binary first message, ${when})`;
  }
  return trimmed.length > 100 ? trimmed.slice(0, 97) + '…' : trimmed;
}

export function listSessionsForWorkspace(workspaceDir: string): SessionInfo[] {
  // Source of truth: every .jsonl transcript stored by Claude Code for this
  // workspace's project key. This catches all historical conversations, not
  // just the ones whose process happens to be running right now.
  const projectKey = projectKeyFor(workspaceDir);
  const projectDir = path.join(PROJECTS_ROOT, projectKey);
  if (!fs.existsSync(projectDir)) { return []; }

  const out: SessionInfo[] = [];
  for (const name of fs.readdirSync(projectDir)) {
    if (!name.endsWith('.jsonl')) { continue; }
    const sessionId = name.slice(0, -'.jsonl'.length);
    const tx = path.join(projectDir, name);
    let mtime = 0;
    try {
      mtime = fs.statSync(tx).mtimeMs;
    } catch { continue; }
    const raw = firstUserText(tx);
    if (!raw) { continue; }
    out.push({
      sessionId,
      title: formatTitle(raw, mtime),
      startedAt: mtime,
      cwd: workspaceDir
    });
  }
  // Most recently active first.
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

export function transcriptPath(workspaceDir: string, sessionId: string): string {
  return path.join(PROJECTS_ROOT, projectKeyFor(workspaceDir), `${sessionId}.jsonl`);
}
