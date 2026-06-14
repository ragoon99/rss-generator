import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { FeedAggregator } from '../aggregator.js';
import { writeJson } from '../database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tempFeedsPath = path.join(__dirname, 'temp_feeds.json');
const tempWebhooksPath = path.join(__dirname, 'temp_webhooks.json');

async function cleanup() {
  try {
    await fs.unlink(tempFeedsPath);
  } catch {}
  try {
    await fs.unlink(tempWebhooksPath);
  } catch {}
}

test.describe('FeedAggregator Unit Tests', () => {
  test.beforeEach(async () => {
    await cleanup();
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test('should parse, normalize, sort and limit feed items', async () => {
    // Setup temporary database with a source feed URL
    await writeJson(tempFeedsPath, ['https://mockfeed1.com/rss']);
    
    // Mock RSS parser
    const mockParser = {
      parseURL: async (url) => {
        assert.strictEqual(url, 'https://mockfeed1.com/rss');
        return {
          title: 'Mock Feed 1',
          items: [
            { title: 'Item Old', link: 'http://old.com', pubDate: '2026-06-09T10:00:00Z', guid: 'g1' },
            { title: 'Item New', link: 'http://new.com', pubDate: '2026-06-10T12:00:00Z', guid: 'g2' },
            { title: 'Item Mid', link: 'http://mid.com', pubDate: '2026-06-10T10:00:00Z', guid: 'g3' }
          ]
        };
      }
    };

    const aggregator = new FeedAggregator({
      parser: mockParser,
      feedsDbPath: tempFeedsPath,
      webhooksDbPath: tempWebhooksPath,
      maxItems: 2
    });

    const { newItems, allItems } = await aggregator.sync();

    // On initial sync, newItems contains the newly cached items
    assert.strictEqual(newItems.length, 2);

    // allItems should be sorted by date descending and limited to maxItems (2)
    assert.strictEqual(allItems.length, 2);
    assert.strictEqual(allItems[0].guid, 'g2'); // Item New (June 10 12:00)
    assert.strictEqual(allItems[1].guid, 'g3'); // Item Mid (June 10 10:00)
    
    // Check fields are normalized
    assert.strictEqual(allItems[0].title, 'Item New');
    assert.strictEqual(allItems[0].sourceFeedTitle, 'Mock Feed 1');
  });

  test('should deduplicate items by guid or link', async () => {
    await writeJson(tempFeedsPath, ['https://mockfeed1.com/rss']);

    const mockParser = {
      parseURL: async () => ({
        title: 'Mock Feed',
        items: [
          { title: 'A', link: 'http://dup.com', pubDate: '2026-06-10T10:00:00Z', guid: 'same-guid' },
          { title: 'B', link: 'http://dup.com', pubDate: '2026-06-10T11:00:00Z', guid: 'same-guid' }
        ]
      })
    };

    const aggregator = new FeedAggregator({
      parser: mockParser,
      feedsDbPath: tempFeedsPath,
      webhooksDbPath: tempWebhooksPath
    });

    const { allItems } = await aggregator.sync();

    // Deduplication should result in exactly 1 item
    assert.strictEqual(allItems.length, 1);
  });

  test('should detect new items after initialization and push to webhooks', async () => {
    await writeJson(tempFeedsPath, ['https://mockfeed1.com/rss']);
    await writeJson(tempWebhooksPath, ['https://mywebhook.com/push']);

    // Setup mock parser with initial state
    let feedItems = [
      { title: 'Item 1', link: 'http://1.com', pubDate: '2026-06-10T10:00:00Z', guid: '1' }
    ];

    const mockParser = {
      parseURL: async () => ({
        title: 'Mock Feed',
        items: feedItems
      })
    };

    // Mock fetch for webhook trigger
    let webhookCalled = false;
    let webhookPayload = null;
    
    const mockFetch = async (url, options) => {
      assert.strictEqual(url, 'https://mywebhook.com/push');
      webhookCalled = true;
      webhookPayload = JSON.parse(options.body);
      return { ok: true, status: 200 };
    };

    const aggregator = new FeedAggregator({
      parser: mockParser,
      feedsDbPath: tempFeedsPath,
      webhooksDbPath: tempWebhooksPath,
      fetchFn: mockFetch
    });

    // 1. Initial sync - should set initialization and cache item, but not trigger webhook push
    await aggregator.sync();
    assert.strictEqual(aggregator.isInitialized, true);
    assert.strictEqual(webhookCalled, false);

    // 2. Add an item to mock feed
    feedItems = [
      { title: 'Item 2', link: 'http://2.com', pubDate: '2026-06-10T11:00:00Z', guid: '2' },
      { title: 'Item 1', link: 'http://1.com', pubDate: '2026-06-10T10:00:00Z', guid: '1' }
    ];

    // 3. Second sync - should identify Item 2 as new and push it
    const { newItems } = await aggregator.sync();
    
    assert.strictEqual(newItems.length, 1);
    assert.strictEqual(newItems[0].guid, '2');
    assert.strictEqual(webhookCalled, true);
    assert.strictEqual(webhookPayload.event, 'new_items');
    assert.strictEqual(webhookPayload.items.length, 1);
    assert.strictEqual(webhookPayload.items[0].guid, '2');
  });
});
