import Parser from 'rss-parser';
import { Feed } from 'feed';
import { readJson } from './database.js';
import { 
  FEEDS_DB_PATH, 
  WEBHOOKS_DB_PATH, 
  MAX_FEED_ITEMS, 
  FEED_TITLE, 
  FEED_DESCRIPTION, 
  FEED_LINK 
} from './config.js';

export class FeedAggregator {
  constructor(options = {}) {
    this.parser = options.parser || new Parser();
    this.feedsDbPath = options.feedsDbPath || FEEDS_DB_PATH;
    this.webhooksDbPath = options.webhooksDbPath || WEBHOOKS_DB_PATH;
    this.maxItems = options.maxItems || MAX_FEED_ITEMS;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    
    this.seenItems = new Set();
    this.isInitialized = false;
    this.cachedXml = '';
    this.cachedItems = [];
  }

  /**
   * Fetches feeds, merges them, detects new items, triggers webhooks, and updates cache.
   */
  async sync() {
    const feeds = await readJson(this.feedsDbPath, []);
    if (feeds.length === 0) {
      this.cachedItems = [];
      this.cachedXml = this.generateRssXml([]);
      return { newItems: [], allItems: [] };
    }

    const fetchPromises = feeds.map(async (feedUrl) => {
      try {
        const feed = await this.parser.parseURL(feedUrl);
        return feed.items.map(item => ({
          title: item.title || 'Untitled',
          link: item.link || '',
          description: item.description || item.contentSnippet || '',
          content: item.content || '',
          pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
          author: item.creator || item.author || 'Unknown',
          guid: item.guid || item.id || item.link || '',
          sourceFeedTitle: feed.title || 'Unknown Source',
          sourceFeedUrl: feedUrl
        }));
      } catch (err) {
        console.error(`Error fetching/parsing feed ${feedUrl}:`, err.message);
        return [];
      }
    });

    const results = await Promise.all(fetchPromises);
    const flatItems = results.flat();

    // Deduplicate items based on guid or link
    const uniqueItemsMap = new Map();
    for (const item of flatItems) {
      const key = item.guid || item.link;
      if (key && !uniqueItemsMap.has(key)) {
        uniqueItemsMap.set(key, item);
      }
    }

    // Sort by pubDate descending
    const sortedItems = Array.from(uniqueItemsMap.values()).sort((a, b) => {
      return new Date(b.pubDate) - new Date(a.pubDate);
    });

    // Limit items
    const limitedItems = sortedItems.slice(0, this.maxItems);
    this.cachedItems = limitedItems;
    this.cachedXml = this.generateRssXml(limitedItems);

    // Identify new items
    const newItems = [];
    for (const item of limitedItems) {
      const key = item.guid || item.link;
      if (key && !this.seenItems.has(key)) {
        newItems.push(item);
        this.seenItems.add(key);
      }
    }

    // Keep seenItems Set bounded
    if (this.seenItems.size > 2000) {
      const keysArray = Array.from(this.seenItems);
      // Remove oldest items to keep size under 2000
      const toRemove = keysArray.slice(0, this.seenItems.size - 2000);
      for (const k of toRemove) {
        this.seenItems.delete(k);
      }
    }

    // Webhook push: only trigger if initialized, to avoid massive push on startup
    if (this.isInitialized && newItems.length > 0) {
      await this.pushToWebhooks(newItems);
    } else if (!this.isInitialized) {
      // First sync complete, now marked as initialized
      this.isInitialized = true;
      console.log(`Aggregator initialized. Cached ${limitedItems.length} items. Seen items count: ${this.seenItems.size}`);
    }

    return { newItems, allItems: limitedItems };
  }

  /**
   * Pushes new feed items to all registered webhooks.
   */
  async pushToWebhooks(newItems) {
    const webhooks = await readJson(this.webhooksDbPath, []);
    if (webhooks.length === 0) return;

    const payload = {
      event: 'new_items',
      timestamp: new Date().toISOString(),
      items: newItems
    };

    console.log(`Pushing ${newItems.length} new items to ${webhooks.length} webhooks.`);

    const pushPromises = webhooks.map(async (url) => {
      try {
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000) // 5 second timeout
        });
        if (!res.ok) {
          console.warn(`Webhook ${url} responded with status: ${res.status}`);
        }
      } catch (err) {
        console.error(`Failed to push to webhook ${url}:`, err.message);
      }
    });

    await Promise.all(pushPromises);
  }

  /**
   * Generates RSS 2.0 XML representation of feed items.
   */
  generateRssXml(items) {
    const feed = new Feed({
      title: FEED_TITLE,
      description: FEED_DESCRIPTION,
      id: FEED_LINK,
      link: FEED_LINK,
      language: 'en',
      updated: items.length > 0 ? new Date(items[0].pubDate) : new Date(),
      generator: 'Antigravity RSS Feed Aggregator',
    });

    for (const item of items) {
      feed.addItem({
        title: item.title,
        id: item.guid || item.link,
        link: item.link,
        description: item.description,
        content: item.content,
        author: [
          {
            name: item.author,
          }
        ],
        date: new Date(item.pubDate),
        extra: {
          source: {
            title: item.sourceFeedTitle,
            url: item.sourceFeedUrl
          }
        }
      });
    }

    return feed.rss2();
  }
}
