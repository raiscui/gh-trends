import { logInfo, TaggedError } from '../utils/logging';
import { Publisher } from '../types/publisher';
import { render, ReleaseSections } from '../pipeline/render';
import { GitHubClient } from '../clients/github';

export class GitHubPublisher extends Publisher {
  readonly name = 'github-releases';

  // ponytail: epoch 只用作"算日距"的参考点;真正的 tag 用日期而不是序号。
  // 跟 weekly 时代兼容(2025-07-21 当 day 0),但 daily schedule 下每天天然唯一。
  readonly epoch = '2025-07-21';

  enabled(): boolean {
    return process.env.GITHUB_RELEASES_ENABLED === 'true';
  }

  render(sections: ReleaseSections): string {
    return render('markdown.hbs', sections);
  }

  async publish(sections: ReleaseSections): Promise<string> {
    const repo = process.env.GITHUB_RELEASES_REPO;

    if (!repo) {
      throw new TaggedError(
        'config',
        'GITHUB_RELEASES_REPO required when GITHUB_RELEASES_ENABLED=true'
      );
    }

    const tag = this.releaseTag();
    const client = new GitHubClient(process.env.GITHUB_TOKEN);

    // ponytail: 同一日重跑(retry / schedule 抖动)才命中,正常 cron 每日独立 tag。
    const existing = await client.getReleaseByTag(repo, tag);
    if (existing) {
      logInfo('github-releases', `release ${tag} already published (id=${existing.id}); skip`);
      return `release-already-exists-${existing.id}`;
    }

    const content = this.render(sections);
    const result = await client.createRelease(repo, {
      tag_name: tag,
      name: this.subject(),
      body: content,
      draft: false,
      prerelease: false,
    });

    return result.id;
  }

  subject(): string {
    return `GitHub trends — ${this.dayTag()}`;
  }

  private releaseTag(): string {
    return `daily-${this.dayTag()}`;
  }

  // YYYY-MM-DD (UTC):把 eval date 锚到 epoch 0 点后按整天取整。
  // 既保证历史回放 (SCAN_EVAL_DATE) 可复现,也保证不同时区跑出来仍是同一天 tag。
  private dayTag(): string {
    const evalDateStr = process.env.SCAN_EVAL_DATE || new Date().toISOString();
    const now = new Date(evalDateStr);

    const startMs = new Date(this.epoch).getTime();
    if (now.getTime() < startMs) {
      throw new Error('Release date is before epoch. Cannot calculate day tag.');
    }

    const dayInMillis = 1000 * 60 * 60 * 24;
    const daysPassed = Math.floor((now.getTime() - startMs) / dayInMillis);
    const dayDate = new Date(startMs + daysPassed * dayInMillis);
    return dayDate.toISOString().slice(0, 10);
  }
}
