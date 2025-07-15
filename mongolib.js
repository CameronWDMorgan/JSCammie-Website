const mongoose = require('mongoose');

const fs = require('fs')

require('dotenv').config();

const userBooruSchema = require('./schemas/userBooruSchema.js');
const userBooruTagsSchema = require('./schemas/userBooruTagsSchema.js');
const userProfileSchema = require('./schemas/userProfileSchemaNew.js');
const userSuggestionSchema = require('./schemas/userSuggestionSchema.js');
const userHistorySchema = require('./schemas/userHistorySchema.js');
const userCreditsHistorySchema = require('./schemas/userCreditsHistorySchema.js');
const generationLoraSchema = require('./schemas/generationLoraSchema.js');
const userBooruCommentsSchema = require('./schemas/userBooruCommentsSchema.js');
const userNotificationSchema = require('./schemas/userNotificationSchema.js');
const userRedeemSchema = require('./schemas/userRedeemSchema.js');
const generatorLoraPreviewSubmissionSchema = require('./schemas/generatorLoraPreviewSubmissionSchema.js');

const { Decimal128 } = mongoose.Types;

async function connectToDatabase() {
	try {
		await mongoose.connect(process.env.MONGODB_URI)
		await mongoose.set('strictQuery', false)
		console.log('Connected to database')

	} catch (error) {
		console.log(`Error connecting to database: ${error}`)
	}

}


async function createUserNotification(accountId, message, type, options = {}) {
	// Support both old and new calling patterns for backward compatibility
	const {
		priority = 'normal',
		actionUrl = null,
		expiresAt = null,
		metadata = {},
		grouped = false,
		groupId = null
	} = options;

	let notificationObject = {
		notificationId: `${accountId}-${Date.now()}-${type}-${Math.floor(Math.random() * 100)}`,
		timestamp: Date.now(),
		message: message,
		accountId: accountId,
		type: type,
		priority: priority,
		read: false,
		readTimestamp: null,
		actionUrl: actionUrl,
		expiresAt: expiresAt,
		metadata: metadata,
		grouped: grouped,
		groupId: groupId
	}

	await userNotificationSchema.create(notificationObject)

	return {status: 'success', message: 'Notification created'}
}

// New function to create grouped notifications (e.g., multiple credit gains)
async function createGroupedNotification(accountId, type, groupId, notifications) {
	try {
		const timestamp = Date.now();
		
		// Create a summary notification for the group
		const totalCredits = notifications.reduce((sum, notif) => sum + (notif.metadata?.credits || 0), 0);
		const count = notifications.length;
		
		let groupMessage = '';
		if (type === 'credits' && totalCredits > 0) {
			groupMessage = `You gained ${totalCredits} credits from ${count} activities`;
		} else {
			groupMessage = `${count} notifications`;
		}

		const groupNotification = {
			notificationId: `${accountId}-${timestamp}-${type}-group-${Math.floor(Math.random() * 100)}`,
			timestamp: timestamp,
			message: groupMessage,
			accountId: accountId,
			type: type,
			priority: 'normal',
			read: false,
			readTimestamp: null,
			actionUrl: null,
			expiresAt: null,
			metadata: { 
				groupedCount: count,
				totalCredits: totalCredits,
				groupedNotifications: notifications
			},
			grouped: true,
			groupId: groupId
		};

		await userNotificationSchema.create(groupNotification);
		return {status: 'success', message: 'Grouped notification created'};
	} catch (error) {
		console.log(`Error creating grouped notification: ${error}`);
		return {status: 'error', message: 'Error creating grouped notification'};
	}
}

// New function to mark notifications as read
async function markNotificationsAsRead(accountId, notificationIds = []) {
	try {
		const timestamp = Date.now();
		
		if (notificationIds.length === 0) {
			// Mark all notifications as read for this user
			await userNotificationSchema.updateMany(
				{ accountId: accountId, read: false },
				{ 
					$set: { 
						read: true, 
						readTimestamp: timestamp 
					}
				}
			);
		} else {
			// Mark specific notifications as read
			await userNotificationSchema.updateMany(
				{ 
					accountId: accountId, 
					notificationId: { $in: notificationIds },
					read: false 
				},
				{ 
					$set: { 
						read: true, 
						readTimestamp: timestamp 
					}
				}
			);
		}
		
		return {status: 'success', message: 'Notifications marked as read'};
	} catch (error) {
		console.log(`Error marking notifications as read: ${error}`);
		return {status: 'error', message: 'Error marking notifications as read'};
	}
}

// New function to clean up expired notifications
async function cleanupExpiredNotifications() {
	try {
		const currentTime = Date.now();
		
		// Delete notifications that have expired
		const result = await userNotificationSchema.deleteMany({
			expiresAt: { $ne: null, $lt: currentTime }
		});
		
		// Only clean up notifications older than 90 days to give users more time
		const ninetyDaysAgo = currentTime - (90 * 24 * 60 * 60 * 1000);
		const oldResult = await userNotificationSchema.deleteMany({
			timestamp: { $lt: ninetyDaysAgo }
		});
		
		console.log(`Cleaned up ${result.deletedCount} expired notifications and ${oldResult.deletedCount} old notifications`);
		return {
			status: 'success', 
			message: `Cleaned up ${result.deletedCount + oldResult.deletedCount} notifications`
		};
	} catch (error) {
		console.log(`Error cleaning up notifications: ${error}`);
		return {status: 'error', message: 'Error cleaning up notifications'};
	}
}

async function modifyUserCredits(accountId, amount, operation, message, testMode=false, notificationOptions = {}) {
	
	let UserProfile = await getSchemaDocumentOnce('userProfile', {accountId: accountId})
	if (UserProfile === null) {
		return null
	}

	// No need to access .data since UserProfile is already the document
	let userCreditsBefore = Number(UserProfile.credits)
	let userCreditsAfter = Number(UserProfile.credits)

	if (operation == '+') {
		userCreditsAfter += Number(amount)
	} else if (operation == '-') {
		userCreditsAfter -= Number(amount)
	} else if (operation == '=') {
		userCreditsAfter = Number(amount)
	} else {
		return null
	}

	// if credits would be negative, return error
	if (userCreditsAfter < 0) {
		return null
	}

	userCreditsAfter = userCreditsAfter.toString()
	userCreditsBefore = userCreditsBefore.toString()

	if (testMode === false) {

		await userProfileSchema.updateOne({accountId: accountId}, {credits: userCreditsAfter})

		creditsHistoryObject = {
			accountId: accountId,
			previousCredits: userCreditsBefore,
			newCredits: userCreditsAfter,
			timestamp: Date.now(),
			message: message
		}

		await userCreditsHistorySchema.create(creditsHistoryObject)

		// Create enhanced notification for credit changes if enabled in user settings
		if (UserProfile.settings?.notification_generatorSpentCredits !== false) {
			const creditChange = userCreditsAfter - userCreditsBefore;
			const notificationType = creditChange > 0 ? 'credits' : 'credits';
			const priority = Math.abs(creditChange) > 1000 ? 'high' : 'normal';
			
			// Don't spam notifications for small credit changes unless it's a significant gain
			if (Math.abs(creditChange) >= 50 || (creditChange > 0 && Math.abs(creditChange) >= 10)) {
				await createUserNotification(
					accountId, 
					message,
					notificationType,
					{
						priority: priority,
						metadata: {
							credits: Math.abs(creditChange),
							operation: operation,
							newTotal: userCreditsAfter
						},
						...notificationOptions
					}
				);
			}
		}
	}

	// Return an object with newCredits property to match what index.js expects
	return {
		newCredits: userCreditsAfter
	}
}

async function modifyUserExp(accountId, amount, operation) {

	let levelsJson = fs.readFileSync('c:\\Users\\anime\\Documents\\Coding\\JSCBot-Node\\levelsArray.json')

	let levelsArray = JSON.parse(levelsJson)
	// [{"level":1,"exp":0},{"level":2,"exp":138},{"level":3,"exp":345},{"level":4,"exp":621},{"level":5,"exp":966},

	let UserProfile = await getSchemaDocumentOnce('userProfile', {accountId: accountId})
	if (UserProfile === null) {
		return null
	}

	// No need to access .data since UserProfile is already the document
	userExpAfter = Number(UserProfile.exp)

	if (operation == '+') {
		userExpAfter += Number(amount)
	} else if (operation == '-') {
		userExpAfter -= Number(amount)
	} else if (operation == '=') {
		userExpAfter = Number(amount)
	} else {
		return null
	}

	// calculate their level:
	let userLevel = 1
	
	for (let i = 0; i < levelsArray.length; i++) {
		if (userExpAfter >= Number(levelsArray[i].exp)) {
			userLevel = levelsArray[i].level
		}
	}

	userExpAfter = userExpAfter.toString()

	await updateSchemaDocumentOnce('userProfile', {accountId: accountId}, {exp: userExpAfter, level: userLevel})

	return userExpAfter
}

async function getSchemaDocumentOnce(schema, query) {
	try {
		let document;

		switch (schema) {
			case 'userBooru':
				document = await userBooruSchema.findOne(query);
				break;
			case 'userBooruTags':
				document = await userBooruTagsSchema.findOne(query);
				break;
			case 'userProfile':
				if (!query.accountId) {
					return null; // Return null instead of an error object
				} else {
					query.accountId = String(query.accountId);
					document = await userProfileSchema.findOne(query);
				}
				break;
			case 'userSuggestion':
				document = await userSuggestionSchema.findOne(query);
				break;
			case 'userHistory':
				document = await userHistorySchema.findOne(query);
				break;
			case 'userCreditsHistory':
				document = await userCreditsHistorySchema.findOne(query);
				break;
			case 'generationLora':
				document = await generationLoraSchema.findOne(query);
				break;
			case 'userBooruComments':
				document = await userBooruCommentsSchema.findOne(query);
				break;
			case 'userNotification':
				document = await userNotificationSchema.findOne(query);
				break;
			case 'userRedeem':
				document = await userRedeemSchema.findOne(query);
				break;
			case 'generatorLoraPreviewSubmission':
				document = await generatorLoraPreviewSubmissionSchema.findOne(query);
				break;
			default:
				document = null;
		}

		return document || null; // Return null explicitly if no document found

	} catch (error) {
		console.log(`Error getting schema: ${error}`);
		return null; // Return null on error
	}
}


async function getSchemaDocuments(schema, query) {
	try {

		let document

		switch (schema) {
			case 'userBooru':
				if (query == {}) {
					document = await userBooruSchema.find({})
				} else {
					document = await userBooruSchema.find(query)
				}
				break;
			case 'userBooruTags':
				if (query == {}) {
					document = await userBooruTagsSchema.find({})
				} else {
					document = await userBooruTagsSchema.find(query)
				}
				break;
			case 'userProfile':
				if (query == {}) {
					document = await userProfileSchema.find({})
				} else {
					document = await userProfileSchema.find(query)
				}
				break;
			case 'userSuggestion':
				if (query == {}) {
					document = await userSuggestionSchema.find({})
				} else {
					document = await userSuggestionSchema.find(query)
				}
				break;
			case 'userHistory':
				if (query == {}) {
					document = await userHistorySchema.find({})
				} else {
					document = await userHistorySchema.find(query)
				}
				break;
			case 'userCreditsHistory':
				if (query == {}) {
					document = await userCreditsHistorySchema.find({})
				} else {
					document = await userCreditsHistorySchema.find(query)
				}
				break;
			case 'generationLora':
				if (query == {}) {
					document = await generationLoraSchema.find({})
				} else {
					document = await generationLoraSchema.find(query)
				}
				break;
			case 'userBooruComments':
				if (query == {}) {
					document = await userBooruCommentsSchema.find({})
				} else {
					document = await userBooruCommentsSchema.find(query)
				}
				break;
			case 'userNotification':
				if (query == {}) {
					document = await userNotificationSchema.find({})
				} else {
					document = await userNotificationSchema.find(query)
				}
				break;
			case 'userRedeem':
				if (query == {}) {
					document = await userRedeemSchema.find({})
				} else {
					document = await userRedeemSchema.find(query)
				}
				break;
			case 'generatorLoraPreviewSubmission':
				if (query == {}) {
					document = await generatorLoraPreviewSubmissionSchema.find({})
				} else {
					document = await generatorLoraPreviewSubmissionSchema.find(query)
				}
				break;
			default:
				document = null
		}

		return document

	} catch (error) {
		console.log(`Error getting schema: ${error}`)
		return {status: 'error', message: 'Error getting schema'}
	}

}


async function aggregateSchemaDocuments(schema, query) {
	try {
		let documents

		switch (schema) {
			case 'userBooru':
				documents = await userBooruSchema.aggregate(query)
				break;
			case 'userBooruTags':
				documents = await userBooruTagsSchema.aggregate(query)
				break;
			case 'userProfile':
				documents = await userProfileSchema.aggregate(query)
				break;
			case 'userSuggestion':
				documents = await userSuggestionSchema.aggregate(query)
				break;
			case 'userHistory':
				documents = await userHistorySchema.aggregate(query)
				break;
			case 'userCreditsHistory':
				documents = await userCreditsHistorySchema.aggregate(query)
				break;
			case 'generationLora':
				documents = await generationLoraSchema.aggregate(query)
				break;
			case 'userBooruComments':
				documents = await userBooruCommentsSchema.aggregate(query)
				break;
			case 'userNotification':
				documents = await userNotificationSchema.aggregate(query)
				break;
			case 'userRedeem':
				documents = await userRedeemSchema.aggregate(query)
				break;
			case 'generatorLoraPreviewSubmission':
				documents = await generatorLoraPreviewSubmissionSchema.aggregate(query)
				break;
			default:
				documents = null
		}

		return documents

	} catch (error) {
		console.log(`Error aggregating schema: ${error}`)
		return {status: 'error', message: 'Error aggregating schema'}
	}
}

async function updateSchemaDocumentOnce(schema, query, update) {
	try {
		switch (schema) {
			case 'userBooru':
				await userBooruSchema.findOneAndUpdate(query, update)
				break;
			case 'userBooruTags':
				await userBooruTagsSchema.findOneAndUpdate(query, update)
				break;
			case 'userProfile':
				if (query.accountId == null) {
					return null
				}
				query.accountId = String(query.accountId)
				await userProfileSchema.findOneAndUpdate(query, update)
				break;
			case 'userSuggestion':
				await userSuggestionSchema.findOneAndUpdate(query, update)
				break;
			case 'userHistory':
				await userHistorySchema.findOneAndUpdate(query, update)
				break;
			case 'userCreditsHistory':
				await userCreditsHistorySchema.findOneAndUpdate(query, update)
				break;
			case 'generationLora':
				await generationLoraSchema.findOneAndUpdate(query, update)
				break;
			case 'userBooruComments':
				await userBooruCommentsSchema.findOneAndUpdate(query, update)
				break;
			case 'userNotification':
				await userNotificationSchema.findOneAndUpdate(query, update)
				break;
			case 'userRedeem':	
				await userRedeemSchema.findOneAndUpdate(query, update)
				break;
			case 'generatorLoraPreviewSubmission':
				await generatorLoraPreviewSubmissionSchema.findOneAndUpdate(query, update)
				break;
			default:
				return null
		}
		
		return {status: 'success', message: `Schema "${schema}" updated`}

	} catch (error) {
		console.log(`Error updating schema: ${error}`)
		return {status: 'error', message: 'Error updating schema'}
	}
	
}

// Function to create a schema document
async function createSchemaDocument(schema, document) {
	try {

		switch (schema) {
			case 'userBooru':
				await userBooruSchema.create(document);
				break;
			case 'userBooruTags':
				await userBooruTagsSchema.create(document);
				break;
			case 'userProfile':

				if (!document.accountId) {
					console.error(`Missing accountId in document: ${JSON.stringify(document)}`);
					return null
				}

				await userProfileSchema.create(document);
				break;
			case 'userSuggestion':
				await userSuggestionSchema.create(document);
				break;
			case 'userHistory':
				await userHistorySchema.create(document);
				break;
			case 'userCreditsHistory':
				await userCreditsHistorySchema.create(document);
				break;
			case 'generationLora':
				await generationLoraSchema.create(document);
				break;
			case 'userBooruComments':
				await userBooruCommentsSchema.create(document);
				break;
			case 'userNotification':
				await userNotificationSchema.create(document);
				break;
			case 'userRedeem':
				await userRedeemSchema.create(document);
				break;
			case 'generatorLoraPreviewSubmission':
				await generatorLoraPreviewSubmissionSchema.create(document);
				break;
			default:
				console.error(`Invalid schema: ${schema}`);
				return null
		}

		return { status: 'success', message: `Schema "${schema}" created` };
	} catch (error) {
		console.error(`Error creating schema "${schema}": ${error.message}`);
		return { status: 'error', message: 'Error creating schema' };
	}
}

async function deleteSchemaDocument(schema, query) {
	try {
		switch (schema) {
			case 'userBooru':
				await userBooruSchema.findOneAndDelete(query)
				break;
			case 'userBooruTags':
				await userBooruTagsSchema.findOneAndDelete(query)
				break;
			case 'userProfile':
				await userProfileSchema.findOneAndDelete(query)
				break;
			case 'userSuggestion':
				await userSuggestionSchema.findOneAndDelete(query)
				break;
			case 'userHistory':
				await userHistorySchema.findOneAndDelete(query)
				break;
			case 'userCreditsHistory':
				await userCreditsHistorySchema.findOneAndDelete(query)
				break;
			case 'generationLora':
				await generationLoraSchema.findOneAndDelete(query)
				break;
			case 'userBooruComments':	
				await userBooruCommentsSchema.findOneAndDelete(query)
				break;
			case 'userNotification':
				await userNotificationSchema.findOneAndDelete(query)
				break;
			case 'userRedeem':
				await userRedeemSchema.findOneAndDelete(query)
				break;
			case 'generatorLoraPreviewSubmission':
				await generatorLoraPreviewSubmissionSchema.findOneAndDelete(query)
				break;
			default:
				return {status: 'error', message: 'Invalid schema'}
		}
	
		return {status: 'success', message: `Schema "${schema}" deleted`}

	} catch (error) {
		console.log(`Error deleting schema: ${error}`)
		return {status: 'error', message: 'Error deleting schema'}
	}

}

// export all functions
module.exports = {
	createUserNotification,
	createGroupedNotification,
	markNotificationsAsRead,
	cleanupExpiredNotifications,
	modifyUserCredits,
	modifyUserExp,
	getSchemaDocumentOnce,
	getSchemaDocuments,
	aggregateSchemaDocuments,
	updateSchemaDocumentOnce,
	createSchemaDocument,
	deleteSchemaDocument,
	connectToDatabase
}