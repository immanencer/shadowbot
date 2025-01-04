
import { MongoClient } from 'mongodb';

export async function initializeMongo(service) {
    try {
        service.mongoClient = new MongoClient(process.env.MONGODB_URI);
        await service.mongoClient.connect();
        service.db = service.mongoClient.db('twitterService');
        service.tweetsCollection = service.db.collection('tweets');
        service.authCollection = service.db.collection('auth');
        console.log('MongoDB connection established and collections initialized');
    } catch (error) {
        console.error('Error initializing MongoDB:', error);
        throw error;
    }
}

export async function storeTweet(service, tweet) {
    try {
        const existingTweet = await service.tweetsCollection.findOne({ id: tweet.id });
        if (!existingTweet) {
            await service.tweetsCollection.insertOne(tweet);
        }
    } catch (error) {
        console.error('Error storing tweet:', error);
    }
}

export async function fetchRelevantPostsFromDB(service) {
    try {
        // Get last 5 stored tweets
        return await service.tweetsCollection
            .find({})
            .sort({ created_at: -1 })
            .limit(5)
            .toArray();
    } catch (error) {
        console.error('Error fetching posts from DB:', error);
        return [];
    }
}