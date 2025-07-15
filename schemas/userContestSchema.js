const mongoose = require ("mongoose");
const { Schema } = mongoose

const entrySchema = new Schema({
    accountId: { type: String, required: true },
    base64: { type: String, required: true },
})  

const userContestSchema = new Schema({
    contestId: { type: String, required: true, unique: true },
    entries: [entrySchema],
})

// Add index for performance
userContestSchema.index({ accountId: 1 });

const name = 'userContest'

module.exports = mongoose.models[name] || mongoose.model(name, userContestSchema, name)
