import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSandboxed, type SandboxOptions } from '../src/tools/sandbox';

/**
 * Exercises the in-process exec jail. Uses the running Node binary as the child so
 * the tests are deterministic and cross-platform (no reliance on /bin/sh & co).
 */
describe('runSandboxed — process jail', () => {
  let root: string;
  const NODE = process.execPath;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sandbox-'));
  });

  function opts(over: Partial<SandboxOptions> = {}): SandboxOptions {
    return {
      cwd: root,
      workspaceRoot: root,
      timeoutMs: 5_000,
      maxOutputBytes: 1_000_000,
      ...over,
    };
  }

  it('runs a command and captures stdout + exit code', async () => {
    const out = await runSandboxed(
      NODE,
      ['-e', "process.stdout.write('hello')"],
      opts(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.stdout).toBe('hello');
    expect(out.result.code).toBe(0);
    expect(out.result.timedOut).toBe(false);
    expect(out.result.truncated).toBe(false);
  });

  it('refuses a working directory outside the workspace root', async () => {
    const out = await runSandboxed(NODE, ['-e', ''], {
      ...opts(),
      // Jail to a subdir, then try to run one level up.
      workspaceRoot: join(root, 'sub'),
      cwd: root,
    });
    expect(out).toEqual({ ok: false, failure: { kind: 'escape' } });
  });

  it('does NOT leak the parent environment, but passes the explicit allowlist', async () => {
    process.env.SANDBOX_SECRET = 'leak';
    try {
      const out = await runSandboxed(
        NODE,
        [
          '-e',
          "process.stdout.write((process.env.SANDBOX_SECRET ?? 'none') + ':' + (process.env.FOO ?? ''))",
        ],
        opts({ env: { FOO: 'bar' } }),
      );
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      // Parent secret scrubbed; caller-supplied var present.
      expect(out.result.stdout).toBe('none:bar');
    } finally {
      delete process.env.SANDBOX_SECRET;
    }
  });

  it('treats arguments as inert data (no shell interpretation)', async () => {
    const out = await runSandboxed(
      NODE,
      ['-e', 'process.stdout.write(process.argv[1])', '$(echo pwned)'],
      opts(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The substitution is passed through literally, never executed.
    expect(out.result.stdout).toBe('$(echo pwned)');
  });

  it('kills a child that exceeds the timeout', async () => {
    const out = await runSandboxed(
      NODE,
      ['-e', 'setTimeout(() => {}, 10000)'],
      opts({ timeoutMs: 200 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.timedOut).toBe(true);
    expect(out.result.signal).toBe('SIGKILL');
  });

  it('caps output and kills a chatty child', async () => {
    const out = await runSandboxed(
      NODE,
      ['-e', "process.stdout.write('x'.repeat(100000))"],
      opts({ maxOutputBytes: 100 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.stdout.length).toBeLessThanOrEqual(100);
  });

  it('reports a spawn failure for a missing binary', async () => {
    const out = await runSandboxed(
      'definitely-not-a-real-binary-xyz',
      [],
      opts(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('spawn');
  });
});
