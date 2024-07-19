const mongoose = require ("mongoose");
const { Schema } = mongoose

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
    timestamp: { type: String, required: true },
    type: { type: String, required: true },
})

const userProfileSchema = new Schema({
    badges: { type: Array, default: [] },
    supporter: { type: Boolean, default: false },
    username: { type: String, required: true, unique: false },
    accountId: { type: String, required: true, unique: true },
    timestamp: { type: String, required: false },
    exp: { type: Number, default: 0, required: false },
    level: { type: Number, default: 1 },
    aiSaveSlots: [aiSaveSlotSchema],
    credits: { type: Number, default: 250 },
    dailies: [dailiesSchema],
})

const name = 'userAccount'

module.exports = mongoose.models[name] || mongoose.model(name, userProfileSchema, name)
