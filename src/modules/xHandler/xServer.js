import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import { TwitterApi } from 'twitter-api-v2';
import credentialService from '../../services/credentialService.js';
import twitterService from '../../modules/xHandler/TwitterService.js';
import { draw_picture } from '../../painter/blackforest-replicate.js';
import { postX } from '../../painter/x.js';
import { ChromaClient } from 'chromadb';
import { initializeMemory } from '../../services/memoryService.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 3600000 // 1 hour
  }
}));

const chromaClient = new ChromaClient({
  path: process.env.CHROMADB_URI || 'http://localhost:8000'
});

async function postImageToX() {
  try {
    console.log('Generating image description and posting image to X');
    const description = await twitterService.generateImageDescription();
    const imageBuffer = await draw_picture(description);
    await twitterService.postImage(imageBuffer);
    console.log('Image posted successfully');
  } catch (error) {
    if (error.code === 413) {
      console.error('Error posting image to X: Image too large');
    } else if (error.code === 429) {
      console.error('Rate limit exceeded while posting image. Skipping instead of exiting.');
      return;
    } else {
      console.error('Error posting image to X:', error);
    }
  }
}

// Post an image on server startup
try {
  await postImageToX();
  console.log('Initial image post successful');
} catch (error) {
  console.error('Unhandled error during initial image post:', error);
}

// Schedule image posting every few hours
try {
  setInterval(async () => {
    try {
      await postImageToX();
    } catch (error) {
      console.error('Unhandled error during scheduled image post:', error);
    }
  }, 4 * 60 * 60 * 1000); // Every 4 hours
} catch (error) {
  console.error('Error setting up interval for image posting:', error);
}

app.listen(port, async () => {
  console.log(`xServer running at http://localhost:${port}`);

  try {
    // Initialize services after server launch
    await credentialService.initialize(process.env.MONGODB_URI);
    console.log('Credential service initialized');

    await initializeMemory();

    const authenticated = await twitterService.authenticate();
    if (!authenticated) {
      console.error('Failed to authenticate Twitter service.');
      return;
    }

    console.log('ChromaDB collection ready');

  } catch (error) {
    console.error('Error during server initialization:', error);
    console.error('Error initializing ChromaDB:', error);
  }
});

app.get('/', async (req, res) => {
  // ...existing code...
  console.log('GET / - Checking user authentication status');
  const client = await credentialService.getClient();
  const authenticated = !!client;

  res.send(`
    <h1>ShadowBot Twitter Auth</h1>
    ${authenticated 
      ? '<p>✅ Authenticated!</p><a href="/auth/twitter/logout">Logout</a>' 
      : '<p>❌ Not authenticated</p><a href="/auth/twitter/login">Login with Twitter</a>'}
    <p><a href="/dashboard">View Dashboard</a></p>
  `);
});

app.get('/auth/twitter/login', async (req, res) => {
  console.log('GET /auth/twitter/login - Starting OAuth flow');
  const client = new TwitterApi({
    clientId: process.env.X_CLIENT_ID,
    clientSecret: process.env.X_CLIENT_SECRET,
  });
  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(
    'http://localhost:3000/auth/twitter/callback',
    {
      scope: ['tweet.read', 'tweet.write', 'users.read', 'follows.read', 'follows.write', 'offline.access']
    }
  );
  req.session.codeVerifier = codeVerifier;
  req.session.state = state;
  await req.session.save(); // Ensure session is saved before redirect

  res.redirect(url);
});

app.get('/auth/twitter/callback', async (req, res) => {
  console.log('GET /auth/twitter/callback - Handling OAuth callback');
  const { code, state } = req.query;
  const { codeVerifier, state: sessionState } = req.session;

  if (!code || !state || !codeVerifier || state !== sessionState) {
    console.error('Invalid OAuth callback parameters');
    return res.status(400).send(`
      <h1>Invalid OAuth state or missing parameters</h1>
      <p>Possible reasons:</p>
      <ul>
        <li>The OAuth state does not match the session state.</li>
        <li>Missing code or state parameters in the callback URL.</li>
        <li>Session expired or invalid.</li>
      </ul>
      <p>Please try logging in again.</p>
      <a href="/auth/twitter/login">Login with Twitter</a>
    `);
  }

  const success = await twitterService.handleOAuthCallback(code, codeVerifier, 'http://localhost:3000/auth/twitter/callback');
  if (success) {
    delete req.session.codeVerifier;
    delete req.session.state;
    await req.session.save(); // Ensure session is saved before redirect
    res.redirect('/');
  } else {
    res.status(500).send('Authentication failed');
  }
});

app.get('/auth/twitter/logout', async (req, res) => {
  console.log('GET /auth/twitter/logout - Clearing credentials and session');
  await credentialService.collection.deleteOne({ type: 'X_oauth2' });
  req.session.destroy();
  res.redirect('/');
});

app.get('/dashboard', async (req, res) => {
  console.log('GET /dashboard - Displaying a custom dashboard');
  const systemPrompt = 'Trending topics in my timeline';
  const memoryPrompt = 'Recent conversations';
  const context = 'Tweet thread context';

  try {
    const relevantPosts = await twitterService.fetchRelevantPosts();
    const rateLimitInfo = await twitterService.getRateLimit('/2/tweets');

    res.send(`
      <h1>ShadowBot Dashboard</h1>
      <p><strong>System Prompt:</strong> ${systemPrompt}</p>
      <p><strong>Memory Prompt:</strong> ${memoryPrompt}</p>
      <p><strong>Context:</strong> ${context}</p>
      <p><strong>Relevant Posts:</strong> ${relevantPosts.map(post => `<p>${post.text}</p>`).join('') || 'No relevant posts found'}</p>
      <p><strong>Rate Limit Info:</strong> ${rateLimitInfo ? JSON.stringify(rateLimitInfo) : 'No rate limit info available'}</p>
      <p>Other relevant info can go here.</p>
      <form action="/post" method="post">
        <button type="submit">Post Now</button>
      </form>
      <a href="/">Back to Home</a>
    `);
  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

app.post('/post', async (req, res) => {
  console.log('POST /post - Triggering a new post');
  try {
    const systemPrompt = 'Trending topics in my timeline';
    const memoryPrompt = 'Recent conversations';
    const context = 'Tweet thread context';
    const content = await twitterService.composePost(systemPrompt, memoryPrompt, context);

    // Remind AI not to use hashtags
    if (content?.content) {
      content.content = content.content.replace(/#[a-zA-Z0-9_]+/g, '');
    }

    // Like every post we see
    const tweets = await twitterService.fetchRelevantPosts();
    for (const tweet of tweets) {
      await twitterService.like(tweet.id);
    }

    // Follow anyone mentioned in threads we respond to
    const mentions = content.entities?.mentions || [];
    for (const mention of mentions) {
      await twitterService.follow(mention.id);
    }

    res.send(`
      <h1>Post Successful</h1>
      <p><strong>Generated Post:</strong> ${content?.content || 'No content generated'}</p>
      <a href="/dashboard">Back to Dashboard</a>
    `);
  } catch (error) {
    console.error('Error posting:', error);
    res.status(500).send('Error posting');
  }
});

app.get('/health', async (req, res) => {
  console.log('GET /health - Checking system health');
  try {
    const health = {
      status: 'OK',
      mongoConnection: !!(await credentialService.getClient()),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      lastError: null
    };
    res.json(health);
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});