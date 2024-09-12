const mongoose = require ("mongoose");
const { Schema } = mongoose


const userUploadSchema = new Schema({
    uploadId: { type: String, required: true, unique: true },
    accountId: { type: String, required: true },
    tags: { type: Array, default: [] },
    contentUrl: { type: String, required: true },
    thumbnailMade: { type: Boolean, default: false },
    timestamp: { type: String, required: true },
    safety: { type: String, default: "sfw" },
    upvotes: { type: Array, default: [] },
    downvotes: { type: Array, default: [] },
})

const name = 'userUpload'

module.exports = mongoose.models[name] || mongoose.model(name, userUploadSchema, name)
