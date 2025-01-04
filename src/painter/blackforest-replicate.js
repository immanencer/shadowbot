import https from 'https';
import { MongoClient } from 'mongodb';
import { Buffer } from 'buffer';
import Replicate from 'replicate';
import process from 'process';
import fs from 'fs';
import path from 'path';

// Initialize Replicate with your API token
const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN
});

// MongoDB connection URI and database name
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = "imageRequests";
const COLLECTION_NAME = "requests";

// Function to insert a new request into MongoDB
async function insertRequestIntoMongo(prompt, result) {
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        const db = client.db(DB_NAME);
        const collection = db.collection(COLLECTION_NAME);
        const now = new Date();

        const record = {
            prompt,
            result,
            date: now,
        };

        await collection.insertOne(record);
        console.log('Record inserted into MongoDB successfully');
    } catch (error) {
        console.error('Error inserting into MongoDB:', error);
    } finally {
        await client.close();
    }
}

// Function to check if the daily limit has been reached
async function checkDailyLimit() {
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        const db = client.db(DB_NAME);
        const collection = db.collection(COLLECTION_NAME);

        const today = new Date();
        today.setHours(0, 0, 0, 0); // Set to start of the day

        const count = await collection.countDocuments({ date: { $gte: today } });
        return count < 10; // Assuming a limit of 10 requests per day
    } catch (error) {
        console.error('Error checking daily limit in MongoDB:', error);
        return false;
    } finally {
        await client.close();
    }
}

// Function to download the image as a PNG and return it as a buffer
function downloadImage(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to get '${url}' (${res.statusCode})`));
                res.resume(); // Consume response data to free up memory
                return;
            }

            const data = [];
            res.on('data', (chunk) => {
                data.push(chunk);
            });
            res.on('end', () => {
                resolve(Buffer.concat(data));
            });
        }).on('error', (error) => {
            reject(new Error('Error downloading the image: ' + error.message));
        });
    });
}

// Main function to draw the picture with polling and return a buffer of the PNG
export async function draw_picture(prompt) {
    const isAllowed = await checkDailyLimit();
    if (!isAllowed) {
        console.error('Daily limit reached. Try again tomorrow.');
        return null;
    }

    try {
        // Step 1: Initiate the image generation request using Replicate API
        const output = await replicate.run(
            process.env.IMAGE_MODEL,
            {
                input: {
                    model: "dev",
                    prompt: `MRQ holographic neon black ${prompt} MRQ`,
                    lora_scale: 1,
                    num_outputs: 1,
                    aspect_ratio: "1:1",
                    output_format: "webp",
                    guidance_scale: 3.5,
                    output_quality: 90,
                    prompt_strength: 0.8,
                    extra_lora_scale: 1,
                    num_inference_steps: 28
                }
            });

        const url = output.toString('utf-8').trim();
        console.log('Image generated successfully:', url);

        // Step 2: Download the image as a buffer
        const imageBuffer = await downloadImage(url);
        // Save the image to a file
        if (!fs.existsSync('./bard_images')) {
            fs.mkdirSync('./bard_images');
        }
        const filepath = path.resolve(`./bard_images/${Date.now()}.png`);
        fs.writeFileSync(filepath, imageBuffer);

        // Step 5: Return the image buffer
        console.log('Image generated and downloaded successfully.');
        return imageBuffer;
    } catch (error) {
        console.error('Error generating or downloading the image:', error);
        return null;
    }
}

export default { draw_picture };
