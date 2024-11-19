const mongoose = require ("mongoose");
const { Schema } = mongoose

const userNotificationSchema = new Schema({
    timestamp: { type: String, required: true },
    message: { type: String, required: true },
    accountId: { type: String, required: true },
    notificationId: { type: String, required: true },
    type: { type: String, required: true, default: 'System' },
})

const name = 'userNotifications'

module.exports = mongoose.models[name] || mongoose.model(name, userNotificationSchema, name)
