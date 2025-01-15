// TwitterService.js
import dotenv from 'dotenv';
dotenv.config();

import { TwitterApi } from 'twitter-api-v2';
import { fileURLToPath } from 'url';
import { TwitterApiRateLimitPlugin } from '@twitter-api-v2/plugin-rate-limit';
import { TwitterApiAutoTokenRefresher } from '@twitter-api-v2/plugin-token-refresher';

import fs from 'fs'; // For synchronous file writes (temp file)
import path from 'path';
import { promises as fsPromises } from 'fs'; // For async file reads

import * as fuzzball from 'fuzzball'; // Used in fetchRelevantPosts() similarity checks

import credentialService from '../../services/credentialService.js';
import { uploadImage } from '../../services/s3Service.js';
import { TwitterAuthManager } from './TwitterAuthManager.js';
import { Metrics } from './Metrics.js';
import { pollMentionsAndReplies } from './Polling.js';
import { initializeMongo, storeTweet } from './TwitterMongo.js';

// Our prompt utility
import { generateTweet } from '../../services/promptService.js';

/**
 * Utility method to generate tweet text via an LLM-based prompt.
 */
export async function composeTweetContent(basePrompt, context = '') {
  const result = await generateTweet(basePrompt, context, { maxAttempts: 5, maxLength: 600 });
  if (result.success) {
    return { type: 'text', content: result.tweet };
  }
  console.error('composeTweetContent error:', result.error);
  return { type: 'text', content: null };
}

/**
 * Provide simplified context for mention/reply generation.
 */
export async function getSimplifiedContext(service, mention) {
  if (!mention || !mention.text || !mention.author_id) return [];

  const userId = await service.getCachedUserId();

  // Grab context from mention’s author, plus the bot's own prior posts
  const authorContext = await service.searchContext(mention.text, mention.author_id);
  const botContext = await service.searchContext('', userId);

  // Combine
  const combined = [...authorContext, ...botContext];

  // 1. Filter out any post that is just a URL
  const isJustUrl = (text = '') => /^(https?:\/\/[^\s]+|www\.[^\s]+)$/i.test(text.trim());
  const filtered = combined.filter((post) => {
    if (!post?.text) return false;
    return !isJustUrl(post.text);
  });

  // 2. Deduplicate by text (case-sensitive)
  const unique = filtered.filter(
    (post, idx, self) => idx === self.findIndex((p) => p.text === post.text)
  );

  // 3. Limit array size if desired
  return unique.slice(0, 33);
}

/**
 * Main TwitterService class
 */
let pollingTimeout; // For mention polling

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

    // Track usage for ratio-limited tweeting
    this.dailyPostsUsed = 0;
    this.dailyRepliesUsed = 0;
    this.dailyPostRatio = 0.2;  // 20% new tweets
    this.dailyReplyRatio = 0.8; // 80% replies

    this.userCache = {
      userId: null,
      lastFetched: 0,
      ttl: 5 * 60 * 1000, // 5 minutes
    };

    // Keep track of posted NFTs by mint
    this.postedNFTs = new Set();
  }

  /**
   * Static init: sets up DB, metrics, authentication, etc.
   */
  static async initialize() {
    const service = new TwitterService();
    await service.initializeMongo();
    service.metrics = new Metrics(service.db);
    setInterval(() => service.metrics.saveMetrics(), 3600000); // Hourly metrics update

    // OAuth
    await service.authenticate();

    // Load last mention
    await service.loadLastProcessedMentionId();
    return service;
  }

  async initializeMongo() {
    await initializeMongo(this);
  }

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
            expiresIn: token.expiresIn ?? 7200,
          });
        },
        onTokenRefreshError: (err) => {
          console.error('Token refresh error:', err);
        },
      });

      // Create read-write client
      this.rwClient = new TwitterApi(credentials.accessToken, {
        plugins: [rateLimitPlugin, autoRefresherPlugin],
      });
      return true;
    } catch (error) {
      console.error('Authentication error:', error);
      return false;
    }
  }

  async storeTokens(accessToken, refreshToken, expiresIn) {
    try {
      await credentialService.storeCredentials({ accessToken, refreshToken, expiresIn });
    } catch (error) {
      console.error('Error storing tokens:', error);
    }
  }

  async storeTweet(tweet) {
    await storeTweet(this, tweet);
  }

  /**
   * Example "searchContext" method:
   * - splits text into keywords,
   * - looks for those in the DB
   * - or matches author_id
   */
  async searchContext(text, authorId) {
    const keywords = text.split(/\s+/).filter((word) => word.length > 3);
    const keywordRegex = new RegExp(
      keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'i'
    );

    return this.tweetsCollection
      .find({
        $or: [
          { text: keywordRegex },
          { author_id: authorId },
        ],
      })
      .toArray();
  }

  /**
   * Resets counters daily and monthly
   */
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

  /**
   * Post an image to Twitter
   */
  async postImage(imageBuffer) {
    this.resetCountersIfNeeded();
    if (this.dailyPosts >= this.dailyPostLimit) {
      console.log('Daily post limit reached.');
      return null;
    }
    try {
      // A separate client is used for v1 media upload
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

  /**
   * Post a text (or image) tweet
   */
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
      // If the content is an image buffer
      if (content.type === 'image') {
        const mediaId = await this.uploadImageToS3(content.content);
        const imageResponse = await this.rwClient.v2.tweet({ media: { media_ids: [mediaId] } });

        // If there's text in prompt, post it as a reply
        if (content.prompt) {
          await this.rwClient.v2.reply({ text: content.prompt }, imageResponse.data.id);
        }
        return imageResponse;
      }

      // Otherwise, text-based
      const tweetPayload = { text: content.content };
      const response = await this.rwClient.v2.tweet(tweetPayload);

      // Store in DB
      await this.storeTweet({
        id: response.data.id,
        text: content.content,
        author_id: await this.getCachedUserId(),
        created_at: new Date().toISOString(),
      });

      this.dailyPostsUsed += 1;
      return response;
    } catch (error) {
      console.error('Error posting tweet:', error);
      return null;
    }
  }

  /**
   * Helper to upload an image to S3, then Twitter.
   */
  async uploadImageToS3(imageBuffer) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const tempFilePath = path.join(__dirname, 'temp_image.png');

    // Synchronous write, then later remove
    fs.writeFileSync(tempFilePath, imageBuffer);

    try {
      const imageUrl = await uploadImage(tempFilePath);
      console.log('Image uploaded to S3 successfully:', imageUrl);

      // Then upload to Twitter
      const uploadClient = new TwitterApi({
        appKey: process.env.X_API_KEY,
        appSecret: process.env.X_API_SECRET,
        accessToken: process.env.X_ACCESS_TOKEN,
        accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
      });
      const mediaId = await uploadClient.v1.uploadMedia(Buffer.from(imageBuffer), {
        mimeType: 'image/png',
      });
      console.log('Image uploaded to Twitter. Media ID:', mediaId);

      return mediaId;
    } catch (error) {
      console.error('Error uploading image to S3/Twitter:', error);
      throw error;
    } finally {
      // Clean up local file
      fs.unlinkSync(tempFilePath);
    }
  }

  /**
   * Reply to a tweet
   */
  async replyToTweet(tweetId, content) {
    this.resetCountersIfNeeded();
    const maxDailyReplies = Math.floor(this.dailyPostLimit * this.dailyReplyRatio);

    if (this.dailyRepliesUsed >= maxDailyReplies) {
      console.log('Daily reply ratio reached.');
      return null;
    }

    try {
      if (content.type === 'image') {
        const mediaId = await this.uploadImageToS3(content.content);
        const response = await this.retryFetch(() =>
          this.rwClient.v2.reply({ text: content.prompt || '', media: { media_ids: [mediaId] } }, tweetId)
        );
        await this.storeTweet({
          id: response.data.id,
          text: content.prompt || 'Image reply',
          author_id: await this.getCachedUserId(),
          created_at: new Date().toISOString(),
        });
        this.dailyRepliesUsed += 1;
        return response;
      }

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
        created_at: new Date().toISOString(),
      });
      this.dailyRepliesUsed += 1;
      return response;
    } catch (error) {
      console.error('Error replying to tweet:', error);
      return null;
    }
  }

  /**
   * lastProcessedMentionId used in mention polling
   */
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
    if (
      this.userCache.userId &&
      Date.now() - this.userCache.lastFetched < this.userCache.ttl
    ) {
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

  /**
   * Handle an inbound mention
   */
  async handleMention(mention) {
    const userId = await this.getCachedUserId();
    if (mention.author_id === userId) {
      console.log('Skipping mention from self:', mention.id);
      return;
    }

    // Basic: fetch context from mention’s text + author
    const contextDocs = await this.searchContext(mention.text, mention.author_id);
    const contextText = contextDocs.map((doc) => `<tweet>${doc.text}</tweet>`).join('\n');

    // Generate a short reply
    const content = await composeTweetContent(
      mention.text,
      `Context:\n${contextText}`
    );
    const reply = await this.replyToTweet(mention.id, content);

    // Store the mention
    await this.storeTweet({
      id: mention.id,
      text: mention.text,
      author_id: mention.author_id,
      created_at: mention.created_at,
    });

    // Mark mention as processed
    await this.saveLastProcessedMentionId(mention.id);
    return reply;
  }

  /**
   * Example method to fetch relevant posts
   * from Twitter (API) or fallback to DB.
   */
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
          max_results: 20, // Increased from 5
          expansions: ['author_id'],
          'user.fields': ['username'],
        })
      );

      if (timeline?.data?.data?.length) {
        const userMap = new Map();
        (timeline.includes?.users || []).forEach((u) => {
          userMap.set(u.id, u.username);
        });

        const storedTweets = await this.fetchRelevantPostsFromDB(20);
        const uniqueTweets = [];

        for (const tweet of timeline.data.data) {
          const isDuplicate = storedTweets.some((stored) => {
            const similarity = fuzzball.ratio(stored.text, tweet.text);
            return similarity > 80; // 80% similarity threshold
          });
          if (!isDuplicate) {
            const tweetData = {
              id: tweet.id,
              text: tweet.text,
              author_id: tweet.author_id,
              author_username: userMap.get(tweet.author_id) || null,
              created_at: tweet.created_at,
            };
            await this.storeTweet(tweetData);
            uniqueTweets.push(tweetData);
          }
        }
        this.monthlyReads++;
        return uniqueTweets;
      }

      console.log('Falling back to DB for relevant posts...');
      return await this.fetchRelevantPostsFromDB();
    } catch (error) {
      console.error('Error fetching posts from Twitter API:', error);
      console.log('Falling back to DB for relevant posts...');
      return await this.fetchRelevantPostsFromDB();
    }
  }

  // DB fallback
  async fetchRelevantPostsFromDB(limit = 5) {
    try {
      return await this.tweetsCollection
        .find({})
        .sort({ created_at: -1 })
        .limit(limit) // Use provided limit
        .toArray();
    } catch (error) {
      console.error('Error fetching posts from DB:', error);
      return [];
    }
  }

  /**
   * Basic method to handle rate-limit with up to 3 retries
   */
  async retryFetch(fetchFunction, maxRetries = 3) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fetchFunction();
      } catch (error) {
        lastError = error;
        if (error.code === 429 && error.rateLimit?.reset) {
          // Wait until reset
          const waitTime = error.rateLimit.reset * 1000 - Date.now() + 1000;
          console.log(`Rate limit; waiting ${waitTime / 1000}s before retry.`);
          await new Promise((res) => setTimeout(res, waitTime));
        } else {
          if (i >= maxRetries - 1) throw lastError;
        }
      }
    }
  }

  // Store rate-limit info if you want
  async storeRateLimit(info) {
    try {
      await this.db.collection('rate_limits').updateOne(
        { endpoint: info.endpoint },
        {
          $set: {
            reset: info.reset,
            limit: info.limit,
            remaining: info.remaining,
            updated_at: new Date(),
          },
        },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error storing rate limit info:', error);
    }
  }

  /**
   * Summarize recent posts + an optional wallet asset report
   */
  async composePost(systemPrompt, memoryPrompt, context) {
    try {
      const relevantPosts = await this.fetchRelevantPosts();
      if (!relevantPosts?.length) {
        console.warn('No relevant posts found; using default prompt.');
        return await composeTweetContent('Share an interesting thought');
      }

      const formattedPosts = relevantPosts
        .filter((p) => p?.text)
        .map((p) => `Post: ${p.text}`)
        .join('\n');

      // Attempt to read a wallet asset report (optional)
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const reportPath = path.join(__dirname, '../../nft_images/x.md');
      let reportContent = '';
      try {
        reportContent = await fsPromises.readFile(reportPath, 'utf8');
      } catch (error) {
        console.warn('Wallet asset report not found:', error);
      }

      const summaryPrompt = `
System: ${systemPrompt}
Memory: ${memoryPrompt}
Context: ${context}
Wallet Asset Report:
${reportContent}
Here are some recent posts:
${formattedPosts}
Please summarize and produce a short tweet.
      `;

      const shortTweet = await composeTweetContent(summaryPrompt);
      const mentionMatches = shortTweet.content?.match(/@[a-zA-Z0-9_]+/g) || [];
      const mentions = mentionMatches.map((h) => h.slice(1));

      return {
        content: shortTweet.content,
        entities: { mentions },
      };
    } catch (error) {
      console.error('Error in composePost:', error);
      return null;
    }
  }

  /**
   * Post an NFT image if not previously posted
   */
  async postNFTImage(nft) {
    if (this.postedNFTs.has(nft.mint)) {
      console.log(`NFT ${nft.mint} has already been posted.`);
      return null;
    }
    try {
      const imageBuffer = await fsPromises.readFile(nft.localImagePath);
      const fileName = path.basename(nft.localImagePath);
      const mediaId = await this.uploadImageToS3(imageBuffer);

      // Include filename and any context data in the tweet
      const tweetText = `Here's a new NFT: ${nft.name || 'Unknown'}\nMint: ${nft.mint}\nFile: ${fileName}`;
      const response = await this.rwClient.v2.tweet({ text: tweetText, media: { media_ids: [mediaId] } });
      this.postedNFTs.add(nft.mint);
      return response;
    } catch (error) {
      console.error('Error posting NFT image:', error);
      return null;
    }
  }

  /**
   * Example method for repeated requests with rate-limit handling
   */
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

  /**
   * Generate an image description from recent posts (demo usage of LLM).
   */
  async generateImageDescription() {
    try {
      const memories = await this.fetchRelevantPosts();
      if (!Array.isArray(memories)) {
        console.error('Error: fetchRelevantPosts did not return an array');
        return null;
      }
      const memoryText = memories.map((m) => m.text).join('\n');
      const prompt = `
Based on these memories, generate a creative, engaging description for an image:
${memoryText}
      `;
      const { success, tweet, error } = await generateTweet(prompt, '', {
        maxAttempts: 5,
        maxLength: 600,
      });
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

/**
 * Sets up mention polling on an interval
 */
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
    const nextInterval =
      error?.code === 429
        ? Math.min(service.pollingInterval * 2, 3600000) // cap at 1 hour
        : service.pollingInterval;

    pollingTimeout = setTimeout(() => setupPolling(service), nextInterval);
  }
}

/**
 * Cleanup function if needed
 */
export function cleanup() {
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
  }
}

/**
 * The main entry flow: 
 * 1) Initialize credential service & DB 
 * 2) Initialize TwitterService 
 * 3) Start mention polling
 */
// We'll export this at the bottom
let twitterService; // Holds the initialized service

export async function initTwitterService() {
  try {
    // Initialize credentials
    await credentialService.initialize(process.env.MONGODB_URI);

    // Create new service if not yet created
    if (!twitterService) {
      twitterService = await TwitterService.initialize();
      setupPolling(twitterService);
      console.log('TwitterService initialized successfully.');
    }
    return twitterService;
  } catch (error) {
    console.error('Fatal error in TwitterService init:', error);
    throw error;
  }
}
