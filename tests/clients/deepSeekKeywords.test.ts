import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_HARNESS_KEYWORDS,
  DEEPSEEK_HARNESS_TOPICS,
  DEEPSEEK_HARNESS_SUPPORT_TOPICS,
  isDeepSeekHarnessRepo,
} from '../../src/clients/deepSeekKeywords';
import { GithubRepo } from '../../src/clients/github.gql';

// 测试工厂:构造一个最小可用的 GithubRepo。
// name/description 走关键词通道, topics 走 topic 通道(2026-09-29 新增)。
function mkRepo(
  name: string,
  description: string | null = 'placeholder',
  topics: string[] = []
): GithubRepo {
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
      starsRecent: '0',
      starsEarlier: '0',
    },
    stargazerCount: 0,
    primaryLanguage: null,
    repositoryTopics: { nodes: topics.map(t => ({ topic: { name: t } })) },
    owner: { __typename: 'User', createdAt: '2024-01-01T00:00:00Z' },
    stargazers: { nodes: [] },
  };
}

describe('deepSeekKeywords.ts', () => {
  describe('常量集合', () => {
    it('强信号 topic 恰好是 dsh / deepseek-harness', () => {
      expect([...DEEPSEEK_HARNESS_TOPICS].sort()).toEqual(['deepseek-harness', 'dsh']);
    });

    it('弱信号 topic 只有 dsh-plugin', () => {
      expect([...DEEPSEEK_HARNESS_SUPPORT_TOPICS]).toEqual(['dsh-plugin']);
    });

    it('关键词集合仍是 cordis / dsh / dsh-plugin 三词', () => {
      expect(DEEPSEEK_HARNESS_KEYWORDS).toContain('cordis');
      expect(DEEPSEEK_HARNESS_KEYWORDS).toContain('dsh');
      expect(DEEPSEEK_HARNESS_KEYWORDS).toContain('dsh-plugin');
    });
  });

  describe('topic 通道(2026-09-29 新增, 主判据)', () => {
    it('命中强信号 topic dsh 即认定生态内(无需 name/desc 佐证)', () => {
      // 真实案例:dsh-tauri/deepseek-harness-desktop 三 topic 全中
      expect(isDeepSeekHarnessRepo(mkRepo('some/unrelated-name', 'nothing special', ['dsh']))).toBe(
        true
      );
    });

    it('命中强信号 topic deepseek-harness 即认定(大小写不敏感)', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('foo/bar', 'no signal here', ['DeepSeek-Harness']))).toBe(
        true
      );
      expect(
        isDeepSeekHarnessRepo(mkRepo('qiz029/dscode', 'A coding agent', ['deepseek-harness']))
      ).toBe(true);
    });

    it('官方仓库三 topic 全中命中', () => {
      const official = mkRepo('deepseek-ai/deepseek-harness', 'The official one', [
        'ai-agents',
        'cordis',
        'dsh',
        'dsh-plugin',
      ]);
      expect(isDeepSeekHarnessRepo(official)).toBe(true);
    });

    it('弱信号 dsh-plugin 单独出现**不**命中(防泛标签污染)', () => {
      // 实测 PicGo / Tencent-WeKnora 等通用项目只挂 dsh-plugin, 名字描述无生态信号
      expect(isDeepSeekHarnessRepo(mkRepo('Molunerfinn/PicGo', 'A GUI tool', ['dsh-plugin']))).toBe(
        false
      );
      expect(
        isDeepSeekHarnessRepo(mkRepo('Tencent/WeKnora', 'RAG framework', ['dsh-plugin']))
      ).toBe(false);
    });

    it('弱信号 dsh-plugin + 关键词佐证则命中', () => {
      // dsh-plugin topic + 名字含 dsh 关键词 → 确认属于生态
      expect(
        isDeepSeekHarnessRepo(mkRepo('yyh-001/DSH-X', 'launcher', ['dsh-plugin', 'dsh']))
      ).toBe(true);
      // dsh-plugin topic + 描述含 cordis 关键词 → 命中
      // 注意: 关键词 `dsh` 匹配不到 "DeepSeek Harness" 全称(非连续子串),
      // 这正是 topic 通道不可替代的原因 —— 全称项目靠 topic 命中, 不靠关键词。
      expect(
        isDeepSeekHarnessRepo(mkRepo('foo/launcher', 'A cordis based launcher', ['dsh-plugin']))
      ).toBe(true);
    });
  });

  describe('关键词兜底通道(无 topic 时保留旧口径)', () => {
    it('name 含 cordis / dsh / dsh-plugin 命中', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('foo/awesome-dsh'))).toBe(true);
      expect(isDeepSeekHarnessRepo(mkRepo('foo/cordis-memory'))).toBe(true);
      expect(isDeepSeekHarnessRepo(mkRepo('bar/cool-dsh-plugin'))).toBe(true);
    });

    it('description 含关键词命中', () => {
      expect(
        isDeepSeekHarnessRepo(mkRepo('foo/silent-name', 'Built on the dsh memory layer'))
      ).toBe(true);
      expect(
        isDeepSeekHarnessRepo(mkRepo('foo/x', 'An official dsh-plugin for vector search'))
      ).toBe(true);
    });

    it('大小写不敏感', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('foo/CORDIS'))).toBe(true);
      expect(isDeepSeekHarnessRepo(mkRepo('foo/DSH-PLUGIN'))).toBe(true);
    });

    it('驼峰连写命中(DshTool)', () => {
      // "后不接小写字母"边界: dsh 后跟大写 T = 新词开始, 算命中
      expect(isDeepSeekHarnessRepo(mkRepo('foo/DshTool'))).toBe(true);
    });

    it('owner 名含 cordis 段命中(cordiverse/cordis)', () => {
      // cordiverse 里的 cordis 后跟 e 会被边界挡住, 但 name 段结尾的独立 cordis 命中
      expect(isDeepSeekHarnessRepo(mkRepo('cordiverse/cordis'))).toBe(true);
    });

    it('Spreadsheets 类普通英文词不误伤(词边界回归)', () => {
      // 2026-09-29 烟测实锤: dream-num/univer 的 desc "Spreadsheets" 含裸子串 dsh
      // 曾被误判进 DeepSeek 榜; 词边界修复后不再误伤
      expect(
        isDeepSeekHarnessRepo(
          mkRepo('dream-num/univer', 'The Office Harness for AI Agents — Spreadsheets, Docs')
        )
      ).toBe(false);
    });
  });

  describe('负例:不误伤非生态项目', () => {
    it('无 topic 且无关键词 → 不命中', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('vercel/next.js', 'The React Framework'))).toBe(false);
      expect(isDeepSeekHarnessRepo(mkRepo('rust-lang/rust', 'Empowering everyone'))).toBe(false);
    });

    it('DeepSeek 官方模型仓库不算 Harness 生态(无 topic 无关键词)', () => {
      expect(
        isDeepSeekHarnessRepo(mkRepo('deepseek-ai/DeepSeek-V3', 'Official model', ['deepseek']))
      ).toBe(false);
    });

    it('harness 是 2026 通用词, 只有 topic 命中才算(不扩关键词)', () => {
      // openharness / JevHarness 这类没有 dsh 系列 topic, 不该进榜
      expect(
        isDeepSeekHarnessRepo(mkRepo('autonomous-ai/openharness', 'The ultimate harness', ['ai']))
      ).toBe(false);
    });

    it('null description 不崩且不命中(无 topic 无 name 关键词)', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('foo/safe-project', null))).toBe(false);
    });
  });

  describe('鲁棒性', () => {
    it('老数据缺 repositoryTopics 字段时按关键词兜底(不崩)', () => {
      // 模拟 GraphQL 尚未返回 topics 的历史数据形状
      const legacy = mkRepo('foo/awesome-dsh', 'placeholder', []);
      delete (legacy as Partial<GithubRepo>).repositoryTopics;
      expect(isDeepSeekHarnessRepo(legacy)).toBe(true);
    });
  });
});
