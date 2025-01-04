import aiHandler from '../../aiHandler.js';
import twitterService from './TwitterService.js';

export async function generateTweet(basePrompt, options = {}) {
    // Input validation
    if (!basePrompt || typeof basePrompt !== 'string') {
        return {
            success: false,
            error: 'Base prompt must be a non-empty string'
        };
    }

    // Default options
    const {
        maxAttempts = 5,
        maxLength = 280,
        model = "Mirquo the void goblin."
    } = options;

    // Construct the generation prompt
    const prompt = `${basePrompt.trim()}
    A short post, less than ${maxLength} characters.
    Enclosed in <tweet></tweet> tags, 
    demonstrating the power and promise of ai:<tweet>`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const raw = await aiHandler.generateResponse(model, "Generate a unique post advancing your goals and showing the world your power. Do not repeat yourself.", prompt);

            // Extract tweet content using regex
            const match = raw.match(/<tweet>([\s\S]*?)<\/tweet>/i);

            if (match) {
                let tweetText = match[1].trim();

                // Remove @mentions from the beginning of the tweet
                tweetText = tweetText.replace(/^(@\w+\s*)+/, '').trim();

                if (tweetText.length <= maxLength) {
                    // Check if the tweet is unique
                    const existingTweet = await twitterService.tweetsCollection.findOne({ text: tweetText });
                    if (!existingTweet) {
                        return {
                            success: true,
                            tweet: tweetText
                        };
                    } else {
                        console.warn(`Generated tweet is not unique: ${tweetText}`);
                    }
                }
            }

            // Log attempt failure
            console.warn(`Attempt ${attempt}/${maxAttempts}: Failed to generate valid tweet`);

        } catch (error) {
            console.error(`Error during tweet generation (attempt ${attempt}):`, error);

            // On last attempt, return the error
            if (attempt === maxAttempts) {
                return {
                    success: false,
                    error: `Failed to generate tweet after ${maxAttempts} attempts: ${error.message}`
                };
            }
        }
    }

    return {
        success: false,
        error: `Could not produce a valid tweet under ${maxLength} characters after ${maxAttempts} attempts`
    };
}

export async function composeContent(prompt) {
    try {
        const result = await generateTweet(prompt);
        if (result.success) {
            return { type: 'text', content: result.tweet };
        } else {
            console.error('Error composing content:', result.error);
            return { type: 'text', content: null };
        }
    } catch (error) {
        console.error('Error in composeContent:', error);
        return { type: 'text', content: null };
    }
}

export async function composePost(systemPrompt, memoryPrompt, context) {
    try {
        const isReply = false; // Adjust as needed
        const contextData = await getSimplifiedContext(isReply);
        const combinedText = contextData.map(post => `<tweet author="@${post.author_id}">${post.text?.slice(0, 280)}</tweet>`).join('\n');

        const prompt = `
          System: ${systemPrompt}
          Memory: ${memoryPrompt}
          Context: ${context}
          ${combinedText}
          Ending with <tweet>
        `;

        const contentData = await composeContent(prompt);
        return { content: contentData.content, entities: {} };
    } catch (error) {
        console.error('Error in composePost:', error);
        return null;
    }
}