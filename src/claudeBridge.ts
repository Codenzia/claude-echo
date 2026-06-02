import { spawn } from 'child_process';
import { logError, logInfo } from './logger';

export interface RunOptions {
  cliPath: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
}

export interface RunResult {
  ok: boolean;
  text: string;
  error?: string;
  durationMs: number;
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
}

export async function runClaudeCli(opts: RunOptions): Promise<RunResult> {
  const args = [
    '--print',
    '--resume', opts.sessionId,
    '--output-format', 'json',
    opts.prompt
  ];
  const startedAt = Date.now();
  return new Promise<RunResult>((resolve) => {
    logInfo(`Spawning: ${opts.cliPath} --print --resume ${opts.sessionId} --output-format json "${opts.prompt.slice(0, 60)}${opts.prompt.length > 60 ? '…' : ''}"`);
    const child = spawn(opts.cliPath, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) { return; }
      settled = true;
      resolve(r);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({
        ok: false,
        text: '',
        error: `Claude CLI timed out after ${opts.timeoutMs}ms`,
        durationMs: Date.now() - startedAt
      });
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(timer);
      logError('Claude CLI spawn error', err);
      finish({
        ok: false,
        text: '',
        error: `Could not spawn Claude CLI at "${opts.cliPath}": ${err.message}`,
        durationMs: Date.now() - startedAt
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        const tail = stderr.trim().split(/\r?\n/).slice(-3).join('\n');
        finish({
          ok: false,
          text: '',
          error: `Claude CLI exited with code ${code}${tail ? `: ${tail}` : ''}`,
          durationMs
        });
        return;
      }
      try {
        const parsed: ClaudeJsonResult = JSON.parse(stdout);
        if (parsed.is_error) {
          finish({
            ok: false,
            text: '',
            error: `Claude returned an error: ${parsed.result ?? '(no detail)'}`,
            durationMs
          });
          return;
        }
        const text = (parsed.result ?? '').toString();
        finish({ ok: true, text, durationMs });
      } catch (err) {
        finish({
          ok: false,
          text: '',
          error: `Could not parse Claude CLI JSON output: ${err instanceof Error ? err.message : String(err)}`,
          durationMs
        });
      }
    });
  });
}
