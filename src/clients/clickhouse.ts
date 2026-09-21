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
