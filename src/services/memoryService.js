import { MongoClient } from 'mongodb';

let client;
let db;
let collection;

export async function getMongoClient() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017');
    await client.connect();
    db = client.db('shadowbot');
    collection = db.collection('memories');
    await collection.createIndex({ text: 'text' });
  }
  return client;
}

export async function fetchMemory(queryText) {
  await getMongoClient();
  if (!collection) {
    throw new Error('Collection is not initialized');
  }
  const results = await collection.find({ $text: { $search: queryText } }).limit(100).toArray();
  return { documents: results };
}

export async function initializeMemory() {
  try {
    await getMongoClient();
    console.log('MongoDB connection established and collection initialized');
  } catch (error) {
    console.error('Error initializing MongoDB:', error);
  }
}

export async function storeMemory(userInput, generatedText) {
  await getMongoClient();
  const memory = {
    userInput,
    generatedText,
    timestamp: new Date()
  };
  await collection.insertOne(memory);
  console.log('Memory stored:', memory);
}