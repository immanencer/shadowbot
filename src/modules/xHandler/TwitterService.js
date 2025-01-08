// TwitterService.js
import dotenv from 'dotenv';
dotenv.config();

import { TwitterApi } from 'twitter-api-v2';
import { fileURLToPath } from 'url';
import { TwitterApiRateLimitPlugin } from '@twitter-api-v2/plugin-rate-limit';
import { TwitterApiAutoTokenRefresher } from '@twitter-api-v2/plugin-token-refresher';
import fs from 'fs';
import path from 'path';

import credentialService from '../../services/credentialService.js';
import { uploadImage } from '../../services/s3Service.js';
import { TwitterAuthManager } from './TwitterAuthManager.js';
import { Metrics } from './Metrics.js';
import { pollMentionsAndReplies } from './Polling.js';
import { initializeMongo, storeTweet } from './TwitterMongo.js';

// Import our new prompt utility
import { generateTweet } from '../../services/promptService.js';

// --------------------------------------------------
// Utility-like method (was composeContent in old code)
// --------------------------------------------------
export async function composeTweetContent(basePrompt, context = '') {
  const result = await generateTweet(basePrompt, context, { maxAttempts: 5, maxLength: 600 });
  if (result.success) {
    return { type: 'text', content: result.tweet };
  }
  console.error('composeTweetContent error:', result.error);
  return { type: 'text', content: null };
}

// --------------------------------------------------
// Exports from old utility (slimmed down):
// getSimplifiedContext used in mention handling
// --------------------------------------------------
// --------------------------------------------------
// Exports from old utility (slimmed down):
// getSimplifiedContext used in mention handling
// --------------------------------------------------
export async function getSimplifiedContext(service, mention, isReply = false) {
  if (!mention || !mention.text || !mention.author_id) return [];
  const userId = await service.getCachedUserId();

  // Grab context from mention’s author
  const authorContext = await service.searchContext(mention.text, mention.author_id);

  // And from the bot’s own prior posts
  const botContext = await service.searchContext('', userId);

  // Combine
  const combined = [...authorContext, ...botContext];

  // 1. Filter out any post whose entire text is just a URL.
  //    For a match, we'll consider http(s):// OR www. pattern with no extra text.
  const isJustUrl = (text = '') =>
    /^(https?:\/\/[^\s]+|www\.[^\s]+)$/i.test(text.trim());

  const filtered = combined.filter((post) => {
    if (!post?.text) return false; // no text at all
    return !isJustUrl(post.text);
  });

  // 2. Deduplicate by text (case-sensitive).
  //    If you want it case-insensitive, you could lowercase before comparing.
  const unique = filtered.filter((post, idx, self) =>
    idx === self.findIndex((p) => p.text === post.text)
  );

  // 3. Return the first 33 items if you want to limit the array size.
  return unique.slice(0, 33);
}

// --------------------------------------------------
// The main class
// --------------------------------------------------
let pollingTimeout;

export class TwitterService {
  constructor() {
    this.authManager = new TwitterAuthManager();
    this.lastProcessedMentionId = null;

    this.pollingInterval = 3600000; // 1 hour
    this.dailyPostLimit = 100;
    this.monthlyReadLimit = 100;

    this.dailyPosts = 0;
    this.monthlyReads = 0;

    this.lastDailyReset = new Date();
    this.lastMonthlyReset = new Date();

    this.dailyPostsUsed = 0;
    this.dailyRepliesUsed = 0;

    // Ratios used in your code
    this.dailyPostRatio = 0.2;  // 20% new tweets
    this.dailyReplyRatio = 0.8; // 80% replies

    this.userCache = {
      userId: null,
      lastFetched: 0,
      ttl: 5 * 60 * 1000 // 5 minutes
    };
  }

  // Static initializer: sets up DB, metrics, authentication, etc.
  static async initialize() {
    const service = new TwitterService();
    await service.initializeMongo(); // initialize your DB
    service.metrics = new Metrics(service.db);
    setInterval(() => service.metrics.saveMetrics(), 3600000);

    await service.authenticate();
    await service.loadLastProcessedMentionId();
    return service;
  }

  async initializeMongo() {
    await initializeMongo(this);
  }

  // OAuth
  async authenticate() {
    try {
      const credentials = await credentialService.getValidCredentials();
      if (!credentials) return false;

      const rateLimitPlugin = new TwitterApiRateLimitPlugin();
      const autoRefresherPlugin = new TwitterApiAutoTokenRefresher({
        refreshToken: credentials.refreshToken,
        refreshCredentials: {
          clientId: process.env.X_CLIENT_ID,
          clientSecret: process.env.X_CLIENT_SECRET,
        },
        onTokenUpdate: async (token) => {
          await credentialService.storeCredentials({
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresIn: token.expiresIn ?? 7200
          });
        },
        onTokenRefreshError: (err) => {
          console.error('Token refresh error:', err);
        }
      });

      this.rwClient = new TwitterApi(credentials.accessToken, {
        plugins: [rateLimitPlugin, autoRefresherPlugin]
      });
      return true;
    } catch (error) {
      console.error('Authentication error:', error);
      return false;
    }
  }

  // For storing new tokens if we get them
  async storeTokens(accessToken, refreshToken, expiresIn) {
    try {
      await credentialService.storeCredentials({ accessToken, refreshToken, expiresIn });
    } catch (error) {
      console.error('Error storing tokens:', error);
    }
  }

  // Reuse your existing storeTweet function from TwitterMongo or directly:
  async storeTweet(tweet) {
    await storeTweet(this, tweet);
  }

  // Example searchContext
  async searchContext(text, authorId) {
    const keywords = text.split(/\s+/).filter(word => word.length > 3);
    const keywordRegex = new RegExp(
      keywords.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'i'
    );

    return await this.tweetsCollection.find({
      $or: [
        { text: keywordRegex },
        { author_id: authorId }
      ],
    }).toArray();
  }

  // Resets counters at midnight or month boundary
  resetCountersIfNeeded() {
    const now = new Date();
    if (now.getDate() !== this.lastDailyReset.getDate()) {
      this.dailyPosts = 0;
      this.dailyPostsUsed = 0;
      this.dailyRepliesUsed = 0;
      this.lastDailyReset = now;
    }
    if (now.getMonth() !== this.lastMonthlyReset.getMonth()) {
      this.monthlyReads = 0;
      this.lastMonthlyReset = now;
    }
  }

  // Generic helper to store images, etc.
  async postImage(imageBuffer) {
    this.resetCountersIfNeeded();
    if (this.dailyPosts >= this.dailyPostLimit) {
      console.log('Daily post limit reached.');
      return null;
    }
    try {
      const uploadClient = new TwitterApi({
        appKey: process.env.X_API_KEY,
        appSecret: process.env.X_API_SECRET,
        accessToken: process.env.X_ACCESS_TOKEN,
        accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
      });
      const mediaId = await this.retryFetch(() =>
        uploadClient.v1.uploadMedia(Buffer.from(imageBuffer), { mimeType: 'image/png' })
      );
      const response = await this.retryFetch(() =>
        this.rwClient.v2.tweet({ media: { media_ids: [mediaId] } })
      );
      this.dailyPosts += 1;
      return response;
    } catch (error) {
      console.error('Error posting image:', error);
      return null;
    }
  }

  // Standard "post a tweet" flow
  async postTweet(content) {
    this.resetCountersIfNeeded();
    if (this.dailyPosts >= this.dailyPostLimit) {
      console.log('Daily post limit reached.');
      return null;
    }
    const maxDailyPosts = Math.floor(this.dailyPostLimit * this.dailyPostRatio);
    if (this.dailyPostsUsed >= maxDailyPosts) {
      console.log('Daily post ratio reached.');
      return null;
    }

    try {
      if (content.type === 'image') {
        // If content includes an image buffer
        const mediaId = await this.uploadImageToS3(content.content);
        const imageResponse = await this.rwClient.v2.tweet({ media: { media_ids: [mediaId] } });
        // Optional: If you also have text in `content.prompt`, post it as reply
        if (content.prompt) {
          await this.rwClient.v2.reply({ text: content.prompt }, imageResponse.data.id);
        }
        return imageResponse;
      }

      // content.type === 'text'
      const tweetPayload = { text: content.content };
      const response = await this.rwClient.v2.tweet(tweetPayload);

      await this.storeTweet({
        id: response.data.id,
        text: content.content,
        author_id: await this.getCachedUserId(),
        created_at: new Date().toISOString()
      });
      this.dailyPostsUsed += 1;
      return response;
    } catch (error) {
      console.error('Error posting tweet:', error);
      return null;
    }
  }

  // Helper to upload to S3, then upload to Twitter
  async uploadImageToS3(imageBuffer) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const tempFilePath = path.join(__dirname, 'temp_image.png');
    fs.writeFileSync(tempFilePath, imageBuffer);

    try {
      const imageUrl = await uploadImage(tempFilePath);
      console.log('Image uploaded to S3 successfully:', imageUrl);

      // Upload to Twitter
      const uploadClient = new TwitterApi({
        appKey: process.env.X_API_KEY,
        appSecret: process.env.X_API_SECRET,
        accessToken: process.env.X_ACCESS_TOKEN,
        accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
      });
      const mediaId = await uploadClient.v1.uploadMedia(Buffer.from(imageBuffer), { mimeType: 'image/png' });
      console.log('Image uploaded to Twitter as media ID:', mediaId);

      return mediaId;
    } catch (error) {
      console.error('Error uploading image to S3:', error);
      throw error;
    } finally {
      fs.unlinkSync(tempFilePath);
    }
  }

  async replyToTweet(tweetId, content) {
    this.resetCountersIfNeeded();
    const maxDailyReplies = Math.floor(this.dailyPostLimit * this.dailyReplyRatio);
    if (this.dailyRepliesUsed >= maxDailyReplies) {
      console.log('Daily reply ratio reached.');
      return null;
    }

    try {
      if (content.type === 'image') {
        // If content is an image buffer
        const mediaId = await this.uploadImageToS3(content.content);
        const response = await this.retryFetch(() =>
          this.rwClient.v2.reply({ text: content.prompt || '', media: { media_ids: [mediaId] } }, tweetId)
        );
        await this.storeTweet({
          id: response.data.id,
          text: content.prompt || 'Image reply',
          author_id: await this.getCachedUserId(),
          created_at: new Date().toISOString()
        });
        this.dailyRepliesUsed += 1;
        return response;
      }

      // content.type === 'text'
      if (!content.content) {
        console.error('No content provided for reply');
        return null;
      }
      const response = await this.retryFetch(() =>
        this.rwClient.v2.reply(content.content, tweetId)
      );
      await this.storeTweet({
        id: response.data.id,
        text: content.content,
        author_id: await this.getCachedUserId(),
        created_at: new Date().toISOString()
      });
      this.dailyRepliesUsed += 1;
      return response;
    } catch (error) {
      console.error('Error replying to tweet:', error);
      return null;
    }
  }

  // For mention polling
  async loadLastProcessedMentionId() {
    try {
      const record = await this.authCollection.findOne({ type: 'last_processed_mention' });
      if (record) {
        this.lastProcessedMentionId = record.mentionId;
      }
    } catch (error) {
      console.error('Error loading last processed mention ID:', error);
    }
  }

  async saveLastProcessedMentionId(mentionId) {
    try {
      await this.authCollection.updateOne(
        { type: 'last_processed_mention' },
        { $set: { mentionId } },
        { upsert: true }
      );
      this.lastProcessedMentionId = mentionId;
    } catch (error) {
      console.error('Error saving last processed mention ID:', error);
    }
  }

  async getCachedUserId() {
    if (this.userCache.userId && (Date.now() - this.userCache.lastFetched) < this.userCache.ttl) {
      return this.userCache.userId;
    }
    try {
      const user = await this.rwClient.currentUserV2();
      this.userCache.userId = user.data.id;
      this.userCache.lastFetched = Date.now();
      return user.data.id;
    } catch (error) {
      console.error('Error getting cached user ID:', error);
      return null;
    }
  }

  async pollMentionsAndReplies() {
    return pollMentionsAndReplies(this);
  }

  // Example of how we handle a mention
  async handleMention(mention) {
    const userId = await this.getCachedUserId();
    if (mention.author_id === userId) {
      console.log('Skipping mention from self:', mention.id);
      return;
    }

    // Basic: fetch context from the mention’s text + author
    const contextDocs = await this.searchContext(mention.text, mention.author_id);
    const contextText = contextDocs.map(doc => `<tweet>${doc.text}</tweet>`).join('\n');

    // Actually generate a short reply using new prompt service
    const content = await composeTweetContent(mention.text, `Context:\n${contextText}`);
    const reply = await this.replyToTweet(mention.id, content);

    // Store the mention itself
    await this.storeTweet({
      id: mention.id,
      text: mention.text,
      author_id: mention.author_id,
      // If you have expansions, you could also store mention.author_username
      created_at: mention.created_at
    });

    // Mark mention as processed
    await this.saveLastProcessedMentionId(mention.id);
    return reply;
  }

  // Example: fetch user timeline w/ expansions for username
  async fetchRelevantPosts() {
    this.resetCountersIfNeeded();
    if (this.monthlyReads >= this.monthlyReadLimit) {
      console.log('Monthly read limit reached.');
      return [];
    }
    try {
      const userId = await this.getCachedUserId();
      const timeline = await this.retryFetch(() =>
        this.rwClient.v2.userTimeline(userId, {
          max_results: 5,
          expansions: ['author_id'],
          'user.fields': ['username']
        })
      );

      // If we got timeline data, store tweets with username
      if (timeline?.data?.data?.length) {
        const userMap = new Map();
        // timeline.includes?.users might hold user objects
        (timeline.includes?.users || []).forEach(u => {
          userMap.set(u.id, u.username);
        });

        for (const tweet of timeline.data.data) {
          await this.storeTweet({
            id: tweet.id,
            text: tweet.text,
            author_id: tweet.author_id,
            author_username: userMap.get(tweet.author_id) || null,
            created_at: tweet.created_at
          });
        }

        this.monthlyReads++;
        return timeline.data.data;
      }

      console.log('Falling back to DB for relevant posts');
      return await this.fetchRelevantPostsFromDB();
    } catch (error) {
      console.error('Error fetching posts from API:', error);
      console.log('Falling back to DB for relevant posts');
      return await this.fetchRelevantPostsFromDB();
    }
  }

  // DB fallback
  async fetchRelevantPostsFromDB() {
    try {
      return await this.tweetsCollection
        .find({})
        .sort({ created_at: -1 })
        .limit(5)
        .toArray();
    } catch (error) {
      console.error('Error fetching posts from DB:', error);
      return [];
    }
  }

  // Basic helper to handle rate-limit retries
  async retryFetch(fetchFunction, maxRetries = 3) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fetchFunction();
      } catch (error) {
        lastError = error;
        if (error.code === 429 && error.rateLimit?.reset) {
          const waitTime = (error.rateLimit.reset * 1000) - Date.now() + 1000;
          console.log(`Rate limit; waiting ${waitTime / 1000}s before retry.`);
          await new Promise(res => setTimeout(res, waitTime));
        } else {
          // Not a rate limit or missing .rateLimit data
          if (i >= maxRetries - 1) throw lastError;
        }
      }
    }
  }

  // Possibly store rate-limit info in DB if you want
  async storeRateLimit(info) {
    try {
      await this.db.collection('rate_limits').updateOne(
        { endpoint: info.endpoint },
        {
          $set: {
            reset: info.reset,
            limit: info.limit,
            remaining: info.remaining,
            updated_at: new Date()
          }
        },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error storing rate limit info:', error);
    }
  }

  // Summarize recent posts
  async composePost(systemPrompt, memoryPrompt, context) {
    try {
      const relevantPosts = await this.fetchRelevantPosts();
      if (!Array.isArray(relevantPosts) || relevantPosts.length === 0) {
        console.warn('No relevant posts found, using default “interesting thought” prompt.');
        return await composeTweetContent('Share an interesting thought');
      }

      const formattedPosts = relevantPosts
        .filter(p => p?.text)
        .map(p => `Post: ${p.text}`)
        .join('\n');

      // Possibly use your own specialized summarizer:
      // e.g. using aiHandler.generateResponse(...) if you want.
      const summaryPrompt = `
System: ${systemPrompt}
Memory: ${memoryPrompt}
Context: ${context}
Here are some recent posts:
${formattedPosts}
Please summarize and produce a short tweet.
`;

      const shortTweet = await composeTweetContent(summaryPrompt);
      // shortTweet => { type: 'text', content: '...' }

      // If you want to parse out mentions or something:
      const mentionMatches = shortTweet.content?.match(/@[a-zA-Z0-9_]+/g) || [];
      const mentions = mentionMatches.map(h => h.slice(1));

      return {
        content: shortTweet.content,
        entities: { mentions }
      };
    } catch (error) {
      console.error('Error in composePost:', error);
      return null;
    }
  }

  async makeRequest(endpoint, apiCall) {
    try {
      const response = await apiCall();
      return response.data;
    } catch (error) {
      if (error.response?.status === 429) {
        console.warn(`Rate limit for ${endpoint}, retrying...`);
        return this.makeRequest(endpoint, apiCall);
      }
      throw error;
    }
  }

  async generateImageDescription() {
    try {
      const memories = await this.fetchRelevantPosts();
      const memoryText = memories.map(m => m.text).join('\n');
      // You can also adapt your new prompt system or do a direct LLM call:
      const prompt = `
Based on these memories, generate a creative, engaging description for an image:
${memoryText}
`;
      const { success, tweet, error } = await generateTweet(prompt, '', { maxAttempts: 5, maxLength: 600 });
      if (!success) {
        console.error('Error generating image description:', error);
        return null;
      }
      return tweet.trim();
    } catch (error) {
      console.error('Error generating image description:', error);
      return null;
    }
  }

  async like(tweetId) {
    return this.rwClient.v2.like(await this.getCachedUserId(), tweetId);
  }

  async follow(userId) {
    return this.rwClient.v2.follow(await this.getCachedUserId(), userId);
  }
}

// --------------------------------------------------
// Polling Setup & Export
// --------------------------------------------------
async function setupPolling(service) {
  let error = null;
  try {
    await service.pollMentionsAndReplies();
  } catch (err) {
    error = err;
    if (error?.message.includes('Rate limit exceeded after')) {
      console.error('Max retry attempts reached. Next poll cycle instead of exit.');
    } else {
      console.error('Polling error:', error);
    }
  } finally {
    const nextInterval = error?.code === 429
      ? Math.min(service.pollingInterval * 2, 3600000) // cap at 1 hour
      : service.pollingInterval;

    pollingTimeout = setTimeout(() => setupPolling(service), nextInterval);
  }
}

export function cleanup() {
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
  }
}

// Initialize at the bottom
await credentialService.initialize(process.env.MONGODB_URI);
const twitterService = await TwitterService.initialize();
setupPolling(twitterService);

export default twitterService;