// analytics.js
import { createObjectCsvWriter } from 'csv-writer';
import logger from './logger.js';

class Analytics {
  constructor() {
    this.messageCount = 0;
    this.responseCount = 0;
    this.userInteractions = new Map();
    this.channelActivity = new Map();
  }

  updateMessageStats(message) {
    this.messageCount++;
    const userId = message.author.id;
    const channelId = message.channel.id;
    this.userInteractions.set(userId, (this.userInteractions.get(userId) || 0) + 1);
    this.channelActivity.set(channelId, (this.channelActivity.get(channelId) || 0) + 1);
  }

  incrementResponseCount() {
    this.responseCount++;
  }

  async exportToCSV() {
    const csvWriter = createObjectCsvWriter({
      path: 'void_goblin_analytics.csv',
      header: [
        { id: 'timestamp', title: 'Timestamp' },
        { id: 'messageCount', title: 'Total Messages' },
        { id: 'responseCount', title: 'Total Responses' },
        { id: 'uniqueUsers', title: 'Unique Users' },
        { id: 'activeChannels', title: 'Active Channels' }
      ]
    });

    const records = [{
      timestamp: new Date().toISOString(),
      messageCount: this.messageCount,
      responseCount: this.responseCount,
      uniqueUsers: this.userInteractions.size,
      activeChannels: this.channelActivity.size
    }];

    try {
      await csvWriter.writeRecords(records);
      logger.info('Analytics exported successfully');
    } catch (error) {
      logger.error('Failed to export analytics', { error: error.message });
    }
  }
}

export default new Analytics();