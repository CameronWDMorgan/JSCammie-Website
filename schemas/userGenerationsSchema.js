const mongoose = require ("mongoose");
const { Schema } = mongoose


const aiData = new Schema({
    prompt: { type: String, required: false },
    negativeprompt: { type: String, required: false },
    aspectRatio: { type: String, required: false },
    model: { type: String, required: false },
    loras: { type: String, required: false },
    lora_strengths: { type: String, required: false },
    steps: { type: String, required: false },
    quantity: { type: String, required: false },
    cfg: { type: String, required: false },
    seed: { type: String, required: false },
})

const userGenerationsSchema = new Schema({
    hash: { type: String, required: true },
    request_type: { type: String, required: false },
    prompt: { type: String, required: false },
    negative_prompt: { type: String, required: false },
    seed: { type: String, required: false },
    cfg: { type: String, required: false },
    steps: { type: String, required: false },
    loras: { type: String, required: false },
    lora_strengths: { type: String, required: false },
    quantity: { type: String, required: false },
    model: { type: String, required: false },
    timestamp: { type: String, required: false },
    aiData: { type: String, required: false }
})

const name = 'userGenerations'

module.exports = mongoose.models[name] || mongoose.model(name, userGenerationsSchema, name)
