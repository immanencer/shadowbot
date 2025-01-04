import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv';

dotenv.config();

export class TwitterAuthManager {
  constructor() {
    this.validateCredentials();
    this.client = new TwitterApi({
      clientId: process.env.X_CLIENT_ID,
      clientSecret: process.env.X_CLIENT_SECRET,
    });
  }

  validateCredentials() {
    const required = [
      'X_CLIENT_ID',
      'X_CLIENT_SECRET'
    ];

    const missing = required.filter(key => !process.env[key]);
    if (missing.length) {
      throw new Error(`Missing required Twitter credentials: ${missing.join(', ')}`);
    }

    console.log('Twitter credentials validated');
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