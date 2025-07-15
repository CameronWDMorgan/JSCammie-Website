const mongoose = require("mongoose");
const { Schema } = mongoose;
const { Decimal128 } = mongoose.Types;

let aiNegativePrompt = "nsfw, monochrome, black and white, worst quality, low quality, watermark, signature, bad anatomy, bad hands, deformed limbs, blurry, cropped, cross-eyed, extra arms, extra legs, extra limbs, extra pupils, bad proportions, poorly drawn hands, simple background, bad background, bad lighting, bad perspective";

const aiSaveSlotSchema = new Schema({
    saveSlotId: { type: String, required: true },
    name: { type: String, default: "Untitled" },
    prompt: { type: String, default: "" },
    negativeprompt: { type: String, default: "" },
    model: { type: String, default: "furry" },
    aspectRatio: { type: String, default: "Square" },
    loras: { type: Array, default: [] },
    lora_strengths: { type: Array, default: [] },
    steps: { type: Number, default: 15 },
    cfg: { type: Number, default: 5 },
    quantity: { type: Number, default: 4 },
    seed: { type: Number, default: -1 },
    advancedMode: { type: Boolean, default: false },
});

const dailiesSchema = new Schema({
    timestamp3hr: { type: String, required: true, default: "0" },
    timestamp12hr: { type: String, required: true, default: "0" },
    timestamp24hr: { type: String, required: true, default: "0" },
    timestamp168hr: { type: String, required: true, default: "0" },
});

const badgesSchema = new Schema({
    owner: { type: Boolean, default: false },
    moderator: { type: Boolean, default: false },
    supporter: { type: Boolean, default: false },
    contributor: { type: Boolean, default: false },
});

const settingsSchema = new Schema({
    notification_booruVote: { type: Boolean, default: true },
    notification_booruComment: { type: Boolean, default: true },
    notification_booruRating: { type: Boolean, default: true },
    notification_suggestionPromoted: { type: Boolean, default: true },
    notification_generatorSpentCredits: { type: Boolean, default: true },
    misc_generationReadyBeep: { type: Boolean, default: true },
    booru_tag_blacklist: { type: String, default: "" },
    user_bio: { type: String, default: "" },
    profile_background_color: { type: String, default: "#4875b4" },
});

// OAuth provider schema for flexible multi-provider support
const oauthProviderSchema = new Schema({
    provider: { type: String, required: true }, // 'discord', 'google', etc.
    providerId: { type: String, required: true }, // Provider-specific user ID
    email: { type: String, default: "" },
    displayName: { type: String, default: "" },
    profilePicture: { type: String, default: "" },
    linkedAt: { type: Date, default: Date.now },
    lastLogin: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true }
});

const userProfileSchema = new Schema({
    // NEW: Auto-incrementing
    accountId: { type: String, required: true },
    
    // Legacy Discord ID support (for backward compatibility during migration)
    discordId: { type: String, default: "" },
    googleId: { type: String, default: "" },
    
    // NEW: Multi-provider OAuth support
    oauthProviders: [oauthProviderSchema],
    
    // Primary account information
    username: { type: String, required: true, unique: false },
    primaryEmail: { type: String, default: "" },
    
    // Account metadata
    timestamp: { type: String, required: false },
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: Date.now },
    
    // User progression
    exp: { 
        type: mongoose.Schema.Types.Decimal128,
        get: (v) => v ? parseFloat(v.toString()) : v,
        default: 0
    }, 
    level: { type: Number, default: 1 },
    
    // AI generation data
    aiSaveSlots: [aiSaveSlotSchema],
    credits: { 
        type: mongoose.Schema.Types.Decimal128,
        get: (v) => v ? parseFloat(v.toString()) : v,
        default: 500 
    },
    
    // User preferences and limits
    variables: {
        userHistoryLimit: { type: Number, default: 5000 }
    },
    dailies: dailiesSchema,
    settings: settingsSchema,
    
    // Profile customization
    profileImg: { type: String, default: "http://www.jscammie.com/noimagefound.png" },
    
    // User status and permissions
    badges: badgesSchema,
    supporter: { type: Boolean, default: false },
    booruPostBanned: { type: Boolean, default: false },
    booruPostBanReason: { type: String, default: "Breaking Rules" },
    
    // Social features
    followedAccounts: { type: Array, default: [] },
    blockedAccounts: { type: Array, default: [] },
    favoriteLoras: { type: Array, default: [] },
    favoriteBooruPosts: { type: Array, default: [] },
    
    // Migration tracking
    migrationData: {
        originalAccountId: { type: String, default: "" }, // Original Discord ID
        migratedAt: { type: Date },
        migrationVersion: { type: String, default: "1.0" }
    }
});

// Indexes for performance
userProfileSchema.index({ accountId: 1 }, { unique: true });
userProfileSchema.index({ discordId: 1 });
userProfileSchema.index({ googleId: 1 });
userProfileSchema.index({ primaryEmail: 1 });
userProfileSchema.index({ "oauthProviders.provider": 1, "oauthProviders.providerId": 1 });
userProfileSchema.index({ username: 1 });
userProfileSchema.index({ lastLoginAt: -1 });

// Instance methods
userProfileSchema.methods.addOAuthProvider = function(providerData) {
    // Remove existing provider of same type
    this.oauthProviders = this.oauthProviders.filter(p => p.provider !== providerData.provider);
    
    // Add new provider
    this.oauthProviders.push({
        provider: providerData.provider,
        providerId: providerData.providerId,
        email: providerData.email || "",
        displayName: providerData.displayName || "",
        profilePicture: providerData.profilePicture || "",
        linkedAt: new Date(),
        lastLogin: new Date(),
        isActive: true
    });
    
    // Update legacy fields for backward compatibility
    if (providerData.provider === 'discord') {
        this.discordId = providerData.providerId;
    } else if (providerData.provider === 'google') {
        this.googleId = providerData.providerId;
    }
    
    // Update primary email if not set
    if (!this.primaryEmail && providerData.email) {
        this.primaryEmail = providerData.email;
    }
    
    this.lastLoginAt = new Date();
};

userProfileSchema.methods.removeOAuthProvider = function(provider) {
    this.oauthProviders = this.oauthProviders.filter(p => p.provider !== provider);
    
    // Clear legacy fields
    if (provider === 'discord') {
        this.discordId = "";
    } else if (provider === 'google') {
        this.googleId = "";
    }
};

userProfileSchema.methods.getOAuthProvider = function(provider) {
    return this.oauthProviders.find(p => p.provider === provider && p.isActive);
};

userProfileSchema.methods.hasOAuthProvider = function(provider) {
    return this.oauthProviders.some(p => p.provider === provider && p.isActive);
};

userProfileSchema.methods.updateLastLogin = function(provider = null) {
    this.lastLoginAt = new Date();
    
    if (provider) {
        const oauthProvider = this.getOAuthProvider(provider);
        if (oauthProvider) {
            oauthProvider.lastLogin = new Date();
        }
    }
};

// Static methods
userProfileSchema.statics.findByOAuthProvider = function(provider, providerId) {
    return this.findOne({
        "oauthProviders.provider": provider,
        "oauthProviders.providerId": providerId,
        "oauthProviders.isActive": true
    });
};

userProfileSchema.statics.findByDiscordId = function(discordId) {
    return this.findByOAuthProvider('discord', discordId);
};

userProfileSchema.statics.findByGoogleId = function(googleId) {
    return this.findByOAuthProvider('google', googleId);
};

userProfileSchema.statics.getNextAccountId = async function() {
    try {
        const lastUsers = await this.aggregate([
            // Only match accountIds that are small sequential numbers (1-10000), not Discord IDs
            { $match: {
                accountId: {
                    $regex: /^[1-9]\d{0,4}$/ // Matches 1-99999 (sequential account IDs)
                }
            }},
            { $project: { accountIdNumeric: { $toLong: "$accountId" } } },
            { $sort: { accountIdNumeric: -1 } },
            { $limit: 1 }
        ]);

        if (lastUsers.length > 0) {
            const nextId = BigInt(lastUsers[0].accountIdNumeric) + BigInt(1);
            return nextId.toString();
        } else {
            return "1";
        }
    } catch (error) {
        console.error("Error in getNextAccountId:", error);
        throw new Error('Could not generate new account ID.');
    }
};

// Pre-save middleware
userProfileSchema.pre('save', async function(next) {
    // Auto-assign accountId for new documents
    if (this.isNew && !this.accountId) {
        try {
            const nextId = await this.constructor.getNextAccountId();
            this.accountId = String(nextId);
        } catch (error) {
            return next(error); // Pass error to Mongoose to halt the save
        }
    }
    
    next();
});

userProfileSchema.set('toObject', { getters: true });
userProfileSchema.set('toJSON', { getters: true });

const name = 'userAccount';

module.exports = mongoose.models[name] || mongoose.model(name, userProfileSchema, name);