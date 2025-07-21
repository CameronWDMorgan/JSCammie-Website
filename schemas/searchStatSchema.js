const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Schema to track popular searches for sitemap generation
 * This helps identify which search terms should be included in the sitemap
 */
const searchStatSchema = new Schema({
    searchTerm: { type: String, required: true, unique: true },
    searchCount: { type: Number, default: 1 },
    lastSearched: { type: Date, default: Date.now },
    resultCount: { type: Number, default: 0 }, // Number of results for this search
    safetyLevel: { type: String, default: 'sfw' }, // Track safety level of searches
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Index for performance
searchStatSchema.index({ searchTerm: 1 }, { unique: true });
searchStatSchema.index({ searchCount: -1 });
searchStatSchema.index({ resultCount: -1 });
searchStatSchema.index({ lastSearched: -1 });

// Update the updatedAt field on save
searchStatSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

const name = 'searchStat';

module.exports = mongoose.models[name] || mongoose.model(name, searchStatSchema, name);
