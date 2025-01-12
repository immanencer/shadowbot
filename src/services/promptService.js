// promptService.js
import fs from 'fs';
import aiHandler from '../aiHandler.js';
import { fetchMemory, storeMemory } from '../services/memoryService.js';

// Load your system prompt from disk (includes persona, instructions, etc.)
const systemPrompt = fs.readFileSync('system_prompt.md', 'utf8');

/**
 * Builds a simplified prompt using systemPrompt, dreams, context, and user input.
 *
 * @param {string} userInput - The user's question or mention text.
 * @param {string} context   - Additional context/memory you want the LLM to see.
 * @param {number} maxLength - Desired max length for the final tweet text.
 * @returns {string} The full prompt to pass to aiHandler.
 */
async function buildPrompt(userInput, context = '', maxLength = 600) {
  console.log('Simplified prompt:', userInput);

  // Fetch memory from ChromaDB
  const memoryResults = await fetchMemory(userInput);
  const memoryText = memoryResults.documents?.flat().join('\n') || '';

  // Combine systemPrompt, possible dream, and user input
  return `${systemPrompt.trim()}

${memoryText}

${userInput}
`.trim();
}

/**
 * Calls the LLM with our built prompt, then parses the response.
 * Retries if invalid or missing.
 *
 * @param {string} userInput - The user's text or mention.
 * @param {string} context   - Additional context from DB or conversation history.
 * @param {object} options   - e.g. { maxAttempts, maxLength }.
 * @returns {{ success: boolean, tweet?: string, error?: string }}
 */
export async function generateTweet(userInput, context = '', options = {}) {
  const { maxAttempts = 5, maxLength = 728 } = options;
  const prompt = await buildPrompt(userInput, context, maxLength);

  console.log('Prompt:', prompt); 
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await aiHandler.generateCompletion(prompt, { stop: ["</tweet>"] });
      let tweetText = raw.trim();
      tweetText = tweetText.replace(/^(@\w+\s*)+/, '').trim();
      if (tweetText.length > maxLength) {
        console.warn(`Attempt ${attempt}: Tweet is too long (${tweetText.length} chars).`);
        continue; // retry
      }
      await storeMemory(userInput, tweetText); // Store the new memory
      return { success: true, tweet: tweetText };
    } catch (error) {
      if (error.response?.status === 429 || error.code === 429) {
        console.warn('Rate limit (429) encountered, waiting 10 seconds...');
        await new Promise(r => setTimeout(r, 10000));
      }
      console.error(`Error generating tweet (attempt ${attempt}):`, error);
      if (attempt === maxAttempts) {
        return { success: false, error: `Failed after ${maxAttempts} attempts: ${error.message}` };
      }
    }
  }
  return {
    success: false,
    error: `No valid response found after ${maxAttempts} attempts (max length ${maxLength})`
  };
}