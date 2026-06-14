import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs/promises';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Setup test env variables BEFORE import is loaded dynamically
const testFeedsPath = path.join(__dirname, 'test_feeds.json');
const testWebhooksPath = path.join(__dirname, 'test_webhooks.json');
process.env.FEEDS_DB_PATH = testFeedsPath;
process.env.WEBHOOKS_DB_PATH = testWebhooksPath;
process.env.NODE_ENV = 'test';

let appModule;
let serverInstance;
let baseUrl;

test.describe('API & Webhooks Integration Tests', () => {
  test.before(async () => {
    // Ensure clean DB files
    await fs.writeFile(testFeedsPath, '[]');
    await fs.writeFile(testWebhooksPath, '[]');

    // Dynamically load server module after setting env
    appModule = await import('../server.js');
    
    // Start Express app on dynamic port
    serverInstance = appModule.app.listen(0);
    const port = serverInstance.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  test.after(async () => {
    if (serverInstance) {
      await new Promise(resolve => serverInstance.close(resolve));
    }
    try { await fs.unlink(testFeedsPath); } catch {}
    try { await fs.unlink(testWebhooksPath); } catch {}
  });

  test.beforeEach(async () => {
    await fs.writeFile(testFeedsPath, '[]');
    await fs.writeFile(testWebhooksPath, '[]');
    
    // Reset aggregator state
    appModule.aggregator.seenItems.clear();
    appModule.aggregator.isInitialized = false;
    appModule.aggregator.cachedItems = [];
    appModule.aggregator.cachedXml = '';
  });

  test('GET /api/feeds should list empty feeds initially', async () => {
    const res = await fetch(`${baseUrl}/api/feeds`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, []);
  });

  test('POST /api/feeds and DELETE /api/feeds CRUD operations', async () => {
    // Mock the parser check for this URL
    appModule.aggregator.parser.parseURL = async (url) => {
      if (url === 'https://news.ycombinator.com/rss') {
        return { title: 'HN Feed', items: [] };
      }
      throw new Error('Not found');
    };

    // 1. Add valid feed
    const resAdd = await fetch(`${baseUrl}/api/feeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://news.ycombinator.com/rss' })
    });
    assert.strictEqual(resAdd.status, 201);
    const feedsAfterAdd = await resAdd.json();
    assert.deepStrictEqual(feedsAfterAdd, ['https://news.ycombinator.com/rss']);

    // 2. Reject invalid feed URL
    const resAddInvalid = await fetch(`${baseUrl}/api/feeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://invalid-url.com' })
    });
    assert.strictEqual(resAddInvalid.status, 400);

    // 3. Remove feed
    const resDel = await fetch(`${baseUrl}/api/feeds`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://news.ycombinator.com/rss' })
    });
    assert.strictEqual(resDel.status, 200);
    const feedsAfterDel = await resDel.json();
    assert.deepStrictEqual(feedsAfterDel, []);
  });

  test('POST /api/webhooks and DELETE /api/webhooks operations', async () => {
    // 1. List initially empty webhooks
    const resGet = await fetch(`${baseUrl}/api/webhooks`);
    assert.strictEqual(resGet.status, 200);
    const bodyGet = await resGet.json();
    assert.deepStrictEqual(bodyGet, []);

    // 2. Add webhook
    const resAdd = await fetch(`${baseUrl}/api/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://test-hook.com/receiver' })
    });
    assert.strictEqual(resAdd.status, 201);
    const hooksAfterAdd = await resAdd.json();
    assert.deepStrictEqual(hooksAfterAdd, ['http://test-hook.com/receiver']);

    // 3. Delete webhook
    const resDel = await fetch(`${baseUrl}/api/webhooks`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://test-hook.com/receiver' })
    });
    assert.strictEqual(resDel.status, 200);
    const hooksAfterDel = await resDel.json();
    assert.deepStrictEqual(hooksAfterDel, []);
  });

  test('Webhook Push end-to-end integration', async () => {
    // 1. Spin up a dummy HTTP server to act as a webhook receiver
    let webhookReceivedPayload = null;
    let resolveWebhookReceived;
    const webhookPromise = new Promise(resolve => {
      resolveWebhookReceived = resolve;
    });

    const dummyWebhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        webhookReceivedPayload = JSON.parse(body);
        res.writeHead(200);
        res.end();
        resolveWebhookReceived();
      });
    });

    await new Promise(resolve => dummyWebhookServer.listen(0, resolve));
    const webhookPort = dummyWebhookServer.address().port;
    const webhookUrl = `http://localhost:${webhookPort}/push`;

    // Register webhook
    await fetch(`${baseUrl}/api/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });

    // Mock feed data
    let mockFeedItems = [
      { title: 'Item 1', link: 'http://1.com', pubDate: '2026-06-10T10:00:00Z', guid: '1' }
    ];

    appModule.aggregator.parser.parseURL = async () => {
      return { title: 'Mock Source Feed', items: mockFeedItems };
    };

    // Register source feed (needs to exist in db)
    // Directly write it to database to skip parser validation logic
    await fs.writeFile(testFeedsPath, JSON.stringify(['https://mock-rss-source.com/rss']));

    // 2. First Sync (Initializes cache, should not trigger webhooks)
    const resSync1 = await fetch(`${baseUrl}/api/trigger-sync`, { method: 'POST' });
    assert.strictEqual(resSync1.status, 200);
    
    // 3. Update mock items with a new item
    mockFeedItems.unshift({
      title: 'Item 2 (New)',
      link: 'http://2.com',
      pubDate: '2026-06-10T11:00:00Z',
      guid: '2'
    });

    // 4. Second Sync (Triggers push)
    const resSync2 = await fetch(`${baseUrl}/api/trigger-sync`, { method: 'POST' });
    assert.strictEqual(resSync2.status, 200);
    const syncResult = await resSync2.json();
    assert.strictEqual(syncResult.newItemsCount, 1);

    // Wait for webhook receiver to capture request
    await webhookPromise;

    // Assert webhook was received with correct content
    assert.ok(webhookReceivedPayload);
    assert.strictEqual(webhookReceivedPayload.event, 'new_items');
    assert.strictEqual(webhookReceivedPayload.items.length, 1);
    assert.strictEqual(webhookReceivedPayload.items[0].guid, '2');
    assert.strictEqual(webhookReceivedPayload.items[0].title, 'Item 2 (New)');

    // Check /feed returns the aggregated XML containing both items
    const resFeed = await fetch(`${baseUrl}/feed`);
    assert.strictEqual(resFeed.status, 200);
    const xml = await resFeed.text();
    assert.ok(xml.includes('<title><![CDATA[Item 2 (New)]]></title>'));
    assert.ok(xml.includes('<title><![CDATA[Item 1]]></title>'));

    // Clean up webhook server
    await new Promise(resolve => dummyWebhookServer.close(resolve));
  });
});
