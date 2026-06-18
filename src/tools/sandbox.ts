import { spawn } from 'node:child_process';
import { isWithinRoot } from './path-jail';

/**
 * Process jail for shell/fs tools — the in-process half of Phase 4 tool sandboxing.
 *
 * What this DOES enforce, portably, in pure Node:
 *  - NO SHELL: `spawn(cmd, args, { shell: false })` — args are passed as a vector,
 *    never concatenated into a shell string, so `;`, `$(...)`, backticks, globs etc.
 *    in arguments are inert. The single largest tool-exec footgun, removed.
 *  - ENV SCRUB: the child sees only an explicit allowlist (default: PATH/HOME/LANG)
 *    plus caller-supplied vars — never the parent's full `process.env` (no API keys,
 *    AWS creds, etc. leaking into a subprocess).
 *  - CWD JAIL: the working directory must resolve within the workspace root.
 *  - WALL-CLOCK TIMEOUT: a hung child is SIGKILL'd after `timeoutMs`.
 *  - OUTPUT CAP: captured stdout+stderr is bounded; once exceeded the child is
 *    killed and the result flagged `truncated` (no unbounded memory from a chatty
 *    or adversarial child).
 *  - PRIVILEGE DROP: optional uid/gid, applied by the OS only when the parent is
 *    privileged enough to set them.
 *
 * What this does NOT do (the documented residual — needs the OS, not Node): syscall
 * filtering (seccomp), and filesystem/PID/network isolation (mount/pid/net
 * namespaces). Those are deploy-time: run this process under a container or seccomp
 * profile. This primitive is the application-layer jail those build on; see the note
 * in path-jail.ts.
 */
export interface SandboxOptions {
  /** Working directory for the child; MUST resolve within `workspaceRoot`. */
  cwd: string;
  /** The jail root the cwd is confined to. */
  workspaceRoot: string;
  /** Hard wall-clock limit; the child is SIGKILL'd past it. */
  timeoutMs: number;
  /** Max captured bytes across stdout+stderr before the child is killed. */
  maxOutputBytes: number;
  /**
   * Extra environment for the child, merged over the minimal allowlist. The parent's
   * full env is never inherited.
   */
  env?: Record<string, string>;
  /** Drop to this uid/gid (effective only when the parent may set them). */
  uid?: number;
  gid?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null if the child was killed by a signal. */
  code: number | null;
  /** Signal that killed the child, if any. */
  signal: NodeJS.Signals | null;
  /** The child exceeded `timeoutMs` and was killed. */
  timedOut: boolean;
  /** Output hit `maxOutputBytes`; stdout/stderr are truncated and the child killed. */
  truncated: boolean;
}

export type SandboxFailure =
  | { kind: 'escape' } // cwd resolves outside the workspace root
  | { kind: 'spawn'; message: string }; // command not found / not executable

export type SandboxOutcome =
  | { ok: true; result: SandboxResult }
  | { ok: false; failure: SandboxFailure };

/** Minimal env every child gets, before the caller's allowlist is merged on top. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'TZ']) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

/**
 * Run `command args[]` under the jail. Resolves with a structured outcome rather
 * than throwing: an out-of-jail cwd or a missing binary is a `failure`, a process
 * that ran (even non-zero / killed) is a `result`.
 */
export function runSandboxed(
  command: string,
  args: string[],
  opts: SandboxOptions,
): Promise<SandboxOutcome> {
  // CWD jail — refuse before spawning anything.
  if (!isWithinRoot(opts.workspaceRoot, opts.cwd)) {
    return Promise.resolve({ ok: false, failure: { kind: 'escape' } });
  }

  return new Promise<SandboxOutcome>((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...baseEnv(), ...(opts.env ?? {}) },
      shell: false, // no shell interpretation — args are inert data
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    timer.unref?.();

    const capture = (chunk: Buffer, sink: 'out' | 'err') => {
      bytes += chunk.length;
      if (bytes > opts.maxOutputBytes) {
        if (!truncated) {
          truncated = true;
          child.kill('SIGKILL');
        }
        return; // stop accumulating past the cap
      }
      if (sink === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr.on('data', (c: Buffer) => capture(c, 'err'));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        failure: { kind: 'spawn', message: err.message },
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: true,
        result: { stdout, stderr, code, signal, timedOut, truncated },
      });
    });
  });
}
