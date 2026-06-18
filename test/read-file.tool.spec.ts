import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadFileTool } from '../src/tools/tools/read-file.tool';

/**
 * Tool sandboxing (Phase 4). `read_file` is jailed to the workspace root and must
 * defend against the three documented escape classes — symlink-out, absolute/`..`
 * traversal, and non-regular files — while still serving legitimate in-root reads.
 * Mirrors the structured `Refused:` / content contract the registry feeds back to
 * the agent loop.
 */
describe('ReadFileTool — workspace-root sandboxing', () => {
  let root: string; // the jailed workspace root
  let outside: string; // a sibling dir OUTSIDE the root
  let tool: ReadFileTool;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'agentrie-tool-'));
    root = join(base, 'workspace');
    outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    tool = new ReadFileTool(root);
  });

  afterEach(async () => {
    // base is the parent of both root and outside.
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('reads a legitimate in-root regular file', async () => {
    await writeFile(join(root, 'hello.txt'), 'in-root content', 'utf8');

    const result = await tool.execute({ path: 'hello.txt' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('in-root content');
  });

  it('refuses a `..` traversal escape', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');

    const result = await tool.execute({ path: '../outside/secret.txt' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('resolves outside the workspace root');
    expect(result.content).not.toContain('top secret');
  });

  it('refuses an absolute-path escape', async () => {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'top secret', 'utf8');

    const result = await tool.execute({ path: secret });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('resolves outside the workspace root');
    expect(result.content).not.toContain('top secret');
  });

  it('refuses a symlink that points outside the root', async () => {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'top secret', 'utf8');
    // A link living INSIDE the root that resolves OUTSIDE it — the symlink-escape
    // a bare string check cannot catch.
    await symlink(secret, join(root, 'link.txt'));

    const result = await tool.execute({ path: 'link.txt' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('resolves outside the workspace root');
    expect(result.content).not.toContain('top secret');
  });

  it('refuses a non-regular file (directory)', async () => {
    await mkdir(join(root, 'subdir'));

    const result = await tool.execute({ path: 'subdir' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('only regular files may be read');
    expect(result.content).toContain('directory');
  });

  it('still serves a symlink that resolves to an in-root file (no over-rejection)', async () => {
    await writeFile(join(root, 'real.txt'), 'legit in-root', 'utf8');
    await symlink(join(root, 'real.txt'), join(root, 'alias.txt'));

    const result = await tool.execute({ path: 'alias.txt' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('legit in-root');
  });
});
