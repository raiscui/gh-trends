import { ButtondownPublisher } from '../publishers/buttondown';
import { GitHubPublisher } from '../publishers/github';
import { RSSPublisher } from '../publishers/rss';
import { logInfo } from '../utils/logging';
import { Publisher } from '../types/publisher';
import { ResendPublisher } from '../publishers/resend';
import { ReleaseSections } from './render';

const publishers = [
  // Executes in order
  new ButtondownPublisher(),
  new ResendPublisher(),
  new GitHubPublisher(),
  new RSSPublisher(),
];

export async function publishAll(
  sections: ReleaseSections,
  // Don't use below argument in production code
  // Enables injecting custom publishers for testing
  pubs: Publisher[] = publishers
): Promise<string[]> {
  const enabledPubs = pubs.filter(pub => pub.enabled());

  if (enabledPubs.length === 0) {
    logInfo('publish', 'no publishers enabled, skipping publication');
    return [];
  }

  const totalRepos = sections.main.length + sections.rust.length + sections.agent.length;
  if (totalRepos === 0) {
    logInfo('publish', 'no repositories to publish, skipping publication');
    return [];
  }

  logInfo('publish', `starting publication via ${enabledPubs.map(p => p.name).join(', ')}`);
  logInfo(
    'publish',
    `sections: main=${sections.main.length}, rust=${sections.rust.length}, agent=${sections.agent.length}`
  );

  // Run all publishers in parallel
  // Promise.allSettled always resolve, even if some promises reject
  const results = await Promise.allSettled(
    enabledPubs.map(async pub => {
      logInfo('publish', `publishing via ${pub.name}`);
      const messageId = await pub.publish(sections);
      logInfo('publish', `${pub.name} published successfully (ID: ${messageId})`);
      return messageId;
    })
  );

  const messageIds: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;

    if (result.status === 'fulfilled') {
      messageIds.push(result.value);
    } else {
      throw result.reason;
    }
  }

  return messageIds;
}
