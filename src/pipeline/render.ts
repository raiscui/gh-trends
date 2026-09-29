import { readFileSync } from 'fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { ScoredRepo } from './select';

// 模板注入的 sections 数据。五段 markdown(html / text 也是同样结构)。
// 每个 section 是一个已排好序的 ScoredRepo 列表,模板按 `@index < sectionTopN` 渲染前 N 个。
// ponytail: 顶层 key 叫 sections 而不是 release;字段命名跟上下文"垂直榜单"对齐。
export interface ReleaseSections {
  main: ScoredRepo[];
  rust: ScoredRepo[];
  agent: ScoredRepo[];
  deepseekHarness: ScoredRepo[];
  vercelAiSdk: ScoredRepo[];
}

Handlebars.registerHelper('lt', (a, b) => a < b);
Handlebars.registerHelper('gte', (a, b) => a >= b);
Handlebars.registerHelper('and', (a, b) => a && b);
Handlebars.registerHelper('formatNumber', (num: number) => num.toLocaleString());
Handlebars.registerHelper('truncate', (str: string, len: number) => {
  if (len <= 0) return str;
  if (str.length <= len) return str;
  if (str[len - 1] === ' ') len -= 1; // trailing space
  return str.slice(0, len) + '…';
});

export function render(templateName: string, sections: ReleaseSections): string {
  // Read template file from src; only *.ts files are compiled to dist/
  const absolutePath = path.join(process.cwd(), 'src', 'templates', templateName);
  const templateSource = readFileSync(absolutePath, 'utf-8');
  const template = Handlebars.compile(templateSource);

  const now = new Date();
  const date = now.toISOString().split('T')[0];

  const descLimit = parseInt(process.env.RELEASE_TRUNCATE_DESC!);
  return template({ sections, date, descLimit });
}
