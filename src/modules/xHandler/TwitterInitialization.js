
import { MongoClient } from 'mongodb';
import { TwitterService } from './TwitterService.js';

export async function initializeTwitterService() {
    const service = new TwitterService();
    await service.initializeMongo();
    service.metrics = new Metrics(service.db);
    setInterval(() => service.metrics.saveMetrics(), 3600000);
    await service.authenticate();
    await service.loadLastProcessedMentionId();
    return service;
}