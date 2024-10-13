const mongoose = require ("mongoose");
const { Schema } = mongoose


const creditsHistorySchema = new Schema({
    accountId: { type: String, required: true },
    previousCredits: { type: String, required: true },
	newCredits: { type: String, required: true },
	timestamp: { type: Number, required: true },
	message: { type: String, default: "" }
})

const name = 'creditsHistory'

module.exports = mongoose.models[name] || mongoose.model(name, creditsHistorySchema, name)
