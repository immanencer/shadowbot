import { TwitterApi } from 'twitter-api-v2';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import aiHandler from './aiHandler.js';
import painter from './painter/blackforest-replicate.js';
import credentialService from './services/credentialService.js';

dotenv.config();

class TwitterAuthManager {
  constructor() {
    this.validateCredentials();
    this.client = new TwitterApi({ 
      clientId: process.env.TWITTER_CLIENT_ID,
      clientSecret: process.env.TWITTER_CLIENT_SECRET,
    });
  }

  validateCredentials() {
    const required = [
      'TWITTER_CLIENT_ID',
      'TWITTER_CLIENT_SECRET'
    ];

    const missing = required.filter(key => !process.env[key]);
    if (missing.length) {
      throw new Error(`Missing required Twitter credentials: ${missing.join(', ')}`);
    }

    console.log('Twitter credentials validated');
  }

  async generateAuthLink(callbackUrl = 'http://localhost:3000/callback') {
    try {
      console.log('Generating OAuth 2.0 auth link with callback:', callbackUrl);
      
      const { url, codeVerifier, state } = await this.client.generateOAuth2AuthLink(callbackUrl, {
        scope: ['tweet.read', 'tweet.write', 'users.read', 'follows.read', 'follows.write', 'offline.access']
      });
      
      console.log('Auth link generated successfully');
      return { url, codeVerifier, state };
    } catch (error) {
      console.error('Auth link error:', error);
      throw error;
    }
  }

  async handleCallback(code, codeVerifier, redirectUri) {
    try {
      const { client: loggedClient, accessToken, refreshToken, expiresIn } = 
        await this.client.loginWithOAuth2({
          code,
          codeVerifier,
          redirectUri,
        });

      return { loggedClient, accessToken, refreshToken, expiresIn };
    } catch (error) {
      console.error('Error handling callback:', error);
      throw error;
    }
  }

  async refreshTokens(refreshToken) {
    try {
      const { client: refreshedClient, accessToken, refreshToken: newRefreshToken } = 
        await this.client.refreshOAuth2Token(refreshToken);
      
      return { refreshedClient, accessToken, refreshToken: newRefreshToken };
    } catch (error) {
      console.error('Error refreshing tokens:', error);
      throw error;
    }
  }
}

class Metrics {
  constructor() {
    this.stats = {
      tweetsPosted: 0,
      repliesSent: 0,
      apiCalls: 0,
      errors: 0,
      rateLimitHits: 0
    };
  }

  async saveMetrics() {
    // Save to MongoDB every hour
    await this.db.collection('metrics').insertOne({
      ...this.stats,
      timestamp: new Date()
    });
  }
}

class RateLimitManager {
  constructor() {
    this.limits = new Map();
    this.queues = new Map();
    this.retryDelays = [1000, 5000, 15000, 30000, 60000]; // Exponential backoff delays
  }

  async checkRateLimit(endpoint) {
    const limit = this.limits.get(endpoint);
    if (limit && Date.now() < limit.reset) {
      const waitTime = limit.reset - Date.now();
      console.log(`Rate limit in effect for ${endpoint}, waiting ${waitTime/1000}s`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  async executeWithRateLimit(endpoint, operation) {
    // Get or create queue for this endpoint
    if (!this.queues.has(endpoint)) {
      this.queues.set(endpoint, Promise.resolve());
    }

    // Add operation to queue
    return this.queues.get(endpoint).then(async () => {
      await this.checkRateLimit(endpoint);
      
      try {
        return await operation();
      } catch (error) {
        if (error.code === 429) {
          const resetTime = error.rateLimit.reset * 1000;
          this.limits.set(endpoint, {
            remaining: 0,
            reset: resetTime,
            limit: error.rateLimit.limit
          });
          
          // Implement exponential backoff
          for (const delay of this.retryDelays) {
            await new Promise(resolve => setTimeout(resolve, delay));
            try {
              return await operation();
            } catch (retryError) {
              if (retryError.code !== 429) throw retryError;
            }
          }
          throw new Error(`Rate limit exceeded after ${this.retryDelays.length} retries`);
        }
        throw error;
      }
    });
  }
}

class TwitterService {
  constructor() {
    this.authManager = new TwitterAuthManager();
    this.lastProcessedMentionId = null;
    this.pollingInterval = 3600000; // Default polling interval (1 hour)
    this.metrics = new Metrics();
    this.rateLimitManager = new RateLimitManager();
    setInterval(() => this.metrics.saveMetrics(), 3600000);
  }

  static async initialize() {
    const service = new TwitterService();
    await service.initializeMongo();
    await service.authenticate();
    await service.loadLastProcessedMentionId();
    await service.pollMentionsAndReplies(); // Check for new mentions on startup
    return service;
  }

  async initializeMongo() {
    try {
      this.mongoClient = new MongoClient(process.env.MONGODB_URI);
      await this.mongoClient.connect();
      this.db = this.mongoClient.db('twitterService');
      this.tweetsCollection = this.db.collection('tweets');
      this.authCollection = this.db.collection('auth');
      console.log('MongoDB connection established and collections initialized');
    } catch (error) {
      console.error('Error initializing MongoDB:', error);
      throw error;
    }
  }

  async authenticate() {
    try {
      const credentials = await credentialService.getValidCredentials();
      
      if (credentials) {
        this.client = new TwitterApi(credentials.accessToken);
        this.rwClient = this.client.readWrite;
        return true;
      }

      const { url } = await this.authManager.generateAuthLink();
      console.log('Please visit this URL to authenticate:', url);
      return false;
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
    try {
      const existingTweet = await this.tweetsCollection.findOne({ id: tweet.id });
      if (!existingTweet) {
        await this.tweetsCollection.insertOne(tweet);
      }
    } catch (error) {
      console.error('Error storing tweet:', error);
    }
  }

  async searchContext(text, authorId) {
    const keywords = text.split(/\s+/).filter(word => word.length > 3);
    const keywordRegex = new RegExp(keywords.join('|'), 'i');

    return await this.tweetsCollection.find({
      $or: [
        { text: keywordRegex },
        { author_id: authorId },
      ],
    }).toArray();
  }

  async generateTweet(basePrompt) {
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      attempts++;
      const raw = await aiHandler.generateResponse(
        "Twitter Bot",
        "",
        `${basePrompt}
        To generate a tweet, wrap your text in <tweet> tags. For example:
        <tweet>Here is a tweet I generated,Making sure it's under 280 characters.</tweet>
        now, generate a tweet freely to be posted on x
        `
      );
      const match = raw.match(/<tweet>([\s\S]*?)<\/tweet>/i);
      if (match) {
        const tweetText = match[1].trim();
        if (tweetText.length <= 280) {
          return tweetText;
        }
      }
    }
    return "Could not produce a valid <tweet> under 280 chars.";
  }

  async composeContent(prompt) {
    const shouldGenerateImage = Math.random() < 0.1;

    if (shouldGenerateImage) {
      const imagePrompt = await aiHandler.generateResponse(
        "Image Creator",
        "Creating visually engaging Twitter content",
        `Create an interesting image prompt based on: ${prompt}`
      );
      const imageBuffer = await painter.draw_picture(imagePrompt);
      return { type: 'image', content: imageBuffer, prompt: imagePrompt };
    }

    const text = await this.generateTweet(prompt);
    return { type: 'text', content: text };
  }

  async postTweet(content) {
    return this.rateLimitManager.executeWithRateLimit('tweet', async () => {
      if (content.type === 'image') {
        const mediaId = await this.client.v1.uploadMedia(content.content, { type: 'png' });
        return await this.rwClient.v2.tweet({
          text: content.prompt,
          media: { media_ids: [mediaId] }
        });
      }
      return await this.rwClient.v2.tweet({ text: content.content });
    });
  }

  async replyToTweet(tweetId, content) {
    return this.rateLimitManager.executeWithRateLimit('reply', async () => {
      if (content.type === 'image') {
        const mediaId = await this.client.v1.uploadMedia(content.content, { type: 'png' });
        return await this.rwClient.v2.reply({
          text: content.prompt,
          media: { media_ids: [mediaId] }
        }, tweetId);
      }
      return await this.rwClient.v2.reply(content.content, tweetId);
    });
  }

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

  async pollMentionsAndReplies() {
    return this.rateLimitManager.executeWithRateLimit('mentions', async () => {
      const userId = (await this.client.v2.me()).data.id;
      const params = this.lastProcessedMentionId ? { since_id: this.lastProcessedMentionId } : {};
      const mentions = await this.rwClient.v2.userMentionTimeline(userId, params);
      
      for await (const mention of mentions) {
        await this.handleMention(mention);
      }
    });
  }

  async handleMention(mention) {
    return this.rateLimitManager.executeWithRateLimit('reply', async () => {
      const context = await this.searchContext(mention.text, mention.author_id);
      const content = await this.composeContent(mention.text);
      const reply = await this.replyToTweet(mention.id, content);
      
      await this.storeTweet({
        id: mention.id,
        text: mention.text,
        author_id: mention.author_id,
        created_at: mention.created_at
      });

      await this.saveLastProcessedMentionId(mention.id);
      return reply;
    });
  }

  async fetchRelevantPostsFromDB() {
    try {
      // Get last 5 stored tweets
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

  async fetchRelevantPosts() {
    try {
      const userId = (await this.client.v2.me()).data.id;
      const timeline = await this.retryFetch(() => 
        this.rwClient.v2.userTimeline(userId, { max_results: 5 })
      );
      
      if (timeline?.data) {
        // Store tweets in DB for future fallback
        await Promise.all(timeline.data.map(tweet => this.storeTweet(tweet)));
        return timeline.data;
      }
      
      // Fallback to DB if API call fails
      console.log('Falling back to database for relevant posts');
      return await this.fetchRelevantPostsFromDB();
    } catch (error) {
      console.error('Error fetching posts from API:', error);
      console.log('Falling back to database for relevant posts');
      return await this.fetchRelevantPostsFromDB();
    }
  }

  async retryFetch(fetchFunction, maxRetries = 3) {
    let lastError = null;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fetchFunction();
      } catch (error) {
        lastError = error;
        
        if (error.code === 429 && error.rateLimit) {
          const resetTime = error.rateLimit.reset * 1000;
          const currentTime = Date.now();
          const waitTime = resetTime - currentTime + 1000; // Add 1s buffer
          
          console.log(`Rate limit hit (${i + 1}/${maxRetries}). Reset in ${waitTime/1000}s`);
          
          // Store the rate limit info for future use
          await this.storeRateLimit({
            endpoint: error.request?.url,
            reset: resetTime,
            limit: error.rateLimit.limit,
            remaining: error.rateLimit.remaining
          });

          // Only wait if we have more retries left
          if (i < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        }
        
        // For non-rate-limit errors or final attempt, throw
        throw lastError;
      }
    }
  }

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

  async getRateLimit(endpoint) {
    try {
      return await this.db.collection('rate_limits').findOne({ endpoint });
    } catch (error) {
      console.error('Error getting rate limit info:', error);
      return null;
    }
  }

  async composePost(botMemory) {
    try {
      const relevantPosts = await this.fetchRelevantPosts();
      if (!Array.isArray(relevantPosts) || relevantPosts.length === 0) {
        console.warn('No relevant posts found, using default prompt');
        return await this.composeContent('Share an interesting thought');
      }

      const formattedPosts = relevantPosts
        .filter(post => post?.text)
        .map(post => `Post: ${post.text}`)
        .join('\n');

      const summaryPrompt = `
        Here are some recent posts:
        ${formattedPosts}
        Please summarize this information.
      `;

      const summary = await aiHandler.generateResponse(
        "Summary Bot", 
        "Summarizing recent activity", 
        summaryPrompt
      );

      const content = await this.composeContent(summary);
      const tweet = await this.postTweet(content);
      console.log('Posted tweet:', tweet.data.id);
      return tweet;
    } catch (error) {
      console.error('Error in composePost:', error);
      // Fallback to simple post if everything fails
      return await this.postTweet({ 
        type: 'text', 
        content: 'Thinking deep thoughts in the void...' 
      });
    }
  }
}

// Update the polling interval setup
let pollingTimeout;

async function setupPolling(service) {
  try {
    await service.pollMentionsAndReplies();
  } catch (error) {
    console.error('Polling error:', error);
  } finally {
    // Schedule next poll with exponential backoff on failure
    const nextInterval = error?.code === 429 ? 
      Math.min(service.pollingInterval * 2, 3600000) : // Double interval up to 1 hour max
      service.pollingInterval;
    
    pollingTimeout = setTimeout(() => setupPolling(service), nextInterval);
  }
}

// Initialize services
await credentialService.initialize(process.env.MONGODB_URI);
const twitterService = await TwitterService.initialize();

// Start polling with proper cleanup
setupPolling(twitterService);

// Cleanup function
export function cleanup() {
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
  }
}

export async function handleOAuthCallback(code, codeVerifier, redirectUri) {
  try {
    const { accessToken, refreshToken, expiresIn } = await twitterService.authManager.handleCallback(
      code,
      codeVerifier,
      redirectUri
    );
    await twitterService.storeTokens(accessToken, refreshToken, expiresIn);
    await twitterService.authenticate();
    return true;
  } catch (error) {
    console.error('OAuth callback error:', error);
    return false;
  }
}

export async function composePost(botMemory) {
  try {
    const relevantPosts = await twitterService.fetchRelevantPosts();
    if (!Array.isArray(relevantPosts) || relevantPosts.length === 0) {
      console.warn('No relevant posts found, using default prompt');
      return await twitterService.composeContent('Share an interesting thought');
    }

    const formattedPosts = relevantPosts
      .filter(post => post?.text)
      .map(post => `Post: ${post.text}`)
      .join('\n');

    const summaryPrompt = `
      Here are some recent posts:
      ${formattedPosts}
      Please summarize this information.
    `;

    const summary = await aiHandler.generateResponse(
      "Summary Bot", 
      "Summarizing recent activity", 
      summaryPrompt
    );

    const content = await twitterService.composeContent(summary);
    const tweet = await twitterService.postTweet(content);
    console.log('Posted tweet:', tweet.data.id);
    return tweet;
  } catch (error) {
    console.error('Error in composePost:', error);
    // Fallback to simple post if everything fails
    return await twitterService.postTweet({ 
      type: 'text', 
      content: 'Thinking deep thoughts in the void...' 
    });
  }
}

export async function handleMentions() {
  try {
    const mentions = await twitterService.rwClient.v2.mentions();
    
    for await (const mention of mentions) {
      const context = await twitterService.searchContext(mention.text, mention.author_id);
      const content = await twitterService.composeContent(mention.text);
      const reply = await twitterService.replyToTweet(mention.id, content);
      
      await twitterService.storeTweet({
        id: mention.id,
        text: mention.text,
        author_id: mention.author_id,
        created_at: mention.created_at
      });
      
      console.log('Replied to mention:', reply.data.id);
    }
  } catch (error) {
    console.error('Error handling mentions:', error);
  }
}