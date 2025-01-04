import { MongoClient } from 'mongodb';
import { TwitterApi } from 'twitter-api-v2';

class CredentialService {
  constructor() {
    this.mongoClient = null;
    this.collection = null;
  }

  async initialize(mongoUri) {
    try {
      this.mongoClient = new MongoClient(mongoUri);
      await this.mongoClient.connect();
      this.collection = this.mongoClient.db('twitterService').collection('credentials');
      await this.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days
      console.log('MongoDB connection established and collection initialized');
    } catch (error) {
      console.error('Error initializing MongoDB:', error);
      throw error;
    }
  }

  async storeCredentials({ accessToken, refreshToken, expiresIn }) {
    if (!this.collection) {
      throw new Error('MongoDB collection not initialized');
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    
    await this.collection.updateOne(
      { type: 'X_oauth2' },
      {
        $set: {
          accessToken,
          refreshToken,
          expiresAt,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  async getValidCredentials() {
    if (!this.collection) {
      throw new Error('MongoDB collection not initialized');
    }

    const credentials = await this.collection.findOne({ type: 'X_oauth2' });
    if (!credentials) return null;

    const now = new Date();
    const expiresAt = new Date(credentials.expiresAt);

    // If token expires in less than 5 minutes, refresh it
    if (expiresAt.getTime() - now.getTime() < 300000) {
      return await this.refreshCredentials(credentials.refreshToken);
    }

    return credentials;
  }

  // No longer needed if using TwitterApiAutoTokenRefresher
  // async refreshCredentials(refreshToken) {
  //   const client = new TwitterApi({
  //     clientId: process.env.X_CLIENT_ID,
  //     clientSecret: process.env.X_CLIENT_SECRET,
  //   });

  //   try {
  //     const { accessToken, refreshToken: newRefreshToken, expiresIn } = 
  //       await client.refreshOAuth2Token(refreshToken);

  //     await this.storeCredentials({ accessToken, refreshToken: newRefreshToken, expiresIn });
      
  //     return await this.getValidCredentials();
  //   } catch (error) {
  //     await this.collection.deleteOne({ type: 'X_oauth2' });
  //     throw error;
  //   }
  // }

  async getClient() {
    const credentials = await this.getValidCredentials();
    if (!credentials) return null;

    return new TwitterApi(credentials.accessToken);
  }
}

export default new CredentialService();
