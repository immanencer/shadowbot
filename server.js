import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import { TwitterApi } from 'twitter-api-v2';
import credentialService from './services/credentialService.js';
import { handleOAuthCallback } from './xHandler.js';

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

// Initialize services
await credentialService.initialize(process.env.MONGODB_URI);

app.get('/', async (req, res) => {
  try {
    const client = await credentialService.getClient();
    const authenticated = !!client;

    res.send(`
      <h1>ShadowBot Twitter Auth</h1>
      ${authenticated 
        ? '<p>✅ Authenticated!</p><a href="/auth/twitter/logout">Logout</a>' 
        : '<p>❌ Not authenticated</p><a href="/auth/twitter/login">Login with Twitter</a>'}
    `);
  } catch (error) {
    res.status(500).send('Error checking authentication status');
  }
});

app.get('/auth/twitter/login', async (req, res) => {
  try {
    const client = new TwitterApi({
      clientId: process.env.TWITTER_CLIENT_ID,
      clientSecret: process.env.TWITTER_CLIENT_SECRET,
    });

    const { url, codeVerifier, state } = client.generateOAuth2AuthLink(
      'http://localhost:3000/auth/twitter/callback',
      {
        scope: ['tweet.read', 'tweet.write', 'users.read', 'follows.read', 'follows.write', 'offline.access']
      }
    );

    req.session.codeVerifier = codeVerifier;
    req.session.state = state;
    
    console.log('Generated OAuth2 auth link:', { url, codeVerifier, state });
    res.redirect(url);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send('Authentication initialization failed');
  }
});

app.get('/auth/twitter/callback', async (req, res) => {
  const { code, state } = req.query;
  const { codeVerifier, state: sessionState } = req.session;

  console.log('Received callback with params:', { code, state });
  console.log('Session state:', { codeVerifier, sessionState });

  if (!code || !state || !codeVerifier || state !== sessionState) {
    console.error('Invalid OAuth params:', { 
      hasCode: !!code,
      hasState: !!state,
      hasVerifier: !!codeVerifier,
      stateMatch: state === sessionState
    });
    return res.status(400).send('Invalid OAuth state or missing parameters');
  }

  try {
    const success = await handleOAuthCallback(code, codeVerifier, 'http://localhost:3000/auth/twitter/callback');

    if (success) {
      // Clear sensitive data from session
      delete req.session.codeVerifier;
      delete req.session.state;

      res.redirect('/');
    } else {
      res.status(500).send('Authentication failed');
    }
  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/auth/twitter/logout', async (req, res) => {
  try {
    await credentialService.collection.deleteOne({ type: 'twitter_oauth2' });
    req.session.destroy();
    res.redirect('/');
  } catch (error) {
    res.status(500).send('Logout failed');
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
