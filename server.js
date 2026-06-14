import express from 'express';
import cors from 'cors';
import { readJson, writeJson } from './database.js';
import { FeedAggregator } from './aggregator.js';
import { 
  PORT, 
  POLL_INTERVAL, 
  FEEDS_DB_PATH, 
  WEBHOOKS_DB_PATH 
} from './config.js';

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Aggregator
const aggregator = new FeedAggregator();

// Helper to validate URL
function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// -------------------------------------------------------------
// Feed Routes
// -------------------------------------------------------------

// Serve aggregated XML feed
app.get('/feed', (req, res) => {
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(aggregator.cachedXml || aggregator.generateRssXml([]));
});

// List source feeds
app.get('/api/feeds', async (req, res) => {
  try {
    const feeds = await readJson(FEEDS_DB_PATH, []);
    res.json(feeds);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read feeds database' });
  }
});

// Add a source feed
app.post('/api/feeds', async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Valid URL is required' });
  }

  try {
    // Validate feed format by trying to parse it
    try {
      await aggregator.parser.parseURL(url);
    } catch (parseErr) {
      return res.status(400).json({ 
        error: `URL is not a valid RSS/Atom feed: ${parseErr.message}` 
      });
    }

    const feeds = await readJson(FEEDS_DB_PATH, []);
    if (feeds.includes(url)) {
      return res.status(409).json({ error: 'Feed already exists' });
    }

    feeds.push(url);
    await writeJson(FEEDS_DB_PATH, feeds);

    // Sync aggregator asynchronously to update cache
    aggregator.sync().catch(err => console.error('Async sync error:', err));

    res.status(201).json(feeds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a source feed
app.delete('/api/feeds', async (req, res) => {
  const url = req.query.url || req.body.url;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const feeds = await readJson(FEEDS_DB_PATH, []);
    const index = feeds.indexOf(url);
    if (index === -1) {
      return res.status(404).json({ error: 'Feed not found' });
    }

    feeds.splice(index, 1);
    await writeJson(FEEDS_DB_PATH, feeds);

    // Sync aggregator asynchronously to update cache
    aggregator.sync().catch(err => console.error('Async sync error:', err));

    res.json(feeds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Webhook Routes
// -------------------------------------------------------------

// List Webhooks
app.get('/api/webhooks', async (req, res) => {
  try {
    const webhooks = await readJson(WEBHOOKS_DB_PATH, []);
    res.json(webhooks);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read webhooks database' });
  }
});

// Register a Webhook
app.post('/api/webhooks', async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Valid URL is required' });
  }

  try {
    const webhooks = await readJson(WEBHOOKS_DB_PATH, []);
    if (webhooks.includes(url)) {
      return res.status(409).json({ error: 'Webhook already registered' });
    }

    webhooks.push(url);
    await writeJson(WEBHOOKS_DB_PATH, webhooks);
    res.status(201).json(webhooks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unregister a Webhook
app.delete('/api/webhooks', async (req, res) => {
  const url = req.query.url || req.body.url;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const webhooks = await readJson(WEBHOOKS_DB_PATH, []);
    const index = webhooks.indexOf(url);
    if (index === -1) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    webhooks.splice(index, 1);
    await writeJson(WEBHOOKS_DB_PATH, webhooks);
    res.json(webhooks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Control Routes
// -------------------------------------------------------------

// Trigger manual sync
app.post('/api/trigger-sync', async (req, res) => {
  try {
    const { newItems, allItems } = await aggregator.sync();
    res.json({
      success: true,
      newItemsCount: newItems.length,
      allItemsCount: allItems.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let server;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, async () => {
    console.log(`RSS Generator Server running on port ${PORT}`);
    
    // Initial sync on startup
    try {
      await aggregator.sync();
    } catch (err) {
      console.error('Initial feed synchronization failed:', err.message);
    }

    // Periodic polling
    setInterval(async () => {
      try {
        console.log('Running periodic feed sync...');
        await aggregator.sync();
      } catch (err) {
        console.error('Periodic feed sync failed:', err.message);
      }
    }, POLL_INTERVAL);
  });
}

// Export server and aggregator instances for testing
export { app, server, aggregator };
