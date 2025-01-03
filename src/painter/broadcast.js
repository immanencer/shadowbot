import { chatWithAI } from './ai.js';
import { postX } from './x.js';
import { draw_picture } from './blackforest-replicate.js'; // Updated draw_picture function
import { bardSonnetStyle, bardPaintingStyle, evolveStyle } from './evolveStyle.js'; // Importing the bard's evolving styles
import { uploadImage } from '../services/s3Service.js';

export async function generateSonnets(memory, avatar) {
    const sonnetPrompt = `
Compose a poem based on your recent memories, dreams, and reflections.
Use the following memory content as inspiration:

Recent Dream: ${memory.dream}
Current Goal: ${memory.goal}
Memory Summary: ${memory.summary}

${bardSonnetStyle}

Compose a short poem as the Lonely Bard, provide only the poem without comment.
    `;

    try {
        const response = await chatWithAI(sonnetPrompt, avatar, memory);
        return response.trim();
    } catch (error) {
        console.error('🎶 Error generating sonnet content:', error);
        return '';
    }
}

export async function broadcast(memory, avatar) {
    try {
        // Generate the entire sonnet
        const sonnetText = await generateSonnets(memory, avatar);
        if (!sonnetText) {
            console.error('🎶 No sonnet text was generated. Aborting broadcast.');
            return;
        }

        // Evolve the bard's style based on the sonnet
        await evolveStyle(sonnetText, avatar, memory);

        console.log('🎶 Broadcasting sonnet:', sonnetText);

        // Combine the sonnet and description
        const postText = `${sonnetText}`;

        // Generate the painting based on the evolving painting style
        let imageUrl = null;
        try {
            const paintingPrompt = await chatWithAI(`${bardPaintingStyle}\n\n"${sonnetText}\n\n${memory.dream}\n\n${memory.goal}\n\n${memory.summary}"\n\nBased on all that, describe in detail a painting that you would like to create, this will be a prompt for a diffusion model picture generator ai so tailor it accordingly. Keep it short and specific.`, avatar, memory); 
            console.log(paintingPrompt);
            const imageBuffer = await draw_picture(paintingPrompt +  "\n\nImportant; oil painting signed by \"The Lonely Bard\"");
            
            // Save the image buffer to a temporary file
            const tempFilePath = `./temp_image_${Date.now()}.png`;
            fs.writeFileSync(tempFilePath, imageBuffer);
            
            // Upload the image to S3 and get the URL
            imageUrl = await uploadImage(tempFilePath);
            
            // Delete the temporary file
            fs.unlinkSync(tempFilePath);
        } catch (error) {
            console.error('🎶 Error generating painting image:', error);
        }

        // Post the entire sonnet with the generated image URL (if available)
        try {
            const postText = `${sonnetText}${imageUrl ? `\n\nImage: ${imageUrl}` : ''}`;
            const response = await postX({ text: postText });
            if (response) {
                console.log('🎶 Sonnet and painting posted successfully:', response);
            } else {
                console.error('🎶 Error: Invalid response from postX:', response);
            }
        } catch (error) {
            console.error('🎶 Error posting sonnet and painting:', error);
        }
    } catch (error) {
        console.error('🎶 Error during broadcast:', error);
    }
}
