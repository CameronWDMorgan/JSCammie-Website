const mongoose = require ("mongoose");
const { Schema } = mongoose

const userHistorySchema = new Schema({
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
    seed: { type: Number, default: -1 },
    image_url: { type: String, default: "" },
})

const name = 'userHistory'

module.exports = mongoose.models[name] || mongoose.model(name, userHistorySchema, name)
