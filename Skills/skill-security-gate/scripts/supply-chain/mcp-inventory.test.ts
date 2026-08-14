import { test, expect, describe } from 'bun:test';
import {
  classifyServer,
  inventoryConfig,
  verdictFor,
  auditMcpPolicy,
  type McpPolicy,
} from './mcp-inventory.js';

describe('classifyServer', () => {
  test('absolute path command -> local', () => {
    const e = classifyServer('cm', '.mcp.json', { command: '/home/workspace/Integrations/x/bin/mcp' });
    expect(e.kind).toBe('local');
    expect(e.source).toBe('local');
  });

  test('bun + local script arg -> local', () => {
    const e = classifyServer('qr', '.mcp.json', { command: 'bun', args: ['/home/workspace/Skills/x/mcp.ts'] });
    expect(e.kind).toBe('local');
    expect(e.source).toBe('local');
  });

  test('uvx package -> third-party', () => {
    const e = classifyServer('ss', '.mcp.json', { command: 'uvx', args: ['semantic-scholar-fastmcp'] });
    expect(e.kind).toBe('package');
    expect(e.source).toBe('third-party');
  });

  test('npx package -> third-party', () => {
    const e = classifyServer('mem', '.mcp.json', { command: 'npx', args: ['zouroboros-memory-mcp'] });
    expect(e.kind).toBe('package');
    expect(e.source).toBe('third-party');
  });

  test('http url -> remote-url third-party', () => {
    const e = classifyServer('heygen', '.mcp.json', { type: 'http', url: 'https://mcp.heygen.com/mcp/v1/' });
    expect(e.kind).toBe('remote-url');
    expect(e.source).toBe('third-party');
  });

  test('bare binary on PATH -> binary third-party', () => {
    const e = classifyServer('weird', '.mcp.json', { command: 'some-binary' });
    expect(e.kind).toBe('binary');
    expect(e.source).toBe('third-party');
  });

  test('bun without a local file arg -> package third-party', () => {
    const e = classifyServer('x', '.mcp.json', { command: 'bun', args: ['x', 'remote-pkg'] });
    expect(e.source).toBe('third-party');
  });
});

describe('inventoryConfig', () => {
  test('parses the standard mcpServers key', () => {
    const parsed = {
      mcpServers: {
        a: { command: 'bun', args: ['/home/workspace/a.ts'] },
        b: { command: 'uvx', args: ['pkg'] },
      },
    };
    const entries = inventoryConfig('.mcp.json', parsed);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.source).sort()).toEqual(['local', 'third-party']);
  });

  test('parses the openclaw servers key', () => {
    const parsed = { servers: { memory: { command: 'npx', args: ['zouroboros-memory-mcp'] } } };
    const entries = inventoryConfig('examples/.mcp.json', parsed);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('memory');
    expect(entries[0].source).toBe('third-party');
  });

  test('tolerates a missing servers key', () => {
    expect(inventoryConfig('.mcp.json', {})).toHaveLength(0);
    expect(inventoryConfig('.mcp.json', null)).toHaveLength(0);
    expect(inventoryConfig('.mcp.json', 'not-an-object')).toHaveLength(0);
  });
});

describe('verdictFor + auditMcpPolicy', () => {
  const policy: McpPolicy = {
    policies: { trusted: 'allow', limited: 'restrict', banned: 'block' },
    default: 'approve',
  };

  test('listed verdicts resolve correctly', () => {
    const mk = (id: string) => classifyServer(id, '.mcp.json', { command: 'bun', args: ['/x.ts'] });
    expect(verdictFor(mk('trusted'), policy)).toBe('allow');
    expect(verdictFor(mk('limited'), policy)).toBe('restrict');
    expect(verdictFor(mk('banned'), policy)).toBe('block');
    expect(verdictFor(mk('unknown'), policy)).toBe('approve');
  });

  test('allow -> no finding', () => {
    const e = [classifyServer('trusted', '.mcp.json', { command: 'bun', args: ['/x.ts'] })];
    expect(auditMcpPolicy(e, policy)).toHaveLength(0);
  });

  test('block -> critical', () => {
    const e = [classifyServer('banned', '.mcp.json', { command: 'npx', args: ['evil'] })];
    const f = auditMcpPolicy(e, policy);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('critical');
  });

  test('restrict -> warning', () => {
    const e = [classifyServer('limited', '.mcp.json', { command: 'npx', args: ['p'] })];
    expect(auditMcpPolicy(e, policy)[0].severity).toBe('warning');
  });

  test('unlisted -> info (defaults to approve) with an "not in the policy file" note', () => {
    const e = [classifyServer('newcomer', '.mcp.json', { command: 'uvx', args: ['p'] })];
    const f = auditMcpPolicy(e, policy);
    expect(f[0].severity).toBe('info');
    expect(f[0].finding).toMatch(/not in the policy file/i);
  });

  test('listed approve -> info needs operator approval', () => {
    const p2: McpPolicy = { policies: { pending: 'approve' } };
    const e = [classifyServer('pending', '.mcp.json', { command: 'uvx', args: ['p'] })];
    const f = auditMcpPolicy(e, p2);
    expect(f[0].severity).toBe('info');
    expect(f[0].finding).toMatch(/needs operator approval/i);
  });
});
