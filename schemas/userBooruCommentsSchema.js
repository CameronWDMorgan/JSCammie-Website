const mongoose = require ("mongoose");
const { Schema } = mongoose

const userBooruCommentsSchema = new Schema({
    commentId: { type: String, required: true, unique: true },
    booruId: { type: String, required: true },
    accountId: { type: String, required: true },
    timestamp: { type: String, required: true },
    comment: { type: String, required: true },
    upvotes: { type: Array, default: [] },
    downvotes: { type: Array, default: [] },
})

const name = 'userBooruComments'

module.exports = mongoose.models[name] || mongoose.model(name, userBooruCommentsSchema, name)
