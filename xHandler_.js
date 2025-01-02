import { MongoClient } from 'mongodb';
import { Scraper } from 'agent-twitter-client';
import dotenv from 'dotenv';
import aiHandler from './aiHandler.js';

dotenv.config();

class TwitterService {
  constructor() {
    this.scraper = new Scraper();
    this.initializeMongo();
  }

  async initializeMongo() {
    this.client = new MongoClient(process.env.MONGODB_URI);
    await this.client.connect();
    this.db = this.client.db('twitterService');
    this.tweetsCollection = this.db.collection('tweets');
  }

  async initialize() {
    await this.scraper.login(
      process.env.TWITTER_USERNAME,
      process.env.TWITTER_PASSWORD,
      process.env.TWITTER_EMAIL,
      process.env.TWITTER_API_KEY,
      process.env.TWITTER_API_SECRET_KEY,
      process.env.TWITTER_ACCESS_TOKEN,
      process.env.TWITTER_ACCESS_TOKEN_SECRET
    );
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

  async searchContext(post) {
    const keywords = post.text.split(/\s+/).filter(word => word.length > 3);
    const keywordRegex = new RegExp(keywords.join('|'), 'i');

    return await this.tweetsCollection.find({
      $or: [
        { text: keywordRegex },
        { author: post.author },
      ],
    }).toArray();
  }
}

class ContentGenerator {
  static async generateContent(context, post) {
    
    const response = await aiHandler.generateResponse(
      "Twitter Bot",
      "Engaging in social media conversations",
      `Generate a reply to: ${post.text}\nContext: ${context.map(c => c.text).join('\n')}`
    );
    return { type: 'text', content: response };
  }
}

// Singleton instance
const twitterService = new TwitterService();

export async function composePost(botMemory) {
  try {
    const content = await ContentGenerator.generateContent(
      [], 
      { text: `Compose based on: ${JSON.stringify(botMemory.conversations.slice(-5))}` }
    );

    if (content.type === 'image') {
      console.log('Posting new image tweet with prompt:', content.prompt);
      // await scraper.tweetWithMedia(content.content, content.prompt);
    } else {
      console.log('Posting new text tweet:', content.content);
      // await scraper.tweet(content.content);
    }
  } catch (error) {
    console.error('Error composing post:', error);
  }
}

export async function handleMentions() {
  try {
    const mentions = await twitterService.scraper.getMentions();
    for (const mention of mentions) {
      const context = await twitterService.searchContext(mention);
      const content = await ContentGenerator.generateContent(context, mention);
      
      if (content.type === 'image') {
        console.log('Replying with image:', content.prompt);
        // await scraper.replyWithMedia(mention.id, content.content, content.prompt);
      } else {
        console.log('Replying with text:', content.content);
        // await scraper.reply(mention.id, content.content);
      }
      
      await twitterService.storeTweet(mention);
    }
  } catch (error) {
    console.error('Error handling mentions:', error);
  }
}

// Initialize the Twitter service when the module is imported
await twitterService.initialize();