import { TwitterApi } from 'twitter-api-v2';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import aiHandler from '../../aiHandler.js';
import credentialService from '../../services/credentialService.js';
import { TwitterAuthManager } from './TwitterAuthManager.js';
import { Metrics } from './Metrics.js';
import { TwitterApiRateLimitPlugin } from '@twitter-api-v2/plugin-rate-limit';
import { TwitterApiAutoTokenRefresher } from '@twitter-api-v2/plugin-token-refresher';
import { uploadImage } from '../../services/s3Service.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { storeTweet, initializeMongo } from './TwitterMongo.js';
import { generateTweet, composeContent } from './TweetComposition.js';
import { pollMentionsAndReplies } from './Polling.js';

dotenv.config();

const uploadClient = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

export class TwitterService {
    constructor() {
        this.authManager = new TwitterAuthManager();
        this.lastProcessedMentionId = null;
        this.pollingInterval = 3600000; // Default polling interval (1 hour)
        this.dailyPosts = 0;
        this.monthlyReads = 0;
        this.dailyPostLimit = 100;
        this.monthlyReadLimit = 100;
        this.lastDailyReset = new Date();
        this.lastMonthlyReset = new Date();
        this.dailyPostsUsed = 0;
        this.dailyRepliesUsed = 0;
        this.dailyPostRatio = 0.2;  // 20% for new posts
        this.dailyReplyRatio = 0.8; // 80% for replies
        this.userCache = {
            userId: null,
            lastFetched: 0,
            ttl: 5 * 60 * 1000 // 5 minutes
        };
    }

    static async initialize() {
        const service = new TwitterService();
        await service.initializeMongo();
        service.metrics = new Metrics(service.db); // Initialize metrics after DB connection
        setInterval(() => service.metrics.saveMetrics(), 3600000);
        await service.authenticate();
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
                    // Store new tokens in Mongo
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

    async searchContext(text, authorId) {
        const keywords = text.split(/\s+/).filter(word => word.length > 3);
        const keywordRegex = new RegExp(keywords.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

        return await this.tweetsCollection.find({
            $or: [
                { text: keywordRegex },
                { author_id: authorId },
            ],
        }).toArray();
    }

    /**
     * Generates a tweet based on a provided prompt while ensuring it meets Twitter's requirements
     * @param {string} basePrompt - The base prompt to generate the tweet from
     * @param {Object} options - Optional configuration parameters
     * @param {number} options.maxAttempts - Maximum number of generation attempts (default: 3)
     * @param {number} options.maxLength - Maximum tweet length (default: 280)
     * @param {string} options.model - AI model to use (default: "Twitter Bot")
     * @returns {Promise<{success: boolean, tweet?: string, error?: string}>}
     */
    async generateTweet(basePrompt, options = {}) {
        return await generateTweet(basePrompt, options);
    }

    async composeContent(prompt) {
        return await composeContent(prompt);
    }

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

    // posts an image with no text
    async postImage(imageBuffer) {
        this.resetCountersIfNeeded();
        if (this.dailyPosts >= this.dailyPostLimit) {
            console.log('Daily post limit reached.');
            return null;
        }

            const mediaId = await this.retryFetch(() => 
                uploadClient.v1.uploadMedia(Buffer.from(imageBuffer), { mimeType: 'image/png' })
            );
            const response = await this.retryFetch(() => 
                this.rwClient.v2.tweet({ media: { media_ids: [mediaId] } })
            );
            this.dailyPosts += 1;
            return response;
    }

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
                // 1) Post the image tweet (no text)
                const mediaId = await this.uploadImageToS3(content.content);
                const imageResponse = await this.rwClient.v2.tweet({ media: { media_ids: [mediaId] } });
                // 2) Reply to the just-posted tweet with text
                if (content.prompt) {
                    await this.rwClient.v2.reply({ text: content.prompt }, imageResponse.data.id);
                }
                return imageResponse;
            }
            const tweetPayload = {
                text: content.content // Ensure text is a string
            };
            console.log('Tweet payload:', tweetPayload); // Log the tweet payload

            const response = await this.rwClient.v2.tweet(tweetPayload);
            console.log('Tweet response:', response); // Log the tweet response

            await this.storeTweet({
                id: response.data.id,
                text: content.content, // Ensure text is a string
                author_id: (await this.getCachedUserId()),
                created_at: new Date().toISOString()
            });
            return response;
        } catch (error) {
            if (error.code === 403) {
                console.error('Error posting tweet: Forbidden (403)');
            } else {
                console.error('Error posting tweet:', error);
            }
            return null;
        }
    }

    async uploadImageToS3(imageBuffer) {
        // Save the image buffer to a temporary file
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const tempFilePath = path.join(__dirname, 'temp_image.png');
        fs.writeFileSync(tempFilePath, imageBuffer);

        try {
            const imageUrl = await uploadImage(tempFilePath);
            console.log('🌳 Image uploaded to S3 successfully:', imageUrl);
            const mediaId = await uploadClient.v1.uploadMedia(Buffer.from(imageBuffer), { mimeType: 'image/png' });
            console.log('🌳 Image uploaded to Twitter as media ID:', mediaId);
            return mediaId;
        } catch (error) {
            console.error('🌳 Error uploading image to S3:', error);
            throw error;
        } finally {
            // Clean up the temporary file
            fs.unlinkSync(tempFilePath);
        }
    }

    async replyToTweet(tweetId, content) {
        const maxDailyReplies = Math.floor(this.dailyPostLimit * this.dailyReplyRatio);
        if (this.dailyRepliesUsed >= maxDailyReplies) {
            console.log('Daily reply ratio reached.');
            return null;
        }
        try {
            if (content.type === 'image') {
                const mediaId = await this.uploadImageToS3(content.content);
                const response = await this.retryFetch(() => 
                    this.rwClient.v2.reply({
                        text: content.content,
                        media: { media_ids: [mediaId] }
                    }, tweetId)
                );
                await this.storeTweet({
                    id: response.data.id,
                    text: content.prompt,
                    author_id: (await this.getCachedUserId()),
                    created_at: new Date().toISOString()
                });
                return response;
            }
            const response = await this.retryFetch(() => 
                this.rwClient.v2.reply(content.content, tweetId)
            );
            await this.storeTweet({
                id: response.data.id,
                text: content.content,
                author_id: (await this.getCachedUserId()),
                created_at: new Date().toISOString()
            });
            this.dailyRepliesUsed += 1;
            return response;
        } catch (error) {
            if (error.code === 403) {
                console.error('Error replying to tweet: Forbidden (403)');
            } else {
                console.error('Error replying to tweet:', error);
            }
            return null;
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

    async getCachedUserId() {
        // Check if cache is fresh:
        if (
            this.userCache.userId &&
            (Date.now() - this.userCache.lastFetched) < this.userCache.ttl
        ) {
            return this.userCache.userId;
        }

        // Otherwise, fetch anew and store:
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
        return await pollMentionsAndReplies(this);
    }

    async handleMention(mention) {
        const userId = await this.getCachedUserId();
        if (mention.author_id === userId) {
            console.log('Skipping mention from self:', mention.id);
            return;
        }

        const context = await this.searchContext(mention.text, mention.author_id);
        const contextText = context.map(post => `<tweet>${post.text}</tweet>`).join('\n');
        const content = await this.composeContent(`${mention.text}\n\nContext:\n${contextText}`);
        const reply = await this.replyToTweet(mention.id, content);

        await this.storeTweet({
            id: mention.id,
            text: mention.text,
            author_id: mention.author_id,
            created_at: mention.created_at
        });

        await this.saveLastProcessedMentionId(mention.id);
        return reply;
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
        this.resetCountersIfNeeded();
        if (this.monthlyReads >= this.monthlyReadLimit) {
            console.log('Monthly read limit reached.');
            return [];
        }
        try {
            // Wrap 'me' call
            const userId = await this.getCachedUserId();
            const timeline = await this.retryFetch(() =>
                this.rwClient.v2.userTimeline(userId, { max_results: 5 })
            );

            if (Array.isArray(timeline?.data.data)) {
                // Store tweets in DB for future fallback
                await Promise.all(timeline.data.data.map(tweet => this.storeTweet(tweet)));
                this.monthlyReads += 1;
                return timeline.data.data;
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

                    console.log(`Rate limit hit (${i + 1}/${maxRetries}). Reset in ${waitTime / 1000}s`);

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

                if (error.code === 429 && !error.rateLimit) {
                    console.warn(`Rate limit exceeded without 'error.rateLimit'. Fallback handling code 429.`);
                    if (error.response?.headers) {
                        this.rateLimitManager.updateLimits('tweets', error.response.headers);
                    }
                    await this.rateLimitManager.shouldThrottle('tweets');
                    if (i < maxRetries - 1) {
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

    async getSimplifiedContext(isReply = false) {
        const max = 100;
        const userId = await this.getCachedUserId();
        let context = [];
    
        if (isReply) {
            console.log('Fetching simplified reply context');
            // Fetch thread posts logic
            context = await this.tweetsCollection.find({ in_reply_to_user_id: userId }).sort({ created_at: -1 }).limit(max).toArray();
        } else {
            console.log('Fetching simplified post context');
            const timeline = await this.makeRequest('tweets', () =>
                this.rwClient.v2.userTimeline(userId, { max_results: max })
            );
    
            context = timeline.data;
        }
    
        const userPosts = await this.tweetsCollection.find({ author_id: userId }).sort({ created_at: -1 }).limit(max).toArray();
        context = context.concat(userPosts).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    
        return context;
    }

    async composePost(systemPrompt, memoryPrompt, context) {
        try {
            const isReply = false; // Adjust as needed
            const contextData = await this.getSimplifiedContext(isReply);
            const combinedText = contextData.map(post => `<tweet author="@${post.author_id}">${post.text?.slice(0, 280)}</tweet>`).join('\n');

            const prompt = `
              System: ${systemPrompt}
              Memory: ${memoryPrompt}
              Context: ${context}
              ${combinedText}
              Ending with <tweet>
            `;

            const contentData = await this.composeContent(prompt);
            return { content: contentData.content, entities: {} };
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
                console.warn(`Rate limit exceeded for ${endpoint}`);
                return this.makeRequest(endpoint, apiCall);
            }
            throw error;
        }
    }

    async generateImageDescription() {
        try {
            const memories = await this.fetchRelevantPosts();
            const memoryText = memories.map(memory => memory.text).join('\n');
            const prompt = `
                Based on the following memories, generate a creative and engaging description for an image:
                ${memoryText}
            `;
            const description = await aiHandler.generateResponse("Image Description Bot", "", prompt);
            return description.trim();
        } catch (error) {
            console.error('Error generating image description:', error);
            return null;
        }
    }

    async like(tweetId) {
        return this.rwClient.v2.like((await this.getCachedUserId()), tweetId);
    }

    async follow(userId) {
        return this.rwClient.v2.follow((await this.getCachedUserId()), userId);
    }
}

// Update the polling interval setup
let pollingTimeout;

async function setupPolling(service) {
    let error = null;
    try {
        await service.pollMentionsAndReplies();
    } catch (err) {
        error = err;
        if (error?.message.includes('Rate limit exceeded after')) {
            console.error('Max retry attempts reached. Waiting for next poll cycle instead of exiting.');
            // Avoid rethrowing so the app doesn’t crash
        } else {
            console.error('Polling error:', error);
        }
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

export async function composePost(systemPrompt, memoryPrompt, context) {
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
      System: ${systemPrompt}
      Memory: ${memoryPrompt}
      Context: ${context}
      Here are some recent posts:
      ${formattedPosts}
      Please summarize this information.
    `;

        const summary = await aiHandler.generateResponse(
            "Summary Bot",
            "Summarizing recent activity",
            summaryPrompt
        );

        const contentData = await twitterService.composeContent(summary);

        // Example mention parsing (optional)
        const mentionMatches = contentData.content?.match(/@[a-zA-Z0-9_]+/g) || [];
        const mentions = mentionMatches.map(handle => ({ id: handle.slice(1) }));

        return {
            content: contentData.content,
            entities: { mentions }
        };
    } catch (error) {
        console.error('Error in composePost:', error);
        // Fallback to simple post if everything fails
        return null;
    }
}

export async function handleMentions() {
    try {
        const userId = await service.getCachedUserId();
        const mentions = await twitterService.rwClient.v2.userMentionTimeline(twitterService.getCachedUserId());

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

export default twitterService;