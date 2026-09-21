import { GithubRepo } from '../src/clients/github.gql';

// 测试辅助: 构造最小可用的 GithubRepo, 覆盖 clickhouse 新增列
export function toClickhouseFormat(isoDate: string): string {
  return isoDate.slice(0, 19).replace('T', ' ');
}

export function hoursAgo(hours: number): string {
  return toClickhouseFormat(new Date(Date.now() - hours * 60 * 60 * 1000).toISOString());
}

export interface MakeRepoOpts {
  name: string;
  starsWithin?: number;
  starsBefore?: number;
  starsRecent?: number;
  starsEarlier?: number;
  firstSeenHoursAgo?: number;
  stargazerAgeDays?: number;
  ownerCreatedDaysAgo?: number;
  ownerType?: 'User' | 'Organization';
  stargazerCount?: number;
  primaryLanguage?: string | null;
}

// 最小 repo 工厂: 字段取值与打分/过滤直接相关, 其余给中性默认值
export function makeRepo(opts: MakeRepoOpts): GithubRepo {
  const within = opts.starsWithin ?? 500;
  const recent = opts.starsRecent ?? within;
  const earlier = opts.starsEarlier ?? 0;
  return {
    nameWithOwner: opts.name,
    url: `https://github.com/${opts.name}`,
    description: '[description]',
    createdAt: opts.firstSeenHoursAgo
      ? new Date(Date.now() - opts.firstSeenHoursAgo * 3600e3).toISOString()
      : new Date().toISOString(),
    stargazerCount: opts.stargazerCount ?? within,
    primaryLanguage:
      opts.primaryLanguage === undefined
        ? { name: 'Rust' }
        : opts.primaryLanguage
          ? { name: opts.primaryLanguage }
          : null,
    owner: {
      __typename: opts.ownerType ?? 'User',
      createdAt: new Date(Date.now() - (opts.ownerCreatedDaysAgo ?? 2000) * 86400e3).toISOString(),
    },
    clickhouse: {
      repoName: opts.name,
      starsBefore: String(opts.starsBefore ?? 0),
      starsWithin: String(within),
      starsRecent: String(recent),
      starsEarlier: String(earlier),
      firstSeenAt: hoursAgo(opts.firstSeenHoursAgo ?? 48),
    },
    stargazers: {
      nodes: [
        {
          createdAt: new Date(Date.now() - (opts.stargazerAgeDays ?? 2000) * 86400e3).toISOString(),
        },
        {
          createdAt: new Date(Date.now() - (opts.stargazerAgeDays ?? 2000) * 86400e3).toISOString(),
        },
      ],
    },
  };
}
