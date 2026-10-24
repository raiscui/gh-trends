import fs from 'node:fs';
import path from 'node:path';
import { logInfo, logWarn } from '../utils/logging';

// 六榜共享发布记忆, 按 UTC 日历日排除今天和昨天已发布的项目.
// 预览只读, 所有启用渠道发布成功后才回写; 候选不足时不补回旧项目.

// 发布记忆文件路径(run.ts 写入、preview.ts 只读、workflow commit 三方共用的单一真相源)
export const PUBLISHED_MEMORY_PATH = 'feed/published.json';

const RETENTION_DAYS = 1;

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
  const today = Date.parse(now.toISOString().slice(0, 10));
  const ageDays = (today - Date.parse(publishedOn)) / 86400e3;
  return ageDays >= 0 && ageDays <= RETENTION_DAYS;
}

// 剔除保留期内已发布过的项目。PUBLISHED_MEMORY_ENABLED != true 时直接原样返回。
// 只读不写 —— preview 与 run 共用, 副作用只发生在 recordPublished。
export function dedupe<T extends { nameWithOwner: string }>(
  repos: T[],
  memoryPath: string,
  now: Date = new Date()
): T[] {
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

// 发布成功后回写: 合并本次六榜单并集, 清理超过保留期的旧条目
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
