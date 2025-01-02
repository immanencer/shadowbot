// config.js
import dotenv from 'dotenv';
import { cleanEnv, str, url } from 'envalid';

dotenv.config();

export const config = cleanEnv(process.env, {
  DISCORD_BOT_TOKEN: str(),
  OPENAI_API_KEY: str(),
  OPENAI_API_URI: str(),
  MONGODB_URI: url(),
  YOUR_SITE_URL: url(),
  YOUR_SITE_NAME: str(),
  MODEL: str(),
  LOG_LEVEL: str({ default: 'info' }),
});