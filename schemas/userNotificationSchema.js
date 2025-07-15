const mongoose = require ("mongoose");
const { Schema } = mongoose

const userNotificationSchema = new Schema({
    timestamp: { type: String, required: true },
    message: { type: String, required: true },
    accountId: { type: String, required: true },
    notificationId: { type: String, required: true },
    type: { type: String, required: true, default: 'System' },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    read: { type: Boolean, default: false },
    readTimestamp: { type: Number, default: null },
    actionUrl: { type: String, default: null },
    expiresAt: { type: Number, default: null },
    metadata: { type: Object, default: {} },
    grouped: { type: Boolean, default: false },
    groupId: { type: String, default: null },
})

// Add index for performance
userNotificationSchema.index({ accountId: 1 });

const name = 'userNotifications'

module.exports = mongoose.models[name] || mongoose.model(name, userNotificationSchema, name)
