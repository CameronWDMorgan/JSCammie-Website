const mongoose = require ("mongoose");
const { Schema } = mongoose


const userSuggestionSchema = new Schema({
    suggestionId: { type: String, required: true, unique: true },
    accountId: { type: String, required: true },
    upvotes: { type: Array, default: [] },
    downvotes: { type: Array, default: [] },
    title: { type: String, default: "No title given" },
    text: { type: String, default: "No text given" },
    timestamp: { type: String, required: false },
    type: { type: String, default: "lora" },
    model: { type: String, required: false },
    status: { type: String, default: "Pending" },
    safety: { type: String, default: "sfw" },
    promoted: { type: Boolean, default: false },
})

// Add index for performance
userSuggestionSchema.index({ accountId: 1 });

const name = 'userSuggestion'

module.exports = mongoose.models[name] || mongoose.model(name, userSuggestionSchema, name)
