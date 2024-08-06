// dbHandler.js
import { MongoClient } from 'mongodb';
import { config } from './config.js';
import logger from './logger.js';

class DBHandler {
  constructor() {
    this.client = new MongoClient(config.MONGODB_URI);
    this.db = null;
  }

  async connect() {
    try {
      await this.client.connect();
      this.db = this.client.db('void_goblin');
      logger.info('Connected to MongoDB');
    } catch (error) {
      logger.error('MongoDB connection error', { error });
      throw error;
    }
  }

  async disconnect() {
    await this.client.close();
    logger.info('Disconnected from MongoDB');
  }

  async saveMemory(memory) {
    try {
      await this.db.collection('memories').updateOne(
        { name: 'void_goblin' },
        { $set: memory },
        { upsert: true }
      );
      logger.info('Memory saved to database');
    } catch (error) {
      logger.error('Error saving memory to database', { error });
      throw error;
    }
  }

  async loadMemory() {
    try {
      const memory = await this.db.collection('memories').findOne({ name: 'void_goblin' });
      logger.info('Memory loaded from database');
      return memory;
    } catch (error) {
      logger.error('Error loading memory from database', { error });
      throw error;
    }
  }
}

export default new DBHandler();