const mongoose = require ("mongoose");
const { Schema } = mongoose


const userBooruTagsSchema = new Schema({
    tag: { type: String, required: true },
    count: { type: String, default: "0" },
    booru_ids: { type: Array, default: [] },
})

const name = 'userBooruTags'

module.exports = mongoose.models[name] || mongoose.model(name, userBooruTagsSchema, name)
