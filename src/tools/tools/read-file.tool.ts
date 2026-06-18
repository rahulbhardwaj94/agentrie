import { z } from 'zod';
import { openWithinRoot, type JailFailure } from '../path-jail';
import type { Tool, ToolResult } from '../tool.interface';

const readFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path to read, relative to the configured workspace root'),
});
type ReadFileInput = z.infer<typeof readFileSchema>;

/**
 * Filesystem read tool with a workspace-root JAIL.
 *
 * Security (real): reads are confined to the configured workspace root by
 * `openWithinRoot`, which defends against `..`/absolute escapes, symlinks that
 * point outside the root, TOCTOU races (it reads from an fd pinned to the inode it
 * validated), and non-regular files (directories, devices, FIFOs, sockets). See
 * `path-jail.ts` for the full ordering and the residual intermediate-symlink race
 * that a real OS sandbox (seccomp/container, Linux `openat2`) must still close.
 *
 * Out of scope (TODO): shell-tool sandboxing and the intermediate-component TOCTOU
 * — both require OS-level isolation rather than tool-body hardening.
 */
export class ReadFileTool implements Tool<ReadFileInput> {
  readonly name = 'read_file';
  readonly description =
    'Read a UTF-8 text file from within the workspace root. Paths outside the root are rejected.';
  readonly inputSchema = readFileSchema;

  constructor(private readonly workspaceRoot: string) {}

  async execute(input: ReadFileInput): Promise<ToolResult> {
    const opened = await openWithinRoot(this.workspaceRoot, input.path);
    if (!opened.ok) {
      return { isError: true, content: this.failureMessage(input.path, opened.failure) };
    }

    try {
      const data = await opened.handle.readFile('utf8');
      return { content: data };
    } catch (err) {
      // Expected failure (e.g. invalid UTF-8, perms) -> structured error into context.
      return {
        isError: true,
        content: `Failed to read '${input.path}': ${(err as Error).message}`,
      };
    } finally {
      await opened.handle.close();
    }
  }

  /** Map a jail failure to the tool's structured, LLM-readable error string. */
  private failureMessage(path: string, failure: JailFailure): string {
    switch (failure.kind) {
      case 'escape':
        // Unchanged wording — preserves the existing workspace-root-escape contract.
        return `Refused: path '${path}' resolves outside the workspace root.`;
      case 'not-regular':
        return `Refused: path '${path}' is a ${failure.type}; only regular files may be read.`;
      case 'io':
        return `Failed to read '${path}': ${failure.message}`;
    }
  }
}
