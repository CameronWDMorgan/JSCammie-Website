/**
 * Test script for sitemap generation
 * Run this to test the sitemap functionality locally
 */

const SitemapGenerator = require('./utils/sitemap/sitemapGenerator');
const mongolib = require('./mongolib');

async function testSitemapGeneration() {
    console.log('Testing sitemap generation...\n');

    try {
        // Connect to database
        await mongolib.connectToDatabase();
        
        // Create sitemap generator
        const generator = new SitemapGenerator();
        
        console.log('1. Testing static sitemap generation...');
        const staticResult = await generator.generateStaticSitemap();
        console.log('Static sitemap result:', staticResult);
        
        console.log('\n2. Testing booru posts sitemap generation...');
        const postsResult = await generator.generateBooruPostsSitemap();
        console.log('Posts sitemap result:', postsResult);
        
        console.log('\n3. Testing user profiles sitemap generation...');
        const usersResult = await generator.generateUserProfilesSitemap();
        console.log('Users sitemap result:', usersResult);
        
        console.log('\n4. Testing searches sitemap generation...');
        const searchesResult = await generator.generateSearchesSitemap();
        console.log('Searches sitemap result:', searchesResult);
        
        console.log('\n5. Testing full sitemap generation...');
        const fullResult = await generator.generateAllSitemaps();
        console.log('Full generation result:', fullResult);
        
        console.log('\nSitemap generation test completed!');
        
    } catch (error) {
        console.error('Error during sitemap generation test:', error);
    }
    
    // Exit the process
    process.exit(0);
}

// Run the test if this file is executed directly
if (require.main === module) {
    testSitemapGeneration();
}

module.exports = testSitemapGeneration;
