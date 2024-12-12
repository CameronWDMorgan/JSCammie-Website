const mongoose = require ("mongoose");
const { Schema } = mongoose

const userRedeemSchema = new Schema({
    timestamp: { type: String, required: true },
    code: { type: String, required: true },
    variable: { type: String, required: true },
    redeemCount: { type: Number, required: true },
    maxRedeems: { type: Number, required: true },
    expires: { type: String, required: true },
    type: { type: String, required: true, default: 'credits' },
    usersRedeemed: { type: Array, required: true, default: [] },
    oneTimeUse: { type: Boolean, required: true, default: true },
})

const name = 'userRedeem'

module.exports = mongoose.models[name] || mongoose.model(name, userRedeemSchema, name)
