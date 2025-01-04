import { TwitterService } from './TwitterService.js';

export async function pollMentionsAndReplies(service) {
    async function poll() {
        let timeout = 60000; // Default timeout of 1 minute
        try {
            const userId = await service.getCachedUserId();
            const mentions = await service.rwClient.v2.userMentionTimeline(userId);

            for (const mention of mentions.data.data) {
                await handleMention(service, mention);
                await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds between mentions
            }
        } catch (error) {
            console.error('Error polling mentions and replies:', error);
            if (error.rateLimit?.reset) {
                timeout = (error.rateLimit.reset * 1000) - Date.now();
            }
        } finally {
            setTimeout(poll, timeout); // Schedule next poll
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

    // Ensure we skip if the mention references a tweet from the bot
    if (mention?.referenced_tweets) {
        for (const ref of mention.referenced_tweets) {
            if (ref.type === 'replied_to') {
                const originalTweet = await service.tweetsCollection.findOne({ id: ref.id });
                if (originalTweet && originalTweet.author_id === userId) {
                    console.log('Skipping mention that replies to the bot\'s own post:', mention.id);
                    return;
                }
            }
        }
    }

    try {
        // Existing context search
        const context = await service.searchContext(mention.text, mention.author_id);

        // Include the bot's own prior posts
        const botPosts = await service.searchContext('', userId);
        const combinedContext = context.concat(botPosts);

        // Deduplicate posts
        const uniqueContext = combinedContext.filter((post, index, self) =>
            index === self.findIndex((p) => p.id === post.id)
        );

        const contextText = uniqueContext.map(post => `<tweet>${post.text}</tweet>`).join('\n');
        const content = await service.composeContent(`${mention.text}\n\nContext:\n${contextText}`);
        
        if (!content) {
            console.warn('Failed to compose content for mention:', mention.id);
            return;
        }
        const reply = await service.replyToTweet(mention.id, content);

        await service.storeTweet({
            id: mention.id,
            text: mention.text,
            author_id: mention.author_id,
            created_at: mention.created_at
        });

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
