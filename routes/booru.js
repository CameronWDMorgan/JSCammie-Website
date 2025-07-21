const express = require('express');
const router = express.Router();
const mongolib = require('../mongolib');
const path = require('path');
const fs = require('fs');
const he = require('he');

// Import required schemas
const userBooruSchema = require('../schemas/userBooruSchema.js');
const userBooruTagsSchema = require('../schemas/userBooruTagsSchema.js');
const userHistorySchema = require('../schemas/userHistorySchema.js');
const userProfileSchema = require('../schemas/userProfileSchema.js');

// Configuration variables
let booruFolder = "booruImages/";
let modifiedCachedYAMLData;

// Blacklisted words for booru prompts
const BLACKLISTED_WORDS = [
	"loli",
	"shota", 
	"child",
	"minor",
	"underage",
	"kid",
	"teen",
	"preteen",
	"juvenile",
	"infant",
	"toddler",
	"baby",
	"elementary",
    "rape",
    "raped",
    "raping",
    "rapist",
    "rapists",
];

// Function to check for blacklisted words in prompt
function checkForBlacklistedWords(prompt) {
	const lowerPrompt = prompt.toLowerCase();
	
	for (const word of BLACKLISTED_WORDS) {
		// Use regex with word boundaries to match whole words only
		const regex = new RegExp(`\\b${word.toLowerCase()}\\b`);
		if (regex.test(lowerPrompt)) {
			return word;
		}
	}
	
	return null;
}

// Import helper functions and dependencies from main file
// Note: These will need to be imported from the main file or made available
let SCORING_CONFIG;

// Helper functions that need to be shared (these should be moved to a utils file eventually)
const splitSearchTags = (tags) => {
    if (!tags) return [];
    return tags.split(/\s+/).map(tag => tag.trim()).filter(tag => tag.length > 0);
};

function splitTags(tags) {
	// make all the tags lowercase:
	tags = tags.map(tag => tag.toLowerCase())

	// remove any html tags:
	tags = tags.map(tag => tag.replace(/<.*?>/g, ''))

	// remove any brackets:
	tags = tags.map(tag => tag.replace(/[()]/g, ''))

	// trim the front and back of the tags:
	tags = tags.map(tag => tag.trim())

	tags = tags.map(tag => tag.replace(/ /g, '_'))
	// remove any back slashes:
	tags = tags.map(tag => tag.replace(/\\/g, ''))

	// remote the conent of tags inbetween <>:
	tags = tags.map(tag => tag.replace(/<.*?>/g, ''))

	// remove any numbers after a colon, IF there is a colon:
	tags = tags.map(tag => tag.replace(/:\d+/g, ''))

	// remove any empty tags:
	tags = tags.filter(tag => tag !== "")
	return tags
}

const getBaseMatchStage = (allowedSafetyLevels, blockedAccounts, followedAccounts = null) => {
    const baseMatch = { safety: { $in: allowedSafetyLevels } };
    
    if (followedAccounts && followedAccounts.length > 0) {
        // If we're filtering by followed accounts, filter out any blocked accounts from the followed list
        let filteredFollowedAccounts = followedAccounts;
        if (blockedAccounts && blockedAccounts.length > 0) {
            filteredFollowedAccounts = followedAccounts.filter(accountId => !blockedAccounts.includes(accountId));
        }
        baseMatch.account_id = { $in: filteredFollowedAccounts };
    } else if (blockedAccounts && blockedAccounts.length > 0) {
        // Only apply blocked accounts filter if we're not filtering by followed accounts
        baseMatch.account_id = { $nin: blockedAccounts };
    }
    
    return { $match: baseMatch };
};

const getPaginationStages = (skip, limit) => [
    { $skip: skip },
    { $limit: limit }
];

const getTrendingScoreStage = (trendingAgo, tempBoostTimestamp) => ({
    $addFields: {
        recentVoteCount: {
            $size: {
                $filter: {
                    input: { $ifNull: ["$upvotes", []] },
                    cond: { $gte: [{ $toLong: "$$this.timestamp" }, trendingAgo] }
                }
            }
        },
        totalVotes: {
            $subtract: [
                { $size: { $ifNull: ["$upvotes", []] } },
                { $size: { $ifNull: ["$downvotes", []] } }
            ]
        },
        recentCommentCount: {
            $size: {
                $filter: {
                    input: { $ifNull: ["$comments", []] },
                    cond: { $gte: [{ $toLong: "$$this.timestamp" }, trendingAgo] }
                }
            }
        },
        commentCount: { $size: { $ifNull: ["$comments", []] } },
        timestampRated: { $toLong: "$timestamp" }
    }
});

const getSortStage = (sortType) => {
    switch (sortType) {
        case "newest":
        case "recent":
            return { $sort: { timestamp: -1 } };
        case "oldest":
            return { $sort: { timestamp: 1 } };
        case "trending":
            return { $sort: { score: -1, timestamp: -1 } };
        case "votes":
            return { $sort: { totalVotes: -1, timestamp: -1 } };
        case "comments":
            return { $sort: { commentCount: -1, timestamp: -1 } };
        case "following":
            // Following is a filter, not a sort - default to newest for followed posts
            return { $sort: { timestamp: -1 } };
        default:
            return { $sort: { timestamp: -1 } };
    }
};

const fetchAccounts = async (booruImages, type) => {
    const accountIds = [...new Set(booruImages.map(image => image.account_id))];
    const profiles = await mongolib.aggregateSchemaDocuments("userProfile", [
        { $match: { accountId: { $in: accountIds } } },
        { $project: { accountId: 1, username: 1, profileImg: 1 } }
    ]);
    
    const profilesMap = Object.fromEntries(profiles.map(p => [p.accountId, p]));
    return booruImages.map(image => ({
        ...image,
        [type]: profilesMap[image.account_id] || { username: "Unknown", profileImg: "" }
    }));
};

const calculateBooruScore = (stats, followerCount, SCORING_CONFIG, highestFollowerCount) => {
    // Calculate follower score modifier
    const followerScoreModifier = ((followerCount / highestFollowerCount) / 7.14) + 0.95;

    // Calculate average score per post
    let avgScore = stats.postCount > 0 ? stats.totalScore / stats.postCount : 0;

    // Add diminishing returns for volume (prevents spam posting)
    let volumeModifier = stats.postCount > 0 ? Math.pow(stats.postCount, SCORING_CONFIG.VOLUME_DIMINISH_FACTOR) / Math.pow(SCORING_CONFIG.MIN_POST_THRESHOLD, SCORING_CONFIG.VOLUME_DIMINISH_FACTOR) : 0;
    if (stats.postCount < SCORING_CONFIG.MIN_POST_THRESHOLD) {
        volumeModifier = Math.pow(stats.postCount / SCORING_CONFIG.MIN_POST_THRESHOLD, SCORING_CONFIG.VOLUME_DIMINISH_FACTOR);
    }

    // Calculate engagement rate (total engagement per post relative to follower count)
    let totalEngagement = (stats.totalUpvotes || 0) + (stats.totalComments || 0);
    let engagementPerPost = stats.postCount > 0 ? totalEngagement / stats.postCount : 0;
    let effectiveFollowerCount = Math.min(followerCount, SCORING_CONFIG.FOLLOWER_ENGAGEMENT_CAP);
    // ensure effectiveFollowerCount is at least 1 to prevent division by zero
    effectiveFollowerCount = Math.max(1, effectiveFollowerCount);
    let engagementRate = engagementPerPost / effectiveFollowerCount;

    // Final score: base average + volume bonus + engagement rate bonus
    let rawFinalScore = avgScore * volumeModifier + (engagementRate * SCORING_CONFIG.ENGAGEMENT_MULTIPLIER);
    let finalScoreWithFollowerModifier = rawFinalScore * followerScoreModifier;
    
    return {
        rawScore: rawFinalScore,
        finalScore: finalScoreWithFollowerModifier,
        avgScore: avgScore,
        volumeModifier: volumeModifier,
        engagementRate: engagementRate,
        followerScoreModifier: followerScoreModifier
    };
};

// Initialize function to set dependencies from main app
router.init = (dependencies) => {
    modifiedCachedYAMLData = dependencies.modifiedCachedYAMLData;
    SCORING_CONFIG = dependencies.SCORING_CONFIG;
};

// Main booru listing page
router.get('/', async function(req, res) {
    try {
        // Get sorting and filtering parameters
        const sort = req.query.sort || "newest";
        
        // Handle safety parameter - can be comma-separated values
        let allowedSafetyLevels;
        const safetyParam = req.query.safety || "sfw";
        
        if (safetyParam.includes(',')) {
            // Multiple safety levels specified
            allowedSafetyLevels = safetyParam.split(',').map(s => s.trim()).filter(s => s.length > 0);
        } else {
            // Single safety level
            allowedSafetyLevels = [safetyParam];
        }
        
        // Debug logging
        console.log(`Debug safety - URL param: "${safetyParam}", allowed levels: [${allowedSafetyLevels.join(', ')}]`);
        
        // Note: We'll pass the allowedSafetyLevels directly to the base match stage
        
        const tags = req.query.search;
        const username = req.query.username;
        
        // Handle following parameter - can come from sort=following or following=true
        let following = false;
        if (req.query.following === 'true') {
            following = true;
        } else if (req.query.sort === 'following') {
            following = true;
        }
        
        let page = Math.max(parseInt(req.query.page) || 1, 1);
        
        const totalPerPage = 42;
        const skip = (page - 1) * totalPerPage;
        
        console.log(`Booru request - Sort: ${sort}, Safety: ${allowedSafetyLevels.join(', ')}, Tags: ${tags}, Username: ${username}, Following: ${following}, Page: ${page}`);
        
        // Get user's blocked accounts
        let blockedAccounts = [];
        let followedAccounts = [];
        
        if (req.session.accountId) {
            try {
                const userProfile = await mongolib.getSchemaDocumentOnce("userProfile", { accountId: req.session.accountId });
                blockedAccounts = userProfile?.blockedAccounts || [];
                followedAccounts = userProfile?.followedAccounts || [];
                
                console.log(`User has ${followedAccounts.length} followed accounts and ${blockedAccounts.length} blocked accounts`);
                console.log(`Following filter active: ${following}`);
            } catch (error) {
                console.log(`Error fetching user profile for blocking: ${error}`);
            }
        }
        
        // If following is true but user has no followed accounts, return empty results
        if (following && (!followedAccounts || followedAccounts.length === 0)) {
            console.log(`Following filter requested but user has no followed accounts`);
            return res.render('booru/home', {
                session: req.session,
                booruImages: [],
                totalPages: 0,
                currentPage: page,
                sort: sort,
                safety: allowedSafetyLevels.join(', '),
                tags: tags,
                username: username,
                following: following,
                maxSafety: req.session.maxSafety || 1,
                booruSearchScript: require('fs').readFileSync('./scripts/booru-search.js', 'utf8'),
                booruAccounts: [],
                upvoteAccounts: [],
                downvoteAccounts: [],
                userProfile: req.session.accountId ? await mongolib.getSchemaDocumentOnce("userProfile", { accountId: req.session.accountId }) || {} : {}
            });
        }
        
        // Build aggregation pipeline
        let pipeline = [];
        
        // Base filtering
        const baseMatchConditions = getBaseMatchStage(
            allowedSafetyLevels, 
            blockedAccounts, 
            following ? followedAccounts : null
        );
        pipeline.push(baseMatchConditions);
        
        console.log(`Base match conditions:`, JSON.stringify(baseMatchConditions, null, 2));
        
        if (following) {
            console.log(`Following filter active - will show posts from ${followedAccounts.length} followed accounts`);
            console.log(`Followed accounts:`, followedAccounts);
            if (blockedAccounts.length > 0) {
                const filteredFollowedAccounts = followedAccounts.filter(accountId => !blockedAccounts.includes(accountId));
                console.log(`After filtering blocked accounts: ${filteredFollowedAccounts.length} accounts remaining`);
                console.log(`Filtered followed accounts:`, filteredFollowedAccounts);
            }
        }
        
        // Tag filtering with support for negative tags (exclusion)
        if (tags) {
            const tagArray = splitSearchTags(tags);
            console.log(`Debug tags - Raw: "${tags}", Split: [${tagArray.join(', ')}]`);
            
            if (tagArray.length > 0) {
                const positiveTags = [];
                const negativeTags = [];
                
                // Separate positive and negative tags
                tagArray.forEach(tag => {
                    if (tag.startsWith('-')) {
                        // Remove the minus sign and add to negative tags
                        negativeTags.push(tag.substring(1));
                    } else {
                        positiveTags.push(tag);
                    }
                });
                
                console.log(`Debug tags - Positive: [${positiveTags.join(', ')}], Negative: [${negativeTags.join(', ')}]`);
                
                let allowedBooruIds = null;
                
                // Handle positive tags - find booru_ids that have ALL positive tags
                if (positiveTags.length > 0) {
                    const positiveTagDocs = await mongolib.getSchemaDocuments("userBooruTags", {
                        tag: { $in: positiveTags }
                    });
                    
                    console.log(`Found ${positiveTagDocs.length} tag documents for positive tags`);
                    
                    if (positiveTagDocs.length === positiveTags.length) {
                        // Find intersection of all booru_ids (images that have ALL positive tags)
                        allowedBooruIds = positiveTagDocs[0].booru_ids;
                        for (let i = 1; i < positiveTagDocs.length; i++) {
                            allowedBooruIds = allowedBooruIds.filter(id => positiveTagDocs[i].booru_ids.includes(id));
                        }
                        console.log(`Images with ALL positive tags: ${allowedBooruIds.length}`);
                    } else {
                        // Not all positive tags exist, so no results
                        allowedBooruIds = [];
                        console.log(`Not all positive tags exist in database`);
                    }
                }
                
                // Handle negative tags - exclude booru_ids that have ANY negative tags
                if (negativeTags.length > 0) {
                    const negativeTagDocs = await mongolib.getSchemaDocuments("userBooruTags", {
                        tag: { $in: negativeTags }
                    });
                    
                    const excludedBooruIds = new Set();
                    negativeTagDocs.forEach(tagDoc => {
                        tagDoc.booru_ids.forEach(id => excludedBooruIds.add(id));
                    });
                    
                    console.log(`Images to exclude (have negative tags): ${excludedBooruIds.size}`);
                    
                    if (allowedBooruIds === null) {
                        // Only negative tags - get all booru_ids except excluded ones
                        const allBooruImages = await mongolib.aggregateSchemaDocuments("userBooru", [
                            baseMatchConditions,
                            { $project: { booru_id: 1 } }
                        ]);
                        allowedBooruIds = allBooruImages
                            .map(img => img.booru_id)
                            .filter(id => !excludedBooruIds.has(id));
                    } else {
                        // Remove excluded IDs from allowed IDs
                        allowedBooruIds = allowedBooruIds.filter(id => !excludedBooruIds.has(id));
                    }
                    
                    console.log(`Final allowed booru_ids after exclusions: ${allowedBooruIds.length}`);
                }
                
                // Add booru_id filter to pipeline
                if (allowedBooruIds !== null) {
                    pipeline.push({
                        $match: { booru_id: { $in: allowedBooruIds } }
                    });
                }
            }
        }
        
        // Username filtering
        if (username) {
            const userProfile = await mongolib.getSchemaDocumentOnce("userProfile", { username: username });
            if (userProfile) {
                pipeline.push({
                    $match: { account_id: userProfile.accountId }
                });
            } else {
                return res.render('booru/home', {
                    session: req.session,
                    booruImages: [],
                    totalPages: 0,
                    currentPage: page,
                    sort: sort,
                    safety: allowedSafetyLevels.join(', '),
                    tags: tags,
                    username: username,
                    following: following,
                    maxSafety: req.session.maxSafety || 1,
                    booruSearchScript: require('fs').readFileSync('./scripts/booru-search.js', 'utf8'),
                    booruAccounts: [],
                    upvoteAccounts: [],
                    downvoteAccounts: [],
                    userProfile: req.session.accountId ? await mongolib.getSchemaDocumentOnce("userProfile", { accountId: req.session.accountId }) || {} : {}
                });
            }
        }
        
        // Sorting logic for trending
        if (sort === "trending") {
            const now = Date.now();
            
            // Updated decay parameters for quicker decay with minimal first-day decay
            const voteDecayRate = 0.03;     // Decay rate per hour after first day
            const commentDecayRate = 0.025; // Decay rate per hour for comments after first day
            const maxVoteWeight = 20;       // Maximum weight for brand new votes
            const maxCommentWeight = 15;    // Maximum weight for brand new comments
            const baseVoteWeight = 0.05;    // Minimum weight for very old votes
            const baseCommentWeight = 0.03; // Minimum weight for very old comments
            const newPostBoost = 3;         // Boost for posts from last 24h
            const noVotesBoost = 1000;       // High boost for posts with 0 upvotes to give them visibility
            const gracePeriodHours = 24;    // Hours of minimal decay (first day)
            
            pipeline.push({
                $addFields: {
                    // Calculate dynamic weighted scores for votes and comments with hourly decay
                    dynamicVoteScore: {
                        $reduce: {
                            input: { $ifNull: ["$upvotes", []] },
                            initialValue: 0,
                            in: {
                                $add: [
                                    "$$value",
                                    {
                                        $let: {
                                            vars: {
                                                hoursElapsed: {
                                                    $divide: [
                                                        { $subtract: [now, { $toLong: "$$this.timestamp" }] },
                                                        3600000 // Convert to hours
                                                    ]
                                                }
                                            },
                                            in: {
                                                $max: [
                                                    baseVoteWeight,
                                                    {
                                                        $cond: {
                                                            if: { $lte: ["$$hoursElapsed", gracePeriodHours] },
                                                            // Minimal decay in first 24 hours (only lose 10% max)
                                                            then: {
                                                                $multiply: [
                                                                    maxVoteWeight,
                                                                    {
                                                                        $subtract: [
                                                                            1,
                                                                            {
                                                                                $multiply: [
                                                                                    0.1,
                                                                                    {
                                                                                        $divide: ["$$hoursElapsed", gracePeriodHours]
                                                                                    }
                                                                                ]
                                                                            }
                                                                        ]
                                                                    }
                                                                ]
                                                            },
                                                            // Exponential decay after first day
                                                            else: {
                                                                $multiply: [
                                                                    maxVoteWeight,
                                                                    0.9, // Start at 90% after grace period
                                                                    {
                                                                        $exp: {
                                                                            $multiply: [
                                                                                -voteDecayRate,
                                                                                { $subtract: ["$$hoursElapsed", gracePeriodHours] }
                                                                            ]
                                                                        }
                                                                    }
                                                                ]
                                                            }
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    },
                    dynamicCommentScore: {
                        $reduce: {
                            input: { $ifNull: ["$comments", []] },
                            initialValue: 0,
                            in: {
                                $add: [
                                    "$$value",
                                    {
                                        $let: {
                                            vars: {
                                                hoursElapsed: {
                                                    $divide: [
                                                        { $subtract: [now, { $toLong: "$$this.timestamp" }] },
                                                        3600000 // Convert to hours
                                                    ]
                                                }
                                            },
                                            in: {
                                                $max: [
                                                    baseCommentWeight,
                                                    {
                                                        $cond: {
                                                            if: { $lte: ["$$hoursElapsed", gracePeriodHours] },
                                                            // Minimal decay in first 24 hours (only lose 10% max)
                                                            then: {
                                                                $multiply: [
                                                                    maxCommentWeight,
                                                                    {
                                                                        $subtract: [
                                                                            1,
                                                                            {
                                                                                $multiply: [
                                                                                    0.1,
                                                                                    {
                                                                                        $divide: ["$$hoursElapsed", gracePeriodHours]
                                                                                    }
                                                                                ]
                                                                            }
                                                                        ]
                                                                    }
                                                                ]
                                                            },
                                                            // Exponential decay after first day
                                                            else: {
                                                                $multiply: [
                                                                    maxCommentWeight,
                                                                    0.9, // Start at 90% after grace period
                                                                    {
                                                                        $exp: {
                                                                            $multiply: [
                                                                                -commentDecayRate,
                                                                                { $subtract: ["$$hoursElapsed", gracePeriodHours] }
                                                                            ]
                                                                        }
                                                                    }
                                                                ]
                                                            }
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    },
                    timestampRated: { $toLong: "$timestamp" }
                }
            });
            
            pipeline.push({
                $addFields: {
                    score: {
                        $max: [
                            {
                                $add: [
                                    "$dynamicVoteScore",
                                    "$dynamicCommentScore",
                                    // Boost for posts from last 24 hours
                                    { $cond: { 
                                        if: { $gt: ["$timestampRated", now - 86400000] }, 
                                        then: newPostBoost, 
                                        else: 0 
                                    }},
                                    // High boost for posts with 0 upvotes to give them visibility
                                    { $cond: {
                                        if: { $eq: [{ $size: { $ifNull: ["$upvotes", []] } }, 0] },
                                        then: noVotesBoost,
                                        else: 0
                                    }}
                                ]
                            },
                            0
                        ]
                    }
                }
            });
        } else if (sort === "votes") {
            pipeline.push({
                $addFields: {
                    totalVotes: {
                        $subtract: [
                            { $size: { $ifNull: ["$upvotes", []] } },
                            { $size: { $ifNull: ["$downvotes", []] } }
                        ]
                    }
                }
            });
        }
        
        // Add sort and pagination stages
        pipeline.push(getSortStage(sort));
        pipeline.push(...getPaginationStages(skip, totalPerPage));
        
        // Execute query
        const booruImages = await mongolib.aggregateSchemaDocuments("userBooru", pipeline);
        
        // Track search for sitemap generation (only for non-empty searches)
        if (tags && tags.trim() !== '' && safetyParam === 'sfw') {
            // Only track SFW searches for sitemap (AI-friendly content)
            try {
                await mongolib.trackSearch(tags.trim(), booruImages.length, 'sfw');
                
                // Trigger sitemap regeneration for popular search updates (but only occasionally)
                if (Math.random() < 0.05) { // 5% chance to trigger update
                    const sitemapTrigger = require('../utils/sitemap/sitemapTrigger');
                    sitemapTrigger.onPopularSearchesChanged();
                }
            } catch (error) {
                console.log('Error tracking search:', error);
                // Don't let search tracking errors affect the main functionality
            }
        }
        
        // Debug logging
        console.log(`Pipeline stages: ${pipeline.length}`);
        console.log(`Results found: ${booruImages.length}`);
        
        // Let's also check if there are ANY booru images with the safety level
        const debugQuery = await mongolib.aggregateSchemaDocuments("userBooru", [
            { $match: { safety: { $in: allowedSafetyLevels } } },
            { $count: "total" }
        ]);
        console.log(`Total images with safety in [${allowedSafetyLevels.join(', ')}]: ${debugQuery[0]?.total || 0}`);
        
        // Check the base match stage results
        const baseMatchResults = await mongolib.aggregateSchemaDocuments("userBooru", [baseMatchConditions]);
        console.log(`Base match results: ${baseMatchResults.length}`);
        
        // If we have tag filtering, let's also check how many images have the positive tags
        if (tags) {
            const tagArray = splitSearchTags(tags);
            const positiveTags = tagArray.filter(tag => !tag.startsWith('-'));
            if (positiveTags.length > 0) {
                // Check what tags exist in userBooruTags collection
                const existingTags = await mongolib.getSchemaDocuments("userBooruTags", {
                    tag: { $in: positiveTags }
                });
                console.log(`Existing tags in database:`, existingTags.map(t => `${t.tag} (${t.booru_ids.length} images)`));
            }
            
            // Let's also check what happens with negative tags only
            const negativeTags = tagArray.filter(tag => tag.startsWith('-')).map(tag => tag.substring(1));
            if (negativeTags.length > 0) {
                const negativeTagsInDb = await mongolib.getSchemaDocuments("userBooruTags", {
                    tag: { $in: negativeTags }
                });
                console.log(`Negative tags in database:`, negativeTagsInDb.map(t => `${t.tag} (${t.booru_ids.length} images)`));
            }
        }
        
        // Let's also check what tags actually exist in the database
        const sampleTags = await mongolib.aggregateSchemaDocuments("userBooruTags", [
            { $sort: { count: -1 } },
            { $limit: 10 },
            { $project: { tag: 1, count: 1 } }
        ]);
        console.log(`Top 10 most common tags:`, sampleTags.map(t => `${t.tag} (${t.count})`));
        
        // Get total count for pagination
        const countPipeline = [...pipeline];
        countPipeline.pop();
        countPipeline.pop();
        countPipeline.push({ $count: "total" });
        
        const countResult = await mongolib.aggregateSchemaDocuments("userBooru", countPipeline);
        const totalImages = countResult.length > 0 ? countResult[0].total : 0;
        const totalPages = Math.ceil(totalImages / totalPerPage);
        
        // Fetch user profiles for creators
        const booruImagesWithProfiles = await fetchAccounts(booruImages, 'creator');
        
        // Get additional data needed by the view
        const booruAccounts = await mongolib.getSchemaDocuments("userProfile", {
            accountId: { $in: Array.from(new Set(booruImages.map(image => image.account_id))) }
        });
        
        // Get user profile for the current user
        let userProfile = {};
        if (req.session.accountId) {
            userProfile = await mongolib.getSchemaDocumentOnce("userProfile", { accountId: req.session.accountId }) || {};
        }
        
        // Get upvote and downvote accounts (simplified version)
        const upvoteAccounts = [];
        const downvoteAccounts = [];
        
        // Get booru search script (this should be available globally)
        const booruSearchScript = require('fs').readFileSync('./scripts/booru-search.js', 'utf8');
        
        res.render('booru/home', {
            session: req.session,
            booruImages: booruImagesWithProfiles,
            totalPages: totalPages,
            currentPage: page,
            sort: sort,
            safety: allowedSafetyLevels.join(', '),
            tags: tags,
            username: username,
            following: following,
            maxSafety: req.session.maxSafety || 1,
            booruSearchScript: booruSearchScript,
            booruAccounts: booruAccounts,
            upvoteAccounts: upvoteAccounts,
            downvoteAccounts: downvoteAccounts,
            userProfile: userProfile
        });
        
    } catch (error) {
        console.log(`Error loading booru: ${error}`);
        res.status(500).send('Error loading booru');
    }
});

// Individual booru post view
router.get('/post/:booru_id', async function(req, res) {
    try {
        const booru_id = req.params.booru_id;
        
        // Get the booru post
        const booruPost = await mongolib.getSchemaDocumentOnce("userBooru", { booru_id: booru_id });
        
        if (!booruPost) {
            return res.status(404).render('booru/post', {
                session: req.session,
                booruImage: null,
                creator: null,
                postProfile: null,
                error: 'Booru post not found'
            });
        }
        
        // Check if user has access based on safety level
        const userSafety = req.session.maxSafety || 1;
        if (booruPost.safety > userSafety) {
            return res.status(403).render('booru/post', {
                session: req.session,
                booruImage: null,
                creator: null,
                postProfile: null,
                error: 'You do not have permission to view this content'
            });
        }
        
        // Get creator profile
        const creator = await mongolib.getSchemaDocumentOnce("userProfile", { accountId: booruPost.account_id });
        
        // Get user profile for the current user
        let userProfile = {};
        if (req.session.accountId) {
            userProfile = await mongolib.getSchemaDocumentOnce("userProfile", { accountId: req.session.accountId }) || {};
        }
        
        // Get booru search script
        const booruSearchScript = require('fs').readFileSync('./scripts/booru-search.js', 'utf8');
        
        res.render('booru/post', {
            session: req.session,
            booruImage: booruPost,
            creator: creator || { username: "Unknown", profileImg: "" },
            postProfile: creator || { username: "Unknown", profileImg: "" },
            userProfile: userProfile,
            booruSearchScript: booruSearchScript
        });
        
    } catch (error) {
        console.log(`Error loading booru post: ${error}`);
        res.status(500).render('booru/post', {
            session: req.session,
            booruImage: null,
            creator: null,
            postProfile: null,
            error: 'Error loading booru post'
        });
    }
});

// Create booru image (mounted at root level via app.use('/', booruRoutes))
router.post('/create-booru-image', async function(req, res) {
	try {
		let data = null
		data = req.body

		// check if the user account exists:
		let userProfile = await userProfileSchema.findOne({
			accountId: req.session.accountId
		})

		if (userProfile == null) {
			res.send({
				status: "error",
				message: "User not found"
			})
			return
		}

		if (userProfile.booruPostBanned === true) {
			res.send({
				status: "error",
				message: `User is banned from posting to the booru due to: '${userProfile.booruPostBanReason}'`
			})
			return
		}

		let hoursAgoBooru = Date.now() - (12 * 60 * 60 * 1000)

		let imageCountAggregate = await mongolib.aggregateSchemaDocuments("userBooru", [{
				$match: {
					account_id: req.session.accountId,
					timestamp: {
						$gt: hoursAgoBooru.toString()
					}
				}
			},
		])

		imageCount = imageCountAggregate.length

		maxBooruImages = 50

		console.log(`Last 12 hrs: ${imageCount} - ${userProfile.username}`)

		if (imageCount >= maxBooruImages) {
			// Calculate the time until the user can post again
			let timeTillNextPost = Math.ceil(hoursAgoBooru - Date.now());
			let timeTillNextPostString = "";

			if (timeTillNextPost > 60 * 60 * 1000) {
				let hours = Math.floor(timeTillNextPost / (60 * 60 * 1000));
				let mins = Math.floor((timeTillNextPost % (60 * 60 * 1000)) / (60 * 1000));
				timeTillNextPostString = `${hours} hour${hours !== 1 ? "s" : ""} and ${mins} minute${mins !== 1 ? "s" : ""}`;
			} else {
				let mins = Math.floor(timeTillNextPost / (60 * 1000));
				timeTillNextPostString = `${mins} minute${mins !== 1 ? "s" : ""}`;
			}

			res.send({
				status: "error",
				message: `You've reached the limit of ${maxBooruImages} images in the last 12 hours. You can post again in ${timeTillNextPostString}.`
			});
			return;
		}

		// check if the user has posted a post in the last 3 days with the exact same prompt, count it, if its above 10, dont allow the post:
		let antiSamePromptSpamDaysAgoBooru = Date.now() - (2 * 24 * 60 * 60 * 1000)

		let samePromptCountAggregate = await mongolib.aggregateSchemaDocuments("userBooru", [{
				$match: {
					account_id: req.session.accountId,
					timestamp: {
						$gt: antiSamePromptSpamDaysAgoBooru.toString()
					},
					prompt: data.prompt
				}
			},
		])

		samePromptCount = samePromptCountAggregate.length

		maxSamePrompt = 1

		console.log(`Same prompt: ${samePromptCount} - ${userProfile.username}`)

		if (samePromptCount >= maxSamePrompt) {
			res.send({
				status: "error",
				message: `You've reached the limit of ${maxSamePrompt} images with the same prompt in the last 2 days.`
			});
			return;
		}

		// check if the folder for the user exists:
		if (!fs.existsSync(`${booruFolder}/${req.session.accountId}/`)) {
			fs.mkdirSync(`${booruFolder}/${req.session.accountId}/`, {
				recursive: true
			});
		}

		let nextImageId = BigInt(Date.now());

		let image_url = data.image_url // the filepath for the png image E:/JSCammie/imagesHistory/

		// replace the http:\\www.jscammie.com\\ at the start:
		image_url = image_url.replace("https://www.jscammie.com/", "")
		image_url = image_url.replace("http://www.jscammie.com/", "")

		// load the image from disk:
		let image = fs.readFileSync(image_url)

		let newImageUrlBase = `booruImages/${req.session.accountId}/${nextImageId}.png`

		// save the image to the booru folder:
		fs.writeFileSync(newImageUrlBase, image)

		// split the prompt into an array of tags, first, split on commas removing any spaces:
		tags = data.prompt

		tags = tags.split(',').map(tag => tag.trim())

		tags = splitTags(tags)

		// remove any tag with "username" in it:
		tags = tags.filter(tag => !tag.includes("username"))

		// tags.push(`${userProfile.username}-username`)

		// get all accounts that have that username, then sort them by timestamp, the oldest one gets username-username, the rest get username-username-1, username-username-2, etc:

		// timestamp is a string like this: "1729524416544", its the same as Date.now() but as a string, make sure it sorts correctly with the oldest having the lowest timestamp:

		let accountsWithUsername = await mongolib.aggregateSchemaDocuments("userProfile", [{ $match: { username: userProfile.username } }, { $sort: { timestamp: 1 } }])
		let usernameCount = 0
		for (const account of accountsWithUsername) {
			if (account.accountId == req.session.accountId) {
				break
			}
			usernameCount++
		}

		if (usernameCount > 0) {
			tags.push(`${userProfile.username}-username-${usernameCount}`)
		} else {
			tags.push(`${userProfile.username}-username`)
		}

		scoreTags = "score_10, score_9, score_8, score_7, score_6, score_5, score_4, score_3, score_2, score_1, score_0"
		scoreUpTags = "score_10_up, score_9_up, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up, score_3_up, score_2_up, score_1_up, score_0_up"
		scoreUpTags2 = "score_10up, score_9up, score_8up, score_7up, score_6up, score_5up, score_4up, score_3up, score_2up, score_1up, score_0up"
		qualityTags = "masterpiece, amazing_quality, best_quality, absurdres, very_aesthetic, high_quality, detailed, perfect_quality, high_resolution"
		qualityTags2 = "8k, ultra-detailed, absurd_res, 4k, high_detail, amazing_lighting, perfect_detail, hi_res, highest_quality_textures"
		qualityTags3 = "extreme_detail, studio_quality, max_detail, refined_detail, insanely_detailed, highres, highly_detailed_background, quality"

		blockedTags = scoreTags + ", " + scoreUpTags + ", " + scoreUpTags2 + ", " + qualityTags + ", " + qualityTags2 + ", " + qualityTags3
		blockedTags = blockedTags.split(", ")

		tags = tags.filter(tag => !blockedTags.includes(tag))

		for (const tag of tags) {
			// check if the tag exists in the userBooruTagsSchema:
			let foundTag = await userBooruTagsSchema.findOne({
				tag: tag
			})

			if (foundTag == null) {
				newCount = BigInt(1)
				newCount = newCount.toString()
			} else {
				newCount = BigInt(foundTag.count) + BigInt(1)
				newCount = newCount.toString()
			}

			await userBooruTagsSchema.findOneAndUpdate({
				tag: tag
			}, { // count is a string, make sure to convert it to a BigInt before incrementing, then back:
				tag: tag,
				count: newCount,
				$push: {
					booru_ids: `${req.session.accountId}-${nextImageId}`
				},
			}, {
				upsert: true
			})
		}

		// convert any broken text, for example &#39; to ', etc:
		data.prompt = he.decode(data.prompt)
		data.negative_prompt = he.decode(data.negative_prompt)

		// Check for blacklisted words in prompt
		const blacklistedWord = checkForBlacklistedWords(data.prompt);
		if (blacklistedWord) {
			res.send({
				status: "error",
				message: `Your prompt contains a blacklisted word: ${blacklistedWord}. Please revise your prompt and try again.`
			});
			return;
		}

		// Prepare the new booru image document
		let newBooruImage = {
			booru_id: `${req.session.accountId}-${nextImageId}`,
			account_id: req.session.accountId,
			image_id: BigInt(nextImageId),
			prompt: data.prompt,
			negative_prompt: data.negative_prompt,
			model: data.model,
			aspect_ratio: data.aspect_ratio,
			loras: data.loras,
			lora_strengths: data.lora_strengths,
			steps: data.steps,
			cfg: data.cfg,
			seed: data.seed,
			content_url: `https://www.jscammie.com/${newImageUrlBase}`,
			safety: "na",
			timestamp: Date.now(),
			timestampRated: Date.now(),
		};

		// Insert the new booru image document into the database
		await userBooruSchema.create(newBooruImage);

		// Trigger sitemap regeneration for new booru post
		try {
			const sitemapTrigger = require('../utils/sitemap/sitemapTrigger');
			sitemapTrigger.onBooruPostCreated();
		} catch (error) {
			console.log('Error triggering sitemap regeneration:', error);
			// Don't let sitemap errors affect the main functionality
		}

		// set the userHistorySchema to have uploadedToBooru as true, use image_url without the .png as the image_id and the account_id:
		await userHistorySchema.findOneAndUpdate({
			image_url: data.image_url
		}, {
			uploadedToBooru: true
		})

		res.send({
			status: "success",
			message: "Booru image created",
			booru_id: `${req.session.accountId}-${nextImageId}`
		})

	} catch (error) {
		console.log(`Error creating booru image: ${error}`);
		res.status(500).json({
			status: "error",
			message: "Error creating booru image"
		});
	}
})

// Vote on booru post
router.post('/vote', async function(req, res) {
    try {
        let data = req.body;
        let vote = data.vote;
        let booru_id = data.booru_id;
        let account_id = req.session.accountId;

        let foundBooruImage = await mongolib.getSchemaDocumentOnce("userBooru", {
            booru_id: booru_id
        });

        if (foundBooruImage == null) {
            return res.send({
                status: "error",
                message: "Booru image not found"
            });
        }

        let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
            accountId: req.session.accountId
        });
        
        if (userProfile == null) {
            return res.send({
                status: 'error',
                message: 'User not found'
            });
        }

        // Check if voter is the same as creator
        if (account_id == foundBooruImage.account_id) {
            return res.send({
                status: "error",
                message: "User cannot vote on their own post"
            });
        }

        // Get creator profile for notifications and rewards
        let creatorProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
            accountId: foundBooruImage.account_id
        });

        // Initialize vote arrays if they don't exist
        if (!foundBooruImage.upvotes) foundBooruImage.upvotes = [];
        if (!foundBooruImage.downvotes) foundBooruImage.downvotes = [];

        let userVoted = foundBooruImage.upvotes.some(upvote => upvote.accountId === account_id);
        let userDownvoted = foundBooruImage.downvotes.some(downvote => downvote.accountId === account_id);

        // Credit and experience rewards
        const creatorCreditsToGain = 1.75;
        const creatorExpToGain = 2;
        const userCreditsToGain = 0.5;
        const userExpToGain = 0.5;

        if (vote === 'upvote') {
            if (userVoted) {
                // User is removing their upvote - charge 5 credits if removeUpvote flag is set
                if (data.removeUpvote) {
                    if (userProfile.credits < 5) {
                        return res.send({
                            status: "error",
                            message: "You need at least 5 credits to remove your upvote"
                        });
                    }
                    
                    // Deduct credits
                    await mongolib.modifyUserCredits(account_id, 5, '-', `You paid 5 credits to remove your upvote on a <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`);
                }
                
                // Remove upvote
                await mongolib.updateSchemaDocumentOnce("userBooru",
                    { booru_id: booru_id },
                    { $pull: { upvotes: { accountId: account_id } } }
                );
                
                userVoted = false;
            } else {
                // Add upvote and remove any existing downvote
                await mongolib.updateSchemaDocumentOnce("userBooru",
                    { booru_id: booru_id },
                    { 
                        $push: { upvotes: { accountId: account_id, timestamp: Date.now().toString() } },
                        $pull: { downvotes: { accountId: account_id } }
                    }
                );

                // Add credits and exp for new upvote
                await mongolib.modifyUserCredits(account_id, userCreditsToGain, '+', `You Upvoted a <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`);
                await mongolib.modifyUserExp(account_id, userExpToGain, '+');

                // Reward creator
                if (creatorProfile != null) {
                    await mongolib.modifyUserCredits(creatorProfile.accountId, creatorCreditsToGain, '+', `Someone upvoted your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`);
                    await mongolib.modifyUserExp(creatorProfile.accountId, creatorExpToGain, '+');
                    
                    // Send notification if enabled
                    if (creatorProfile.settings?.notification_booruVote == true || creatorProfile.settings?.notification_booruVote == undefined) {
                        await mongolib.createUserNotification(creatorProfile.accountId, `Someone upvoted your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`, 'booru');
                    }
                }
                
                userVoted = true;
                userDownvoted = false;
            }
        } else if (vote === 'downvote') {
            // Disable downvotes for now
            return res.send({
                status: "error",
                message: "Downvotes are disabled"
            });
        }

        // Get updated vote counts
        const updatedPost = await mongolib.getSchemaDocumentOnce("userBooru", { booru_id: booru_id });
        
        res.send({
            status: "success",
            message: "Vote processed successfully",
            upvotes: updatedPost.upvotes?.length || 0,
            downvotes: updatedPost.downvotes?.length || 0,
            userVoted: userVoted,
            userDownvoted: userDownvoted,
            upvotesList: updatedPost.upvotes || [],
            creditsDeducted: data.removeUpvote && userVoted === false ? 5 : 0
        });

    } catch (error) {
        console.log(`Error processing vote: ${error}`);
        res.status(500).send({
            status: "error",
            message: "Error processing vote"
        });
    }
});

// Set booru post rating
router.post('/setRating/', async function(req, res) {
    try {
        let { booru_id, rating } = req.body;
        
        // Check if user is authorized to set rating
        let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
            accountId: req.session.accountId
        });

        if (!userProfile || !userProfile.badges?.moderator) {
            return res.status(403).send({
                status: "error",
                message: "Unauthorized - moderator access required"
            });
        }

        // Update booru post rating
        await mongolib.updateSchemaDocumentOnce("userBooru", 
            { booru_id: booru_id },
            { safety: parseInt(rating) }
        );

        res.send({
            status: "success",
            message: "Rating updated successfully"
        });

    } catch (error) {
        console.log(`Error setting rating: ${error}`);
        res.status(500).send({
            status: "error",
            message: "Error setting rating"
        });
    }
});

// Delete booru post
router.post('/delete', async function(req, res) {
    try {
        let { booru_id } = req.body;
        
        let booruPost = await mongolib.getSchemaDocumentOnce("userBooru", {
            booru_id: booru_id
        });

        if (!booruPost) {
            return res.status(404).send({
                status: "error",
                message: "Booru post not found"
            });
        }

        // Check if user owns the post or is a moderator
        let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
            accountId: req.session.accountId
        });

        if (!userProfile) {
            return res.status(401).send({
                status: "error",
                message: "User not found"
            });
        }

        if (booruPost.account_id !== req.session.accountId && !userProfile.badges?.moderator) {
            return res.status(403).send({
                status: "error",
                message: "Unauthorized - you can only delete your own posts"
            });
        }

        // Delete the post
        await mongolib.deleteSchemaDocument("userBooru", { booru_id: booru_id });

        res.send({
            status: "success",
            message: "Booru post deleted successfully"
        });

    } catch (error) {
        console.log(`Error deleting booru post: ${error}`);
        res.status(500).send({
            status: "error",
            message: "Error deleting booru post"
        });
    }
});

// Ban user from booru
router.post('/ban/:accountId', async function(req, res) {
    try {
        let { accountId } = req.params;
        let { reason } = req.body;
        
        // Check if user is a moderator
        let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
            accountId: req.session.accountId
        });

        if (!userProfile || !userProfile.badges?.moderator) {
            return res.status(403).send({
                status: "error",
                message: "Unauthorized - moderator access required"
            });
        }

        // Ban the user
        await mongolib.updateSchemaDocumentOnce("userProfile",
            { accountId: accountId },
            { 
                booruPostBanned: true,
                booruPostBanReason: reason || "No reason provided"
            }
        );

        res.send({
            status: "success",
            message: "User banned from booru successfully"
        });

    } catch (error) {
        console.log(`Error banning user: ${error}`);
        res.status(500).send({
            status: "error",
            message: "Error banning user"
        });
    }
});

// Creator stats page
router.get('/creator-stats', async function(req, res) {
    try {
        console.log("Starting creator stats calculation...");
        
        // Check if user is logged in
        if (!req.session.accountId) {
            return res.render('booru/creator-stats', {
                session: req.session,
                userStats: null
            });
        }

        const accountId = req.session.accountId;
        console.log(`Processing stats for account ID: ${accountId}`);
        
        // Time periods for stats calculation
        const now = Date.now();
        const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
        const previousTwentyFourHours = twentyFourHoursAgo - (24 * 60 * 60 * 1000);
        
        const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
        const previousSevenDays = sevenDaysAgo - (7 * 24 * 60 * 60 * 1000);
        
        const twentyEightDaysAgo = now - (28 * 24 * 60 * 60 * 1000);
        const previousTwentyEightDays = twentyEightDaysAgo - (28 * 24 * 60 * 60 * 1000);
                
        // Fetch all user booru posts with timestamps, votes, and comments
        const userBooruPosts = await mongolib.aggregateSchemaDocuments("userBooru", [
            { $match: { account_id: accountId } },
            { $project: {
                booru_id: 1,
                title: 1,
                content_url: 1,
                timestamp: { $toLong: "$timestamp" },
                upvotes: { $cond: { if: { $isArray: "$upvotes" }, then: "$upvotes", else: [] } },
                comments: { $cond: { if: { $isArray: "$comments" }, then: "$comments", else: [] } }
            }}
        ]);
        
        // Get follower count for the user (needed for leaderboard score calculation)
        const followedCountResult = await mongolib.aggregateSchemaDocuments("userProfile", [
            { $match: { followedAccounts: accountId } },
            { $count: "followedCount" }
        ]);
        const userFollowerCount = followedCountResult[0]?.followedCount || 1;
        
        // Get highest follower count for normalization
        const highestFollowerCountData = await mongolib.aggregateSchemaDocuments("userProfile", [
            { $match: { followedAccounts: { $exists: true, $ne: [] } } },
            { $project: { followedCount: { $size: "$followedAccounts" } } },
            { $sort: { followedCount: -1 } },
            { $limit: 1 }
        ]);
        const highestFollowerCount = highestFollowerCountData[0]?.followedCount || userFollowerCount;
        
        // Calculate follower score modifier once to reuse
        const followerScore = ((userFollowerCount / highestFollowerCount) / 7.14) + 0.95;
        
        // Calculate total stats
        const totalStats = {
            posts: userBooruPosts.length,
            upvotes: 0,
            comments: 0,
            booruScore: 0,
            rawBooruScore: 0,
            followerBoost: followerScore
        };
        
        userBooruPosts.forEach(post => {
            totalStats.upvotes += (post.upvotes?.length || 0);
            totalStats.comments += (post.comments?.length || 0);
        });
        
        // Calculate total Booru score
        const totalStatsForCalculation = {
            postCount: totalStats.posts,
            totalScore: (totalStats.upvotes * SCORING_CONFIG.UPVOTE_WEIGHT) + (totalStats.comments * SCORING_CONFIG.COMMENT_WEIGHT),
            totalUpvotes: totalStats.upvotes,
            totalComments: totalStats.comments
        };
        
        console.log(`Total stats for calculation:`, totalStatsForCalculation);
        console.log(`User follower count: ${userFollowerCount}, Highest follower count: ${highestFollowerCount}`);
        
        const totalScoreData = calculateBooruScore(totalStatsForCalculation, userFollowerCount, SCORING_CONFIG, highestFollowerCount);
        totalStats.rawBooruScore = totalScoreData.rawScore;
        totalStats.booruScore = totalScoreData.finalScore;
        totalStats.followerBoost = totalScoreData.followerScoreModifier;
        
        console.log(`Total stats - Posts: ${totalStats.posts}, Upvotes: ${totalStats.upvotes}, Comments: ${totalStats.comments}`);
        console.log(`Total Booru score: ${totalStats.booruScore.toFixed(1)} (raw: ${totalStats.rawBooruScore.toFixed(1)})`);
        
        // Get top posts from the last 28 days
        const topPosts = userBooruPosts
            .filter(post => post.timestamp >= twentyEightDaysAgo)
            .map(post => {
                const score = (post.upvotes?.length || 0) * 2 + (post.comments?.length || 0) * 3;
                return { ...post, score };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 25);

        // Helper functions
        function calculatePeriodStats(posts, currentPeriodStart, previousPeriodStart, currentPeriodEnd) {
            const currentStats = { posts: 0, upvotes: 0, comments: 0 };
            const previousStats = { posts: 0, upvotes: 0, comments: 0 };
            
            posts.forEach(post => {
                // Count posts based on when they were created
                if (post.timestamp >= currentPeriodStart && post.timestamp < currentPeriodEnd) {
                    currentStats.posts++;
                } else if (post.timestamp >= previousPeriodStart && post.timestamp < currentPeriodStart) {
                    previousStats.posts++;
                }
                
                // Count upvotes based on when they actually occurred
                if (post.upvotes) {
                    post.upvotes.forEach(vote => {
                        const voteTimestamp = parseInt(vote.timestamp);
                        if (voteTimestamp >= currentPeriodStart && voteTimestamp < currentPeriodEnd) {
                            currentStats.upvotes++;
                        } else if (voteTimestamp >= previousPeriodStart && voteTimestamp < currentPeriodStart) {
                            previousStats.upvotes++;
                        }
                    });
                }
                
                // Count comments based on when they actually occurred
                if (post.comments) {
                    post.comments.forEach(comment => {
                        const commentTimestamp = parseInt(comment.timestamp);
                        if (commentTimestamp >= currentPeriodStart && commentTimestamp < currentPeriodEnd) {
                            currentStats.comments++;
                        } else if (commentTimestamp >= previousPeriodStart && commentTimestamp < currentPeriodStart) {
                            previousStats.comments++;
                        }
                    });
                }
            });
            
            return { currentStats, previousStats };
        }
        
        function calculatePercentageChange(current, previous) {
            return previous === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - previous) / previous) * 100);
        }
        
        function calculateEngagementRate(upvotes, posts) {
            return posts > 0 ? upvotes / posts : 0;
        }
        
        function createPeriodStatsObject(currentStats, previousStats, userFollowerCount, SCORING_CONFIG, highestFollowerCount, followerScore) {
            const engagementRate = calculateEngagementRate(currentStats.upvotes, currentStats.posts);
            const previousEngagementRate = calculateEngagementRate(previousStats.upvotes, previousStats.posts);
            
            // Calculate Booru scores
            const currentStatsForCalculation = {
                postCount: currentStats.posts,
                totalScore: (currentStats.upvotes * SCORING_CONFIG.UPVOTE_WEIGHT) + (currentStats.comments * SCORING_CONFIG.COMMENT_WEIGHT),
                totalUpvotes: currentStats.upvotes,
                totalComments: currentStats.comments
            };
            
            const previousStatsForCalculation = {
                postCount: previousStats.posts,
                totalScore: (previousStats.upvotes * SCORING_CONFIG.UPVOTE_WEIGHT) + (previousStats.comments * SCORING_CONFIG.COMMENT_WEIGHT),
                totalUpvotes: previousStats.upvotes,
                totalComments: previousStats.comments
            };
            
            const currentBooruScore = calculateBooruScore(currentStatsForCalculation, userFollowerCount, SCORING_CONFIG, highestFollowerCount);
            const previousBooruScore = calculateBooruScore(previousStatsForCalculation, userFollowerCount, SCORING_CONFIG, highestFollowerCount);
            
            return {
                posts: currentStats.posts,
                upvotes: currentStats.upvotes,
                comments: currentStats.comments,
                postsChange: calculatePercentageChange(currentStats.posts, previousStats.posts),
                upvotesChange: calculatePercentageChange(currentStats.upvotes, previousStats.upvotes),
                commentsChange: calculatePercentageChange(currentStats.comments, previousStats.comments),
                engagementRate: engagementRate,
                engagementRateChange: calculatePercentageChange(engagementRate, previousEngagementRate),
                booruScore: currentBooruScore.finalScore,
                booruScoreChange: calculatePercentageChange(currentBooruScore.finalScore, previousBooruScore.finalScore),
                rawBooruScore: currentBooruScore.rawScore,
                followerBoost: followerScore
            };
        }

        // Calculate period stats
        const { currentStats: current24h, previousStats: prev24h } = calculatePeriodStats(userBooruPosts, twentyFourHoursAgo, previousTwentyFourHours, now);
        const last24Hours = createPeriodStatsObject(current24h, prev24h, userFollowerCount, SCORING_CONFIG, highestFollowerCount, followerScore);

        const { currentStats: current7d, previousStats: prev7d } = calculatePeriodStats(userBooruPosts, sevenDaysAgo, previousSevenDays, now);
        const last7Days = createPeriodStatsObject(current7d, prev7d, userFollowerCount, SCORING_CONFIG, highestFollowerCount, followerScore);

        const { currentStats: current28d, previousStats: prev28d } = calculatePeriodStats(userBooruPosts, twentyEightDaysAgo, previousTwentyEightDays, now);
        const last28Days = createPeriodStatsObject(current28d, prev28d, userFollowerCount, SCORING_CONFIG, highestFollowerCount, followerScore);

        // Prepare chart data
        const dailyData = {};
        const lastNDays = 28;
        
        // Initialize daily data for last N days
        for (let i = lastNDays - 1; i >= 0; i--) {
            const date = new Date(now - (i * 24 * 60 * 60 * 1000));
            const dateKey = date.toISOString().split('T')[0];
            dailyData[dateKey] = { posts: 0, upvotes: 0, comments: 0, booruScore: 0 };
        }
        
        // Process each post for daily chart data
        userBooruPosts.forEach(post => {
            // Count posts based on when they were created
            const postDate = new Date(parseInt(post.timestamp));
            const postDateKey = postDate.toISOString().split('T')[0];
            
            if (dailyData[postDateKey]) {
                dailyData[postDateKey].posts++;
            }
            
            // Count upvotes based on when they actually occurred
            if (post.upvotes) {
                post.upvotes.forEach(vote => {
                    const voteDate = new Date(parseInt(vote.timestamp));
                    const voteDateKey = voteDate.toISOString().split('T')[0];
                    
                    if (dailyData[voteDateKey]) {
                        dailyData[voteDateKey].upvotes++;
                    }
                });
            }
            
            // Count comments based on when they actually occurred
            if (post.comments) {
                post.comments.forEach(comment => {
                    const commentDate = new Date(parseInt(comment.timestamp));
                    const commentDateKey = commentDate.toISOString().split('T')[0];
                    
                    if (dailyData[commentDateKey]) {
                        dailyData[commentDateKey].comments++;
                    }
                });
            }
        });
        
        // Calculate hourly data for the last 24 hours
        const hourlyData = {};
        const last24HoursTimestamp = now - (24 * 60 * 60 * 1000);
        
        // Initialize hourly buckets for the last 24 hours
        for (let i = 23; i >= 0; i--) {
            const hourStart = now - (i * 60 * 60 * 1000);
            const hourKey = new Date(hourStart).getHours();
            hourlyData[hourKey] = { posts: 0, upvotes: 0, comments: 0, booruScore: 0 };
        }
        
        // Process posts from the last 24 hours with actual timestamps
        userBooruPosts.forEach(post => {
            // Count posts that were created in the last 24 hours
            if (post.timestamp >= last24HoursTimestamp) {
                const postHour = new Date(parseInt(post.timestamp)).getHours();
                hourlyData[postHour].posts++;
            }
            
            // Count upvotes that happened in the last 24 hours (regardless of when post was created)
            if (post.upvotes) {
                post.upvotes.forEach(vote => {
                    const voteTimestamp = parseInt(vote.timestamp);
                    if (voteTimestamp >= last24HoursTimestamp) {
                        const voteHour = new Date(voteTimestamp).getHours();
                        hourlyData[voteHour].upvotes++;
                    }
                });
            }
            
            // Count comments that happened in the last 24 hours (regardless of when post was created)
            if (post.comments) {
                post.comments.forEach(comment => {
                    const commentTimestamp = parseInt(comment.timestamp);
                    if (commentTimestamp >= last24HoursTimestamp) {
                        const commentHour = new Date(commentTimestamp).getHours();
                        hourlyData[commentHour].comments++;
                    }
                });
            }
        });

        // Calculate Booru scores for hourly data
        Object.keys(hourlyData).forEach(hour => {
            const data = hourlyData[hour];
            const hourlyStatForScore = {
                postCount: data.posts,
                totalScore: (data.upvotes * SCORING_CONFIG.UPVOTE_WEIGHT) + (data.comments * SCORING_CONFIG.COMMENT_WEIGHT),
                totalUpvotes: data.upvotes,
                totalComments: data.comments
            };

            const hourlyScoreData = calculateBooruScore(hourlyStatForScore, userFollowerCount, SCORING_CONFIG, highestFollowerCount);
            data.booruScore = hourlyScoreData.finalScore;
        });

        // Prepare hourly chart arrays
        const hourlyLabels = [];
        const hourlyUpvotes = [];
        const hourlyComments = [];
        const hourlyPosts = [];
        const hourlyEngagement = [];
        const hourlyBooruScores = [];

        for (let i = 23; i >= 0; i--) {
            const hourStart = now - (i * 60 * 60 * 1000);
            const hour = new Date(hourStart).getHours();
            const data = hourlyData[hour];
            
            hourlyLabels.push(`${hour}:00`);
            hourlyUpvotes.push(data.upvotes);
            hourlyComments.push(data.comments);
            hourlyPosts.push(data.posts);
            hourlyEngagement.push(data.posts > 0 ? data.upvotes / data.posts : 0);
            hourlyBooruScores.push(data.booruScore);
        }

        // Calculate daily Booru Scores for the chart
        const sortedDays = Object.keys(dailyData).sort();
        const recentDays = sortedDays.slice(-lastNDays);
        
        recentDays.forEach(day => {
            const data = dailyData[day];
            const dailyStatForScore = {
                postCount: data.posts,
                totalScore: (data.upvotes * SCORING_CONFIG.UPVOTE_WEIGHT) + (data.comments * SCORING_CONFIG.COMMENT_WEIGHT),
                totalUpvotes: data.upvotes,
                totalComments: data.comments
            };

            const scoreDataDaily = calculateBooruScore(dailyStatForScore, userFollowerCount, SCORING_CONFIG, highestFollowerCount);
            data.booruScore = scoreDataDaily.finalScore;
        });

        const dailyLabels = recentDays.map(date => {
            const [year, month, day] = date.split('-');
            return `${month}/${day}`;
        });
        
        const dailyUpvotes = recentDays.map(date => dailyData[date].upvotes);
        const dailyComments = recentDays.map(date => dailyData[date].comments);
        const dailyPosts = recentDays.map(date => dailyData[date].posts);
        const dailyEngagement = recentDays.map(date => {
            const posts = dailyData[date].posts;
            return posts > 0 ? (dailyData[date].upvotes / posts) : 0;
        });
        const dailyBooruScores = recentDays.map(date => dailyData[date].booruScore);

        const userStats = {
            last24Hours,
            last7Days,
            last28Days,
            dailyLabels,
            dailyUpvotes,
            dailyComments,
            dailyPosts,
            dailyEngagement,
            dailyBooruScores,
            hourlyLabels,
            hourlyUpvotes,
            hourlyComments,
            hourlyPosts,
            hourlyEngagement,
            hourlyBooruScores,
            topPosts,
            followerCount: userFollowerCount,
            totalStats
        };
        
        res.render('booru/creator-stats', {
            session: req.session,
            userStats
        });
        
    } catch (error) {
        console.log(`Error loading creator stats: ${error}`);
        res.status(500).send('Error loading creator statistics');
    }
});

module.exports = router; 