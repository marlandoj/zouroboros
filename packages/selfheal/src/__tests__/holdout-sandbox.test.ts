import { describe, test, expect } from 'bun:test';
import {
  buildHoldoutSandboxEnv,
  HOLDOUT_PRESERVE_NAMES,
} from '../introspect/holdout-sandbox.js';
import { isSecretEnvName } from '../crystallize/eval-replay.js';

const RICH_PARENT: NodeJS.ProcessEnv = {
  PATH: '/custom/bin:/usr/bin',
  HOME: '/home/workspace',
  USER: 'marlandoj',
  LANG: 'en_US.UTF-8',
  ZO_WORKSPACE: '/home/workspace',
  ZOUROBOROS_DATA_DIR: '/home/workspace/.zo/data',
  // Secrets that MUST NOT leak:
  STRIPE_SECRET_KEY: 'sk_live_xxx',
  OPENAI_API_KEY: 'sk-openai-xxx',
  ANTHROPIC_API_KEY: 'sk-ant-xxx',
  ZO_API_KEY: 'zo-secret-xxx',
  ALPACA_API_KEY: 'alpaca-xxx',
  GITHUB_TOKEN: 'ghp_xxx',
  AWS_SECRET_ACCESS_KEY: 'aws-xxx',
  GMAIL_PASSWORD: 'gmail-xxx',
  CRYSTALLIZE_APPROVAL_SECRET: 'approve-xxx',
  // Non-secret noise that should still be dropped (not on allowlist):
  RANDOM_VAR: 'noise',
  TERM: 'xterm-256color',
};

describe('buildHoldoutSandboxEnv — allowlist', () => {
  test('preserves every curated trusted name verbatim from parent', () => {
    const env = buildHoldoutSandboxEnv(RICH_PARENT);
    for (const name of HOLDOUT_PRESERVE_NAMES) {
      expect(env[name]).toBe(RICH_PARENT[name]);
    }
  });

  test('preserves the REAL HOME (does not rewrite to workspace)', () => {
    const env = buildHoldoutSandboxEnv({ ...RICH_PARENT, HOME: '/root' });
    // Contrast with buildSandboxEnv which forces HOME=workspace; the grader
    // needs the real HOME so homedir() finds the holdout fixture bank.
    expect(env.HOME).toBe('/root');
    expect(env.HOME).not.toBe(env.ZO_WORKSPACE);
  });

  test('drops non-allowlisted vars even when they are not secret', () => {
    const env = buildHoldoutSandboxEnv(RICH_PARENT);
    expect(env.RANDOM_VAR).toBeUndefined();
    expect(env.TERM).toBeUndefined();
  });
});

describe('buildHoldoutSandboxEnv — secret stripping', () => {
  const SECRET_KEYS = [
    'STRIPE_SECRET_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ZO_API_KEY',
    'ALPACA_API_KEY',
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'GMAIL_PASSWORD',
    'CRYSTALLIZE_APPROVAL_SECRET',
  ];

  for (const key of SECRET_KEYS) {
    test(`secret ${key} is absent from the child env`, () => {
      const env = buildHoldoutSandboxEnv(RICH_PARENT);
      expect(env[key]).toBeUndefined();
    });
  }

  test('ZO_WORKSPACE survives despite matching the ZO_ secret prefix', () => {
    // Sanity: the prefix check WOULD flag it, but the curated list trumps.
    expect(isSecretEnvName('ZO_WORKSPACE')).toBe(true);
    const env = buildHoldoutSandboxEnv(RICH_PARENT);
    expect(env.ZO_WORKSPACE).toBe('/home/workspace');
  });
});

describe('buildHoldoutSandboxEnv — egress refusal', () => {
  const SINK = 'http://127.0.0.1:0';

  test('pins ALL proxy variants (upper + lower + ALL_PROXY) to the dead sink', () => {
    const env = buildHoldoutSandboxEnv(RICH_PARENT);
    // Upper-case (tools that read these)
    expect(env.HTTPS_PROXY).toBe(SINK);
    expect(env.HTTP_PROXY).toBe(SINK);
    expect(env.ALL_PROXY).toBe(SINK);
    // Lower-case (curl, requests/urllib3, Go, undici) — would be UNSET (= no
    // proxy) under an allowlist if we didn't pin them, allowing direct connect.
    expect(env.https_proxy).toBe(SINK);
    expect(env.http_proxy).toBe(SINK);
    expect(env.all_proxy).toBe(SINK);
    // No bypass list, either case.
    expect(env.NO_PROXY).toBe('');
    expect(env.no_proxy).toBe('');
  });

  test('parent proxy overrides cannot leak through (any case)', () => {
    const env = buildHoldoutSandboxEnv({
      ...RICH_PARENT,
      HTTPS_PROXY: 'http://evil.example:8080',
      https_proxy: 'http://evil.example:8080',
      ALL_PROXY: 'socks5://evil.example:1080',
      NO_PROXY: '*',
      no_proxy: '*',
    });
    expect(env.HTTPS_PROXY).toBe(SINK);
    expect(env.https_proxy).toBe(SINK);
    expect(env.ALL_PROXY).toBe(SINK);
    expect(env.NO_PROXY).toBe('');
    expect(env.no_proxy).toBe('');
  });

  test('opts.preserve cannot override any egress proxy variant', () => {
    const env = buildHoldoutSandboxEnv(
      { ...RICH_PARENT, HTTPS_PROXY: 'http://evil.example:8080', all_proxy: 'socks5://evil:1' },
      { preserve: ['HTTPS_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] },
    );
    expect(env.HTTPS_PROXY).toBe(SINK);
    expect(env.http_proxy).toBe(SINK);
    expect(env.ALL_PROXY).toBe(SINK);
    expect(env.all_proxy).toBe(SINK);
    expect(env.NO_PROXY).toBe('');
    expect(env.no_proxy).toBe('');
  });
});

describe('HOLDOUT_PRESERVE_NAMES — curated-list secret guard', () => {
  // Defense-in-depth for finding #4: the curated allowlist bypasses the secret
  // check by design, so a future edit could silently forward a secret-class var.
  // Only ZO_WORKSPACE is an INTENTIONAL secret-prefix collision (a trusted path).
  const KNOWN_SAFE_COLLISIONS = new Set(['ZO_WORKSPACE']);

  test('no curated name is secret-class except the documented ZO_WORKSPACE exception', () => {
    const unexpected = HOLDOUT_PRESERVE_NAMES.filter(
      (n) => isSecretEnvName(n) && !KNOWN_SAFE_COLLISIONS.has(n),
    );
    expect(unexpected).toEqual([]);
  });
});

describe('buildHoldoutSandboxEnv — fallbacks', () => {
  test('supplies PATH/LANG/USER defaults when parent lacks them', () => {
    const env = buildHoldoutSandboxEnv({ HOME: '/home/workspace' });
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.USER).toBe('zouroboros');
  });

  test('does not clobber parent PATH/LANG/USER when present', () => {
    const env = buildHoldoutSandboxEnv(RICH_PARENT);
    expect(env.PATH).toBe('/custom/bin:/usr/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.USER).toBe('marlandoj');
  });

  test('empty parent still yields a runnable env with egress refused', () => {
    const env = buildHoldoutSandboxEnv({});
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.USER).toBe('zouroboros');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:0');
    expect(env.HOME).toBeUndefined();
  });
});

describe('buildHoldoutSandboxEnv — caller escape hatch', () => {
  test('forwards a requested non-secret extra var', () => {
    const env = buildHoldoutSandboxEnv(
      { ...RICH_PARENT, EXTRA_FLAG: 'on' },
      { preserve: ['EXTRA_FLAG'] },
    );
    expect(env.EXTRA_FLAG).toBe('on');
  });

  test('refuses to forward a secret even when explicitly requested', () => {
    const env = buildHoldoutSandboxEnv(RICH_PARENT, {
      preserve: ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'ANTHROPIC_API_KEY'],
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test('requested-but-absent extra var is simply not added', () => {
    const env = buildHoldoutSandboxEnv(RICH_PARENT, { preserve: ['NOT_SET'] });
    expect(env.NOT_SET).toBeUndefined();
  });
});

describe('buildHoldoutSandboxEnv — control flag propagation', () => {
  test('forwards HOLDOUT_SUBCHECKS so the child honors the operator off-switch', () => {
    const env = buildHoldoutSandboxEnv({ ...RICH_PARENT, HOLDOUT_SUBCHECKS: '0' });
    expect(env.HOLDOUT_SUBCHECKS).toBe('0');
  });

  test('omits HOLDOUT_SUBCHECKS when the parent never set it (default ON in child)', () => {
    const env = buildHoldoutSandboxEnv(RICH_PARENT);
    expect(env.HOLDOUT_SUBCHECKS).toBeUndefined();
  });
});
