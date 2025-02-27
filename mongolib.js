const mongoose = require('mongoose');

const fs = require('fs')

require('dotenv').config();

const userBooruSchema = require('./schemas/userBooruSchema.js');
const userBooruTagsSchema = require('./schemas/userBooruTagsSchema.js');
const userProfileSchema = require('./schemas/userProfileSchema.js');
const userSuggestionSchema = require('./schemas/userSuggestionSchema.js');
const userHistorySchema = require('./schemas/userHistorySchema.js');
const userCreditsHistorySchema = require('./schemas/userCreditsHistorySchema.js');
const generationLoraSchema = require('./schemas/generationLoraSchema.js');
const userBooruCommentsSchema = require('./schemas/userBooruCommentsSchema.js');
const userNotificationSchema = require('./schemas/userNotificationSchema.js');
const userRedeemSchema = require('./schemas/userRedeemSchema.js');

async function connectToDatabase() {
	try {
		await mongoose.connect(process.env.MONGODB_URI)
		await mongoose.set('strictQuery', false)
		console.log('Connected to database')
	} catch (error) {
		console.log(`Error connecting to database: ${error}`)
	}
}

async function createUserNotification(accountId, message, type) {
	let notificationObject = {
		notificationId: `${accountId}-${Date.now()}-${type}-${Math.floor(Math.random() * 100)}`,
		timestamp: Date.now(),
		message: message,
		accountId: accountId,
		type: type
	}

	await userNotificationSchema.create(notificationObject)

	return {status: 'success', message: 'Notification created'}
}

async function modifyUserCredits(accountId, amount, operation, message, testMode=false) {
	
	let UserProfile = await getSchemaDocumentOnce('userProfile', {accountId: accountId})
	if (UserProfile.status === 'error') {
		return {status: 'error', message: 'User not found'}
	}

	userProfile = UserProfile.data

	userCreditsBefore = BigInt(UserProfile.credits)
	userCreditsAfter = BigInt(UserProfile.credits)

	if (operation == '+') {
		userCreditsAfter += BigInt(amount)
	} else if (operation == '-') {
		userCreditsAfter -= BigInt(amount)
	} else if (operation == '=') {
		userCreditsAfter = BigInt(amount)
	} else {
		return {status: 'error', message: 'Invalid operation'}
	}

	// if credits would be negative, return error
	if (userCreditsAfter < 0) {
		return {status: 'error', message: 'Insufficient credits'}
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

	}

	return {status: 'success', newCredits: userCreditsAfter}
}

async function modifyUserExp(accountId, amount, operation) {

	let levelsJson = fs.readFileSync('c:\\Users\\anime\\Documents\\Coding\\JSCBot-Node\\levelsArray.json')

	let levelsArray = JSON.parse(levelsJson)
	// [{"level":1,"exp":0},{"level":2,"exp":138},{"level":3,"exp":345},{"level":4,"exp":621},{"level":5,"exp":966},

	let UserProfile = await getSchemaDocumentOnce('userProfile', {accountId: accountId})
	if (UserProfile.status === 'error') {
		return {status: 'error', message: 'User not found'}
	}

	userProfile = UserProfile.data

	userExpAfter = BigInt(UserProfile.exp)

	if (operation == '+') {
		userExpAfter += BigInt(amount)
	} else if (operation == '-') {
		userExpAfter -= BigInt(amount)
	} else if (operation == '=') {
		userExpAfter = BigInt(amount)
	} else {
		return {status: 'error', message: 'Invalid operation'}
	}

	// calculate their level:
	let userLevel = 1
	
	for (let i = 0; i < levelsArray.length; i++) {
		if (userExpAfter >= BigInt(levelsArray[i].exp)) {
			userLevel = levelsArray[i].level
		}
	}

	userExpAfter = userExpAfter.toString()

	await updateSchemaDocumentOnce('userProfile', {accountId: accountId}, {exp: userExpAfter, level: userLevel})

	return {status: 'success', newExp: userExpAfter}
}

async function getSchemaDocumentOnce(schema, query) {
	try {

		let document

		switch (schema) {
			case 'userBooru':
				document = await userBooruSchema.findOne(query)
				break;
			case 'userBooruTags':
				document = await userBooruTagsSchema.findOne(query)
				break;
			case 'userProfile':
				if (query.accountId == null) {
					return {status: 'error', message: 'No account ID provided'}
				} else {
					document = await userProfileSchema.findOne(query)
				}
				break;
			case 'userSuggestion':
				document = await userSuggestionSchema.findOne(query)
				break;
			case 'userHistory':
				document = await userHistorySchema.findOne(query)
				break;
			case 'userCreditsHistory':
				document = await userCreditsHistorySchema.findOne(query)
				break;
			case 'generationLora':
				document = await generationLoraSchema.findOne(query)
				break;
			case 'userBooruComments':
				document = await userBooruCommentsSchema.findOne(query)
				break;
			case 'userNotification':
				document = await userNotificationSchema.findOne(query)
				break;
			case 'userRedeem':
				document = await userRedeemSchema.findOne(query)
				break;
			default:
				document = null
		}

		if (document == null) {
			return {status: 'error', message: 'Document not found'}
		}

		return document

	} catch (error) {
		console.log(`Error getting schema: ${error}`)
		return {status: 'error', message: 'Error getting schema'}
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
			default:
				document = null
		}

		if (document === null) {
			return {status: 'error', message: 'Document not found'}
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
			default:
				documents = null
		}

		if (documents === null) {
			return {status: 'error', message: 'Document not found'}
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
					return {status: 'error', message: 'No account ID provided'}
				}
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
			default:
				return {status: 'error', message: 'Invalid schema'}
		}
		
		return {status: 'success', message: `Schema "${schema}" updated`}

	} catch (error) {
		console.log(`Error updating schema: ${error}`)
		return {status: 'error', message: 'Error updating schema'}
	}
	
}

async function createSchemaDocument(schema, document) {
	try {
		switch (schema) {
			case 'userBooru':
				await userBooruSchema.create(document)
				break;
			case 'userBooruTags':
				await userBooruTagsSchema.create(document)
				break;
			case 'userProfile':
				if (query.accountId == null) {
					return {status: 'error', message: 'No account ID provided'}
				}
				await userProfileSchema.create(document)
				break;
			case 'userSuggestion':
				await userSuggestionSchema.create(document)
				break;
			case 'userHistory':
				await userHistorySchema.create(document)
				break;
			case 'userCreditsHistory':
				await userCreditsHistorySchema.create(document)
				break;
			case 'generationLora':
				await generationLoraSchema.create(document)
				break;
			case 'userBooruComments':
				await userBooruCommentsSchema.create(document)
				break;
			case 'userNotification':
				await userNotificationSchema.create(document)
				break;
			case 'userRedeem':
				await userRedeemSchema.create(document)
				break;
			default:
				return {status: 'error', message: 'Invalid schema'}
		}
		
		return {status: 'success', message: `Schema "${schema}" created`}

	} catch (error) {
		console.log(`Error creating schema: ${error}`)
		return {status: 'error', message: 'Error creating schema'}
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
