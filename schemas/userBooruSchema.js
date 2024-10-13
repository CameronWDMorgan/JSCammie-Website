const mongoose = require ("mongoose");
const { Schema } = mongoose

const userBooruSchema = new Schema({
    booru_id: { type: String, required: true, unique: true },
    account_id: { type: String, required: true },
    image_id: { type: String, required: true },
    prompt: { type: String, default: "" },
    negative_prompt: { type: String, default: "" },
    model: { type: String, default: "furrybelnd" },
    aspect_ratio: { type: String, default: "square" },
    loras: { type: Array, default: [] },
    lora_strengths: { type: Array, default: [] },
    steps: { type: Number, default: 15 },
    cfg: { type: Number, default: 5 },
    seed: { type: Number, default: "-1" },
    content_url: { type: String, required: true },
    thumbnailMade: { type: Boolean, default: false },
    timestamp: { type: String, required: true },
    safety: { type: String, default: "na" },
    upvotes: { type: Array, default: [] },
    downvotes: { type: Array, default: [] },
    reported: { type: Boolean, default: false },
    reported_by: { type: Array, default: [] },
})

const name = 'userBooru'

module.exports = mongoose.models[name] || mongoose.model(name, userBooruSchema, name)
