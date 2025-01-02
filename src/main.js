import ShadowBot from './shadowbot.js';

const bot = new ShadowBot();
bot.login().catch(console.error);