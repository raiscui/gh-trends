import { Publisher } from '../types/publisher';
import { ButtondownClient } from '../clients/buttondown';
import { render, ReleaseSections } from '../pipeline/render';

export class ButtondownPublisher extends Publisher {
  readonly name = 'buttondown';

  enabled(): boolean {
    return process.env.BUTTONDOWN_ENABLED === 'true';
  }

  render(sections: ReleaseSections): string {
    // email 渠道(若启用)目前只渲染主榜;Rust / Agent 三段由 GitHub release / RSS 承担。
    // html.hbs / text.hbs 内部用 sections.main,这里整段 sections 透传即可。
    return render('html.hbs', sections);
  }

  async publish(sections: ReleaseSections): Promise<string> {
    const content = this.render(sections);
    const client = new ButtondownClient(process.env.BUTTONDOWN_API_KEY);
    const result = await client.sendEmail({
      subject: this.subject(),
      body: content,
      email_type: 'public',
    });

    return result.id;
  }
}
