const mongoose = require ("mongoose");
const { Schema } = mongoose


const generationLoraSchema = new Schema({
    loraId: { type: String, required: true, unique: true },
    usesCount: { type: String, default: "0" },
    lastUsed: { type: String, default: "0" },
})

const name = 'generationLora'

module.exports = mongoose.models[name] || mongoose.model(name, generationLoraSchema, name)
