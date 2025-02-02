require('console-stamp')(console, {
	format: ':date(HH:MM:ss)'
});

const express = require('express')
const app = express()
const port = 80
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs')
const bodyParser = require('body-parser')

const mongolib = require('./mongolib.js')

// axios
const axios = require('axios');

const { promisify } = require('util');


// connect to the database:
mongolib.connectToDatabase()

const cors = require('cors');
app.use(cors());

const compression = require('compression');
app.use(compression());

app.set('view engine', 'ejs');

const ExifReader = require('exifreader');

// load getCreditsPrice(loraCount, model) function from scripts/ai-calculateCreditsPrice.js
const customFunctions = require('./scripts/ai-calculateCreditsPrice.js')
const getFastqueuePrice = customFunctions.getFastqueuePrice
const getExtrasPrice = customFunctions.getExtrasPrice

// Middleware to parse incoming form data
app.use(express.urlencoded({
	extended: true
}));
// set limit:
app.use(express.json({
	limit: '50mb'
}));


const cookieSession = require('cookie-session');

// Session middleware
app.use(cookieSession({
	name: 'session',
	keys: [process.env.COOKIE_KEY1, process.env.COOKIE_KEY2],
	secure: true, // Ensures the browser only sends the cookie over HTTPS
	httpOnly: true, // Helps prevent attacks such as cross-site scripting
	maxAge: (24 * 60 * 60 * 1000) * 999 // 30 days
}));

// Middleware to refresh session expiration
app.use((req, res, next) => {
    if (req.session) {
        req.session.nowInMinutes = Math.floor(Date.now() / 60e3);
        req.sessionOptions.maxAge = req.sessionOptions.maxAge; // Explicitly refresh maxAge
    }
    next();
});


app.use(express.static(__dirname));

function enforceSecureDomain(req, res, next) {
    if (req.headers.host.slice(0, 4) !== 'www.' || !req.secure && req.get('x-forwarded-proto') !== 'https') {
        const host = req.headers.host.slice(0, 4) !== 'www.' ? 'www.' + req.headers.host : req.headers.host;
        return res.redirect(301, `https://${host}${req.url}`);
    }
    next();
}
app.use(enforceSecureDomain);

app.set('trust proxy', true);


const userProfileSchema = require('./schemas/userProfileSchema.js');
const userSuggestionSchema = require('./schemas/userSuggestionSchema.js');
const userHistorySchema = require('./schemas/userHistorySchema.js');

const generationLoraSchema = require('./schemas/generationLoraSchema.js');

// setup views directory:
app.set('views', './views')

app.get('/aibeta', (req, res) => {
	res.render('aibeta', {
		session: req.session
	})
})

app.get('/home', (req, res) => {
	res.render('home', {
		session: req.session
	})
})

app.get('/login', (req, res) => {
	// send login.ejs:
	res.render('login', {
		session: req.session
	})
})

app.get('/logout', (req, res) => {
	req.session.loggedIn = false;
	req.session.accountId = null;
	// redirect to previous page:
	res.redirect('back')
})

app.get('/auth/discord', (req, res) => {
	res.render('discordcallback', {
		session: req.session
	})
})

app.get('/contact', (req, res) => {
	res.render('contact', {
		session: req.session
	})
})

app.post('/toggle-darkmode', (req, res) => {
	// Toggle the current state
	if (req.session.darkmode === undefined || req.session.darkmode === null) {
		req.session.darkmode = true;
	} else {
		req.session.darkmode = !req.session.darkmode;
	}

	// Respond with the new state or redirect, etc.
	res.json({
		darkmode: req.session.darkmode
	});
});

app.get('/projects', (req, res) => {
	res.render('projects', {
		session: req.session
	})
})

app.get('/privacypolicy', (req, res) => {
	res.render('privacypolicy', {
		session: req.session
	})
})

app.get('/profile', async (req, res) => {

	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	res.render('profile', {
		userProfile: userProfile,
		session: req.session
	})

})

// OAuth route to handle Discord token and login
app.post('/receive-token', async (req, res) => {
	const accessToken = req.body.accessToken;

	try {
		const discordResponse = await fetch('https://discord.com/api/users/@me', {
			headers: {
				'Authorization': `Bearer ${accessToken}`
			}
		});
		if (!discordResponse.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const discordUser = await discordResponse.json();

		if (!discordUser.id) {
			return res.status(400).send({
				status: 'error',
				message: 'Account not found'
			});
		}

		const newProfile = {
			accountId: discordUser.id,
			username: discordUser.username,
			timestamp: Date.now(),
		};

		// Update or create user profile in database
		await userProfileSchema.findOneAndUpdate({
			accountId: discordUser.id
		}, newProfile, {
			upsert: true
		});

		// Store user session information
		req.session.accountId = discordUser.id;
		req.session.loggedIn = true;

		// Add user to the Discord server
		await fetch(`https://discord.com/api/guilds/${process.env.GUILD_ID}/members/${discordUser.id}`, {
			method: 'PUT',
			headers: {
				'Authorization': `Bot ${process.env.BOT_TOKEN}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				access_token: accessToken
			})
		});

		res.sendStatus(200);
	} catch (error) {
		console.log(`Error receiving token: ${error}`);
		res.status(500).send({
			status: 'error',
			message: 'Server error'
		});
	}
});

app.get('/suggestions', async (req, res) => {
	let suggestions = await userSuggestionSchema.find()

	// userProfile:

	if (req.session.loggedIn) {
		userProfile = await userProfileSchema.findOne({
			accountId: req.session.accountId
		})
	} else {
		userProfile = {}
	}

	res.render('suggestions/suggestions', {
		suggestions: suggestions,
		session: req.session,
		userProfile: userProfile
	})
})

	// Shows the page where users can submit suggestions
app.get('/submit-suggestion', (req, res) => {
	// check they are logged in:
	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	res.render('suggestions/submit-suggestion', {
		session: req.session
	})
})

	// Post request  to use credits to promote a suggestion
app.post('/promote-suggestion', async (req, res) => {
	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	let suggestionId = req.body.suggestionId
	let accountId = req.session.accountId

	let suggestion = await userSuggestionSchema.findOne({
		suggestionId: suggestionId
	})

	if (suggestion === null) {
		res.send({
			status: 'error',
			message: 'Suggestion not found'
		})
		return
	}

	// check if the suggestion is already promoted:
	if (suggestion.promoted === true) {
		res.send({
			status: 'error',
			message: 'Suggestion already promoted'
		})
		return
	}

	// check if the user has more than 300 credits:
	let result = await mongolib.modifyUserCredits(accountId, 1500, '-', `Promoted Suggestion Titled: "${suggestion.title}"`, true)

	if (result.status === 'error') {
		res.send({
			status: result.status,
			message: result.message
		})
		return
	}

	// promote the suggestion:
	await userSuggestionSchema.findOneAndUpdate({
		suggestionId: suggestionId
	}, {
		promoted: true
	})

	let suggestionUserProfile = await userProfileSchema.findOne({
		accountId: suggestion.accountId
	})

	await mongolib.modifyUserCredits(accountId, 1500, '-', `Promoted Suggestion Titled: "${suggestion.title}"`)
	// if the notification setting doesnt exist or is true, then send the notification, if its false then dont:
	if (suggestionUserProfile.settings?.notification_suggestionPromoted === true || suggestionUserProfile.settings?.notification_suggestionPromoted === undefined) {
		await mongolib.createUserNotification(req.session.accountId, `You promoted a suggestion titled: "${suggestion.title}"`, 'suggestion')
	}
	res.send({
		status: 'success',
		message: 'Suggestion promoted (refresh to see changes)'
	})
})


// Post request so users or admins can change the safety rating of a suggestion 
app.post('/toggle-suggestion-safety', async (req, res) => {

	// check if they are logged in:
	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	let suggestionId = req.body.suggestionId
	let accountId = req.session.accountId

	let suggestion = await userSuggestionSchema.findOne({
		suggestionId: suggestionId
	})

	if (suggestion === null) {
		res.send({
			status: 'error',
			message: 'Suggestion not found'
		})
		return
	}

	let currentUser = await userProfileSchema.findOne({
		accountId: accountId
	})

	// check if the user is the author of the suggestion, or a owner:
	if (suggestion.accountId !== accountId && currentUser.badges?.owner !== true) {
		res.send({
			status: 'error',
			message: 'You are not the author of this suggestion'
		})
		return
	}


	let newSafety = 'sfw'

	if (suggestion.safety.toLowerCase() === 'sfw') {
		newSafety = 'nsfw'
	}

	await userSuggestionSchema.findOneAndUpdate({
		suggestionId: suggestionId
	}, {
		safety: newSafety
	})

	res.send({
		status: 'success',
		message: `Suggestion safety flipped to ${newSafety}`
	})
})

app.post('/submit-suggestion', async (req, res) => {

	// check if they are logged in:
	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	let text = req.body.text
	let accountId = req.session.accountId

	// make a unique suggestionId, 1, 2, 3 etc using the suggestion with the highest suggestionId as a base, then +1:
	let allSuggestions = await userSuggestionSchema.find()
	// get the highest one:
	let highestSuggestion = allSuggestions.sort((a, b) => Number(b.suggestionId) - Number(a.suggestionId))[0]
	let suggestionId = 1

	if (highestSuggestion !== null) {
		suggestionId = Number(highestSuggestion.suggestionId) + 1
	}

	let title = req.body.title

	// type:
	let type = req.body.type

	let newSuggestion = {
		title: title,
		type: type,
		suggestionId: String(suggestionId),
		accountId: accountId,
		text: text,
		timestamp: Date.now(),
		safety: req.body.safety,
	}

	// check if the user has already submitted 2 or more suggestions, if they have they cannot submit another:
	let userSuggestions = await userSuggestionSchema.find({
		accountId: accountId
	})
	// remove any that dont have a status of pending:
	userSuggestions = userSuggestions.filter(suggestion => suggestion.status.toLowerCase() === 'pending')
	if (userSuggestions.length >= 10) {
		res.send({
			status: 'error',
			message: 'You have already submitted 10 suggestions'
		})
		return
	}

	await userSuggestionSchema.create(newSuggestion)

	// wait 2 seconds:
	await new Promise(resolve => setTimeout(resolve, 2000))

	res.redirect('suggestions')
})

app.post('/vote-suggestion', async (req, res) => {

	// check if they are logged in:
	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	let suggestionId = req.body.suggestionId
	let accountId = req.session.accountId

	let suggestion = await userSuggestionSchema.findOne({
		suggestionId: suggestionId
	})

	if (suggestion === null) {
		res.send({
			status: 'error',
			message: 'Suggestion not found'
		})
		return
	}

	let upvoted = false
	let downvoted = false

	// check if the user has already upvoted or downvoted the suggestion:
	if (suggestion.upvotes.includes(accountId)) {
		upvoted = true
	}

	if (suggestion.downvotes.includes(accountId)) {
		downvoted = true
	}

	// if the user has already downvoted and have chosen to downvote, do nothing:
	if (downvoted && req.body.vote === 'downvote') {
		res.send({
			status: 'error',
			message: 'You have already downvoted this suggestion'
		})
		return
	}

	// if the user has already upvoted and have chosen to upvote, do nothing:
	if (upvoted && req.body.vote === 'upvote') {
		res.send({
			status: 'error',
			message: 'You have already upvoted this suggestion'
		})
		return
	}

	// if the user has already upvoted and have chosen to downvote, remove the upvote:
	if (upvoted && req.body.vote === 'downvote') {
		// await userSuggestionSchema.findOneAndUpdate({suggestionId: suggestionId}, { $pull: { upvotes: accountId } })
		await mongolib.updateSchemaDocumentOnce("userSuggestion", {
			suggestionId: suggestionId
		}, {
			$pull: {
				upvotes: accountId
			}
		})
	}

	// if the user has already downvoted and have chosen to upvote, remove the downvote:
	if (downvoted && req.body.vote === 'upvote') {
		await mongolib.updateSchemaDocumentOnce("userSuggestion", {
			suggestionId: suggestionId
		}, {
			$pull: {
				downvotes: accountId
			}
		})
	}

	if (req.body.vote === 'upvote') {
		await mongolib.updateSchemaDocumentOnce("userSuggestion", {
			suggestionId: suggestionId
		}, {
			$push: {
				upvotes: accountId
			}
		})
	} else if (req.body.vote === 'downvote') {
		await mongolib.updateSchemaDocumentOnce("userSuggestion", {
			suggestionId: suggestionId
		}, {
			$push: {
				downvotes: accountId
			}
		})
	}

	suggestion = await mongolib.getSchemaDocumentOnce("userSuggestion", {
		suggestionId: suggestionId
	})

	// if suggestion doesnt exist, send error:
	if (suggestion === null) {
		res.send({
			status: 'error',
			message: 'Suggestion not found',
			votes: {
				upvotes: "Doesnt exist",
				downvotes: "Doesnt exist"
			}
		})
		return
	}

	res.send({
		status: 'success',
		message: `${req.body.vote} Vote submitted`,
		votes: {
			upvotes: suggestion.upvotes,
			downvotes: suggestion.downvotes
		}
	})
})

app.post('/remove-suggestion', async (req, res) => {

	// check if they are logged in:
	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	let suggestionId = req.body.suggestionId
	let accountId = req.session.accountId

	let currentUser = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: accountId
	})
	let suggestion = await mongolib.getSchemaDocumentOnce("userSuggestion", {
		suggestionId: suggestionId
	})

	if (suggestion === null) {
		res.send({
			status: 'error',
			message: 'Suggestion not found'
		})
		return
	}

	// check if the user is the author of the suggestion, or a owner:
	if (suggestion.accountId !== accountId && currentUser.badges?.owner !== true) {
		res.send({
			status: 'error',
			message: 'You are not the author of this suggestion'
		})
		return
	}

	await userSuggestionSchema.findOneAndDelete({
		suggestionId: suggestionId
	})
	await mongolib.createUserNotification(req.session.accountId, `Your suggestion titled: "${suggestion.title}" was removed.`, 'moderation')

	res.send({
		status: 'success',
		message: 'Suggestion removed'
	})
})

app.post('/update-suggestion-status', async (req, res) => {

	// check if they are logged in:
	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	let suggestionId = req.body.suggestionId
	let accountId = req.session.accountId

	let currentUser = await userProfileSchema.findOne({
		accountId: accountId
	})
	let suggestion = await userSuggestionSchema.findOne({
		suggestionId: suggestionId
	})

	if (suggestion === null) {
		res.send({
			status: 'error',
			message: 'Suggestion not found'
		})
		return
	}

	// check if the user is a owner:
	if (currentUser.badges?.owner !== true) {
		res.send({
			status: 'error',
			message: 'You are not a owner'
		})
		return
	}

	let newStatus = req.body.status

	await userSuggestionSchema.findOneAndUpdate({
		suggestionId: suggestionId
	}, {
		status: newStatus
	})

	await mongolib.createUserNotification(suggestion.accountId, `Your suggestion titled: "${suggestion.title}" has been updated to status: ${newStatus}`, 'suggestion')
	
	res.send({
		status: 'success',
		message: 'Suggestion status updated'
	})
})

app.get('/suggestion/:suggestionId', async (req, res) => {
	let suggestionId = req.params.suggestionId

	let suggestion = await userSuggestionSchema.findOne({
		suggestionId: suggestionId
	})

	if (suggestion === null) {
		res.send('Suggestion not found')
		return
	}

	res.render('suggestions/suggestion', {
		suggestion: suggestion,
		session: req.session
	})
})


app.get('/image-history', async (req, res) => {

	try {

		let userProfile = await userProfileSchema.findOne({
			accountId: req.session.accountId,
		});

		if (!userProfile) {
			res.send('User not found');
			return;
		}

		// Redirect to default page if necessary
		if (!req.url.includes('?page=') && !req.url.includes('?search=')) {
			res.redirect('/image-history?page=1&search=&model=all');
			return;
		}

		// Parse query parameters
		let page = parseInt(req.query.page) || 1;
		let search = req.query.search || '';
		let model = req.query.model || 'all';
		const totalPerPage = 24;
		let skip = (page - 1) * totalPerPage;

		if (isNaN(skip)) skip = 0;

		// Build the query for model filter
		let modelQuery = model === 'all' ? {} : { model };

		// Build the query for search filter
		let searchTerms = search
			.split(',')
			.map(term => term.trim())
			.filter(term => term.length > 0);

		let searchQuery = {};
		if (searchTerms.length > 0) {
			searchQuery = {
				$and: searchTerms.map(term => ({
					prompt: { $regex: term, $options: 'i' }, // Case-insensitive match for each term
				})),
			};
		}

		// Perform the aggregation with pagination and total count
		let results = await userHistorySchema.aggregate([
			{
				$match: {
					account_id: req.session.accountId,
					...modelQuery,
					...searchQuery,
				},
			},
			{
				$sort: { timestamp: -1, _id: -1 }, // Sort by timestamp (and _id as tiebreaker)
			},
			{
				$facet: {
					paginatedResults: [
						{ $skip: skip },
						{ $limit: totalPerPage },
					],
					totalCount: [
						{ $count: "count" },
					],
				},
			},
		]);

		// Extract the results and total count
		let userHistory = results[0].paginatedResults;
		let totalImages = results[0].totalCount.length > 0 ? results[0].totalCount[0].count : 0;
		let totalPages = Math.ceil(totalImages / totalPerPage);

		// Redirect to last page if the current page exceeds total pages
		if (page > totalPages && totalPages > 0) {
			res.redirect(`/image-history?page=${totalPages}&search=${encodeURIComponent(search)}&model=${model}`);
			return;
		}

		let totalUserImages = await userHistorySchema.countDocuments({
			account_id: req.session.accountId
		})

		// Render the template
		res.render('image-history-beta', {
			userHistory,
			session: req.session,
			page,
			search,
			model,
			totalPages,
			totalUserImages,
		});

	} catch (error) {
		console.log(`Error loading tags: ${error}`);
	}

});



app.post('/image-history/delete-image', async (req, res) => {
	let image_id = req.body.image_id

	let image = await userHistorySchema.findOne({
		image_id: image_id,
		account_id: req.session.accountId
	})

	if (image === null) {
		res.send({
			status: 'error',
			message: 'Image not found'
		})
		return
	}

	if (image.account_id !== req.session.accountId) {
		res.send({
			status: 'error',
			message: 'You are not the author of this image'
		})
		return
	}

	await userHistorySchema.findOneAndDelete({
		image_id: image_id
	})

	// remove the image from the disk:
	let imageFilePath = path.join(__dirname, `${req.session.accountId}/${image_id}.png`)
	let potentialThumbFilePath = path.join(__dirname, `${req.session.accountId}/${image_id}-thumb.png`)

	if (fs.existsSync(imageFilePath)) {
		fs.unlinkSync(imageFilePath)
	}

	if (fs.existsSync(potentialThumbFilePath)) {
		fs.unlinkSync(potentialThumbFilePath)
	}

	res.send({
		status: 'success',
		message: 'Image removed'
	})
})


app.post('/image-history/delete-all-images', async (req, res) => {

	let accountId = req.session.accountId

	// check the user exists:
	let user = await userProfileSchema.findOne({
		accountId: accountId
	})

	if (user === null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	let folderPath = path.join(__dirname, `imagesHistory/${accountId}`)

	if (fs.existsSync(folderPath)) {
		fs.rmdirSync(folderPath, {
			recursive: true
		})
	}

	await userHistorySchema.deleteMany({
		account_id: accountId
	})

	res.send({
		status: 'success',
		message: 'All images removed'
	})
})


app.get('/metadata', (req, res) => {
	res.render('metadata', {
		session: req.session
	})
})

app.post('/get-metadata', (req, res) => {
	const dataUrl = req.body.image;

	if (!dataUrl) {
		res.status(400).send('No image data received.');
		return;
	}

	try {
		// Convert data URL to a buffer
		const base64 = dataUrl.split(',')[1];
		let buffer = Buffer.from(base64, 'base64');

		// Load metadata from buffer
		const tags = ExifReader.load(buffer);
		let fields = ['<h2>Image Info</h2>'];

		for (let [key, value] of Object.entries(tags)) {
			if (['accountId'].includes(key)) {
				continue;
			}

			if (key == "parameters") {
				key = "Image Info";
			}

			let description = value.description || value;
			if (description.length > 0) {
				fields.push(`<div class="round-frosted" style="padding:10px; margin-bottom:10px; border-radius:5px"><p>${key}:</p><a>${description}</a></div>`);
			}
		}

		const joinedFields = fields.join('');
		res.json({
			html: joinedFields
		});
	} catch (error) {
		console.log(`Error processing image data: ${error}`);
		res.status(500).send(`Error processing image data: ${error.message}`);
	}
});

const {
	parse
} = require('csv-parse/sync');

// Function to load tags from a CSV file
async function loadTags() {
	const csvContent = fs.readFileSync(path.resolve(__dirname, 'tags.csv'), {
		encoding: 'utf-8'
	});
	const records = parse(csvContent, {
		columns: true,
		skip_empty_lines: true,
		trim: true
	});

	// Sort the records by the usage count (which is at index 2) in descending order.
	records.sort((a, b) => b.post_count - a.post_count);

	let allTags = []

	records.forEach(record => {
		let tag = record.name;
		tag = tag.replace(/_/g, ' '); // Replace underscores with spaces
		const score = parseInt(record.post_count); // Get the usage count and parse it as an integer.
		allTags.push({
			tag: tag,
			score: score
		});
	});

	// sort the tags by score
	allTags.sort((a, b) => b.score - a.score);

	topx = allTags.slice(0, 5)

	return allTags;
}

let allTags = null

app.post('/autocomplete', async (req, res) => {
	if (allTags === null) {
		allTags = await loadTags();
	}

	const {
		query
	} = req.body;
	let tagsThatMatch = [];

	// Check if query is defined and not an empty string
	if (query && typeof query === 'string') {
		const lowercaseQuery = query.toLowerCase();

		// Filter the tags based on both versions
		tagsThatMatch = allTags.filter(tag => tag.tag.toLowerCase().includes(lowercaseQuery));

		// Sort the tags by score:
		tagsThatMatch.sort((a, b) => b.score - a.score);

		// Get the top 10 tags:
		const topx = tagsThatMatch.slice(0, 20);

		res.json(topx);
	} else {
		// Handle the case when query is undefined or not a string
		res.status(400).json({
			error: 'Invalid query parameter'
		});
	}
});

let cachedYAMLData = null
let AI_API_URL = "http://127.0.0.1:5003"

// Function to sort an object by its keys
function sortObjectByKey(obj) {
	return Object.keys(obj).sort().reduce((acc, key) => {
		acc[key] = obj[key];
		return acc;
	}, {});
}

// Function to fetch, sort, and cache YAML data
async function updateYAMLCache() {
	try {
		let response = await fetch(`${AI_API_URL}/get-lora-yaml`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json'
			}
		})

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		response = response.json()

		// get data from response, old code was:
		// .then(response => response.json())
		// .then(data => {

		let data = await response

		// console.log('YAML data fetched');
		Object.keys(data).forEach(category => {
			try {
				data[category] = sortObjectByKey(data[category]);
			} catch (error) {
				console.log(`Error sorting data for category ${category}: ${error}`);
			}
		});

		cachedYAMLData = sortObjectByKey(data);
			
	} catch (error) {
		console.log(`Error fetching YAML data: ${error}`);
	}

	if (cachedYAMLData !== null) {
		// console.log('YAML data updated and cached');
		loraImagesCache()
	}


}

updateYAMLCache()

setTimeout(() => {
	updateYAMLCache()
}, 5000)

setInterval(updateYAMLCache, 10000);

async function loraImagesCache() {

	for (const [category, loras] of Object.entries(cachedYAMLData)) {
		// get the default image:
		const defaultImage = fs.readFileSync('.\\loraimages\\default.png')

		for (const [lora, loraData] of Object.entries(loras)) {

			// ensure directories exist:
			if (!fs.existsSync(`.\\loraimages\\${category}`)) {
				fs.mkdirSync(`.\\loraimages\\${category}`, {
					recursive: true
				})
			}
			if (!fs.existsSync(`.\\loraimages\\sdxl\\${category}`)) {
				fs.mkdirSync(`.\\loraimages\\sdxl\\${category}`, {
					recursive: true
				})
			}
			if (!fs.existsSync(`.\\loraimages\\flux\\${category}`)) {
				fs.mkdirSync(`.\\loraimages\\flux\\${category}`, {
					recursive: true
				})
			}

			// set the image path in the loraData:
			if (lora.includes('sdxl')) {
				// if there is no lora image then set it to the default image:
				if (!fs.existsSync(`.\\loraimages\\sdxl\\${category}\\${lora}.png`)) {
					fs.writeFileSync(`.\\loraimages\\sdxl\\${category}\\${lora}.png`, defaultImage)
				}
				loraData.image = `http://www.jscammie.com/loraimages/sdxl/${category}/${lora}.png`
			} else if (lora.includes('flux')) {
				// if there is no lora image then set it to the default image:
				if (!fs.existsSync(`.\\loraimages\\flux\\${category}\\${lora}.png`)) {
					fs.writeFileSync(`.\\loraimages\\flux\\${category}\\${lora}.png`, defaultImage)
				}
				loraData.image = `http://www.jscammie.com/loraimages/flux/${category}/${lora}.png`
			} else {
				// if there is no lora image then set it to the default image:
				if (!fs.existsSync(`.\\loraimages\\${category}\\${lora}.png`)) {
					fs.writeFileSync(`.\\loraimages\\${category}\\${lora}.png`, defaultImage)
				}
				loraData.image = `http://www.jscammie.com/loraimages/${category}/${lora}.png`
			}

			// add it to the cachedYAMLData:
			cachedYAMLData[category][lora] = loraData
		}
		// console.log the index:
		// console.log(`Cached YAML data updated with images for ${category}`)
	}

	// modify the cachedYAMLData, adding information from generationLoraSchema 'usesCount' and 'lastUsed', use the loraId as the key:
	try {
		let allLoras = await mongolib.getSchemaDocuments("generationLora", {})

		for (const lora of allLoras) {
			// get the category and loraId:
			let category = lora.loraId.split('-')[0]
			let loraId = lora.loraId

			// get the loraData from the cachedYAMLData:
			let loraData = cachedYAMLData[category][loraId]

			if (loraData === undefined) {
				continue
			}

			loraData.usesCount = lora.usesCount
			loraData.lastUsed = lora.lastUsed

			// add the loraData back to the cachedYAMLData:
			cachedYAMLData[category][loraId] = loraData
		}

		// console.log('Cached YAML data updated with images, usesCount, and lastUsed')
	} catch (error) {
		console.log(`Error updating cachedYAMLData with usesCount and lastUsed: ${error}`)
	}


	modifiedCachedYAMLData = cachedYAMLData
}

let aiScripts = {
	calculateCreditsPrice: fs.readFileSync('./scripts/ai-calculateCreditsPrice.js', 'utf8'),
	aiForm: fs.readFileSync('./scripts/ai-form.js', 'utf8'),
}

// split on module.exports to remove it and everything after:
aiScripts.calculateCreditsPrice = aiScripts.calculateCreditsPrice.split('module.exports')[0]

let betaAiScripts = {
	calculateCreditsPrice: fs.readFileSync('./scripts/ai-calculateCreditsPrice.js', 'utf8'),
	aiForm: fs.readFileSync('./scripts/ai-form-beta.js', 'utf8'),
}

// split on module.exports to remove it and everything after:
betaAiScripts.calculateCreditsPrice = betaAiScripts.calculateCreditsPrice.split('module.exports')[0]

app.get('/beta/ai', async function(req, res) {
	try {
		const accountId = req.session.accountId;

		// Parallelize database calls
		const [foundAccount, imageHistoryCountRaw] = await Promise.all([
			userProfileSchema.findOne({
				accountId: accountId
			}),
			userHistorySchema.aggregate([{
					$match: {
						account_id: accountId
					}
				},
				{
					$count: "count"
				}
			])
		]);

		let aiSaveSlots = foundAccount?.aiSaveSlots ?? [];

		// If aiSaveSlots is not initialized, update in parallel
		if (!aiSaveSlots.length) {
			await userProfileSchema.findOneAndUpdate({
				accountId: accountId
			}, {
				$set: {
					aiSaveSlots: []
				}
			}, {
				upsert: true
			});
		}

		// Scripts and history count
		const scripts = aiScripts;
		const imageHistoryCount = imageHistoryCountRaw[0]?.count ?? 0;

		// Render the page
		res.render('aibeta', {
			userProfile: foundAccount, // Reuse foundAccount instead of querying again
			imageHistoryCount,
			session: req.session,
			scripts,
			lora_data: modifiedCachedYAMLData,
			aiSaveSlots
		});
	} catch (error) {
		console.log(`Error loading tags data: ${error}`);
		res.status(500).send('Error loading tags data');
	}
})

app.get('/userProfile', async (req, res) => {
	let userProfile = await userProfileSchema.findOne({
		accountId: req.session.accountId
	});
	// check if the user exists, its a mongodb document that is returned:
	if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}
	res.send({
		userProfile: userProfile
	})
})

app.post('/dailies', async (req, res) => {

	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	let userProfile = await userProfileSchema.findOne({
		accountId: req.session.accountId
	});

	// check if the user exists, its a mongodb document that is returned:
	if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	let dailyType = req.body.type;
	let currentTimestamp = await Date.now()

	// the time that the dailies were last claimed:
	let dailiesTime = 0

	// the time difference in ms that is required for the dailies to be claimed: 
	let differenceRequired = 0

	// the amount of credits earned for the dailies:
	let creditsEarned = 0

	timestamp3hr = userProfile?.dailies?.timestamp3hr ?? "0";
	timestamp12hr = userProfile?.dailies?.timestamp12hr ?? "0";
	timestamp24hr = userProfile?.dailies?.timestamp24hr ?? "0";
	timestamp168hr = userProfile?.dailies?.timestamp168hr ?? "0";

	switch (dailyType) {
		case '3hr':
			dailiesTime = Number(timestamp3hr)
			differenceRequired = 10800000
			creditsEarned = 50
			break
		case '12hr':
			dailiesTime = Number(timestamp12hr)
			differenceRequired = 43200000
			creditsEarned = 100
			break
		case '24hr':
			dailiesTime = Number(timestamp24hr)
			differenceRequired = 86400000
			creditsEarned = 200
			break
		case '168hr':
			dailiesTime = Number(timestamp168hr)
			differenceRequired = 604800000
			creditsEarned = 500
			break
	}

	let dailiesTimeDifference = dailiesTime + differenceRequired

	if (dailiesTimeDifference > currentTimestamp) {
		res.send({
			status: 'error',
			message: 'Dailies already claimed'
		})
		return
	}

	result = await mongolib.modifyUserCredits(req.session.accountId, creditsEarned, '+', `Dailies claimed: ${dailyType}`)
	await mongolib.modifyUserExp(req.session.accountId, 5, '+')
	
	// await mongolib.createUserNotification(req.session.accountId, `You claimed your ${dailyType} dailies and earned ${creditsEarned} credits`, 'dailies')

	if (result.status == 'error') {
		res.send({
			status: result.status,
			message: result.message
		})
		return
	}

	result = await mongolib.updateSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	}, {
		[`dailies.timestamp${dailyType}`]: currentTimestamp
	})
	if (result.status == 'error') {
		res.send({
			status: result.status,
			message: result.message
		})
		return
	}

	res.send({
		status: 'success',
		message: 'Dailies claimed'
	})
})

// update the aiScripts every 15 seconds:
setInterval(() => {
	aiScripts = {
		calculateCreditsPrice: fs.readFileSync('./scripts/ai-calculateCreditsPrice.js', 'utf8'),
		aiForm: fs.readFileSync('./scripts/ai-form.js', 'utf8'),
	}
	aiScripts.calculateCreditsPrice = aiScripts.calculateCreditsPrice.replace("module.exports = { getFastqueuePrice, getExtrasPrice }", "")
}, 15000)

app.get('/', async function(req, res) {
	try {
		const accountId = req.session.accountId;

		// Parallelize database calls
		const [foundAccount, imageHistoryCountRaw] = await Promise.all([
			userProfileSchema.findOne({
				accountId: accountId
			}),
			userHistorySchema.aggregate([{
					$match: {
						account_id: accountId
					}
				},
				{
					$count: "count"
				}
			])
		]);

		let aiSaveSlots = foundAccount?.aiSaveSlots ?? [];

		// If aiSaveSlots is not initialized, update in parallel
		if (!aiSaveSlots.length) {
			await userProfileSchema.findOneAndUpdate({
				accountId: accountId
			}, {
				$set: {
					aiSaveSlots: []
				}
			}, {
				upsert: true
			});
		}

		// Scripts and history count
		const scripts = aiScripts;
		const imageHistoryCount = imageHistoryCountRaw[0]?.count ?? 0;

		// Render the page
		res.render('ai', {
			userProfile: foundAccount, // Reuse foundAccount instead of querying again
			imageHistoryCount,
			session: req.session,
			scripts,
			lora_data: modifiedCachedYAMLData,
			aiSaveSlots
		});
	} catch (error) {
		console.log(`Error loading tags data: ${error}`);
		res.status(500).send('Error loading tags data');
	}
});

app.post('/token-length', async function(req, res) {
	try {
		const response = await fetch(`${AI_API_URL}/token-length`, {
			method: 'POST',
			body: JSON.stringify(req.body),
			headers: {
				'Content-Type': 'application/json'
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const json = await response.json();

		res.send(json);
	} catch (error) {
		console.log(`Error getting token length: ${error}`);
		res.status(500).send('Error getting token length');
	}
})

app.post('/generate', async function(req, res) {
	try {
		let request = req.body; // Use 'let' or 'const' to ensure 'request' is scoped to this function

		// // Declare 'ip' and 'userAgent' with 'const' as they don't need to be reassigned
		const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
		const userAgent = req.headers['user-agent'];

		// Prepare request data with IP and User Agent
		request.ip = ip || "";
		request.userAgent = userAgent || "";

		const prompt = request.prompt;
		const loraPattern = /(style|effect|concept|clothing|character|pose|background)-([a-zA-Z0-9]+):(-?[0-9.]+)/g;
		let cleanedPrompt = prompt.replace(loraPattern, '').trim().replace(/, , /g, ", ");

		// if the prompt contains any : then alert the user that they need to remove them:
		if (cleanedPrompt.includes("<SPLIT>")) {
			res.send({
				status: "error",
				message: "BRUH LMAO"
			})
			return
		}

		if (request.negativeprompt.includes("<SPLIT>")) {
			res.send({
				status: "error",
				message: "BRUH LMAO"
			})
			return
		}

		let bannedTags = ['olivialewdz']
		// remove any banned tags from the prompt, use regex:
		cleanedPrompt = cleanedPrompt.replace(new RegExp(bannedTags.join("|"), "gi"), "");

		request.prompt = cleanedPrompt; // Update the prompt in the request object to be sent

		// make any <rp> lowercase:
		request.prompt = request.prompt.replace(/<RP>/g, "<rp>")

		if (request.model.startsWith('flux')) {
			request.quantity = 2
		}

		let filteredLastRequest = {
			prompt: request.prompt,
			negativeprompt: request.negativeprompt,
			model: request.model,
			loras: request.lora,
			aspectRatio: request.aspect_ratio,
			favoriteLoras: request.favoriteLoras,
			steps: request.steps,
			quantity: request.quantity,
			cfguidance: request.guidance,
			seed: request.seed,
			scheduler: request.scheduler
		};
		req.session.lastRequestSD = filteredLastRequest;

		if (request.fastqueue == true || request.extras?.removeWatermark == true || request.extras?.upscale == true || request.extras?.doubleImages == true || request.extras?.removeBackground == true) {

			let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			})

			if (userProfile == null) {
				res.send({
					status: "error",
					message: "User not found"
				})
				return
			}

			let fastqueueCreditsRequired

			if (request.fastqueue == true) {
				fastqueueCreditsRequired = getFastqueuePrice(request.lora.length, request.model)
				request.creditsRequired += fastqueueCreditsRequired
			}

			let extrasCreditsRequired

			// if any value in the extras object is true, then proceed with the if statement:
			if (Object.values(request.extras).includes(true)) {
				extrasCreditsRequired = getExtrasPrice(request.extras, request.model)

				// add all the values in the extrasCreditsRequired object to the request.creditsRequired:
				for (const [key, value] of Object.entries(extrasCreditsRequired)) {
					request.creditsRequired += value
				}
			}

			if (userProfile.credits < request.creditsRequired) {
				res.send({
					status: "error",
					message: "You do not have enough credits to generate an image with those settings!"
				})
				return
			}

			if (userProfile == null) {
				res.send({
					status: "error",
					message: "User not found"
				})
				return
			}

			if (request.fastqueue == true) {
				request.fastqueue = true
			} else {
				request.fastqueue = false
			}


		}

		// Send the modified request object
		const postResponse = await fetch(`${AI_API_URL}/generate`, {
			method: 'POST',
			body: JSON.stringify(request),
			headers: {
				'Content-Type': 'application/json'
			},
		});

		

		if (!postResponse.ok) {
			console.log('Response:', postResponse);
			console.log('Request:', JSON.stringify(request));
			throw new Error(`HTTP error! status: ${postResponse.status}`);
		}

		const jsonResponse = await postResponse.json();
		res.send(jsonResponse);
	} catch (error) {
		console.log(`Error generating image: ${error}`);
		res.status(500).send('Error generating image');
	}
});


app.get('/cancel_request/:request_id', async function(req, res) {
	try {
		request_id = req.param('request_id')
		const response = await fetch(`${AI_API_URL}/cancel_request/${request_id}`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json'
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const json = await response.json();

		res.send(json);
	} catch (error) {
		console.log(`Error cancelling request: ${error}`);
		res.status(500).send('Error cancelling request');
	}
})

app.get('/queue_position/:request_id', async function(req, res) {
	try {
		request_id = req.param('request_id')
		const response = await fetch(`${AI_API_URL}/queue_position/${request_id}`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json'
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const json = await response.json();

		// remove any number in brackets from queue_length:
		if (json.queue_length != null) {
			if (json.queue_length.includes("(")) {
				json.queue_length = json.queue_length.replace(/\s*\(.*?\)\s*/g, '')
			}
		}

		res.send(json);
	} catch (error) {
		console.log(`Error getting queue position: ${error}`);
		res.status(500).send('Error getting queue position');
	}
})

let imagesHistorySaveLocation = "E:/JSCammie/imagesHistory/"

app.get('/result/:request_id', async function(req, res) {
	try {
		request_id = req.param('request_id')
		const response = await fetch(`${AI_API_URL}/result/${request_id}`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json'
			},
		});
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const json = await response.json();

		let usedLoras = json.historyData.loras

		// convert the usedLoras "object" to an array, here is an example of the output `[ 'concept-sdxlantilongtorso', 'effect-sdxldetailifier' ]`:
		usedLoras = usedLoras.flat()

		// for each lora in the usedLoras array, generationLoraSchema.findOneAndUpdate increase the usesCount by 1, update lastUsed to be the current timestamp, and upsert it if it doesnt exist:
		// first check if usedLoras is not empty:
		if (usedLoras.length > 0) {
			// the usesCount and lastUsed are strings, so they need to be converted to number / BigInt before they can be incremented THEN converted back to string:
			for (const lora of usedLoras) {
				currentLora = await generationLoraSchema.findOne({
					loraId: lora
				})
				if (currentLora == null) {
					await generationLoraSchema.create({
						loraId: lora,
						usesCount: "1",
						lastUsed: `${Date.now()}`
					})
				} else {
					usesCount = BigInt(currentLora.usesCount) + BigInt(1)
					usesCount = usesCount.toString()
					await generationLoraSchema.findOneAndUpdate({
						loraId: lora
					}, {
						usesCount: usesCount,
						lastUsed: `${Date.now()}`
					})
				}
			}
		}

		let allImageHistory = []

		if (json.historyData.account_id != "0") {

			if (!fs.existsSync(imagesHistorySaveLocation)) {
				fs.mkdirSync(imagesHistorySaveLocation, {
					recursive: true
				});
			}
			if (!fs.existsSync(`${imagesHistorySaveLocation}${json.historyData.account_id}/`)) {
				fs.mkdirSync(`${imagesHistorySaveLocation}${json.historyData.account_id}/`, {
					recursive: true
				});
			}

			let nextImageId = BigInt(Date.now());



			for (const image of json.images) {
				try {
					// Check if the image object contains a base64 key
					if (image.hasOwnProperty('base64')) {
						let base64Data = image.base64;

						// Save the image to the file system
						fs.writeFileSync(`${imagesHistorySaveLocation}${json.historyData.account_id}/${nextImageId}.png`, base64Data, 'base64');

						// Prepare the new image history document
						let newImageHistory = {
							account_id: json.historyData.account_id,
							image_id: BigInt(nextImageId),
							prompt: json.historyData.prompt,
							negative_prompt: json.historyData.negative_prompt,
							model: json.historyData.model,
							aspect_ratio: json.historyData.aspect_ratio,
							loras: json.historyData.loras,
							lora_strengths: json.historyData.lora_strengths,
							steps: json.historyData.steps,
							cfg: json.historyData.cfg,
							seed: json.historyData.seed,
							image_url: `http://www.jscammie.com/imagesHistory/${json.historyData.account_id}/${nextImageId}.png`
						};

						// change the newImageHistory image_id to a string:
						newImageHistory.image_id = newImageHistory.image_id.toString()

						allImageHistory.push(newImageHistory);

						// Increment the image ID for the next iteration
						nextImageId = BigInt(nextImageId) + BigInt(1);
					}
				} catch (err) {
					console.log('Error saving image or updating database:', err);
				}
			}

			// // Insert the new image history documents into the database
			try {

				// get the count of all the images in the userHistory collection:
				let count = await userHistorySchema.countDocuments({
					account_id: json.historyData.account_id
				})

					if (count < 15000) {
						
						if (allImageHistory.length > 0) {
							for (const image of allImageHistory) {
								let result = await mongolib.createSchemaDocument("userHistory", image)
							}
						}
					} else {
					
						let result = await mongolib.createUserNotification(json.historyData.account_id, `You have reached the maximum amount of images in your history, please delete some images to make room for more, future images will not be saved! To see the limit, go to the <a href='/image-history'>Image History</a> page!`, 'generator')
					
					}
			} catch (err) {
				console.log('Error saving image or updating database:', err);
			}

		}

		// make it so allImageHistory is added to the json object:
		json.allImageHistory = allImageHistory

		if (json.creditsRequired > 0) {
			// get the user profile:

			let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			})

			if (userProfile.status == 'error') {
				res.send({
					status: 'error',
					message: 'User not found'
				})
				return
			}

			creditsRequired = json.creditsRequired

			// set credits to be the default value if it is not found:
			if (userProfile.credits == null || userProfile.credits == undefined) {
				creditsCurrent = 500
			} else {
				creditsCurrent = userProfile.credits
			}

			creditsMessage = `Generated images, Using: ${json.historyData.model}`

			// creditsFinal = creditsCurrent - creditsRequired
			result = await mongolib.modifyUserCredits(req.session.accountId, creditsRequired, '-', creditsMessage)

			if (userProfile.settings?.notification_generatorSpentCredits == true || userProfile.settings?.notification_generatorSpentCredits == undefined) {
				await mongolib.createUserNotification(req.session.accountId, `You spent ${creditsRequired} credits on generating images using ${json.historyData.model}`, 'generator')
			}
			json.credits = result.newCredits
		}

		historyData = json.historyData

		// add misc_generationReadyBeep from the userProfile to the json object, set it to true if it doesnt exist, or if its true, set it to false only if its false:
		json.misc_generationReadyBeep = userProfile?.settings?.misc_generationReadyBeep ?? true

		res.send(json);
	} catch (error) {
		console.log(`Error getting result: ${error}`);
		res.status(500).send('Error getting result');
	}
})

app.post('/ai-save-create', async function(req, res) {

	userProfile = await userProfileSchema.findOne({
		accountId: req.session.accountId
	})

	if (userProfile == null) {
		res.send({
			error: 'User profile not found'
		})
		return
	}

	let noSaves = false

	// using mongoose push empty save slot to user profile,
	// using the defaults in the schema apart from the saveSlotId which needs to be +1 of the last one:
	if (userProfile.aiSaveSlots.length == Array(0)) {
		noSaves = true
		userProfile.aiSaveSlots = []

	}

	// get the last save slot id and add 1 to it to get the next save slot id:

	if (noSaves) {
		nextSaveSlotId = 0
	} else {
		mostRecentSaveSlotId = Number(userProfile.aiSaveSlots[userProfile.aiSaveSlots.length - 1].saveSlotId)
		nextSaveSlotId = mostRecentSaveSlotId + 1
	}

	String(nextSaveSlotId)

	await userProfileSchema.findOneAndUpdate({
		accountId: req.session.accountId
	}, {
		$push: {
			aiSaveSlots: {
				saveSlotId: nextSaveSlotId,
				name: req.body.name,
				prompt: req.body.prompt,
				negativeprompt: req.body.negativeprompt,
				aspectRatio: req.body.aspectRatio,
				model: req.body.model,
				loras: req.body.loras,
				lora_strengths: req.body.lora_strengths,
				steps: req.body.steps,
				quantity: req.body.quantity,
				cfg: req.body.cfg,
				seed: req.body.seed
			}
		}
	})

	res.send({
		success: 'Created'
	})

})

app.post('/ai-save-update', async function(req, res) {

	userProfile = await userProfileSchema.findOne({
		accountId: req.session.accountId
	})

	if (userProfile == null) {
		res.send({
			error: 'User profile not found'
		})
		return
	}

	if (userProfile.aiSaveSlots === null) {
		userProfile.aiSaveSlots = []
	}

	saveSlotId = req.body.saveSlotId

	// update the save slot using the saveSlotId to find it in the array of save slots: 
	await userProfileSchema.findOneAndUpdate({
		accountId: req.session.accountId,
		"aiSaveSlots.saveSlotId": saveSlotId
	}, {
		"aiSaveSlots.$.prompt": req.body.prompt,
		"aiSaveSlots.$.negativeprompt": req.body.negativeprompt,
		"aiSaveSlots.$.aspectRatio": req.body.aspectRatio,
		"aiSaveSlots.$.model": req.body.model,
		"aiSaveSlots.$.loras": req.body.loras,
		"aiSaveSlots.$.lora_strengths": req.body.lora_strengths,
		"aiSaveSlots.$.steps": req.body.steps,
		"aiSaveSlots.$.quantity": req.body.quantity,
		"aiSaveSlots.$.cfg": req.body.cfg,
		"aiSaveSlots.$.seed": req.body.seed
	})

	res.send({
		success: 'Updated'
	})

})

app.get('/ai-saves-get', async function(req, res) {

	userProfile = await userProfileSchema.findOne({
		accountId: req.session.accountId
	})

	if (userProfile == null) {
		res.send({
			error: 'User profile not found'
		})
		return
	}

	res.send({
		aiSaveSlots: userProfile.aiSaveSlots
	})

})

app.post('/ai-save-delete/', async function(req, res) {

	userProfile = await userProfileSchema.findOne({
		accountId: req.session.accountId
	})

	if (userProfile == null) {
		res.send({
			error: 'User profile not found'
		})
		return
	}

	// delete the specific array item from the userprofile.aiSaveSlots array
	saveSlotId = req.body.saveSlotId
	await userProfileSchema.findOneAndUpdate({
		accountId: req.session.accountId
	}, {
		$pull: {
			aiSaveSlots: {
				saveSlotId: saveSlotId
			}
		}
	})
	res.send({
		success: 'Deleted'
	})
})

app.get('/ai', async function(req, res) {
	res.redirect('/')
})


const userBooruSchema = require('./schemas/userBooruSchema.js');
const userBooruTagsSchema = require('./schemas/userBooruTagsSchema.js');

let booruSearchScript = fs.readFileSync('./scripts/booru-search.js', 'utf8')

setInterval(() => {
	booruSearchScript = fs.readFileSync('./scripts/booru-search.js', 'utf8')
}, 15000)



let booruFolder = "E:/JSCammie/booruImages/"


app.get('/booru/post/:booru_id', async function(req, res) {
	booru_id = req.param('booru_id')

	let foundBooruImage = await userBooruSchema.findOne({
		booru_id: booru_id
	})

	if (foundBooruImage == null) {
		res.redirect('/booru/')
		return
	}

	// find the user profile:
	let userProfile = await userProfileSchema.findOne({
		accountId: req.session.accountId
	})

	let postProfile = await userProfileSchema.findOne({
		accountId: foundBooruImage.account_id
	})

	let foundBooruImages = await userBooruSchema.aggregate([{
			$match: {
				account_id: foundBooruImage.account_id
			}
		},
		{
			$group: {
				_id: "$safety",
				count: {
					$sum: 1
				}
			}
		}
	])
	let ratings = {
		sfw: false,
		suggestive: false,
		nsfw: false
	}
	foundBooruImages.forEach(image => {
		if (image._id == "sfw") {
			ratings.sfw = true
		} else if (image._id == "suggestive") {
			ratings.suggestive = true
		} else if (image._id == "nsfw") {
			ratings.nsfw = true
		}
	})
	postProfile.ratings = Object.keys(ratings).filter(key => ratings[key]).join(',')
	postProfile.ratings = postProfile.ratings.replace(/,/g, '/')
	postProfile.ratings = `(${postProfile.ratings} Account)`



	res.render('booru/post', {
		session: req.session,
		booruImage: foundBooruImage,
		booruSearchScript,
		userProfile,
		postProfile
	})

})

function splitTags(tags) {
	// make all the tags lowercase:
	tags = tags.map(tag => tag.toLowerCase())

	// remove any html tags:
	tags = tags.map(tag => tag.replace(/<.*?>/g, ''))

	// remove any brackets:
	tags = tags.map(tag => tag.replace(/[()]/g, ''))

	// trim the front and back of the tags:
	tags = tags.map(tag => tag.trim())

	tags = tags.map(tag => tag.replace(/ /g, '_'))
	// remove any back slashes:
	tags = tags.map(tag => tag.replace(/\\/g, ''))

	// remote the conent of tags inbetween <>:
	tags = tags.map(tag => tag.replace(/<.*?>/g, ''))

	// remove any numbers after a colon, IF there is a colon:
	tags = tags.map(tag => tag.replace(/:\d+/g, ''))

	// remove any empty tags:
	tags = tags.filter(tag => tag !== "")
	return tags
}

app.get('/booru/', async function(req, res) {
	search = req.param('search') || ""
	page = req.param('page') || 1
	safety = req.param('safety') || ["sfw"]
	sort = req.param('sort') || "trending"

	try {

		totalPerPage = 48

		// make trending ago 2 days:
		let trendingAgo = Date.now() - (3 * 24 * 60 * 60 * 1000)

		// add the params to the url if they are not already there:
		if (!req.url.includes('?')) {
			res.redirect(`/booru/?search=${search}&page=${page}&safety=${safety}`)
			return
		}

		// if the rating is not an array, make it an array:
		// example output of safety: na,sfw,suggestive,nsfw
		if (!Array.isArray(safety)) {
			safety = safety.split(',')
		}

		skip = (page - 1) * totalPerPage

		if (typeof(skip) !== 'number') {
			skip = 0
		}

		let booruImages = []

		console.log(`search: "${search}", safety: "${safety}", sort: "${sort}"`)

		if (search.includes(' ')) {
			search = search.split(' ')
		} else if (search.includes(',')) {
			search = search.split(',')
		} else {
			search = [search]
		}

		if (search == ",") {
			search = ""
		}

		if (search == "") {
			if (sort == "recent") {
				booruImages = await userBooruSchema.find({
					safety: {
						$in: safety
					}
				}).sort({
					timestamp: -1
				}).skip(skip).limit(totalPerPage)
			} else if (sort == "votes") {
				booruImages = await userBooruSchema.aggregate([{
						$match: {
							safety: {
								$in: safety
							}
						}
					},
					{
						$addFields: {
							votes: {
								$subtract: [{
									$size: "$upvotes"
								}, {
									$size: "$downvotes"
								}]
							}
						}
					},
					{
						$sort: {
							votes: -1,
							_id: 1
						}
					},
					{
						$skip: skip
					},
					{
						$limit: totalPerPage
					}
				])
			} else if (sort == "trending") {

				booruImages = await userBooruSchema.aggregate([{
						$match: {
							safety: {
								$in: safety
							}
						}
					}, // Only filter by safety
					{
						$addFields: {
							recentVoteCount: {
								$subtract: [
									{
										$size: {
											$filter: {
												input: "$upvotes",
												as: "vote",
												cond: {
													$gt: ["$$vote.timestamp", trendingAgo]
												}
											}
										}
									},
									{
										$size: {
											$filter: {
												input: "$downvotes",
												as: "vote",
												cond: {
													$gt: ["$$vote.timestamp", trendingAgo]
												}
											}
										}
									}
								]
							},
							votes: {
								$subtract: [
									{
										$size: {
											$filter: {
												input: "$upvotes",
												as: "vote",
												cond: {
													$gt: ["$$vote.timestamp", trendingAgo]
												}
											}
										}
									},
									{
										$size: {
											$filter: {
												input: "$downvotes",
												as: "vote",
												cond: {
													$gt: ["$$vote.timestamp", trendingAgo]
												}
											}
										}
									}
								]
							}
						}
					},
					{
						$sort: {
							recentVoteCount: -1,
							votes: -1,
							_id: 1
						}
					}, // Sort by recent votes, then total votes
					{
						$skip: skip
					},
					{
						$limit: totalPerPage
					}
				])

			}



			totalImages = await userBooruSchema.aggregate([{
					$match: {
						safety: {
							$in: safety
						}
					}
				},
				{
					$count: 'count'
				}
			]);


			if (totalImages.length == 0) {
				totalImages = 0
			} else {
				totalImages = totalImages[0].count
			}
		} else {

			searchTags = splitTags(search);

			// Build the regex for positive tags
			let regex = searchTags.map(tag => `(?=.*${tag})`).join('');
			// Remove any backslashes
			regex = regex.replace(/\\/g, '');

			let positiveTags = searchTags.filter(tag => !tag.startsWith('-')); // Positive tags (without '-')

			let allFoundBooruIds = [];

			// Retrieve booru_ids for positive tags (if there are any positive tags)
			const promises = positiveTags.map(async (tag) => {
				let foundTag = await userBooruTagsSchema.findOne({
					tag: tag
				});
				if (foundTag !== null) {
					return foundTag.booru_ids; // return booru_ids for the found tag
				}
				return [];
			});

			const allFoundBooruIdsArrays = await Promise.all(promises);

			// Filter to get only booru_ids that appear in all arrays (if there are any positive tags)
			let allBooruIds = allFoundBooruIdsArrays.length > 0 ? allFoundBooruIdsArrays.reduce((acc, val) => {
				if (!acc.length || !val.length) return [];
				return acc.filter(x => val.includes(x)); // Keep only common booru_ids
			}, allFoundBooruIdsArrays[0]) : []; // If no positive tags, start with an empty array

			// Now handle minus tags (even if no positive tags)
			let minusBooruIds = [];

			// If there are minus tags (e.g., '-cat')
			if (searchTags.some(tag => tag.startsWith('-'))) {
				// Extract the tags without the leading '-'
				let minusTags = searchTags.filter(tag => tag.startsWith('-')).map(tag => tag.slice(1));
				minusTags = splitTags(minusTags); // Process split tags if necessary

				if (minusTags.length > 0) {
					const minusPromises = minusTags.map(async (tag) => {
						let foundTag = await userBooruTagsSchema.findOne({ tag: tag });
						return foundTag ? foundTag.booru_ids : []; // Return booru_ids for minus tags
					});

					const minusFoundBooruIdsArrays = await Promise.all(minusPromises);

					// Flatten the array of arrays and eliminate duplicates
					minusBooruIds = Array.from(new Set(minusFoundBooruIdsArrays.flat())); // Ensure unique booru_ids
				}
			}

			// Now decide how to query the database based on whether there are positive or negative tags
			if (sort == "recent") {
				// If there are positive tags, find booru_ids that match the positive tags and exclude the ones with negative tags
				if (allBooruIds.length > 0) {
					booruImages = await mongolib.aggregateSchemaDocuments("userBooru", [
						{
							$match: {
								booru_id: {
									$in: allBooruIds, // Include images with positive tags
									$nin: minusBooruIds // Exclude images with negative tags
								},
								safety: {
									$in: safety // Include safety filters
								}
							}
						},
						{
							$sort: {
								timestamp: -1 // Sort by timestamp, most recent first
							}
						},
						{
							$skip: skip // Pagination: skip the first `skip` number of results
						},
						{
							$limit: totalPerPage // Pagination: limit to `totalPerPage` results
						}
					]);
				} else {
					// If there are no positive tags, only use the negative tags to filter out posts
					booruImages = await mongolib.aggregateSchemaDocuments("userBooru", [
						{
							$match: {
								booru_id: {
									// Include all images, but exclude the ones with negative tags
									$nin: minusBooruIds
								},
								safety: {
									$in: safety // Include safety filters
								}
							}
						},
						{
							$sort: {
								timestamp: -1 // Sort by timestamp, most recent first
							}
						},
						{
							$skip: skip // Pagination: skip the first `skip` number of results
						},
						{
							$limit: totalPerPage // Pagination: limit to `totalPerPage` results
						}
					]);
				}
			} else if (sort == "votes") {
				if (allBooruIds.length > 0) {
					booruImages = await userBooruSchema.aggregate([{
						$match: {
							booru_id: {
								$in: allBooruIds,
								$nin: minusBooruIds
							},
							safety: {
								$in: safety
							}
						}
					}, {
						$addFields: {
							votes: {
								$subtract: [{
									$size: "$upvotes"
								}, {
									$size: "$downvotes"
								}]
							}
						}
					}, {
						$sort: {
							votes: -1,
							timestamp: 1
						}
					}, {
						$skip: skip
					}, {
						$limit: totalPerPage
					}])
				} else {
					booruImages = await userBooruSchema.aggregate([{
						$match: {
							booru_id: {
								$nin: minusBooruIds
							},
							safety: {
								$in: safety
							}
						}
					}, {
						$addFields: {
							votes: {
								$subtract: [{
									$size: "$upvotes"
								}, {
									$size: "$downvotes"
								}]
							}
						}
					}, {
						$sort: {
							votes: -1,
							timestamp: 1
						}
					}, {
						$skip: skip
					}, {
						$limit: totalPerPage
					}])
				}
			} else if (sort == "trending") {
				if (allBooruIds.length > 0) {

					booruImages = await mongolib.aggregateSchemaDocuments("userBooru", [
						{
							$match: {
								booru_id: {
									$in: allBooruIds,
									$nin: minusBooruIds
								},
								safety: {
									$in: safety
								}
							}
						}, // Only filter by safety
						{
							$addFields: {
								recentVoteCount: {
									$subtract: [
										{
											$size: {
												$filter: {
													input: "$upvotes",
													as: "vote",
													cond: {
														$gt: ["$$vote.timestamp", trendingAgo]
													}
												}
											}
										},
										{
											$size: {
												$filter: {
													input: "$downvotes",
													as: "vote",
													cond: {
														$gt: ["$$vote.timestamp", trendingAgo]
													}
												}
											}
										}
									]
								},
								votes: {
									$subtract: [
										{
											$size: {
												$filter: {
													input: "$upvotes",
													as: "vote",
													cond: {
														$gt: ["$$vote.timestamp", trendingAgo]
													}
												}
											}
										},
										{
											$size: {
												$filter: {
													input: "$downvotes",
													as: "vote",
													cond: {
														$gt: ["$$vote.timestamp", trendingAgo]
													}
												}
											}
										}
									]
								}
							}
						},
						{
							$sort: {
								recentVoteCount: -1,
								votes: -1,
								_id: 1
							}
						}, // Sort by recent votes, then total votes
						{
							$skip: skip
						},
						{
							$limit: totalPerPage
						}
					])
				} else {
					booruImages = await mongolib.aggregateSchemaDocuments("userBooru", [
						{
							$match: {
								booru_id: {
									$nin: minusBooruIds
								},
								safety: {
									$in: safety
								}
							}
						}, // Only filter by safety
						{
							$addFields: {
								recentVoteCount: {
									$subtract: [
										{
											$size: {
												$filter: {
													input: "$upvotes",
													as: "vote",
													cond: {
														$gt: ["$$vote.timestamp", trendingAgo]
													}
												}
											}
										},
										{
											$size: {
												$filter: {
													input: "$downvotes",
													as: "vote",
													cond: {
														$gt: ["$$vote.timestamp", trendingAgo]
													}
												}
											}
										}
									]
								},
								votes: {
									$subtract: [
										{
											$size: {
												$filter: {
													input: "$upvotes",
													as: "vote",
													cond: {
														$gt: ["$$vote.timestamp", trendingAgo]
													}
												}
											}
										},
										{
											$size: {
												$filter: {
													input: "$downvotes",
													as: "vote",
													cond: {
														$gt: ["$$vote.timestamp", trendingAgo]
													}
												}
											}
										}
									]
								}
							}
						},
						{
							$sort: {
								recentVoteCount: -1,
								votes: -1,
								_id: 1
							}
						}, // Sort by recent votes, then total votes
						{
							$skip: skip
						},
						{
							$limit: totalPerPage
						}
					])
				}
			}


			totalImages = await userBooruSchema.aggregate([{
					$match: {
						booru_id: {
							$in: allBooruIds
						},
						safety: {
							$in: safety
						}
					}
				},
				{
					$count: 'count'
				}
			]);

			if (totalImages.length == 0) {
				totalImages = 0
			} else {
				totalImages = totalImages[0].count
			}

		}

		// get the total count of the pages:
		totalPages = Math.ceil(totalImages / totalPerPage)

		let userProfile = await userProfileSchema.findOne({
			accountId: req.session.accountId
		})

		if (req.session.loggedIn) {
			res.render('booru/home', {
				session: req.session,
				booruImages: booruImages,
				userProfile: userProfile,
				booruSearchScript: booruSearchScript,
				totalPages: totalPages
			});
			return
		} else {
			res.render('booru/home', {
				session: req.session,
				booruImages: booruImages,
				userProfile: userProfile,
				booruSearchScript: booruSearchScript,
				totalPages: totalPages
			});
		}

	} catch (error) {
		console.log(`Error loading tags data: ${error}`);
		res.status(500).send('Error loading booru tags data');
	}

	

})

app.get('/recounttags', async function(req, res) {

	let tags = await userBooruTagsSchema.find()

	for (const tag of tags) {
		let newCount = tag.booru_ids.length
		newCount = newCount.toString()

		await userBooruTagsSchema.findOneAndUpdate({
			tag: tag.tag
		}, {
			count: newCount
		})
	}

	res.send({
		status: "success"
	})
})

app.post('/tags-autocomplete', async function(req, res) {
	try {

		let isMinus = false

		// if there is a minus at the start then remove it

		// let tags = await userBooruTagsSchema.find().sort({count: -1})
		// count is a string so use aggregate to convert it to a number, then sort by count, also limit to 10:
		let lastWord = req.body.lastWord

		if (lastWord.startsWith('-')) {
			isMinus = true
			lastWord = lastWord.slice(1)
		}

		let tags = await userBooruTagsSchema.aggregate([{
				$match: {
					tag: {
						$regex: lastWord,
						$options: 'i'
					} // Filters tags that contain the lastWord (case insensitive)
				}
			},
			{
				$addFields: {
					count: {
						$toInt: "$count"
					}
				}
			},
			{
				$sort: {
					count: -1
				}
			},
			{
				$limit: 10
			}
		]);

		
		if (isMinus) {
			for (const tag of tags) {
				tag.tag = `-${tag.tag}`
			}
		}


		res.send({
			tags: tags
		})
	} catch (error) {
		console.log(`Error getting tags: ${error}`);
		res.status(500).send('Error getting tags');
	}
})

he = require('he')

app.post('/create-booru-image', async function(req, res) {
	try {

		data = req.body

		// check if the user account exists:
		let userProfile = await userProfileSchema.findOne({
			accountId: req.session.accountId
		})

		if (userProfile == null) {
			res.send({
				status: "error",
				message: "User not found"
			})
			return
		}

		if (userProfile.booruPostBanned === true) {
			res.send({
				status: "error",
				message: `User is banned from posting to the booru due to: '${userProfile.booruPostBanReason}'`
			})
			return
		}


		// if the user has posted more than 10 images in the last 24 hours, dont allow them to post:
		let twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000)

		let twentyFourHourImageCount = await userBooruSchema.countDocuments({
			account_id: req.session.accountId,
			timestamp: {
				$gt: twentyFourHoursAgo
			}
		})

		if (twentyFourHourImageCount == null || twentyFourHourImageCount == undefined || twentyFourHourImageCount == NaN) {
			twentyFourHourImageCount = 0
		}

		if (twentyFourHourImageCount >= 25) {

			res.send({
				status: "error",
				message: "You have posted more than 25 images in the last 24 hours"
			})
			return
		}


		// check if the folder for the user exists:
		if (!fs.existsSync(`${booruFolder}/${req.session.accountId}/`)) {
			fs.mkdirSync(`${booruFolder}/${req.session.accountId}/`, {
				recursive: true
			});
		}

		let nextImageId = BigInt(Date.now());

		let image_url = data.image_url // the filepath for the png image E:/JSCammie/imagesHistory/

		// replace the http:\\www.jscammie.com\\ at the start:
		image_url = image_url.replace("http://www.jscammie.com/", "")

		// load the image from disk:
		let image = fs.readFileSync(image_url)

		let newImageUrlBase = `booruImages/${req.session.accountId}/${nextImageId}.png`

		// save the image to the booru folder:
		fs.writeFileSync(newImageUrlBase, image)

		// split the prompt into an array of tags, first, split on commas removing any spaces:

		tags = data.prompt

		tags = tags.split(',').map(tag => tag.trim())

		tags = splitTags(tags)

		// remove any tag with "username" in it:
		tags = tags.filter(tag => !tag.includes("username"))

		// tags.push(`${userProfile.username}-username`)

		// get all accounts that have that username, then sort them by timestamp, the oldest one gets username-username, the rest get username-username-1, username-username-2, etc:

		// timestamp is a string like this: "1729524416544", its the same as Date.now() but as a string, make sure it sorts correctly with the oldest having the lowest timestamp:

		let accountsWithUsername = await mongolib.aggregateSchemaDocuments("userProfile", [{ $match: { username: userProfile.username } }, { $sort: { timestamp: 1 } }])
		let usernameCount = 0
		for (const account of accountsWithUsername) {
			if (account.accountId == req.session.accountId) {
				break
			}
			usernameCount++
		}

		if (usernameCount > 0) {
			tags.push(`${userProfile.username}-username-${usernameCount}`)
		} else {
			tags.push(`${userProfile.username}-username`)
		}

		for (const tag of tags) {
			// check if the tag exists in the userBooruTagsSchema:
			let foundTag = await userBooruTagsSchema.findOne({
				tag: tag
			})

			if (foundTag == null) {
				newCount = BigInt(1)
				newCount = newCount.toString()
			} else {
				newCount = BigInt(foundTag.count) + BigInt(1)
				newCount = newCount.toString()
			}

			await userBooruTagsSchema.findOneAndUpdate({
				tag: tag
			}, { // count is a string, make sure to convert it to a BigInt before incrementing, then back:
				tag: tag,
				count: newCount,
				$push: {
					booru_ids: `${req.session.accountId}-${nextImageId}`
				},
			}, {
				upsert: true
			})
		}

		// convert any broken text, for example &#39; to ', etc:
		data.prompt = he.decode(data.prompt)
		data.negative_prompt = he.decode(data.negative_prompt)

		// Prepare the new booru image document
		let newBooruImage = {
			booru_id: `${req.session.accountId}-${nextImageId}`,
			account_id: req.session.accountId,
			image_id: BigInt(nextImageId),
			prompt: data.prompt,
			negative_prompt: data.negative_prompt,
			model: data.model,
			aspect_ratio: data.aspect_ratio,
			loras: data.loras,
			lora_strengths: data.lora_strengths,
			steps: data.steps,
			cfg: data.cfg,
			seed: data.seed,
			content_url: `http://www.jscammie.com/${newImageUrlBase}`,
			safety: "na",
			timestamp: Date.now(),
		};



		// Insert the new booru image document into the database
		await userBooruSchema.create(newBooruImage);

		// set the userHistorySchema to have uploadedToBooru as true, use image_url without the .png as the image_id and the account_id:
		await userHistorySchema.findOneAndUpdate({
			image_url: data.image_url
		}, {
			uploadedToBooru: true
		})

		res.send({
			status: "success",
			message: "Booru image created",
			booru_id: `${req.session.accountId}-${nextImageId}`
		})

	} catch (error) {
		console.log(`Error creating booru image: ${error}`);
		res.status(500).send('Error creating booru image');
	}
})

app.post('/booru/setRating/', async function(req, res) {

	try {

		booru_id = req.body.booru_id
		rating = req.body.rating

		let foundBooruImage = await userBooruSchema.findOne({
			booru_id: booru_id
		})

		if (foundBooruImage == null) {
			res.send({
				status: "error",
				message: "Booru image not found"
			})
			return
		}

		let userProfile = await userProfileSchema.findOne({
			accountId: req.session.accountId
		})

		let creatorProfile = await userProfileSchema.findOne({
			accountId: foundBooruImage.account_id
		})

		// if the user is not logged in, send them back to the previous page:
		if (!req.session.loggedIn) {
			res.send({
				status: "error",
				message: "User is not logged in"
			})
			return
		}

		// check if the user has badges.moderator:
		if (userProfile.badges?.moderator !== true) {
			res.send({
				status: "error",
				message: "User does not have permission to set the rating"
			})
			return
		}

		if (foundBooruImage.safety == "na") {
			await mongolib.modifyUserCredits(creatorProfile.accountId, 50, '+', `Your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a> was rated ${rating.toUpperCase()}`)
			await mongolib.modifyUserExp(creatorProfile.accountId, 50, '+')
			if (creatorProfile.settings?.notification_booruRating == true || creatorProfile.settings?.notification_booruRating == undefined) {
				await mongolib.createUserNotification(creatorProfile.accountId, `Your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a> was rated ${rating.toUpperCase()}`, 'booru')
			}
			// fire a webhook to the discord.js bot running on localhost:
			let webhookData = {
				accountId: creatorProfile.accountId,
				username: creatorProfile.username,
				booru_id: booru_id,
				rating: rating,
				booruUrl: `https://www.jscammie.com/booru/post/${booru_id}`
			}

			// send the webhook to the bot:
			await axios.post('http://127.0.0.1:3040/booruRating', webhookData)

		}

		await userBooruSchema.findOneAndUpdate({
			booru_id: booru_id
		}, {
			safety: rating
		})

		res.send({
			status: "success",
			message: "Rating set"
		})
	
	} catch(error) {
		console.log(`Error setting rating: ${error}`);
		res.status(500).send('Error setting rating');
	}

})

// <a href="/booru/delete/${value.booru_id}">Delete</a>
app.get('/booru/delete/:booru_id', async function(req, res) {
	booru_id = req.param('booru_id')

	let foundBooruImage = await userBooruSchema.findOne({
		booru_id: booru_id
	})

	let userProfile = await userProfileSchema.findOne({
		accountId: req.session.accountId
	})

	if (foundBooruImage == null) {
		res.send({
			status: "error",
			message: "Booru image not found"
		})
		return
	}

	// check if the user either owns the image, or has badges.moderator:
	if (foundBooruImage.account_id !== req.session.accountId && userProfile.badges?.moderator !== true) {
		res.send({
			status: "error",
			message: "User does not own the image"
		})
		return
	}



	localImage = foundBooruImage.content_url.replace("http://www.jscammie.com/", "")

	// delete the image from the booruImages folder:
	// check if it exists first:
	if (fs.existsSync(localImage)) {
		fs.unlinkSync(localImage)
	}

	// local thumbnail:
	localImage = localImage.replace(".png", "-thumb.png")

	if (fs.existsSync(localImage)) {
		fs.unlinkSync(localImage)
	}

	// delete the image from the userBooruSchema:
	await userBooruSchema.findOneAndDelete({
		booru_id: booru_id
	})

	
	await mongolib.createUserNotification(foundBooruImage.account_id, `Your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a> was deleted`, 'moderation')

	// delete the image from the userBooruTagsSchema:
	// find every booruTagsSchema where the array booru_ids contains the booru_id:
	let foundTags = await userBooruTagsSchema.find({
		booru_ids: booru_id
	})

	for (const tag of foundTags) {
		let newCount = tag.booru_ids.length - 1
		if (newCount == 0 || newCount < 0) {
			await userBooruTagsSchema.findOneAndDelete({
				tag: tag.tag
			})
		} else {
			await userBooruTagsSchema.findOneAndUpdate({
				tag: tag.tag
			}, {
				count: newCount.toString(),
				$pull: {
					booru_ids: booru_id
				}
			})
		}

	}

	res.redirect('back')
})

app.post('/booru/ban/:accountId', async function(req, res) {
	accountId = req.param('accountId')

	let clientProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	if (clientProfile == null) {
		res.send({
			status: "error",
			message: "Client not found"
		})
		return
	}

	if (clientProfile.badges.moderator !== true) {
		res.send({
			status: "error",
			message: "Client is not a moderator"
		})
		return
	}

	let targetProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: accountId
	})

	if (targetProfile == null) {
		res.send({
			status: "error",
			message: "Target not found"
		})
		return
	}

	mongolib.updateSchemaDocumentOnce("userProfile", {
		accountId: accountId
	}, {
		$set: {
			booruPostBanned: true,
			booruPostBanReason: req.body.reason
		}
	})

	// send a notification to the target:
	await mongolib.createUserNotification(accountId, `You have been banned from posting to the booru due to: ${req.body.reason}`, 'moderation')

	res.send({
		status: "success",
		message: "User has been banned from the booru"
	})

})


app.post('/booru/vote', async function(req, res) {
	try {
		let data = req.body
		let vote = data.vote
		let booru_id = data.booru_id
		let account_id = req.session.accountId

		let foundBooruImage = await mongolib.getSchemaDocumentOnce("userBooru", {
			booru_id: booru_id
		})

		if (foundBooruImage == null) {
			res.send({
				status: "error",
				message: "Booru image not found"
			})
			return
		}

		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})
		if (userProfile.status == 'error') {
			res.send({
				status: "error",
				message: "User not found"
			})
			return
		}

		let creatorProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: foundBooruImage.account_id
		})
		if (creatorProfile.status == 'error') {
			res.send({
				status: "error",
				message: "Creator not found"
			})
			return
		}

		// if the voter is the same as the creator, then return an error:
		if (account_id == foundBooruImage.account_id) {
			res.send({
				status: "error",
				message: "User cannot vote on their own post"
			})
			return
		}

		// votes are stored as an array of objects, each object has a accountId and a timestamp:
		// check if the user has already voted on the post:

		creditsToGain = 2

		switch (vote) {
			case 'upvote':
				// check if the user has already upvoted:
				// votes are stored as an array of objects, each object has a accountId and a timestamp:
				if (foundBooruImage.upvotes.some(vote => vote.accountId == account_id)) {
					res.send({
						status: "success",
						message: "User has already upvoted",
						upvotes: foundBooruImage.upvotes.length,
						downvotes: foundBooruImage.downvotes.length
					})
					return
				}
				// check if the user has already downvoted:
				if (foundBooruImage.downvotes.some(vote => vote.accountId == account_id)) {
					// remove the downvote:
					await mongolib.updateSchemaDocumentOnce("userBooru", {
						booru_id: booru_id
					}, {
						$pull: {
							downvotes: {
								accountId: account_id
							}
						}
					})

				} else {

					await mongolib.modifyUserCredits(account_id, creditsToGain, '+', `You Upvoted a <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`)
					await mongolib.modifyUserExp(account_id, 1, '+')

					if (creatorProfile != null) {
						await mongolib.modifyUserCredits(creatorProfile.accountId, creditsToGain, '+', `Someone upvoted your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`)
						await mongolib.modifyUserExp(creatorProfile.accountId, 1, '+')
						if (creatorProfile.settings?.notification_booruVote == true || creatorProfile.settings?.notification_booruVote == undefined) {
							await mongolib.createUserNotification(creatorProfile.accountId, `Someone upvoted your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`, 'booru')
						}
					}

				}
				// add the upvote:
				await mongolib.updateSchemaDocumentOnce("userBooru", {
					booru_id: booru_id
				}, {
					$push: {
						upvotes: {
							accountId: account_id,
							timestamp: Date.now()
						}
					}
				})
				break
			case 'downvote':
				// check if the user has already downvoted:
				if (foundBooruImage.downvotes.some(vote => vote.accountId == account_id)) {
					res.send({
						status: "success",
						message: "User has already downvoted",
						upvotes: foundBooruImage.upvotes.length,
						downvotes: foundBooruImage.downvotes.length
					})
					return
				}
				// check if the user has already upvoted:
				if (foundBooruImage.upvotes.some(vote => vote.accountId == account_id)) {
					// remove the upvote:
					await mongolib.updateSchemaDocumentOnce("userBooru", {
						booru_id: booru_id
					}, {
						$pull: {
							upvotes: {
								accountId: account_id
							}
						}
					})
				}
				// add the downvote:
				await mongolib.updateSchemaDocumentOnce("userBooru", {
					booru_id: booru_id
				}, {
					$push: {
						downvotes: {
							accountId: account_id,
							timestamp: Date.now()
						}
					}
				})
				break
		}

		let newBooruImage = await mongolib.getSchemaDocumentOnce("userBooru", {
			booru_id: booru_id
		})

		res.send({
			status: "success",
			message: "Vote added",
			upvotes: newBooruImage.upvotes.length,
			downvotes: newBooruImage.downvotes.length
		})

	} catch (error) {
		console.log(`Error voting: ${error}`);
		res.status(500).send('Error voting');
	}
})

app.post('/booru/comment/post/:booru_id', async function(req, res) {
	booru_id = req.param('booru_id')

	let foundBooruImage = await mongolib.getSchemaDocumentOnce("userBooru", {
		booru_id: booru_id
	})

	if (foundBooruImage == null) {
		res.send({
			status: "error",
			message: "Booru image not found"
		})
		return
	}

	let comment = req.body.comment

	let foundAccount = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	if (foundAccount == null) {
		res.send({
			status: "error",
			message: "Account not found"
		})
		return
	}

	await mongolib.createSchemaDocument("userBooruComments", {
		commentId: `${req.session.accountId}-${Date.now()}-${booru_id}`,
		booruId: booru_id,
		accountId: req.session.accountId,
		comment: comment,
		timestamp: Date.now()
	})

	let creatorProfile = await userProfileSchema.findOne({
		accountId: foundBooruImage.account_id
	})

	if (creatorProfile.settings?.notification_booruComment == true || creatorProfile.settings?.notification_booruComment == undefined) {
		await mongolib.createUserNotification(foundBooruImage.account_id, `${foundAccount.username} commented on your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`, 'booru')
	}

	res.send({
		status: "success",
		message: "Comment added"
	})
})


app.get('/booru/comment/delete/:commentId', async function(req, res) {
	commentId = req.param('commentId')

	let foundComment = await mongolib.getSchemaDocumentOnce("userBooruComments", {
		commentId: commentId
	})

	if (foundComment == null) {
		res.send({
			status: "error",
			message: "Comment not found"
		})
		return
	}

	let foundAccount = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	if (foundAccount == null) {
		res.send({
			status: "error",
			message: "Account not found"
		})
		return
	}

	if (foundComment.accountId !== req.session.accountId) {
		res.send({
			status: "error",
			message: "Account does not own the comment"
		})
		return
	}

	await mongolib.deleteSchemaDocument("userBooruComments", {
		commentId: commentId
	})

	await mongolib.createUserNotification(foundComment.accountId, `Your comment was deleted`, 'moderation')

	res.send({
		status: "success",
		message: "Comment deleted"
	})
})


app.post('/booru/comment/vote', async function(req, res) {
	let voteType = req.body.vote
	let commentId = req.body.commentId
	let accountId = req.session.accountId

	let foundComment = await mongolib.getSchemaDocumentOnce("userBooruComments", {
		commentId: commentId
	})

	if (foundComment == null) {
		res.send({
			status: "error",
			message: "Comment not found"
		})
		return
	}

	let foundAccount = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: accountId
	})

	if (foundAccount == null) {
		res.send({
			status: "error",
			message: "Account not found"
		})
		return
	}

	if (voteType == "upvote") {
		// check if the user has already upvoted:
		if (foundComment.upvotes.some(vote => vote.accountId == accountId)) {
			// remove the upvote:
			await mongolib.updateSchemaDocumentOnce("userBooruComments", {
				commentId: commentId
			}, {
				$pull: {
					upvotes: {
						accountId: accountId
					}
				}
			})
			res.send({
				status: "success",
				message: "User has already upvoted",
				upvotes: foundComment.upvotes.length,
				downvotes: foundComment.downvotes.length
			})
			return
		}
		// check if the user has already downvoted:
		if (foundComment.downvotes.some(vote => vote.accountId == accountId)) {
			await mongolib.updateSchemaDocumentOnce("userBooruComments", {
				commentId: commentId
			}, {
				$pull: {
					downvotes: {
						accountId: accountId
					}
				}
			})
		}
		// add the upvote:
		await mongolib.updateSchemaDocumentOnce("userBooruComments", {
			commentId: commentId
		}, {
			$push: {
				upvotes: {
					accountId: accountId,
					timestamp: Date.now()
				}
			}
		})
	} else if (voteType == "downvote") {
		// check if the user has already downvoted:
		if (foundComment.downvotes.some(vote => vote.accountId == accountId)) {
			// remove the downvote:
			await mongolib.updateSchemaDocumentOnce("userBooruComments", {
				commentId: commentId
			}, {
				$pull: {
					downvotes: {
						accountId: accountId
					}
				}
			})
			res.send({
				status: "success",
				message: "User has already downvoted",
				upvotes: foundComment.upvotes.length,
				downvotes: foundComment.downvotes.length
			})
			return
		}

		// check if the user has already upvoted:
		if (foundComment.upvotes.some(vote => vote.accountId == accountId)) {
			await mongolib.updateSchemaDocumentOnce("userBooruComments", {
				commentId: commentId
			}, {
				$pull: {
					upvotes: {
						accountId: accountId
					}
				}
			})
		}
		// add the downvote:
		await mongolib.updateSchemaDocumentOnce("userBooruComments", {
			commentId: commentId
		}, {
			$push: {
				downvotes: {
					accountId: accountId,
					timestamp: Date.now()
				}
			}
		})
	}

	let newComment = await mongolib.getSchemaDocumentOnce("userBooruComments", {
		commentId: commentId
	})

	res.send({
		status: "success",
		message: "Vote added",
		upvotes: newComment.upvotes.length,
		downvotes: newComment.downvotes.length
	})

})


app.get('/booru/comment/get/:booru_id', async function(req, res) {
	booru_id = req.param('booru_id')

	let foundBooruImage = await mongolib.getSchemaDocumentOnce("userBooru", {
		booru_id: booru_id
	})

	let foundBooruComments = await mongolib.getSchemaDocuments("userBooruComments", {
		booruId: booru_id
	})

	if (foundBooruImage == null) {
		res.send({
			status: "error",
			message: "Booru image not found"
		})
		return
	}

	let comments = []

	let foundAccounts = []

	for (const comment of foundBooruComments) {
		// found accounts is an array of objects, each object has an accountId, username and profileImg:
		let foundAccount = foundAccounts.find(account => account.accountId == comment.accountId)
		if (foundAccount == undefined) {
			foundAccount = await mongolib.getSchemaDocumentOnce("userProfile", {
				accountId: comment.accountId
			})
			foundAccounts.push(foundAccount)
		}
		comments.push({
			comment: comment.comment,
			commentId: comment.commentId,
			timestamp: comment.timestamp,
			accountId: comment.accountId,
			upvotes: comment.upvotes.length || "0",
			downvotes: comment.downvotes.length || "0",
			username: foundAccount.username,
			profileImg: foundAccount.profileImg || "http://www.jscammie.com/noimagefound.png"
		})
	}

	res.send({
		status: "success",
		comments: comments
	})
})

app.get('/profile/:account_id', async function(req, res) {
	account_id = req.param('account_id')

	let profileProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: account_id
	})

	if (profileProfile == null) {
		res.send({
			status: "error",
			message: "User not found"
		})
		return
	}

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	let userBooru = await userBooruSchema.find({
		account_id: account_id
	})

	res.render('profile', {
		session: req.session,
		profileProfile: profileProfile,
		userProfile: userProfile,
		userBooru: userBooru,
		booruSearchScript: booruSearchScript
	});
})

app.get('/game', async function(req, res) {
	res.render('game', {
		session: req.session
	});
})

app.get('/credits-history', async function(req, res) {
	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	if (userProfile.status == 'error') {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	let creditsHistory = await mongolib.getSchemaDocuments("userCreditsHistory", {
		accountId: req.session.accountId
	})

	if (creditsHistory.status == 'error') {
		res.send({
			status: 'error',
			message: 'User credits history not found'
		})
		return
	}

	res.render('creditshistory', {
		session: req.session,
		userProfile: userProfile,
		creditsHistory: creditsHistory
	});
})

app.post('/get-notifications', async function(req, res) {
	let data = req.body
	// accountId"", notificationsReceived[]

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", { accountId: data.accountId })

	if (userProfile.status == 'error') {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	let receivedNotifications = new Set(data.notificationsReceived);

	// set req.session.notificationsChecked to the current time:
	if (data.popupOpened) {
		req.session.notificationsChecked = Date.now()
	}

	// if the req.session.notificationsChecked is not set, set it to the current time:
	if (!req.session.notificationsChecked) {
		req.session.notificationsChecked = Date.now()
	}
	
	let notifications = await mongolib.aggregateSchemaDocuments("userNotification", [
		{
			$match: {
				accountId: req.session.accountId,
				notificationId: { $nin: Array.from(receivedNotifications) }
			}
		},
		{
			$sort: { timestamp: -1 }
		},
		{ $limit: 30 }
	]);

		// if the notification is older than 7 days, dont send it:
		notifications = notifications.filter(notification => notification.timestamp > req.session.notificationsChecked - 604800000)


		res.send({ status: 'success', notifications: notifications, notificationsChecked: req.session.notificationsChecked })
	})

app.get('/settings', async function(req, res) {
	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	if (userProfile.status == 'error') {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	res.render('settings', {
		session: req.session,
		userProfile: userProfile
	});
})

app.post('/settings/avatar', async (req, res) => {
	try {
		let responseSent = false;

		// Helper function to send a response only once
		const sendResponse = (status, json) => {
			if (!responseSent) {
				responseSent = true;
				res.status(status).json(json);
			}
		};

		// Check if user profile exists
		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		});

		if (userProfile.status === 'error') {
			return sendResponse(404, {
				status: 'error',
				message: 'User not found'
			});
		}

		// Create the directory if it does not exist
		const avatarDir = path.join(__dirname, 'userAvatars');
		if (!fs.existsSync(avatarDir)) {
			fs.mkdirSync(avatarDir, { recursive: true });
		}

		// Buffer to store the first few bytes of the file
		let fileHeaderBuffer = Buffer.alloc(8);
		let headerBytesRead = 0;
		let fileSize = 0;
		const maxSize = 5 * 1024 * 1024; // 5MB

		// Generate a temporary filename
		const tempFilename = `temp-${Date.now()}-${Math.floor(Math.random() * 10)}-${req.session.accountId}.tmp`;
		const tempFilePath = path.join(avatarDir, tempFilename);

		const writeStream = fs.createWriteStream(tempFilePath);

		req.on('data', (chunk) => {
			fileSize += chunk.length;
			if (fileSize > maxSize) {
				writeStream.destroy();
				fs.unlink(tempFilePath, () => {});
				sendResponse(413, {
					status: 'error',
					message: 'File too large'
				});
				return;
			}

			// Only read the first 8 bytes if we haven't already
			if (headerBytesRead < 8) {
				const bytesToRead = Math.min(8 - headerBytesRead, chunk.length);
				chunk.copy(fileHeaderBuffer, headerBytesRead, 0, bytesToRead);
				headerBytesRead += bytesToRead;
			}

			writeStream.write(chunk);
		});

		req.on('end', async () => {
			if (responseSent) return;
			writeStream.end();

			if (fileSize === 0) {
				fs.unlink(tempFilePath, () => {});
				return sendResponse(400, {
					status: 'error',
					message: 'No file uploaded'
				});
			}

			// Determine file type based on file signature
			let fileExtension;
			if (fileHeaderBuffer.toString('hex', 0, 8) === '89504e470d0a1a0a') {
				fileExtension = '.png';
			} else if (fileHeaderBuffer.toString('hex', 0, 2) === 'ffd8') {
				fileExtension = '.jpg';
			} else if (fileHeaderBuffer.toString('hex', 0, 3) === '474946') {
				fileExtension = '.gif';
			} else {
				fs.unlink(tempFilePath, () => {});
				return sendResponse(400, {
					status: 'error',
					message: 'Invalid file type',
					fileHeader: fileHeaderBuffer.toString('hex')
				});
			}

			// Generate the final filename
			const finalFilename = `${req.session.accountId}${fileExtension}`;
			const finalFilePath = path.join(avatarDir, finalFilename);

			// Rename the temp file to the final filename
			fs.rename(tempFilePath, finalFilePath, async (err) => {
				if (err) {
					console.log(`Error renaming avatar file: ${err}`);
					return sendResponse(500, {
						status: 'error',
						message: 'Error saving avatar'
					});
				}

				// Update the user's profile image URL in the database
				const avatarUrl = `https://www.jscammie.com/userAvatars/${finalFilename}`;
				await mongolib.updateSchemaDocumentOnce("userProfile", {
					accountId: req.session.accountId
				}, {
					profileImg: avatarUrl
				});

				sendResponse(200, {
					status: 'success',
					message: 'Avatar uploaded successfully',
					avatarUrl
				});
			});
		});

		writeStream.on('error', (err) => {
			console.log(`Error writing avatar file: ${err}`);
			sendResponse(500, {
				status: 'error',
				message: 'Error saving avatar'
			});
		});

	} catch (error) {
		console.log(`Error uploading avatar: ${error}`);
		res.status(500).json({
			status: 'error',
			message: 'Unexpected error'
		});
	}
});


app.post('/settings/update', async function(req, res) {

	try {

		let data = req.body

		console.log(data)

		let settingWanted = data.setting
		let settingValue = data.value

		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		if (userProfile.status == 'error') {
			res.send({
				status: "error",
				message: "User not found"
			})
			return
		}

		if (settingWanted == 'user_bio') {
			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$set: {
					'settings.user_bio': settingValue
				}
			})

		} else if (settingWanted.startsWith('toggle_')) {

			let toggleValue = settingValue

			settingWanted = settingWanted.replace('toggle_', '')

			let updateQuery = {};

			console.log(settingWanted)

			// new settings:
			let newSettings = userProfile.settings

			// check if the setting exists:
			if (newSettings[settingWanted] == undefined) {

				res.send({	
					status: "error",
					message: "Setting not found"
				})
				return
			}

			// update the setting:
			newSettings[settingWanted] = toggleValue

			// update the settings in the database:
			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$set: {
					settings: newSettings
				}
			})


			console.log(result)

		} else {
			res.send({
				status: "error",
				message: "Setting not found"
			})
		}

		res.send({
			status: "success",
			message: "Settings updated"
		})

	
	} catch(error) {
		console.log(`Error updating settings: ${error}`);
		res.send({
			status: "error",
			message: "Error updating settings"
		})
	}
	
})



app.post('/modify-user-credits', async function(req, res) {

	let data = req.body

	// if the accountId is not "550239177837379594/1039574722163249233" then return an error:
	accountsAllowed = ["550239177837379594", "1039574722163249233"]

	if (!accountsAllowed.includes(req.session.accountId)) {
		res.send({
			status: "error",
			message: "User not found"
		})
		return
	}

	let accountId = data.accountId
	let amount = data.credits

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: accountId
	})

	if (userProfile.status == 'error') {
		res.send({
			status: "error",
			message: "User not found"
		})
		return
	}

	let operation = data.action

	if (operation == '+') {
		await mongolib.modifyUserCredits(accountId, amount, '+', data.reason)
		await mongolib.createUserNotification(accountId, `You have been given ${amount} credits for: ${data.reason}`, 'moderation')
	} else if (operation == '-') {
		await mongolib.modifyUserCredits(accountId, amount, '-', data.reason)
		await mongolib.createUserNotification(accountId, `You have lost ${amount} credits for: ${data.reason}`, 'moderation')
	}

	res.send({
		status: "success",
		message: "User credits modified"
	})
})

app.get('/modify-user-credits', async function(req, res) {

	res.render('modifyusercredits', {
		session: req.session
	});

})


app.get('/paypal-shop', async function(req, res) {

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	if (userProfile.status == 'error') {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	res.render('paypal-shop', {
		session: req.session,
		userProfile: userProfile
	});

})


// Load sensitive data from environment variables
const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_API = process.env.PAYPAL_API || 'https://api-m.paypal.com'; // Use live API URL

const creditOptions = [
    { credits: 15000, price: 5 },
	{ credits: 37500, price: 10 },
	{ credits: 95000, price: 20 }
];

// Payment Verification Route (Manually Triggered after capture)
app.post('/payment/verify', async (req, res) => {
    const { orderId, accountId, credits, amount } = req.body;

    try {
        const selectedOption = creditOptions.find(option => option.credits === credits && option.price === amount);
        if (!selectedOption) {
            return res.status(400).send('Invalid credits or amount provided.');
        }

        // Verify the order with PayPal
        const auth = Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64');
        const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}`, {
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });

        const order = await response.json();
        if (
            order.status === 'COMPLETED' &&
            order.purchase_units[0].amount.value === selectedOption.price.toFixed(2)
        ) {
            // Add credits to the user's account
            await mongolib.modifyUserCredits(accountId, selectedOption.credits, '+', `Purchased ${selectedOption.credits} credits for $${selectedOption.price.toFixed(2)}`);
            await mongolib.createUserNotification(accountId, `You have purchased ${selectedOption.credits} credits for $${selectedOption.price.toFixed(2)}`, 'payment');
            res.status(200).send('Payment verified and credits added.');
        } else {
            res.status(400).send('Payment verification failed.');
        }
    } catch (error) {
        console.error('Error verifying PayPal payment:', error);
        res.status(500).send('Internal server error.');
    }
});

// Webhook Listener for PayPal Events
app.post('/payment/webhook', async (req, res) => {
    const event = req.body;

    // Log the webhook event for debugging
    console.log('Webhook Event:', event);

    try {
        if (event.event_type === 'PAYMENT.SALE.COMPLETED') {
            const { resource } = event;
            const orderId = resource.id;
            const accountId = resource.custom_id;
            const credits = parseInt(resource.custom_id.split('-')[1]); // Extract credits from custom_id

            // Add credits to the user's account
            await mongolib.modifyUserCredits(accountId, credits, '+', `Purchased ${credits} credits via PayPal`);
            await mongolib.createUserNotification(accountId, `You have successfully purchased ${credits} credits.`, 'payment');

            res.status(200).send('Webhook processed.');
        } else {
            res.status(400).send('Unhandled event type.');
        }
    } catch (error) {
        console.error('Error processing PayPal webhook:', error);
        res.status(500).send('Internal server error.');
    }
});


app.get('/redeem-code', async function(req, res) {

	try {

		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		if (userProfile.status == 'error') {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		res.render('redeem-code', {
			session: req.session,
			userProfile: userProfile
		});


	} catch(error) {
	
		console.log(`Error redeeming code: ${error}`);
		res.status(500).send('Error redeeming code');

	}

})

app.post('/redeem-code', async function(req, res) {

	try {

		let data = req.body

		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		if (userProfile.status == 'error') {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		let code = data.code

		let foundCode = await mongolib.getSchemaDocumentOnce("userRedeem", {
			code: code
		})

		if (foundCode.status == 'error') {
			res.send({
				status: 'error',
				message: 'Code not found'
			})
			return
		}

		if (foundCode.oneTimeUse == true && foundCode.usersRedeemed.includes(req.session.accountId)) {
			res.send({
				status: 'error',
				message: 'Code is one time use only'
			})
			return	
		}

		if (foundCode.expires < Date.now()) {
			res.send({
				status: 'error',
				message: 'Code expired'
			})
			return
		}

		if (foundCode.redeemCount >= foundCode.maxRedeems) {
			res.send({
				status: 'error',
				message: 'Code max redeems reached'
			})
			return
		}	

		// add the user to the usersRedeemed array:
		await mongolib.updateSchemaDocumentOnce("userRedeem", {
			code: code
		}, {
			$push: {
				usersRedeemed: req.session.accountId
			}
		})

		let nextRedeemCount = foundCode.redeemCount + 1

		await mongolib.updateSchemaDocumentOnce("userRedeem", {
			code: code
		}, {
			redeemCount: nextRedeemCount
		})

		if (foundCode.type == "credits") {
			await mongolib.modifyUserCredits(req.session.accountId, Number(foundCode.variable), '+', `Redeemed code: ${code}`)
		} else if (foundCode.type == "badge") {
			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$set: {
					[`badges.${foundCode.variable}`]: true
				}
			})
		}

		res.send({
			status: 'success',
			message: 'Code redeemed'
		})

	} catch(error) {

		console.log(`Error redeeming code: ${error}`);
		res.status(500).send('Error redeeming code');

	}

})


app.get('/create-redeem-code', async function(req, res) {
	try {
		
		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		if (userProfile.status == 'error') {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		if (userProfile.accountId !== "1039574722163249233") {
			res.send({
				status: 'error',
				message: 'User not allowed to create redeem codes'
			})
			return
		}

		res.render('create-redeem-code', {
			session: req.session,
			userProfile: userProfile
		});
	} catch(error) {
		console.log(`Error creating redeem code: ${error}`);
		res.status(500).send('Error creating redeem code');
	}
})


app.post('/create-redeem-code', async function(req, res) {
	try {
		let data = req.body

		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		if (userProfile.status == 'error') {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		if (userProfile.accountId !== "1039574722163249233") {
			res.send({
				status: 'error',
				message: 'User not allowed to create redeem codes'
			})
			return
		}

		let code = data.code
		let type = data.type
		let variable = data.variable
		let maxRedeems = data.maxRedeems
		let expires = data.expires

		let foundCode = await mongolib.getSchemaDocumentOnce("userRedeem", {
			code: code
		})

		if (foundCode.length > 0) {
			res.send({
				status: 'error',
				message: 'Code already exists'
			})
			return
		}

		// ensure expires is a timestamp in unix format:
		if (expires) {
			expires = new Date(expires).getTime()
		}

		let codeObject = {
			code: code,
			type: type,
			variable: variable,
			maxRedeems: maxRedeems,
			redeemCount: 0,
			expires: expires,
			timestamp: String(Date.now())
		}

		let result = await mongolib.createSchemaDocument("userRedeem", {
			...codeObject
		})

		if (result.status == 'error') {
			res.send({
				status: 'error',
				message: 'Error creating redeem code'
			})
			return
		} else {
			res.send({
				status: 'success',
				message: 'Code created'
			})
		}

	} catch(error) {
		console.log(`Error creating redeem code: ${error}`);
		res.send({
			status: 'error',
			message: 'Error creating redeem code: ' + error
		})
	}
})



app.get('/download', async function(req, res) {
	res.render('download', {
		session: req.session
	});
})

	
app.get('/.well-known/pki-validation/BD4ADEC68E8CA80AB663C847A5D5990E.txt', async function(req, res) {
	// send the BD4ADEC68E8CA80AB663C847A5D5990E.txt file:
	res.sendFile(path.join(__dirname, 'BD4ADEC68E8CA80AB663C847A5D5990E.txt'));
})







const http = require('http')
const https = require('https');

// https only enabled when not in DEVELOPMENT mode, as the certificates are not valid for localhost/not in the repo:
if (process.env.DEVELOPMENT !== 'true') {
	const caBundle = fs.readFileSync(process.env.CA_BUNDLE_PATH)
	const caString = caBundle.toString();
	const ca = caString.split('-----END CERTIFICATE-----\r\n').map(cert => cert + '-----END CERTIFICATE-----\r\n')
	ca.pop()
	const cert = fs.readFileSync(process.env.CRT_PATH)
	const key = fs.readFileSync(process.env.PK_PATH)

	let options = {
		cert: cert,
		ca: ca,
		key: key
	};

	const httpsServer = https.createServer(options, app)

	httpsServer.listen(443, () => {
		console.log(`JSCammie listening at https://localhost:443`)
	})

}

const httpServer = http.createServer(app)

httpServer.listen(80, () => {
	console.log(`JSCammie listening at http://localhost:80`)
})