import { describe, expect, it } from 'vitest';
import { AGENT_KEYWORDS, isAgentRepo } from '../../src/clients/agentKeywords';
import { GithubRepo } from '../../src/clients/github.gql';

// 测试工厂:构造一个最小可用的 GithubRepo(只关心 nameWithOwner / description)。
function mkRepo(name: string, description: string | null = 'placeholder'): GithubRepo {
  return {
    nameWithOwner: name,
    url: `https://github.com/${name}`,
    description,
    createdAt: '2024-01-01T00:00:00Z',
    clickhouse: {
      repoName: name,
      firstSeenAt: '2024-01-01 00:00:00',
      starsWithin: '0',
      starsBefore: '0',
    },
    stargazerCount: 0,
    primaryLanguage: null,
    owner: { __typename: 'User', createdAt: '2024-01-01T00:00:00Z' },
    stargazers: { nodes: [] },
  };
}

describe('agentKeywords.ts', () => {
  describe('AGENT_KEYWORDS', () => {
    it('should be a non-empty readonly array of strings', () => {
      expect(AGENT_KEYWORDS.length).toBeGreaterThan(0);
      for (const k of AGENT_KEYWORDS) {
        expect(typeof k).toBe('string');
        expect(k.length).toBeGreaterThan(0);
      }
    });

    it('should contain canonical agent-related keywords', () => {
      // 至少覆盖 agent / mcp / claude-code 三个核心生态
      expect(AGENT_KEYWORDS).toContain('agent');
      expect(AGENT_KEYWORDS).toContain('mcp');
      expect(AGENT_KEYWORDS).toContain('claude-code');
    });
  });

  describe('isAgentRepo', () => {
    it('matches when nameWithOwner contains "agent" (case-insensitive)', () => {
      expect(isAgentRepo(mkRepo('foo/agent-sdk'))).toBe(true);
      expect(isAgentRepo(mkRepo('foo/AGENT-X'))).toBe(true);
      expect(isAgentRepo(mkRepo('foo/AgentFlow'))).toBe(true);
    });

    it('matches when description contains an agent keyword', () => {
      expect(isAgentRepo(mkRepo('foo/something', 'A claude-code integration'))).toBe(true);
      expect(isAgentRepo(mkRepo('foo/another', 'Built with MCP support'))).toBe(true);
    });

    it('matches copilot in name', () => {
      expect(isAgentRepo(mkRepo('foo/copilot-cli'))).toBe(true);
    });

    it('matches autogen / langgraph / crewai in description', () => {
      expect(isAgentRepo(mkRepo('foo/x', 'Uses LangGraph for orchestration'))).toBe(true);
      expect(isAgentRepo(mkRepo('foo/y', 'AutoGen-powered multi-agent'))).toBe(true);
      expect(isAgentRepo(mkRepo('foo/z', 'CrewAI deployment template'))).toBe(true);
    });

    it('does NOT match random repos without agent signals', () => {
      expect(isAgentRepo(mkRepo('vercel/next.js', 'The React Framework'))).toBe(false);
      expect(
        isAgentRepo(mkRepo('rust-lang/rust', 'Empowering everyone to build reliable software'))
      ).toBe(false);
      expect(isAgentRepo(mkRepo('oven-sh/bun', 'Incredibly fast JavaScript runtime'))).toBe(false);
    });

    it('handles null description gracefully', () => {
      // name 不含关键词,description 为 null → 不命中
      expect(isAgentRepo(mkRepo('foo/safe-project', null))).toBe(false);
    });

    it('does NOT match keyword partial-overlap that would cause false positives', () => {
      // 关键词集合里的 'agent' 必须命中完整词,但 name 含 'agent' 都算。
      // 这里只验证 description 不含关键词时不误报。
      expect(isAgentRepo(mkRepo('foo/not-agent', 'A static site generator'))).toBe(true); // name 命中
      expect(isAgentRepo(mkRepo('foo/static-gen', 'A boring markdown parser'))).toBe(false); // 都不命中
    });

    it('matches across multiple keywords in description', () => {
      expect(
        isAgentRepo(mkRepo('foo/cool-project', 'A combined MCP + claude-code + agent demo'))
      ).toBe(true);
    });
  });
});
