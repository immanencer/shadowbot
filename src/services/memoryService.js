import { ChromaClient } from 'chromadb';

let chromaClient = null;

export async function initializeMemory() {
  try {
    chromaClient = new ChromaClient({
      path: process.env.CHROMADB_URI || 'http://localhost:8000'
    });
    await chromaClient.createCollection({ name: 'shadowbot_collection' });
    console.log('ChromaDB collection ready');
  } catch (error) {
    console.error('Error initializing ChromaDB:', error);
  }
}

export function getChromaClient() {
  return chromaClient;
}