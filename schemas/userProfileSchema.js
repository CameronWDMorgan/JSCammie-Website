const mongoose = require ("mongoose");
const { Schema } = mongoose
const { Decimal128 } = mongoose.Types

let aiNegativePrompt = "nsfw, monochrome, black and white, worst quality, low quality, watermark, signature, bad anatomy, bad hands, deformed limbs, blurry, cropped, cross-eyed, extra arms, extra legs, extra limbs, extra pupils, bad proportions, poorly drawn hands, simple background, bad background, bad lighting, bad perspective"

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
})  

const dailiesSchema = new Schema({
    timestamp3hr: { type: String, required: true, default: "0" },
    timestamp12hr: { type: String, required: true, default: "0" },
    timestamp24hr: { type: String, required: true, default: "0" },
    timestamp168hr: { type: String, required: true, default: "0" },
})

const badgesSchema = new Schema({
    owner: { type: Boolean, default: false },
    moderator: { type: Boolean, default: false },
    supporter: { type: Boolean, default: false },
    contributor: { type: Boolean, default: false },
})

const settingsSchema = new Schema({
    notification_booruVote: { type: Boolean, default: true },
    notification_booruComment: { type: Boolean, default: true },
    notification_booruRating: { type: Boolean, default: true },
    notification_suggestionPromoted: { type: Boolean, default: true },
    notification_generatorSpentCredits: { type: Boolean, default: true },
    misc_generationReadyBeep: { type: Boolean, default: true },
    booru_tag_blacklist: { type: String, default: "" },
    user_bio: { type: String, default: "" },
})

const userProfileSchema = new Schema({
    badges: badgesSchema,
    supporter: { type: Boolean, default: false },
    username: { type: String, required: true, unique: false },
    accountId: { type: String, required: true, unique: true },
    timestamp: { type: String, required: false },
    exp: { 
        type: mongoose.Schema.Types.Decimal128,
        get: (v) => v ? parseFloat(v.toString()) : v,
        default: 0
    }, 
    level: { type: Number, default: 1 },
    aiSaveSlots: [aiSaveSlotSchema],
    credits: { 
        type: mongoose.Schema.Types.Decimal128,
        get: (v) => v ? parseFloat(v.toString()) : v,
        default: 500 
    },
    variables: {
        userHistoryLimit: { type: Number, default: 5000 }
    },
    dailies: dailiesSchema,
    profileImg: { type: String, default: "http://www.jscammie.com/noimagefound.png" },
    booruPostBanned: { type: Boolean, default: false },
    booruPostBanReason: { type: String, default: "Breaking Rules" },
    settings: settingsSchema,
    discordId: { type: String, default: "", required: false },
    googleId: { type: String, default: "", required: false },
    followedAccounts: { type: Array, default: [] },
    blockedAccounts: { type: Array, default: [] },
    favoriteLoras: { type: Array, default: [] },
    favoriteBooruPosts: { type: Array, default: [] },
})

userProfileSchema.set('toObject', { getters: true });
userProfileSchema.set('toJSON', { getters: true });

const name = 'userAccount'

module.exports = mongoose.models[name] || mongoose.model(name, userProfileSchema, name)
