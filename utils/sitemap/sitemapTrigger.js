/**
 * Sitemap utilities for triggering regeneration when content changes
 */

const SitemapGenerator = require('./sitemapGenerator');

class SitemapTrigger {
    constructor() {
        this.sitemapGenerator = new SitemapGenerator();
        this.lastRegeneration = Date.now();
        this.minRegenerationInterval = 30 * 60 * 1000; // 30 minutes minimum between regenerations
        this.pendingRegeneration = false;
    }

    /**
     * Trigger sitemap regeneration (with throttling)
     */
    async triggerRegeneration(reason = 'Content updated') {
        // Throttle regeneration requests
        const now = Date.now();
        if (now - this.lastRegeneration < this.minRegenerationInterval) {
            if (!this.pendingRegeneration) {
                this.pendingRegeneration = true;
                // Schedule regeneration for later
                setTimeout(() => {
                    this.triggerRegeneration(`Delayed: ${reason}`);
                }, this.minRegenerationInterval - (now - this.lastRegeneration));
            }
            return;
        }

        this.pendingRegeneration = false;
        this.lastRegeneration = now;

        try {
            console.log(`Triggering sitemap regeneration: ${reason}`);
            const result = await this.sitemapGenerator.generateAllSitemaps();
            console.log(`Sitemap regeneration completed: ${result.success ? 'Success' : 'Failed'}`);
            return result;
        } catch (error) {
            console.error('Error during triggered sitemap regeneration:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Should be called when new booru posts are created
     */
    onBooruPostCreated() {
        this.triggerRegeneration('New booru post created');
    }

    /**
     * Should be called when user profiles are updated significantly
     */
    onUserProfileUpdated() {
        this.triggerRegeneration('User profile updated');
    }

    /**
     * Should be called when new users register
     */
    onUserRegistered() {
        this.triggerRegeneration('New user registered');
    }

    /**
     * Should be called when popular searches change significantly
     */
    onPopularSearchesChanged() {
        this.triggerRegeneration('Popular searches updated');
    }
}

// Create singleton instance
const sitemapTrigger = new SitemapTrigger();

module.exports = sitemapTrigger;
