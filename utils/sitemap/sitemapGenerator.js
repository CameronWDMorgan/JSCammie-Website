const fs = require('fs');
const path = require('path');
const mongolib = require('../../mongolib');

/**
 * Sitemap Generator for JSCammie.com
 * Generates XML sitemaps for static pages, user profiles, booru posts, and popular searches
 */

class SitemapGenerator {
    constructor() {
        this.baseUrl = 'https://www.jscammie.com';
        this.maxUrlsPerSitemap = 50000;
        this.sitemapDir = path.join(__dirname, '../../');
    }

    /**
     * Escape XML special characters
     */
    escapeXml(str) {
        if (!str) return '';
        return str.toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Format timestamp for sitemap lastmod
     */
    formatTimestamp(timestamp) {
        let date;
        if (typeof timestamp === 'string' && timestamp.length === 13) {
            // Unix timestamp in milliseconds
            date = new Date(parseInt(timestamp));
        } else if (typeof timestamp === 'number') {
            date = new Date(timestamp);
        } else if (timestamp instanceof Date) {
            date = timestamp;
        } else {
            date = new Date();
        }
        
        return date.toISOString().split('T')[0]; // YYYY-MM-DD format
    }

    /**
     * Generate XML header for sitemap
     */
    generateXmlHeader() {
        return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    }

    /**
     * Generate XML footer for sitemap
     */
    generateXmlFooter() {
        return '</urlset>';
    }

    /**
     * Generate sitemap index XML
     */
    generateSitemapIndex(sitemaps) {
        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

        for (const sitemap of sitemaps) {
            xml += `
    <sitemap>
        <loc>${this.baseUrl}/${sitemap.filename}</loc>
        <lastmod>${this.formatTimestamp(sitemap.lastmod)}</lastmod>
    </sitemap>`;
        }

        xml += '\n</sitemapindex>';
        return xml;
    }

    /**
     * Generate URL entry for sitemap
     */
    generateUrlEntry(url, lastmod, priority = '0.5', changefreq = 'monthly') {
        return `
    <url>
        <loc>${this.escapeXml(url)}</loc>
        <lastmod>${this.formatTimestamp(lastmod)}</lastmod>
        <priority>${priority}</priority>
        <changefreq>${changefreq}</changefreq>
    </url>`;
    }

    /**
     * Generate static pages sitemap
     */
    async generateStaticSitemap() {
        console.log('Generating static sitemap...');
        
        const staticPages = [
            { url: '/', priority: '1.00', changefreq: 'daily' },
            { url: '/home', priority: '0.80', changefreq: 'weekly' },
            { url: '/booru/', priority: '1.00', changefreq: 'daily' },
            { url: '/login', priority: '0.80', changefreq: 'monthly' },
            { url: '/suggestions', priority: '0.80', changefreq: 'weekly' },
            { url: '/image-history', priority: '0.80', changefreq: 'weekly' },
            { url: '/contact', priority: '0.80', changefreq: 'monthly' },
            { url: '/privacypolicy', priority: '0.80', changefreq: 'monthly' },
            { url: '/projects', priority: '0.64', changefreq: 'monthly' },
            { url: '/metadata', priority: '0.51', changefreq: 'monthly' },
            { url: '/ai', priority: '0.90', changefreq: 'weekly' },
            { url: '/credits-history', priority: '0.60', changefreq: 'weekly' },
            { url: '/game', priority: '0.50', changefreq: 'monthly' }
        ];

        let xml = this.generateXmlHeader();
        const now = new Date();

        for (const page of staticPages) {
            xml += this.generateUrlEntry(
                `${this.baseUrl}${page.url}`,
                now,
                page.priority,
                page.changefreq
            );
        }

        xml += this.generateXmlFooter();
        
        const filename = 'sitemap-static.xml';
        fs.writeFileSync(path.join(this.sitemapDir, filename), xml);
        
        return {
            filename,
            lastmod: now,
            count: staticPages.length
        };
    }

    /**
     * Generate booru posts sitemap
     */
    async generateBooruPostsSitemap() {
        console.log('Generating booru posts sitemap...');
        
        try {
            // Get all booru posts with SFW safety rating only (for AI crawlers)
            const booruPosts = await mongolib.aggregateSchemaDocuments('userBooru', [
                { 
                    $match: { 
                        safety: { $in: ['sfw', 'suggestive'] } // Include SFW and suggestive for broader appeal
                    } 
                },
                { 
                    $project: { 
                        booru_id: 1, 
                        timestamp: 1, 
                        title: 1,
                        upvotes: 1,
                        downvotes: 1
                    } 
                },
                { $sort: { timestamp: -1 } },
                { $limit: this.maxUrlsPerSitemap }
            ]);

            if (!booruPosts || booruPosts.length === 0) {
                console.log('No booru posts found for sitemap');
                return null;
            }

            let xml = this.generateXmlHeader();

            for (const post of booruPosts) {
                // Calculate priority based on engagement
                const upvotes = post.upvotes ? post.upvotes.length : 0;
                const downvotes = post.downvotes ? post.downvotes.length : 0;
                const netVotes = upvotes - downvotes;
                
                // Priority between 0.5 and 0.9 based on engagement
                let priority = '0.7'; // Base priority
                if (netVotes > 10) priority = '0.8';
                if (netVotes > 25) priority = '0.9';
                if (netVotes < -5) priority = '0.5';

                xml += this.generateUrlEntry(
                    `${this.baseUrl}/booru/post/${this.escapeXml(post.booru_id)}`,
                    post.timestamp,
                    priority,
                    'weekly'
                );
            }

            xml += this.generateXmlFooter();
            
            const filename = 'sitemap-posts.xml';
            fs.writeFileSync(path.join(this.sitemapDir, filename), xml);
            
            return {
                filename,
                lastmod: new Date(),
                count: booruPosts.length
            };
        } catch (error) {
            console.error('Error generating booru posts sitemap:', error);
            return null;
        }
    }

    /**
     * Generate user profiles sitemap
     */
    async generateUserProfilesSitemap() {
        console.log('Generating user profiles sitemap...');
        
        try {
            // Get active users with recent activity and public content
            const users = await mongolib.aggregateSchemaDocuments('userAccount', [
                {
                    $match: {
                        // Only include users with recent activity (last 6 months)
                        lastLoginAt: { 
                            $gte: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) 
                        },
                        // Exclude banned users
                        booruPostBanned: { $ne: true }
                    }
                },
                {
                    $lookup: {
                        from: 'userBooru',
                        localField: 'accountId',
                        foreignField: 'account_id',
                        as: 'booruPosts',
                        pipeline: [
                            { $match: { safety: { $in: ['sfw', 'suggestive'] } } },
                            { $limit: 1 } // Just check if they have any posts
                        ]
                    }
                },
                {
                    $match: {
                        // Only include users with at least one public booru post
                        'booruPosts.0': { $exists: true }
                    }
                },
                {
                    $project: {
                        accountId: 1,
                        username: 1,
                        lastLoginAt: 1,
                        booruPostCount: { $size: '$booruPosts' }
                    }
                },
                { $sort: { lastLoginAt: -1 } },
                { $limit: this.maxUrlsPerSitemap }
            ]);

            if (!users || users.length === 0) {
                console.log('No active users found for sitemap');
                return null;
            }

            let xml = this.generateXmlHeader();

            for (const user of users) {
                xml += this.generateUrlEntry(
                    `${this.baseUrl}/profile/${this.escapeXml(user.accountId)}`,
                    user.lastLoginAt,
                    '0.6',
                    'monthly'
                );
            }

            xml += this.generateXmlFooter();
            
            const filename = 'sitemap-users.xml';
            fs.writeFileSync(path.join(this.sitemapDir, filename), xml);
            
            return {
                filename,
                lastmod: new Date(),
                count: users.length
            };
        } catch (error) {
            console.error('Error generating user profiles sitemap:', error);
            return null;
        }
    }

    /**
     * Generate popular searches sitemap
     */
    async generateSearchesSitemap() {
        console.log('Generating searches sitemap...');
        
        try {
            // First try to get popular searches from tracked search stats
            let popularSearches = await mongolib.aggregateSchemaDocuments('searchStat', [
                { 
                    $match: { 
                        resultCount: { $gte: 10 }, // Only searches with 10+ results
                        safetyLevel: 'sfw' // Only SFW searches for AI crawlers
                    } 
                },
                { $sort: { searchCount: -1 } },
                { $limit: 500 } // Top 500 most searched terms
            ]);

            // If we don't have enough search stats, fall back to popular tags
            if (!popularSearches || popularSearches.length < 50) {
                console.log('Insufficient search stats, falling back to popular tags...');
                const popularTags = await mongolib.aggregateSchemaDocuments('userBooruTags', [
                    { $group: { _id: '$tag', count: { $sum: 1 } } },
                    { $match: { count: { $gte: 10 } } }, // Only tags with 10+ posts
                    { $sort: { count: -1 } },
                    { $limit: 500 } // Limit to top 500 searches
                ]);

                // Convert tag format to search format
                const tagSearches = popularTags.map(tag => ({
                    searchTerm: tag._id,
                    searchCount: tag.count,
                    resultCount: tag.count
                }));

                // Merge with existing search stats (if any)
                if (popularSearches && popularSearches.length > 0) {
                    const existingTerms = new Set(popularSearches.map(s => s.searchTerm));
                    const newTagSearches = tagSearches.filter(t => !existingTerms.has(t.searchTerm));
                    popularSearches = [...popularSearches, ...newTagSearches];
                } else {
                    popularSearches = tagSearches;
                }
            }

            if (!popularSearches || popularSearches.length === 0) {
                console.log('No popular searches found for sitemap');
                return null;
            }

            // Sort by search count and limit to top 1000
            popularSearches.sort((a, b) => b.searchCount - a.searchCount);
            popularSearches = popularSearches.slice(0, 1000);

            let xml = this.generateXmlHeader();

            for (const search of popularSearches) {
                // Encode the search term for URL
                const encodedTerm = encodeURIComponent(search.searchTerm);
                
                // Priority based on popularity
                let priority = '0.5';
                if (search.searchCount > 50) priority = '0.6';
                if (search.searchCount > 100) priority = '0.7';
                if (search.searchCount > 500) priority = '0.8';

                xml += this.generateUrlEntry(
                    `${this.baseUrl}/booru/?search=${encodedTerm}&safety=sfw`,
                    new Date(),
                    priority,
                    'weekly'
                );
            }

            xml += this.generateXmlFooter();
            
            const filename = 'sitemap-searches.xml';
            fs.writeFileSync(path.join(this.sitemapDir, filename), xml);
            
            return {
                filename,
                lastmod: new Date(),
                count: popularSearches.length
            };
        } catch (error) {
            console.error('Error generating searches sitemap:', error);
            return null;
        }
    }

    /**
     * Generate all sitemaps and sitemap index
     */
    async generateAllSitemaps() {
        console.log('Starting sitemap generation...');
        
        const sitemaps = [];
        
        try {
            // Generate individual sitemaps
            const staticSitemap = await this.generateStaticSitemap();
            if (staticSitemap) sitemaps.push(staticSitemap);
            
            const postsSitemap = await this.generateBooruPostsSitemap();
            if (postsSitemap) sitemaps.push(postsSitemap);
            
            const usersSitemap = await this.generateUserProfilesSitemap();
            if (usersSitemap) sitemaps.push(usersSitemap);
            
            const searchesSitemap = await this.generateSearchesSitemap();
            if (searchesSitemap) sitemaps.push(searchesSitemap);
            
            // Generate sitemap index
            if (sitemaps.length > 0) {
                const indexXml = this.generateSitemapIndex(sitemaps);
                fs.writeFileSync(path.join(this.sitemapDir, 'sitemap.xml'), indexXml);
                
                console.log(`Sitemap generation complete. Generated ${sitemaps.length} sitemaps:`);
                sitemaps.forEach(sitemap => {
                    console.log(`- ${sitemap.filename}: ${sitemap.count} URLs`);
                });
                
                return {
                    success: true,
                    sitemaps: sitemaps,
                    totalUrls: sitemaps.reduce((sum, sitemap) => sum + sitemap.count, 0)
                };
            } else {
                console.log('No sitemaps generated');
                return { success: false, error: 'No sitemaps generated' };
            }
        } catch (error) {
            console.error('Error during sitemap generation:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if sitemaps need regeneration (daily check)
     */
    async shouldRegenerateSitemaps() {
        try {
            const sitemapPath = path.join(this.sitemapDir, 'sitemap.xml');
            
            if (!fs.existsSync(sitemapPath)) {
                return true; // No sitemap exists
            }
            
            const stats = fs.statSync(sitemapPath);
            const lastModified = stats.mtime;
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            
            return lastModified < oneDayAgo;
        } catch (error) {
            console.error('Error checking sitemap age:', error);
            return true; // Regenerate on error
        }
    }
}

module.exports = SitemapGenerator;
