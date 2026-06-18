import { z } from 'zod';
import { ToolRegistryService } from '../src/tools/tool-registry.service';
import type { Tool, ToolResult } from '../src/tools/tool.interface';

/** A trivial named tool that records whether it actually executed. */
function probe(name: string): Tool & { ran: boolean } {
  const t = {
    name,
    description: `probe ${name}`,
    inputSchema: z.object({}),
    ran: false,
    async execute(): Promise<ToolResult> {
      t.ran = true;
      return { content: `${name} ran` };
    },
  };
  return t;
}

describe('ToolRegistryService — per-run tool scope', () => {
  let registry: ToolRegistryService;
  let alpha: ReturnType<typeof probe>;
  let beta: ReturnType<typeof probe>;
  let gamma: ReturnType<typeof probe>;

  beforeEach(() => {
    registry = new ToolRegistryService();
    alpha = probe('alpha');
    beta = probe('beta');
    gamma = probe('gamma');
    registry.register(alpha);
    registry.register(beta);
    registry.register(gamma);
  });

  it('lists the full registry when no scope is given', () => {
    expect(registry.names()).toEqual(['alpha', 'beta', 'gamma']);
    expect(registry.list().map((t) => t.name).sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('allow restricts to the listed tools', () => {
    expect(registry.names({ allow: ['alpha'] })).toEqual(['alpha']);
  });

  it('deny subtracts from the full set', () => {
    expect(registry.names({ deny: ['beta'] })).toEqual(['alpha', 'gamma']);
  });

  it('allow and deny combine (in allow AND not in deny)', () => {
    expect(registry.names({ allow: ['alpha', 'beta'], deny: ['beta'] })).toEqual([
      'alpha',
    ]);
  });

  it('an empty allow is treated as "no restriction" (full set)', () => {
    expect(registry.names({ allow: [] })).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('executes an in-scope tool', async () => {
    const res = await registry.execute('alpha', {}, { allow: ['alpha'] });
    expect(res.isError).toBeUndefined();
    expect(alpha.ran).toBe(true);
  });

  it('refuses a registered-but-out-of-scope tool WITHOUT running it', async () => {
    const res = await registry.execute('beta', {}, { allow: ['alpha'] });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("'beta' is not available in this run");
    // The scope is a real boundary — execute() never reached the tool body.
    expect(beta.ran).toBe(false);
  });

  it('still reports a genuinely unknown tool distinctly from an out-of-scope one', async () => {
    const res = await registry.execute('missing', {}, { allow: ['alpha'] });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Unknown tool 'missing'");
    // The "available tools" hint reflects the scope, not the whole registry.
    expect(res.content).toContain('alpha');
    expect(res.content).not.toContain('beta');
  });
});
