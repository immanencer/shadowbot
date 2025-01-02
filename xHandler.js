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

class TwitterService {
  constructor() {
    this.authManager = new TwitterAuthManager();
    this.lastProcessedMentionId = null;
    this.pollingInterval = 3600000; // Default polling interval (1 hour)
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

    const text = await aiHandler.generateResponse(
      "Twitter Bot",
      "Engaging in social media conversations",
      `Generate a tweet about: ${prompt}`
    );

    // Slice the text at a more reasonable place
    const slicedText = text.split('. ').slice(0, 3).join('. ').slice(0, 280);
    return { type: 'text', content: slicedText };
  }

  async postTweet(content) {
    try {
      if (content.type === 'image') {
        const mediaId = await this.client.v1.uploadMedia(content.content, { type: 'png' });
        return await this.rwClient.v2.tweet({
          text: content.prompt,
          media: { media_ids: [mediaId] }
        });
      }
      return await this.rwClient.v2.tweet({ text: content.content });
    } catch (error) {
      console.error('Error posting tweet:', error);
      throw error;
    }
  }

  async replyToTweet(tweetId, content) {
    try {
      if (content.type === 'image') {
        const mediaId = await this.client.v1.uploadMedia(content.content, { type: 'png' });
        return await this.rwClient.v2.reply({
          text: content.prompt,
          media: { media_ids: [mediaId] }
        }, tweetId);
      }
      return await this.rwClient.v2.reply(content.content, tweetId);
    } catch (error) {
      console.error('Error replying to tweet:', error);
      throw error;
    }
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
    try {
      const userId = (await this.client.v2.me()).data.id;
      const params = this.lastProcessedMentionId ? { since_id: this.lastProcessedMentionId } : {};
      const mentions = await this.rwClient.v2.userMentionTimeline(userId, params);
      
      for await (const mention of mentions) {
        const context = await this.searchContext(mention.text, mention.author_id);
        const content = await this.composeContent(mention.text);
        const reply = await this.replyToTweet(mention.id, content);
        
        await this.storeTweet({
          id: mention.id,
          text: mention.text,
          author_id: mention.author_id,
          created_at: mention.created_at
        });

        // Update the last processed mention ID
        await this.saveLastProcessedMentionId(mention.id);
        
        console.log('Replied to mention:', reply.data.id);
      }
    } catch (error) {
      if (error.code === 429) {
        const resetTime = error.rateLimit.reset * 1000; // Convert to milliseconds
        const currentTime = Date.now();
        const waitTime = resetTime - currentTime;

        console.error(`Rate limit exceeded. Waiting for ${waitTime / 1000} seconds before retrying.`);
        this.pollingInterval = waitTime;
      } else {
        console.error('Error polling mentions and replies:', error);
      }
    }
  }

  async fetchRelevantPosts() {
    try {
      const userId = (await this.client.v2.me()).data.id;
      const timeline = await this.retryFetch(() => this.rwClient.v2.userTimeline(userId, { max_results: 5 }));
      return timeline.data;
    } catch (error) {
      console.error('Error fetching relevant posts:', error);
      return [];
    }
  }

  async retryFetch(fetchFunction, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fetchFunction();
      } catch (error) {
        if (error.code === 429 && error.rateLimit) {
          const resetTime = error.rateLimit.reset * 1000; // Convert to milliseconds
          const currentTime = Date.now();
          const waitTime = resetTime - currentTime;

          console.error(`Rate limit exceeded. Waiting for ${waitTime / 1000} seconds before retrying.`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          if (i === maxRetries - 1) throw error;
          console.error(`Fetch failed, retrying (${i + 1}/${maxRetries})`, { error: error.message });
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
        }
      }
    }
  }

  async composePost(botMemory) {
    try {
      const relevantPosts = await this.fetchRelevantPosts();
      const formattedPosts = relevantPosts.map(post => `Post: ${post.text}`).join('\n');

      const summaryPrompt = `
        Here are some recent posts:
        ${formattedPosts}
        Please summarize this information.
      `;

      const summary = await aiHandler.generateResponse("Summary Bot", "Summarizing recent activity", summaryPrompt);

      const content = await this.composeContent(summary);
      const tweet = await this.postTweet(content);
      console.log('Posted tweet:', tweet.data.id);
      return tweet;
    } catch (error) {
      console.error('Error in composePost:', error);
    }
  }
}

// Initialize credentialService before TwitterService
await credentialService.initialize(process.env.MONGODB_URI);
const twitterService = await TwitterService.initialize();

// Set up polling interval
setInterval(async () => {
  await twitterService.pollMentionsAndReplies();
}, twitterService.pollingInterval); // Use dynamic polling interval

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
    const formattedPosts = relevantPosts.map(post => `Post: ${post.text}`).join('\n');

    const summaryPrompt = `
      Here are some recent posts:
      ${formattedPosts}
      Please summarize this information.
    `;

    const summary = await aiHandler.generateResponse("Summary Bot", "Summarizing recent activity", summaryPrompt);

    const content = await twitterService.composeContent(summary);
    const tweet = await twitterService.postTweet(content);
    console.log('Posted tweet:', tweet.data.id);
    return tweet;
  } catch (error) {
    console.error('Error in composePost:', error);
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