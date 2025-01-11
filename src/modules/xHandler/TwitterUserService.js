
import { TwitterApi } from 'twitter-api-v2';

export class TwitterUserService {
  constructor(rwClient, db) {
    this.rwClient = rwClient;
    this.db = db;
  }

  async fetchUserById(userId) {
    const response = await this.rwClient.v2.user(userId);
    return response.data;
  }

  async fetchUsersByIds(userIds) {
    const response = await this.rwClient.v2.users(userIds);
    return response.data;
  }

  async saveUserDetailsToDb(userData) {
    if (!this.db) return;
    await this.db.collection('twitter_users').updateOne(
      { id: userData.id },
      { $set: userData },
      { upsert: true }
    );
  }
}