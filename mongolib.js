const mongoose = require('mongoose');

require('dotenv').config();



const userBooruSchema = require('./schemas/userBooruSchema.js');
const userBooruTagsSchema = require('./schemas/userBooruTagsSchema.js');
const userProfileSchema = require('./schemas/userProfileSchema.js');
const userSuggestionSchema = require('./schemas/userSuggestionSchema.js');
const userHistorySchema = require('./schemas/userHistorySchema.js');
const userCreditsHistorySchema = require('./schemas/userCreditsHistorySchema.js');
const generationLoraSchema = require('./schemas/generationLoraSchema.js');
const userBooruCommentsSchema = require('./schemas/userBooruCommentsSchema.js');

async function connectToDatabase() {
	try {
		await mongoose.connect(process.env.MONGODB_URI)
		await mongoose.set('strictQuery', false)
		console.log('Connected to database')
	} catch (error) {
		console.log(`Error connecting to database: ${error}`)
	}
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
				document = await userProfileSchema.findOne(query)
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
			default:
				return {status: 'error', message: 'Invalid schema'}
		}
		
		console.log(`Schema "${schema}" updated`)

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
			default:
				return {status: 'error', message: 'Invalid schema'}
		}
		
		console.log(`Schema "${schema}" created`)

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
			default:
				return {status: 'error', message: 'Invalid schema'}
		}
	
		console.log(`Schema "${schema}" deleted`)

		return {status: 'success', message: `Schema "${schema}" deleted`}

	} catch (error) {
		console.log(`Error deleting schema: ${error}`)
		return {status: 'error', message: 'Error deleting schema'}
	}

}




// export all functions
module.exports = {
	modifyUserCredits,
	getSchemaDocumentOnce,
	getSchemaDocuments,
	updateSchemaDocumentOnce,
	createSchemaDocument,
	deleteSchemaDocument,
	connectToDatabase
}
