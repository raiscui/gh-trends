import { HttpError, logInfo } from '../utils/logging';

export interface ClickHouseResponse {
  data: ClickHouseRepo[];
  statistics: { rows_read: number };
}

export interface ClickHouseRepo {
  repoName: string; // e.g, "owner/repo"
  starsBefore: string; // stars count before the scan window
  starsWithin: string; // stars count within the scan window
  starsRecent: string; // 窗口后半段的 star 数(accel 分子)
  starsEarlier: string; // 窗口前半段的 star 数(accel 分母)
  firstSeenAt: string; // e.g, 2025-07-20 00:48:54
}

// SQL 生成的全部入参。从 class 私有方法提出来成为纯函数, 便于单测断言。
export interface TrendingReposQueryOpts {
  evalDate: Date;
  windowDays: number;
  historyDays: number; // WHERE 时间轴长度, 供 starsBefore 判定真实历史
  limitA: number; // 通道 A 配额: 有 base 的加速项目
  growthRate: number; // 通道 A 相对增速门槛(starsWithin/starsBefore)
  channelBMinStars: number; // 通道 B 绝对门槛: 从零爆火项目
  channelBLimit: number; // 通道 B 配额
}

// 双通道趋势查询(specs/0001 D1):
//   通道 A —— 原有逻辑, starsBefore > 0 且窗口内相对增速超门槛("有 base 的加速");
//   通道 B —— starsBefore = 0 且窗口内绝对 star 数超门槛("从零爆火"的新项目)。
// 两通道条件互斥(>0 vs =0), UNION ALL 天然无重复。
// 窗口在时间中点劈半输出 starsRecent / starsEarlier, 供 select 阶段计算加速度。
export function buildTrendingReposQuery(opts: TrendingReposQueryOpts): string {
  // ClickHouse expects 2000-01-01 00:00:00 format; ISO is 2000-01-01T00:00:00.000Z
  const evalDateStr = opts.evalDate.toISOString().slice(0, 19).replace('T', ' ');
  // 劈半窗口用小时表达(7 天 -> 84h), 避免 INTERVAL 天数取整导致 recent/earlier 时长不对称
  const halfWindowHours = opts.windowDays * 12;

  return `
    WITH
        '${evalDateStr}'::timestamp AS END_DATE,
        END_DATE - INTERVAL ${opts.windowDays} DAY AS START_DATE,
        ${halfWindowHours} AS HALF_WINDOW_HOURS,
        repo_stats AS (
            SELECT
                repo_name,
                countIf(created_at < START_DATE) AS starsBefore,
                countIf(created_at >= START_DATE) AS starsWithin,
                countIf(created_at >= START_DATE + INTERVAL HALF_WINDOW_HOURS HOUR) AS starsRecent,
                countIf(created_at >= START_DATE AND created_at < START_DATE + INTERVAL HALF_WINDOW_HOURS HOUR) AS starsEarlier,
                min(created_at) AS firstSeenAt
            FROM github.events
            WHERE event_type = 'WatchEvent'
              AND created_at <= END_DATE
              AND created_at >= END_DATE - INTERVAL ${opts.historyDays} DAY
            GROUP BY repo_name
        )
    SELECT * FROM (
        SELECT
            repo_name AS repoName,
            starsBefore,
            starsWithin,
            starsRecent,
            starsEarlier,
            formatDateTime(firstSeenAt, '%Y-%m-%d %H:%i:%S') AS firstSeenAt
        FROM repo_stats
        WHERE starsBefore > 0 AND starsWithin / starsBefore > ${opts.growthRate}
        ORDER BY starsWithin DESC
        LIMIT ${opts.limitA}
    )
    UNION ALL
    SELECT * FROM (
        SELECT
            repo_name AS repoName,
            starsBefore,
            starsWithin,
            starsRecent,
            starsEarlier,
            formatDateTime(firstSeenAt, '%Y-%m-%d %H:%i:%S') AS firstSeenAt
        FROM repo_stats
        WHERE starsBefore = 0 AND starsWithin >= ${opts.channelBMinStars}
        ORDER BY starsWithin DESC
        LIMIT ${opts.channelBLimit}
    )
    FORMAT JSON
  `;
}

// 生态榜增速查询(ADR-0003)的入参。与主榜查询的差别只有"候选集从
// 全站趋势改成指定 repo 名单", 聚合口径(窗口劈半 / firstSeenAt)完全一致,
// 这样两路数据算出来的 starsPerHour 与 accel 才是同一把尺子。
export interface RepoGrowthQueryOpts {
  repoNames: string[];
  evalDate: Date;
  windowDays: number;
  historyDays: number;
}

// 生态榜取数: 只如实回报"这批 repo 在窗口内各拿到多少 star 事件",
// **不施加任何增长门槛** —— 门槛由上层 rankAndSlice 的排序隐式决定。
//
// 与主榜的通道 A/B 有本质区别: 主榜要先过爆发式增长门槛才能进池,
// 而生态榜的候选池来自 GitHub topic 搜索(生态全量), 排序权交给增速;
// 若这里也套门槛, 慢增长生态(Vercel AI SDK 周增速个位数)会被二次清空。
export function buildRepoGrowthQuery(opts: RepoGrowthQueryOpts): string {
  // ClickHouse expects 2000-01-01 00:00:00 format; ISO is 2000-01-01T00:00:00.000Z
  const evalDateStr = opts.evalDate.toISOString().slice(0, 19).replace('T', ' ');
  // 劈半窗口用小时表达(28 天 -> 336h), 避免 INTERVAL 天数取整导致 recent/earlier 时长不对称
  const halfWindowHours = opts.windowDays * 12;
  const nameList = opts.repoNames.map(escapeSqlLiteral).join(',');

  return `
    WITH
        '${evalDateStr}'::timestamp AS END_DATE,
        END_DATE - INTERVAL ${opts.windowDays} DAY AS START_DATE,
        ${halfWindowHours} AS HALF_WINDOW_HOURS
    SELECT
        repo_name AS repoName,
        countIf(created_at < START_DATE) AS starsBefore,
        countIf(created_at >= START_DATE) AS starsWithin,
        countIf(created_at >= START_DATE + INTERVAL HALF_WINDOW_HOURS HOUR) AS starsRecent,
        countIf(created_at >= START_DATE AND created_at < START_DATE + INTERVAL HALF_WINDOW_HOURS HOUR) AS starsEarlier,
        formatDateTime(min(created_at), '%Y-%m-%d %H:%i:%S') AS firstSeenAt
    FROM github.events
    WHERE event_type = 'WatchEvent'
      AND created_at <= END_DATE
      AND created_at >= END_DATE - INTERVAL ${opts.historyDays} DAY
      AND repo_name IN (${nameList})
    GROUP BY repo_name
    FORMAT JSON
  `;
}

// SQL 字符串字面量转义。repo 名来自 GitHub API(owner/name 形态, 正常只含
// [A-Za-z0-9._-]/), 但仍按 ClickHouse 的反斜杠转义规则处理, 避免
// 畸形输入拼出可执行的额外字面量。
function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export class ClickHouseClient {
  static readonly baseUrl = 'https://sql-clickhouse.clickhouse.com';

  async getTrendingRepos(windowInDays: number, limit: number): Promise<ClickHouseRepo[]> {
    // Enables querying historical windows, where now is eval date
    const evalDateStr = process.env.SCAN_EVAL_DATE || new Date().toISOString();
    const evalDate = new Date(evalDateStr);

    const sql = buildTrendingReposQuery({
      evalDate,
      windowDays: windowInDays,
      historyDays: parseInt(process.env.SCAN_HISTORY_DAYS ?? '60'),
      limitA: limit,
      growthRate: parseFloat(process.env.SCAN_MIN_GROWTH_RATE!),
      channelBMinStars: parseInt(process.env.SCAN_CHANNEL_B_MIN_STARS ?? '40'),
      channelBLimit: parseInt(process.env.SCAN_CHANNEL_B_LIMIT ?? '100'),
    });
    const result = await this.query(sql);
    return result.data;
  }

  // 生态榜取数(ADR-0003): 给指定 repo 名单取窗口内增速, 无增长门槛。
  //
  // 只返回**确实有 star 事件**的 repo —— 没有事件的 repo 增速为 0,
  // 排不进榜, 提前剔除可以少做一轮 GraphQL enrich。
  //
  // 名单可能很长(Vercel 191 / 视频 288), 故按 CHUNK 分批查询:
  // 单条 SQL 的 IN 列表过长会显著拖慢解析, 且一次失败要重跑全部。
  async getRepoGrowth(repoNames: string[], windowDays: number): Promise<ClickHouseRepo[]> {
    if (repoNames.length === 0) return [];

    const CHUNK = 200;
    const out: ClickHouseRepo[] = [];
    for (let i = 0; i < repoNames.length; i += CHUNK) {
      const chunk = repoNames.slice(i, i + CHUNK);
      const sql = buildRepoGrowthQuery({
        repoNames: chunk,
        evalDate: new Date(process.env.SCAN_EVAL_DATE || new Date().toISOString()),
        windowDays,
        // 历史时间轴要盖住"窗口前的 base"才能算出 starsBefore:
        // 至少 3 倍窗口, 保证劈半与基线都有足够样本(采样表本身很稀疏)
        historyDays: Math.max(90, windowDays * 3),
      });
      const result = await this.query(sql);
      out.push(...result.data);
    }
    return out;
  }

  private async query(sql: string): Promise<ClickHouseResponse> {
    const response = await fetch(ClickHouseClient.baseUrl, {
      method: 'POST',
      body: sql,
      headers: {
        'X-ClickHouse-User': 'demo',
        'X-ClickHouse-Key': '',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new HttpError('clickhouse', 'query execution failed', response);
    }

    const json = await response.json();
    const rowsRead = json.statistics.rows_read.toLocaleString();
    logInfo('clickhouse', `number of rows inspected: ${rowsRead}`);

    return {
      data: json.data,
      statistics: json.statistics,
    };
  }
}
