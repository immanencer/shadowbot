# Project Setup

This document provides detailed instructions for setting up the project.

## Prerequisites

Before you begin, ensure you have the following installed on your system:

- Node.js (version 14 or higher)
- npm (Node Package Manager)
- MongoDB (for database)

## Installation Steps

1. **Clone the Repository**: Clone the repository to your local machine.
   ```sh
   git clone https://github.com/immanencer/shadowbot.git
   cd shadowbot
   ```

2. **Install Dependencies**: Install the required dependencies using npm.
   ```sh
   npm install
   ```

3. **Create a `.env` File**: Create a `.env` file based on the provided `.env.sample` and fill in the required values.
   ```sh
   cp .env.sample .env
   ```

4. **Start MongoDB**: Ensure that MongoDB is running on your system. You can start MongoDB using the following command:
   ```sh
   mongod
   ```

5. **Start the Bot**: Start the bot using npm.
   ```sh
   npm start
   ```

## Configuration Details

The `.env` file should contain the following configuration variables:

```env
NODE_ENV="development"
DISCORD_BOT_TOKEN=""
MONGODB_URI=""
OPENROUTER_API_KEY=""
YOUR_SITE_NAME=""
YOUR_SITE_URL=""
MODEL="meta-llama/llama-3.1-8b-instruct:free"
```

Ensure that you fill in the required values for each variable.

## Additional Notes

- Make sure to keep your `.env` file secure and do not share it publicly.
- If you encounter any issues during setup, refer to the project's documentation or seek help from the community.
