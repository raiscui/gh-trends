import fs from 'node:fs';
import path from 'node:path';
import { logWarn } from '../utils/logging';
import { ScoredRepo } from './select';

// ============================================================================
// 生态榜尾部轮换(ADR-0003 决策 2 修订)
//
// 背景: 生态榜按 28 天稳态增速排序, 头部项目的位次本来就不会天天变。实测
// 10 期里 hypit / filmcraft / autoclip 等 8 个项目期期满勤, 相邻两期重合
// 10~13 条 —— 用户看到的"没有新东西"就是这个。
//
// 为什么不套用主榜的 90 天去重记忆: 生态榜候选池小(粗排 90 → 过 filter
// → 选出 30, 实际约 45 个), 90 天硬去重会在两三天内把池子掏空, 之后每天
// 触发回退, 问题被兜底逻辑掩盖。故只轮换**尾部**, 头部稳态常驻 —— 成熟生态
// 的头部项目常驻本来就是榜单价值所在。
//
// 记忆文件与主榜 feed/published.json 完全分离: 主记忆由 run.ts 回写并参与
// 池内四榜去重, 生态榜条目进主记忆会被挡在门外(见 run.ts 注释), 反之亦然。
// ============================================================================

export interface RotationOpts {
  // 头部稳态槽位数: 前 headSlots 条不参与轮换
  headSlots: number;
  // 尾部保留期(天): 期内已上榜的尾部项目被剔除, 由后续名次顶上
  retentionDays: number;
}

// 形如 { "owner/name": "2026-10-16" } 的上榜日期记录
type RotationMemory = Record<string, string>;

function readMemory(memoryPath: string): RotationMemory | null {
  if (!fs.existsSync(memoryPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(memoryPath, 'utf-8')) as RotationMemory;
  } catch (err) {
    logWarn('rotation', `failed to parse ${memoryPath}, treating as empty: ${err}`);
    return null;
  }
}

// 按**日历天**差判定, 而非 dedupe.ts 的精确时间差。
//
// 原因: 记忆写入的是 YYYY-MM-DD(日期粒度), 而每天两次运行分别在 00:27 与
// 09:33 UTC。用精确时间差时"昨天 00:00 到 今天 09:33"= 1.4 天, retentionDays=1
// 会把它判成已过期, 保留期语义随运行时刻漂移。按日历天差则稳定:
// retentionDays=2 恒等于"今天 + 昨天上过榜的不再上"。
function isWithinRetention(publishedOn: string, retentionDays: number, now: Date): boolean {
  if (!publishedOn) return false;
  const published = new Date(`${publishedOn}T00:00:00Z`).getTime();
  if (Number.isNaN(published)) return false;
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  const ageDays = Math.round((today - published) / (1000 * 60 * 60 * 24));
  return ageDays <= retentionDays;
}

// 头部原样保留 + 尾部按记忆轮换。fail-open: 记忆缺失/损坏一律视为全未上榜,
// 轮换候选不足时回退原排序填满, 绝不让轮换造成空榜或短榜。
export function rotateTail(
  repos: ScoredRepo[],
  topN: number,
  opts: RotationOpts,
  memoryPath: string,
  now: Date = new Date()
): ScoredRepo[] {
  // headSlots 不能超过 topN, 否则尾部配额为负; 也不能超过池子长度
  const headSlots = Math.min(opts.headSlots, topN, repos.length);
  const head = repos.slice(0, headSlots);

  if (opts.retentionDays <= 0) return repos.slice(0, topN);

  const memory = readMemory(memoryPath);
  const tailPool = repos.slice(headSlots);
  const tailNeed = topN - head.length;

  const rotated = memory
    ? tailPool.filter(
        r => !isWithinRetention(memory[r.nameWithOwner] ?? '', opts.retentionDays, now)
      )
    : tailPool;

  const tail = rotated.slice(0, tailNeed);

  // 可轮换候选不足: 回退原排序补满, 保证条目数不因轮换而缩水
  if (tail.length < tailNeed) {
    const picked = new Set(tail.map(r => r.nameWithOwner));
    for (const r of tailPool) {
      if (tail.length >= tailNeed) break;
      if (!picked.has(r.nameWithOwner)) tail.push(r);
    }
    if (tail.length < tailNeed) {
      logWarn(
        'rotation',
        `${memoryPath}: 轮换后仅 ${tail.length}/${tailNeed} 条可填, 已回退原排序(池子 ${tailPool.length} 条)`
      );
    }
  }

  return [...head, ...tail];
}

// 发布成功后回写本期尾部名单。retentionDays <= 0 表示轮换关闭, 不产生文件。
export function recordRotation(
  names: string[],
  memoryPath: string,
  retentionDays: number,
  now: Date = new Date()
): void {
  if (retentionDays <= 0) return;

  const memory = readMemory(memoryPath) ?? {};
  const today = now.toISOString().slice(0, 10);

  for (const name of names) {
    memory[name] = today;
  }

  const active: RotationMemory = {};
  for (const [name, publishedOn] of Object.entries(memory)) {
    if (isWithinRetention(publishedOn, retentionDays, now)) active[name] = publishedOn;
  }

  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  fs.writeFileSync(memoryPath, JSON.stringify(active, null, 2) + '\n', 'utf-8');
}
