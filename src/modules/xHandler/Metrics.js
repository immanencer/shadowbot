export class Metrics {
  constructor(db) {
    this.db = db;
    this.stats = {
      tweetsPosted: 0,
      repliesSent: 0,
      apiCalls: 0,
      errors: 0,
      rateLimitHits: 0
    };
  }

  async saveMetrics() {
    if (!this.db) return;
    await this.db.collection('metrics').insertOne({
      ...this.stats,
      timestamp: new Date()
    });
  }
}