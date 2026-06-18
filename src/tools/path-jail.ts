import { constants, type Stats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Why a path is refused. Security rejections (`escape`, `not-regular`) are distinct
 * from ordinary IO failures so the tool can keep its `Refused:` vs `Failed to read:`
 * contract — the agent loop reads the difference and self-corrects accordingly.
 */
export type JailFailure =
  | { kind: 'escape' }
  | { kind: 'not-regular'; type: string }
  | { kind: 'io'; message: string };

export type JailResult =
  | { ok: true; handle: FileHandle; realPath: string }
  | { ok: false; failure: JailFailure };

function describeType(s: Stats): string {
  if (s.isDirectory()) return 'directory';
  if (s.isFIFO()) return 'FIFO';
  if (s.isSocket()) return 'socket';
  if (s.isBlockDevice()) return 'block device';
  if (s.isCharacterDevice()) return 'character device';
  if (s.isSymbolicLink()) return 'symlink';
  return 'non-regular file';
}

function escapesRoot(realRoot: string, candidate: string): boolean {
  const rel = relative(realRoot, candidate);
  // A `..` prefix (or an absolute remainder, e.g. a different Windows drive) means
  // `candidate` is not contained in `realRoot`.
  return rel.startsWith('..') || isAbsolute(rel);
}

/**
 * Lexical containment check: is `candidate` at or beneath `root`? Both are resolved
 * first. Exported for reuse by the exec jail (sandbox.ts) to confine a child
 * process's working directory to the workspace root. This is a string check — for
 * file reads, prefer the symlink/TOCTOU-hardened {@link openWithinRoot}.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  return !escapesRoot(resolvedRoot, resolve(resolvedRoot, candidate));
}

/**
 * Open a file for reading, JAILED to `root`, defending against symlink escapes,
 * TOCTOU races, and non-regular files. The caller owns the returned handle and
 * MUST close it.
 *
 * Defense, in order:
 *  1. Cheap string pre-check rejects obvious `..`/absolute escapes before any
 *     syscall (also preserves the historical workspace-root-escape rejection).
 *  2. `realpath(root)` resolves a possibly-symlinked workspace root once.
 *  3. `open()` follows symlinks and binds a file descriptor to the actual inode
 *     that existed at open time — nothing read later can be swapped out from under
 *     it (the fd, not the path, is what we read).
 *  4. `fstat` on the *fd* (not the path) classifies the opened object with no
 *     TOCTOU window; anything that isn't a regular file is refused.
 *  5. `realpath(candidate)` resolves every symlink in the path and must land
 *     inside `realRoot`; then the resolved path is `stat`'d and its (dev, ino)
 *     must equal the fd's. That binding is the crux: it proves the in-root path we
 *     validated and the inode we hold open are the same object, closing the
 *     open->validate race a bare string/realpath check leaves open.
 *
 * Residual gap: an attacker who can write inside the root could still swap an
 * *intermediate* directory of the path for a symlink between step 3 and step 5; the
 * (dev, ino) bind catches a changed final target but a fully race-controlled
 * intermediate needs fd-relative per-component opens or Linux
 * `openat2(RESOLVE_BENEATH)` — a syscall Node does not expose, so this is the
 * pure-Node ceiling. The *exec* half of tool sandboxing (no-shell spawn, env scrub,
 * cwd jail, timeout, output cap, privilege drop) lives in `sandbox.ts`; kernel-level
 * syscall/namespace confinement (seccomp, mount/pid/net namespaces) is a deploy-time
 * concern (run the process under a container/seccomp profile), tracked as the
 * remaining Phase 4 sandboxing work.
 */
export async function openWithinRoot(
  root: string,
  requestedPath: string,
): Promise<JailResult> {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, requestedPath);

  // 1. String pre-check — reject `..`/absolute escapes without touching the fs.
  if (escapesRoot(resolvedRoot, candidate)) {
    return { ok: false, failure: { kind: 'escape' } };
  }

  // 2. Resolve the workspace root's real location once (it may itself be a symlink).
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch (err) {
    return { ok: false, failure: { kind: 'io', message: (err as Error).message } };
  }

  // 3. Open, following symlinks, to pin an fd to the actual inode.
  let handle: FileHandle;
  try {
    handle = await open(candidate, constants.O_RDONLY);
  } catch (err) {
    return { ok: false, failure: { kind: 'io', message: (err as Error).message } };
  }

  try {
    // 4. Classify the opened object via the fd — no TOCTOU.
    const fdStat = await handle.stat();
    if (!fdStat.isFile()) {
      return { ok: false, failure: { kind: 'not-regular', type: describeType(fdStat) } };
    }

    // 5. Resolve symlinks and confirm containment, then bind the resolved path to
    //    the open fd by (dev, ino) so a swap between open and validate is caught.
    const realTarget = await realpath(candidate);
    if (escapesRoot(realRoot, realTarget)) {
      return { ok: false, failure: { kind: 'escape' } };
    }
    const pathStat = await stat(realTarget);
    if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) {
      // The in-root path we validated is no longer the inode we hold open.
      return { ok: false, failure: { kind: 'escape' } };
    }

    const result: JailResult = { ok: true, handle, realPath: realTarget };
    handle = undefined as unknown as FileHandle; // ownership transferred to caller
    return result;
  } catch (err) {
    return { ok: false, failure: { kind: 'io', message: (err as Error).message } };
  } finally {
    // Close on every path EXCEPT success (where ownership moved to the caller).
    if (handle) await handle.close();
  }
}
