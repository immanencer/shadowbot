// promptService.js
import fs from 'fs';
import aiHandler from '../aiHandler.js';

// Load your system prompt from disk (includes persona, instructions, etc.)
const systemPrompt = fs.readFileSync('system_prompt.md', 'utf8');

/**
 * Builds a valid XML prompt that ends with <tweet>. The LLM must fill and close </tweet>.
 *
 * @param {string} userInput - The user's question or mention text.
 * @param {string} context   - Additional context/memory you want the LLM to see.
 * @param {number} maxLength - Desired max length for the final tweet text.
 * @returns {string} The full XML prompt to pass to aiHandler.
 */
function buildPrompt(userInput, context = '', maxLength = 600) {
  // Minimal example snippet showing the final structure:
  const xmlExample = `<?xml version="1.0" encoding="UTF-8"?>
<conversation>
  <system>Example system instructions here.</system>
  <human>Example user text here.</human>
  <assistant>
    <tweet>This is an example tweet.</tweet>
  </assistant>
</conversation>`;

  // We include a comment telling the LLM to produce text inside <tweet> and close it.
  // The systemPrompt can contain persona, style, or general instructions.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 
  Provide a short answer inside <tweet>...</tweet>, 
  then close it with </tweet>.
  Keep it under ~${maxLength} chars. 
  Do not add extra tags or disclaimers.
-->

${xmlExample}

<conversation>
  <system>
${systemPrompt.trim()}
    You are "Mirquo the void goblin." 
    (Additional persona instructions or constraints go here.)
  </system>
  <human>
${context.trim()}
    The user says: "${userInput.trim()}"
  </human>
  <assistant>
    <tweet author="Mirquo">`;
}

/**
 * Calls the LLM with our built XML prompt, then parses <tweet>...</tweet>.
 * Retries if invalid or missing.
 *
 * @param {string} userInput - The user's text or mention.
 * @param {string} context   - Additional context from DB or conversation history.
 * @param {object} options   - e.g. { maxAttempts, maxLength }.
 * @returns {{ success: boolean, tweet?: string, error?: string }}
 */
export async function generateTweet(userInput, context = '', options = {}) {
  const { maxAttempts = 5, maxLength = 600 } = options;

  // Construct the prompt
  const prompt = buildPrompt(userInput, context, maxLength);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // If aiHandler supports a "stop" array, you can do:
      const raw = await aiHandler.generateCompletion(prompt, { stop: ["</tweet>"] });
      // Otherwise, just fetch the entire output and parse manually.
      ///const raw = await aiHandler.generateCompletion(prompt);


      let tweetText = raw.trim();

      // Optionally remove leading @mentions
      tweetText = tweetText.replace(/^(@\w+\s*)+/, '').trim();

      // Check if it's too long
      if (tweetText.length > maxLength) {
        console.warn(`Attempt ${attempt}: Tweet is too long (${tweetText.length} chars).`);
        continue; // retry
      }

      // If we get here, success!
      return { success: true, tweet: tweetText };

    } catch (error) {
      if (error.response?.status === 429 || error.code === 429) {
        console.warn('Rate limit (429) encountered, waiting 10 seconds...');
        await new Promise(r => setTimeout(r, 10000));
      }
      console.error(`Error generating tweet (attempt ${attempt}):`, error);
      // If it's the final attempt, return failure
      if (attempt === maxAttempts) {
        return { success: false, error: `Failed after ${maxAttempts} attempts: ${error.message}` };
      }
    }
  }

  // If we exhausted retries without success:
  return {
    success: false,
    error: `No valid <tweet> found after ${maxAttempts} attempts (max length ${maxLength})`
  };
}