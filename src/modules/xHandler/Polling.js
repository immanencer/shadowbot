// pollMentionsAndReplies.js

import { composeTweetContent, getSimplifiedContext } from './TwitterService.js';

export async function pollMentionsAndReplies(service) {
  async function poll() {
    let timeout = 60000; // Default of 1 minute
    try {
      const userId = await service.getCachedUserId();
      const mentions = await service.rwClient.v2.userMentionTimeline(userId, {
        since_id: service.lastProcessedMentionId,
        'tweet.fields': ['created_at', 'author_id', 'referenced_tweets']
      });

      if (!mentions.data || mentions.data.meta.result_count === 0) {
        console.log('No new mentions found');
        return;
      }

      for (const mention of mentions.data.data) {
        if (mention.author_id === userId) {
          console.log('Skipping mention from self:', mention.id);
          continue;
        }

        await handleMention(service, mention);

        // Wait a bit between handling each mention
        await new Promise(resolve => setTimeout(resolve, 6660));
      }
    } catch (error) {
      console.error('Error polling mentions and replies:', error);
      if ((error.response?.status === 429 || error.code === 429) && !error.rateLimit?.reset) {
        console.warn('Rate limit (429) encountered, waiting 10 seconds...');
        await new Promise(r => setTimeout(r, 10000));
      }
      // If rate-limited and we have a reset time, adjust "timeout"
      if (error.rateLimit?.reset) {
        timeout = (error.rateLimit.reset * 1000) - Date.now();
      }
    } finally {
      // Schedule the next poll
      setTimeout(poll, timeout);
    }
  }

  // Start the initial poll
  poll();
}

export async function handleMention(service, mention) {
  const userId = await service.getCachedUserId();
  if (mention.author_id === userId) {
    console.log('Skipping mention from self:', mention.id);
    return;
  }

  try {
    // 1) Grab prior context from DB
    const conversationContext = await getSimplifiedContext(service, mention, true);
    console.log(`Found ${conversationContext.length} context messages`);

    // 2) Format that context
    const formattedContext = conversationContext
      .map(post => `<tweet author="${post.author_id === userId ? 'Mirquo' : 'Human'}">${post.text}</tweet>`)
      .join('\n');

    // 3) Generate the text content via the new function
    // e.g. composeTweetContent(userPrompt, additionalContext)
    const content = await composeTweetContent(mention.text, formattedContext);

    if (!content || !content.content) {
      console.warn('Failed to compose content for mention:', mention.id);
      return;
    }

    // 4) Post the reply
    const reply = await service.replyToTweet(mention.id, content);

    // 5) Store the mention in DB if needed
    await service.storeTweet({
      id: mention.id,
      text: mention.text,
      author_id: mention.author_id,
      created_at: mention.created_at
    });

    // 6) Mark as processed
    await service.saveLastProcessedMentionId(mention.id);
    return reply;

  } catch (error) {
    console.error('Error handling mention:', error);
  }
}

export async function loadLastProcessedMentionId(service) {
  try {
    const record = await service.authCollection.findOne({ type: 'last_processed_mention' });
    if (record) {
      service.lastProcessedMentionId = record.mentionId;
    }
  } catch (error) {
    console.error('Error loading last processed mention ID:', error);
  }
}

export async function saveLastProcessedMentionId(service, mentionId) {
  try {
    await service.authCollection.updateOne(
      { type: 'last_processed_mention' },
      { $set: { mentionId } },
      { upsert: true }
    );
    service.lastProcessedMentionId = mentionId;
  } catch (error) {
    console.error('Error saving last processed mention ID:', error);
  }
}