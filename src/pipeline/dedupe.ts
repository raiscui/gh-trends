import fs from 'node:fs';
import path from 'node:path';
import { logInfo, logWarn } from '../utils/logging';
import { GithubRepo } from '../clients/github.gql';

// ============================================================================
// 发布去重记忆(specs/0001 D3)
//
// 记录文件 feed/published.json 形如 {"owner/name": "YYYY-MM-DD", ...}。
// daily 频率下, 没有"已发布"记忆的爆火项目会连续霸榜一周, 挤掉新面孔;
// 这里在 select 之前剔除 N 天内已发布过的项目, 发布成功后回写本次榜单并集。
//
// 设计取舍:
//   - 文件缺失 / JSON 损坏 => 降级为"全通过"并 WARN, 绝不让去重挡住发布(fail-open);
//   - 条目保留 RETENTION_DAYS 天后自动清理, 控制文件体积;
//   - 路径固定不做成配置: 单一真相源, 避免读写两端漂移。
// ============================================================================

// 发布记忆文件路径(run.ts 写入、preview.ts 只读、workflow commit 三方共用的单一真相源)
export const PUBLISHED_MEMORY_PATH = 'feed/published.json';

const RETENTION_DAYS = 90;

// 形如 { "owner/name": "2026-09-19" } 的发布日期记录
type PublishedMemory = Record<string, string>;

// 读发布记录; 文件不存在或损坏时返回 null(调用方降级为全通过)
function readMemory(path: string): PublishedMemory | null {
  if (!fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf-8')) as PublishedMemory;
  } catch (err) {
    logWarn('dedupe', `failed to parse ${path}, treating as empty: ${err}`);
    return null;
  }
}

// 条目是否仍在保留期内(N 天内已发布过 => 应被去重剔除)
function isWithinRetention(publishedOn: string, now: Date): boolean {
  const ageDays = (now.getTime() - new Date(publishedOn).getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= RETENTION_DAYS;
}

// 剔除保留期内已发布过的项目。PUBLISHED_MEMORY_ENABLED != true 时直接原样返回。
// 只读不写 —— preview 与 run 共用, 副作用只发生在 recordPublished。
export function dedupe(
  repos: GithubRepo[],
  memoryPath: string,
  now: Date = new Date()
): GithubRepo[] {
  if (process.env.PUBLISHED_MEMORY_ENABLED !== 'true') return repos;

  const memory = readMemory(memoryPath);
  if (!memory || Object.keys(memory).length === 0) return repos;

  const kept = repos.filter(repo => {
    const publishedOn = memory[repo.nameWithOwner];
    if (!publishedOn) return true;
    return !isWithinRetention(publishedOn, now);
  });

  const removedCount = repos.length - kept.length;
  if (removedCount > 0) {
    logInfo('dedupe', `${removedCount} repos published within ${RETENTION_DAYS}d, filtered`);
  }
  return kept;
}

// 发布成功后回写: 合并本次四榜单并集, 清理超过保留期的旧条目
export function recordPublished(
  repoNames: string[],
  memoryPath: string,
  now: Date = new Date()
): void {
  if (process.env.PUBLISHED_MEMORY_ENABLED !== 'true') return;

  const memory = readMemory(memoryPath) ?? {};
  const today = now.toISOString().slice(0, 10);

  for (const name of repoNames) {
    memory[name] = today;
  }

  // 顺带清理过期条目, 保证文件体积随时间收敛
  const active: PublishedMemory = {};
  for (const [name, publishedOn] of Object.entries(memory)) {
    if (isWithinRetention(publishedOn, now)) {
      active[name] = publishedOn;
    }
  }

  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  fs.writeFileSync(memoryPath, JSON.stringify(active, null, 2) + '\n', 'utf-8');
  logInfo(
    'dedupe',
    `recorded ${repoNames.length} repos to ${memoryPath} (${Object.keys(active).length} total)`
  );
}
