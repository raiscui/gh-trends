import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectRust, selectAgent } from '../../src/pipeline/vertical';
import { GithubRepo } from '../../src/clients/github.gql';

// 测试工厂:构造可控制 primaryLanguage / description / score 的 repo。
function mkRepo(opts: {
  name: string;
  language?: string | null;
  description?: string | null;
  hoursAgo: number;
  starsWithin: number;
}): GithubRepo {
  const nowMs = new Date().getTime();
  const firstSeen = new Date(nowMs - opts.hoursAgo * 3600_000).toISOString();
  return {
    nameWithOwner: opts.name,
    url: `https://github.com/${opts.name}`,
    description: opts.description ?? '[description]',
    primaryLanguage: opts.language ? { name: opts.language } : null,
    createdAt: new Date(nowMs - 86400_000).toISOString(),
    stargazerCount: opts.starsWithin,
    owner: { __typename: 'Organization', createdAt: '2020-01-01T00:00:00Z' },
    clickhouse: {
      repoName: opts.name,
      firstSeenAt: firstSeen.slice(0, 19).replace('T', ' '),
      starsWithin: String(opts.starsWithin),
      starsBefore: '0',
    },
    stargazers: { nodes: [{ createdAt: '2020-01-01T00:00:00Z' }] },
  };
}

describe('vertical.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T12:00:00Z'));
    vi.stubEnv('SCAN_WINDOW_DAYS', '7');
    vi.stubEnv('SELECT_FRESH_HOURS', '24');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('selectRust', () => {
    it('only includes repos with primaryLanguage.name === "Rust"', () => {
      vi.stubEnv('RELEASE_TOP_N_RUST', '5');

      const rustA = mkRepo({ name: 'rust/a', language: 'Rust', hoursAgo: 10, starsWithin: 100 });
      const rustB = mkRepo({ name: 'rust/b', language: 'Rust', hoursAgo: 20, starsWithin: 80 });
      const tsC = mkRepo({ name: 'ts/c', language: 'TypeScript', hoursAgo: 5, starsWithin: 200 });
      const pyD = mkRepo({ name: 'py/d', language: 'Python', hoursAgo: 8, starsWithin: 150 });
      const nullE = mkRepo({ name: 'null/e', language: null, hoursAgo: 6, starsWithin: 90 });

      const out = selectRust([rustA, tsC, rustB, pyD, nullE]);

      expect(out.map(r => r.nameWithOwner).sort()).toEqual(['rust/a', 'rust/b']);
    });

    it('returns empty array when no Rust repos in pool', () => {
      vi.stubEnv('RELEASE_TOP_N_RUST', '15');

      const ts = mkRepo({ name: 'ts/a', language: 'TypeScript', hoursAgo: 5, starsWithin: 100 });
      const py = mkRepo({ name: 'py/b', language: 'Python', hoursAgo: 6, starsWithin: 80 });

      const out = selectRust([ts, py]);

      expect(out).toEqual([]);
    });

    it('respects RELEASE_TOP_N_RUST top-N cap', () => {
      vi.stubEnv('RELEASE_TOP_N_RUST', '2');

      const rustRepos = Array.from({ length: 5 }, (_, i) =>
        mkRepo({ name: `rust/${i}`, language: 'Rust', hoursAgo: 5, starsWithin: 100 - i * 10 })
      );

      const out = selectRust(rustRepos);

      expect(out).toHaveLength(2);
    });

    it('uses fresh-firstSeen bucket prioritization (default SELECT_FRESH_HOURS=24)', () => {
      vi.stubEnv('RELEASE_TOP_N_RUST', '2');

      const hotButOld = mkRepo({
        name: 'rust/hot-but-old',
        language: 'Rust',
        hoursAgo: 96, // legacy bucket
        starsWithin: 1000,
      });
      const warmButFresh = mkRepo({
        name: 'rust/warm-but-fresh',
        language: 'Rust',
        hoursAgo: 6, // fresh bucket
        starsWithin: 200,
      });

      const out = selectRust([hotButOld, warmButFresh]);

      // 即使 hot-but-old starsWithin 高(heavily trending 4 天),
      // fresh bucket 仍优先于 legacy bucket。
      expect(out.map(r => r.nameWithOwner)).toEqual(['rust/warm-but-fresh', 'rust/hot-but-old']);
    });
  });

  describe('selectAgent', () => {
    it('includes repos whose name contains an agent keyword', () => {
      vi.stubEnv('RELEASE_TOP_N_AGENT', '5');

      const agentByName = mkRepo({
        name: 'foo/awesome-agent',
        language: 'TypeScript',
        hoursAgo: 10,
        starsWithin: 100,
      });
      const nonAgent = mkRepo({
        name: 'rust/random-tool',
        language: 'Rust',
        hoursAgo: 8,
        starsWithin: 80,
      });

      const out = selectAgent([agentByName, nonAgent]);

      expect(out.map(r => r.nameWithOwner)).toEqual(['foo/awesome-agent']);
    });

    it('includes repos whose description contains an agent keyword (M2)', () => {
      vi.stubEnv('RELEASE_TOP_N_AGENT', '5');

      const agentByDesc = mkRepo({
        name: 'foo/silent-name',
        language: 'Python',
        hoursAgo: 5,
        starsWithin: 90,
        description: 'A MCP-compatible AI integration layer',
      });
      const nonAgent = mkRepo({
        name: 'foo/something',
        language: 'TypeScript',
        hoursAgo: 7,
        starsWithin: 80,
        description: 'Static site generator',
      });

      const out = selectAgent([agentByDesc, nonAgent]);

      expect(out.map(r => r.nameWithOwner)).toEqual(['foo/silent-name']);
    });

    it('returns empty array when no agent repos in pool', () => {
      vi.stubEnv('RELEASE_TOP_N_AGENT', '15');

      const a = mkRepo({
        name: 'rust/web',
        language: 'Rust',
        hoursAgo: 5,
        starsWithin: 100,
        description: 'Web framework',
      });
      const b = mkRepo({
        name: 'ts/lib',
        language: 'TypeScript',
        hoursAgo: 6,
        starsWithin: 80,
        description: 'Utility library',
      });

      const out = selectAgent([a, b]);

      expect(out).toEqual([]);
    });

    it('handles null description gracefully (no crash)', () => {
      vi.stubEnv('RELEASE_TOP_N_AGENT', '15');

      const nullDesc = mkRepo({
        name: 'foo/agent-tool',
        language: 'TypeScript',
        hoursAgo: 5,
        starsWithin: 100,
        description: null,
      });

      // name 命中 "agent",description 为 null → 仍命中
      const out = selectAgent([nullDesc]);

      expect(out.map(r => r.nameWithOwner)).toEqual(['foo/agent-tool']);
    });

    it('respects RELEASE_TOP_N_AGENT top-N cap', () => {
      vi.stubEnv('RELEASE_TOP_N_AGENT', '2');

      const agents = Array.from({ length: 5 }, (_, i) =>
        mkRepo({
          name: `foo/agent-${i}`,
          language: 'TypeScript',
          hoursAgo: 5,
          starsWithin: 100 - i * 10,
        })
      );

      const out = selectAgent(agents);

      expect(out).toHaveLength(2);
    });
  });

  describe('Rust + Agent dual filtering', () => {
    it('a Rust + agent repo appears in both selectRust and selectAgent outputs', () => {
      vi.stubEnv('RELEASE_TOP_N_RUST', '15');
      vi.stubEnv('RELEASE_TOP_N_AGENT', '15');

      const rustAgent = mkRepo({
        name: 'foo/rust-agent',
        language: 'Rust',
        hoursAgo: 5,
        starsWithin: 100,
        description: 'An agent framework in Rust',
      });

      const rustOnly = mkRepo({
        name: 'foo/rust-only',
        language: 'Rust',
        hoursAgo: 6,
        starsWithin: 80,
      });
      const agentOnly = mkRepo({
        name: 'foo/agent-only',
        language: 'TypeScript',
        hoursAgo: 7,
        starsWithin: 70,
      });
      const neither = mkRepo({
        name: 'foo/neither',
        language: 'Python',
        hoursAgo: 8,
        starsWithin: 60,
        description: 'A boring library',
      });

      const input = [rustAgent, rustOnly, agentOnly, neither];

      const rustOut = selectRust(input);
      const agentOut = selectAgent(input);

      expect(rustOut.map(r => r.nameWithOwner).sort()).toEqual(['foo/rust-agent', 'foo/rust-only']);
      expect(agentOut.map(r => r.nameWithOwner).sort()).toEqual([
        'foo/agent-only',
        'foo/rust-agent',
      ]);
    });
  });
});
