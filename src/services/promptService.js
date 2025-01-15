// promptService.js
import fs from 'fs';
import aiHandler from '../aiHandler.js';
import { fetchMemory, storeMemory } from '../services/memoryService.js';
import path from 'path';
import Exa from 'exa-js';

// Load your system prompt from disk (includes persona, instructions, etc.)
const systemPrompt = (() => {
  try {
    let promptText = (() => {
      try { return fs.readFileSync('system_prompt.md', 'utf8'); }
      catch (error) { return ''; }
    })();
    const nftDir = path.resolve('./nft_images');
    const mdFiles = fs.readdirSync(nftDir).filter((file) => file.endsWith('.md'));
    for (const file of mdFiles) {
      const mdContent = fs.readFileSync(path.join(nftDir, file), 'utf8');
      promptText += `\n\n${mdContent}`;
    }
    return promptText;
  } catch (error) {
    console.error('Failed to load system prompt:', error);
    return '';
  }
})();

/**
 * Builds a simplified prompt using systemPrompt, dreams, context, and user input.
 *
 * @param {string} userInput - The user's question or mention text.
 * @param {string} context   - Additional context/memory you want the LLM to see.
 * @param {number} maxLength - Desired max length for the final tweet text.
 * @returns {string} The full prompt to pass to aiHandler.
 */
async function buildPrompt(userInput) {
  console.log('Simplified prompt:', userInput);

  try {
    const memoryResults = await fetchMemory(userInput);
    const memoryText = memoryResults?.documents?.flat().join('\n') || '';

    let exaResults = '';
    if (process.env.EXA_KEY) {
      try {
        const exa = new Exa(process.env.EXA_KEY);
        const exaResponse = await exa.search({
          query: userInput,
          type: 'neural',
          useAutoprompt: true,
          numResults: 5
        });
        exaResults = exaResponse?.results
          ?.map((r) => `- ${r.title || 'Untitled'}`)
          .join('\n') || '';
      } catch (error) {
        console.error('Exa search error:', error.message);
      }
    }

    // Combine systemPrompt, possible dream, and user input
    return `${systemPrompt.trim()}

${memoryText}

EXA SEARCH RESULTS:
${exaResults}

${userInput}
`.trim();
  } catch (error) {
    console.error('Failed to fetch memory', { error: error.message });
    throw error;
  }
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
      const raw = await aiHandler.generateCompletion(prompt, { stop: ["\n\n"] });
      let tweetText = raw.trim();

      // Remove duplicate lines
      let lines = tweetText.split('\n');
      lines = lines.filter((line, idx) => lines.indexOf(line) === idx);
      tweetText = lines.join('\n');

      // Filter out URLs
      tweetText = tweetText.replace(/https?:\/\/\S+/gi, '');

      // Filter out ETH addresses
      tweetText = tweetText.replace(/0x[a-fA-F0-9]{40}/gi, '');

      // Filter out Sol addresses
      tweetText = tweetText.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, '');

      // Deduplicate tags and keep only the first one
      const tagMatches = tweetText.match(/@[a-zA-Z0-9_]+/g) || [];
      const distinctTags = [];
      for (const t of tagMatches) {
        if (!distinctTags.includes(t)) {
          distinctTags.push(t);
        }
      }
      if (distinctTags.length > 1) {
        for (let i = 1; i < distinctTags.length; i++) {
          tweetText = tweetText.replace(new RegExp(distinctTags[i], 'g'), distinctTags[i].replace('@', ''));
        }
      }

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