import { weekNumber } from '../utils/common';
import { ReleaseSections } from '../pipeline/render';

// abstract base。所有 publisher 一律接 ReleaseSections(主榜 + Rust + Agent 三段),
// 由各 publisher 自行决定怎么用(渲染 markdown / 用 main 做 RSS item / 等)。
//
// ponytail: 不做 VerticalSectionPublisher 子类继承;abstract publish(sections)
// 统一签名更直接,各 publisher 内部取 sections.main 或 sections 整体都自由。
export abstract class Publisher {
  abstract readonly name: string;
  abstract enabled(): boolean;
  render?(sections: ReleaseSections): string | object;
  abstract publish(sections: ReleaseSections): Promise<string>;

  subject(): string {
    const now = new Date();
    const year = now.getFullYear();
    const week = weekNumber(now);
    return `GitHub Trends - ${year}-W${week.toString().padStart(2, '0')}`;
  }
}
