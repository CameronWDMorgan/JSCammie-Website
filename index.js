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
const customFunctions = require('./scripts/ai/calculateCreditsPrice.js')
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

const moderatePrompt = require('./scripts/moderate-prompt.js')


console.log(`Environment: ${process.env.NODE_ENV}`);

const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);

const store = new MongoDBStore({
	uri: process.env.MONGODB_URI,
	collection: 'site-sessions'
});

store.on('error', function (error) {
	console.error(error);
});

// Session middleware
app.use(session({
	store: store,
	secret: `${process.env.SESSION_SECRET}`,
	cookie: {
		maxAge: 1000 * 60 * 60 * 24 * 31
	},
	store: store,
	resave: true,
	saveUninitialized: true
}));


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

async function showMessagePage(res, req, message) {
	res.render('message', {
		message: message,
		session: req.session
	})
}

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
    console.log('Toggle darkmode request received:', req.body);
    
    // using isDarkMode from the request, toggle the darkmode:
    if (req.body.isDarkMode === 'true') {
        req.session.darkmode = true;
    } else {
        req.session.darkmode = false;
    }
    
    console.log('Session darkmode updated to:', req.session.darkmode);
    
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
        // Fetch user details from Discord API
        const discordResponse = await fetch('https://discord.com/api/users/@me', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        if (!discordResponse.ok) {
            console.error(`Failed to fetch Discord user: ${discordResponse.statusText}`);
            return res.status(discordResponse.status).send({
                status: 'error',
                message: `Discord API error: ${discordResponse.statusText}`
            });
        }

        const discordUser = await discordResponse.json();

        if (!discordUser.username || !discordUser.id) {
            console.error(`Invalid Discord user data received: ${JSON.stringify(discordUser)}`);
            return res.status(400).send({
                status: 'error',
                message: 'Invalid Discord user data'
            });
        }

        const newProfile = {
            accountId: discordUser.id,
            discordId: discordUser.id,
            username: discordUser.username,
            timestamp: Date.now(),
        };

        // Check if user already exists
        let existingProfile = await userProfileSchema.findOne({ accountId: discordUser.id });

        if (!existingProfile) {
            console.log(`Creating new user profile: ${JSON.stringify(newProfile)}`);
            const createResult = await mongolib.createSchemaDocument("userProfile", newProfile);
            if (createResult.status === 'error') {
                console.error(`Error creating user profile: ${createResult.message}`);
                return res.status(500).send(createResult);
            }
        } else {
            console.log(`Updating existing user profile: ${discordUser.id}`);
            await mongolib.updateSchemaDocumentOnce(
                "userProfile",
                { discordId: discordUser.id },
                { accountId: discordUser.id, discordId: discordUser.id }
            );
        }

        // Store user session information
        req.session.accountId = discordUser.id;
        req.session.loggedIn = true;

		res.send({
			status: 'success',
			message: 'User logged in',
			account_id: discordUser.id,
			username: discordUser.username
		});

    } catch (error) {
        console.error(`Error receiving token: ${error.message}`);
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

	// if (userProfile == {} || userProfile.accountId != 1039574722163249233) {
	// 	res.status(200).send("Suggestions is currently disabled as it is being re-worked to be better! Please check back later.")
	// }

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

	if (result == null) {
		res.send({
			status: 'error',
			message: 'You do not have enough credits to promote this suggestion'
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

	let currentUser = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: accountId
	})

	if (currentUser == null) {
		res.send({
			status: 'error',
			message: 'User not found'
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

app.post('/update-suggestion-model', async (req, res) => {

	// check if they are logged in:
	if (!req.session.loggedIn) {
		res.redirect('/login')
		return
	}

	let suggestionId = req.body.suggestionId
	let accountId = req.session.accountId

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

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: accountId
	})

	if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	// check if the user is the author of the suggestion, or a owner:
	if (suggestion.accountId !== accountId && userProfile.badges?.owner !== true) {
		res.send({
			status: 'error',
			message: 'You are not the author of this suggestion'
		})
		return
	}

	switch (req.body.model) {
		case 'sd1.5':
			await mongolib.updateSchemaDocumentOnce("userSuggestion", {
				suggestionId: suggestionId
			}, {
				model: 'sd1.5'
			})
			break;
		
		case 'pdxl':
			await mongolib.updateSchemaDocumentOnce("userSuggestion", {
				suggestionId: suggestionId
			}, {
				model: 'pdxl'
			})
			break;
		
		case 'illustrious':
			await mongolib.updateSchemaDocumentOnce("userSuggestion", {
				suggestionId: suggestionId
			}, {
				model: 'illustrious'
			})
			break;
		default:
			res.send({
				status: 'error',
				message: 'Invalid model'
			})
			return
	}

	res.send({
		status: 'success',
		message: `Suggestion model updated to ${req.body.model}`
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

	let model = req.body.model || ""

	let newSuggestion = {
		title: title,
		type: type,
		model: model,
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
	if (userSuggestions.length >= 20) {
		res.send({
			status: 'error',
			message: 'You can only have 20 PENDING suggestions at once, please wait for some to be accepted or rejected to request more!'
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

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: accountId
	})

	if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}


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
	if (suggestion.accountId !== accountId && userProfile.badges?.owner !== true) {
		res.send({
			status: 'error',
			message: 'You are not the author of this suggestion'
		})
		return
	}

	await userSuggestionSchema.findOneAndDelete({
		suggestionId: suggestionId
	})
	await mongolib.createUserNotification(suggestion.accountId, `Your suggestion titled: "${suggestion.title}" was removed.`, 'moderation')

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

	if (suggestion == null) {
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

	console.log(`Suggestion status updated to ${newStatus} from ${suggestion.status}`)

	if (newStatus == 'added') {
		await mongolib.modifyUserCredits(suggestion.accountId, 50, '+', `Suggestion Accepted: "${suggestion.title}"`)
		await mongolib.modifyUserExp(suggestion.accountId, 50, '+')
	}
	
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

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	res.render('suggestions/suggestion', {
		userProfile: userProfile,
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
			showMessagePage(res, req, 'You need to be logged in to view the image history page.');
			return;
		}

		// Redirect to default page if necessary
		if (!req.url.includes('?page=') && !req.url.includes('?search=') && !req.url.includes('&ajax=true')) {
			res.redirect('/image-history?page=1&search=&model=all&sort=newest');
			return;
		}

		// Parse query parameters
		let page = parseInt(req.query.page) || 1;
		let search = req.query.search || '';
		let model = req.query.model || 'all';
		let sort = req.query.sort || 'newest';
		const totalPerPage = 96;
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

		// Determine sort order
		const sortOrder = sort === 'oldest' ? 1 : -1;

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
				$sort: { timestamp: sortOrder, _id: sortOrder }, // Sort by timestamp (and _id as tiebreaker)
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
		if (page > totalPages && totalPages > 0 && !req.query.ajax) {
			res.redirect(`/image-history?page=${totalPages}&search=${encodeURIComponent(search)}&model=${model}&sort=${sort}`);
			return;
		}

		let totalUserImages = await userHistorySchema.countDocuments({
			account_id: req.session.accountId
		});
        
        // If AJAX request, return JSON
        if (req.query.ajax === 'true') {
            return res.json({
                images: userHistory,
                currentPage: page,
                totalPages: totalPages,
                hasMorePages: page < totalPages
            });
        }

		// Render the template
		res.render('image-history-beta', {
			userProfile: userProfile,
			userHistory,
			session: req.session,
			page,
			search,
			model,
			sort,
			totalPages,
			totalUserImages,
		});

	} catch (error) {
		console.log(`Error loading image history: ${error}`);
		if (req.query.ajax === 'true') {
			return res.status(500).json({ error: 'Failed to load images' });
		}
		showMessagePage(res, req, 'Error loading image history.');
	}

});

const archiver = require('archiver');

app.post('/image-history/download-page', async (req, res) => {
	try {
		const accountId = req.session.accountId;

		// Fetch user profile
		const userProfile = await mongolib.getSchemaDocumentOnce("userProfile", { accountId });
		
		if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

		const { imageIds } = req.body;

		// Fetch user history
		const images = await mongolib.aggregateSchemaDocuments("userHistory", [
		{ $match: { account_id: accountId, image_id: { $in: imageIds } } },
		{ $sort: { timestamp: -1 } }
		]);

		if (images.length === 0) {
		return res.status(404).json({ status: 'error', message: 'No images found' });
		}

		// Extract relative file paths
		const imagePaths = images.map(image => {
		const imageUrl = image.image_url;
		const relativePath = imageUrl.split('.com/')[1];
		if (!relativePath) throw new Error(`Invalid URL format: ${imageUrl}`);
		return relativePath;
		});

		// Prepare temp directory and zip file
		const tempFolder = path.join(__dirname, `temp/${accountId}`);
		const tempFilePath = path.join(tempFolder, `${Date.now()}.zip`);

		if (!fs.existsSync(tempFolder)) {
		fs.mkdirSync(tempFolder, { recursive: true });
		}

		const output = fs.createWriteStream(tempFilePath);
		const zip = archiver('zip', { zlib: { level: 9 } });

		output.on('close', async () => {
		console.log(`Zip file created: ${tempFilePath}`);
		res.setHeader('Content-Disposition', `attachment; filename="jscammie-images-${Date.now()}.zip"`);
		await res.download(tempFilePath, `jscammie-images-${Date.now()}.zip`, () => {
			fs.unlinkSync(tempFilePath); // Clean up temp file
		});
		});

		zip.on('error', err => {
		console.error('Archiver error:', err);
		res.status(500).json({ status: 'error', message: 'Failed to create zip file' });
		});

		zip.pipe(output);

		imagePaths.forEach(imagePath => {
		const fullPath = path.join(__dirname, imagePath);
		if (fs.existsSync(fullPath)) {
			zip.file(fullPath, { name: path.basename(imagePath) });
		} else {
			console.warn(`File not found: ${fullPath}`);
		}
		});

		await zip.finalize();
	} catch (error) {
		console.error('Error in download-page route:', error);
		res.status(500).json({ status: 'error', message: 'Internal server error' });
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
	const csvContent = fs.readFileSync(path.resolve(__dirname, 'tags-2025-03-03.csv'), {
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
		// tag.toLowerCase is not a function
		// tagsThatMatch = allTags.filter(tag => tag?.tag.toLowerCase().includes(lowercaseQuery));
		tagsThatMatch = allTags.filter(tag => tag?.tag?.toLowerCase().includes(lowercaseQuery));

		// Sort the tags by score:
		tagsThatMatch.sort((a, b) => b.score - a.score);

		// remove any tags that are 50 characters or more:
		tagsThatMatch = tagsThatMatch.filter(tag => tag?.tag?.length < 50);

		// Get the top 10 tags:
		const topx = tagsThatMatch.slice(0, 25);

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

			// skip it if it starts with flux:
			if (lora.includes('flux')) {
				continue
			}

			// ensure directories exist:
			if (!fs.existsSync(`.\\loraimages\\${category}`)) {
				fs.mkdirSync(`.\\loraimages\\${category}`, {
					recursive: true
				})
			}
			if (!fs.existsSync(`.\\loraimages\\pdxl\\${category}`)) {
				fs.mkdirSync(`.\\loraimages\\pdxl\\${category}`, {
					recursive: true
				})
			}
			if (!fs.existsSync(`.\\loraimages\\flux\\${category}`)) {
				fs.mkdirSync(`.\\loraimages\\flux\\${category}`, {
					recursive: true
				})
			}
			if (!fs.existsSync(`.\\loraimages\\illustrious\\${category}`)) {
				fs.mkdirSync(`.\\loraimages\\illustrious\\${category}`, {
					recursive: true
				})
			}

			let isSD15 = false 
			switch (lora) {
				case 'pdxl':
					break
				case 'flux':
					break
				case 'illustrious':
					break
				default:
					isSD15 = true
					break
			}

			// set the image path in the loraData:
			if (lora.includes('pdxl')) {
				// if there is no lora image then set it to the default image:
				if (!fs.existsSync(`.\\loraimages\\pdxl\\${category}\\${lora}.png`)) {
					fs.writeFileSync(`.\\loraimages\\pdxl\\${category}\\${lora}.png`, defaultImage)
				}
				loraData.image = `https://www.jscammie.com/loraimages/pdxl/${category}/${lora}.png`
			} else if (lora.includes('flux')) {
				// if there is no lora image then set it to the default image:
				if (!fs.existsSync(`.\\loraimages\\flux\\${category}\\${lora}.png`)) {
					fs.writeFileSync(`.\\loraimages\\flux\\${category}\\${lora}.png`, defaultImage)
				}
				loraData.image = `https://www.jscammie.com/loraimages/flux/${category}/${lora}.png`
			} else if (lora.includes('illustrious')) {
				// if there is no lora image then set it to the default image:
				if (!fs.existsSync(`.\\loraimages\\illustrious\\${category}\\${lora}.png`)) {
					fs.writeFileSync(`.\\loraimages\\illustrious\\${category}\\${lora}.png`, defaultImage)
				}
				loraData.image = `https://www.jscammie.com/loraimages/illustrious/${category}/${lora}.png`
			} else if (isSD15) {
				// if there is no lora image then set it to the default image:
				if (!fs.existsSync(`.\\loraimages\\${category}\\${lora}.png`)) {
					fs.writeFileSync(`.\\loraimages\\${category}\\${lora}.png`, defaultImage)
				}
				loraData.image = `https://www.jscammie.com/loraimages/${category}/${lora}.png`
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
	calculateCreditsPrice: fs.readFileSync('./scripts/ai/calculateCreditsPrice.js', 'utf8'),
	APIForm: fs.readFileSync('./scripts/ai/API-form.js', 'utf8'),
	imageGeneratorTour: fs.readFileSync('./scripts/ai/imageGeneratorTour.js', 'utf8'),
}

// split on module.exports to remove it and everything after:
aiScripts.calculateCreditsPrice = aiScripts.calculateCreditsPrice.split('module.exports')[0]


app.get('/userProfile', async (req, res) => {
	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})
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

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

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
	await mongolib.modifyUserExp(req.session.accountId, 3, '+')
	
	// await mongolib.createUserNotification(req.session.accountId, `You claimed your ${dailyType} dailies and earned ${creditsEarned} credits`, 'dailies')

	if (result == null) {
		res.send({
			status: 'error',
			message: 'Error claiming dailies'
		})
		return
	}

	result = await mongolib.updateSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	}, {
		[`dailies.timestamp${dailyType}`]: currentTimestamp
	})
	if (result == null) {
		res.send({
			status: 'error',
			message: 'Error updating dailies'
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
		calculateCreditsPrice: fs.readFileSync('./scripts/ai/calculateCreditsPrice.js', 'utf8'),
		APIForm: fs.readFileSync('./scripts/ai/API-form.js', 'utf8'),
		imageGeneratorTour: fs.readFileSync('./scripts/ai/imageGeneratorTour.js', 'utf8'),
	}
	aiScripts.calculateCreditsPrice = aiScripts.calculateCreditsPrice.split('module.exports')[0]
}, 15000)

app.get('/', async function(req, res) {
	try {
		const accountId = req.session.accountId;

		// Parallelize database calls
		const [foundAccount, imageHistoryCountRaw] = await Promise.all([
			userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
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

		if (foundAccount != null) {
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

app.post('/generator-set-favorite-loras', async function(req, res) {
	try {
		const accountId = req.session.accountId;
		let favoriteLoras = req.body.favoriteLoras;

		console.log(`Setting favorite Loras for account ${accountId}: ${favoriteLoras.length} Fav Loras`);

		// set the req.session.favoriteLoras to the favoriteLoras:
		// req.session.favoriteLoras = favoriteLoras

		// ensure that req.body.favoriteLoras doesnt go above 10:

		// check if their profile exists, if it does then dont clip the favoriteLoras:
		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: accountId
		})

		if (typeof favoriteLoras === 'object') {
			favoriteLoras = Object.values(favoriteLoras)
		}
	

		if (favoriteLoras.length == 0) {
			favoriteLoras = []
		}

		if (userProfile == null) {

			if (favoriteLoras.length > 10) {
				favoriteLoras = favoriteLoras.slice(0, 10)
			}

			req.session.favoriteLoras = favoriteLoras

			console.log(`set req.session.favoriteLoras to: ${req.session.favoriteLoras.length} Fav Loras`)
			res.send({
				status: 'success',
				message: 'Favorite Loras updated'
			})
			return
		}

		console.log(`type of favoriteLoras: ${typeof favoriteLoras}`)
		// make it an array from an object:
		let result = await mongolib.updateSchemaDocumentOnce("userProfile", {
			accountId: accountId
		}, {
			favoriteLoras: favoriteLoras
		});

		if (result == null) {
			console.log(`Error setting favorite Loras`);
			res.send({
				status: 'error',
				message: 'Error setting favorite Loras'
			});
			return;
		} else {
			res.send({
				status: 'success',
				message: 'Favorite Loras updated'
			});
		}
	} catch (error) {
		console.log(`Error setting favorite Loras: ${error}`);
		res.status(500).send('Error setting favorite Loras');
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
		if (request.negativeprompt.includes("<rp>") || request.negativeprompt.includes("<RP>")) {
			res.send({
				status: "error",
				message: "BRUH LMAO"
			})
			return
		}

		
		// regex to error when there are any <> tags which are not <rp> or <RP>
		loraIncorrectRegex = /<(?!rp|RP)[^>]*>/g
		if (loraIncorrectRegex.test(cleanedPrompt)) {
			res.send({
				status: "error",
				message: "You do not set loras in the prompt, please remove anything like <lora:loraname:0.5> etc, etc from the prompt"
			})
			return
		}



		let bannedTags = ['olivialewdz']
		// remove any banned tags from the prompt, use regex:
		cleanedPrompt = cleanedPrompt.replace(new RegExp(bannedTags.join("|"), "gi"), "");

		request.prompt = cleanedPrompt; // Update the prompt in the request object to be sent

		// make any <rp> lowercase:
		request.prompt = request.prompt.replace(/<RP>/g, "<rp>")

		moderatedPrompt = await moderatePrompt.positive(request.prompt)

		if (request.model.startsWith('pdxl')) {
			request.steps = 25
		} else if (request.model.startsWith('illustrious')) {
			request.steps = 25
		} else {
			request.steps = 40
		}



		if (request.model.startsWith('flux')) {
			request.quantity = 2
		}

		if (request.model == "illustrious-novafurry") {
			request.scheduler = "eulera"
		}

		let filteredLastRequest = {
			prompt: request.prompt,
			negativeprompt: request.negativeprompt,
			model: request.model,
			loras: request.lora,
			aspectRatio: request.aspect_ratio,
			steps: request.steps,
			quantity: request.quantity,
			cfguidance: request.guidance,
			seed: request.seed,
			scheduler: request.scheduler
		};
		req.session.lastRequestSD = filteredLastRequest;

		request.prompt = moderatedPrompt

		request.creditsRequired = 0

		// Validate seed value
		if (request.seed && (parseInt(request.seed) < -1 || isNaN(parseInt(request.seed)))) {
			request.seed = "-1";  // Default to -1 if seed is invalid or too small
		}

		if (request.fastqueue == true || request.extras?.removeWatermark == true || request.extras?.upscale == true || request.extras?.doubleImages == true || request.extras?.removeBackground == true) {

			let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			})

			if (userProfile == null) {
				res.send({
					status: 'error',
					message: 'User not found'
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
			console.log('Request:', request);
			console.log('Response:', postResponse);
			
			// Get the content type to check if it's JSON or HTML
			const contentType = postResponse.headers.get('content-type');
			
			if (contentType && contentType.includes('application/json')) {
				// It's JSON, try to parse it
				try {
					const postResponseBody = await postResponse.json();
					console.log('Response body:', postResponseBody);
					
					if (postResponseBody.status === "error") {
				res.send({
					status: "error",
					message: postResponseBody.message ? postResponseBody.message : "Error generating image, please try again later, or contact Cammie!"
						});
						return;
					}
				} catch (parseError) {
					console.log('Failed to parse response JSON:', parseError);
				}
			} else {
				// It's not JSON (probably HTML), log the text
				try {
					const htmlText = await postResponse.text();
					console.log('Non-JSON response:', htmlText.substring(0, 500) + '...');  // Log first 500 chars
				} catch (textError) {
					console.log('Failed to get response text:', textError);
				}
			}
			
			throw new Error(`HTTP error! status: ${postResponse.status}`);
		}

		const jsonResponse = await postResponse.json();
		res.send(jsonResponse);
	} catch (error) {
		console.log(`Error generating image: ${error}`);
		
		// Log any available error details
		if (error.response) {
			console.log('Error response:', error.response);
			if (error.response.data) {
				console.log('Error response data:', error.response.data);
			}
		}
		
		res.send({
			status: "error",
			message: "Error generating image, please try again later, or contact Cammie!"
		})
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

		console.log(`Request cancelled: ${request_id}) `);

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
		// console.log(`Error getting queue position: ${error}`);
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

		if (json.historyData == undefined) {
			json.historyData = {}
		}

		// if any values are undefined or null in historyData then set them to "":
		for (const [key, value] of Object.entries(json.historyData)) {
			if (value == undefined || value == null) {
				switch (key) {
					case 'loras':
						json.historyData.loras = []
						break
					case 'lora_strengths':
						json.historyData.lora_strengths = []
						break
					case 'cfg':
						json.historyData.cfg = "3"
						break
					case 'seed':
						json.historyData.seed = "-1"
						break
					case 'steps':
						json.historyData.steps = "30"
						break
					default:
						json.historyData[key] = ""
						break
				}
			}
		}

		let usedLoras = json.historyData.loras ?? []

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

			// Insert the new image history documents into the database
			try {
				let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
					accountId: json.historyData.account_id
				})

				let userHistoryLimit = userProfile?.variables?.userHistoryLimit ?? 5000

				// give the user exp:
				await mongolib.modifyUserExp(json.historyData.account_id, 1, '+')

				// get the count of all the images in the userHistory collection:
				let imageCount = await userHistorySchema.countDocuments({
					account_id: json.historyData.account_id
				})

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
								image_url: `https://www.jscammie.com/imagesHistory/${json.historyData.account_id}/${nextImageId}.png`
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
				
				// Now that allImageHistory is populated, save to database if under the limit
				if (imageCount < userHistoryLimit) {
					if (allImageHistory.length > 0) {
						for (const image of allImageHistory) {
							let result = await mongolib.createSchemaDocument("userHistory", image)
						}
					}
				} else {
					let result = await mongolib.createUserNotification(json.historyData.account_id, `You have reached the maximum amount of images in your history, please delete some images to make room for more, future images will not be saved! To see the limit, go to the <a href='/image-history'>Image History</a> page, alternatively you can upgrade your image history limit <a href='/profile-upgrades'>here</a>!`, 'generator')
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

			if (userProfile == null) {
				res.send({
					status: 'error',
					message: 'User not found'
				})
				return
			}

			creditsRequired = json.creditsRequired

			creditsMessage = `Generated images, Using: ${json.historyData.model}`

			// creditsFinal = creditsCurrent - creditsRequired
			result = await mongolib.modifyUserCredits(req.session.accountId, creditsRequired, '-', creditsMessage)

			if (userProfile.settings?.notification_generatorSpentCredits == true || userProfile.settings?.notification_generatorSpentCredits == undefined) {
				await mongolib.createUserNotification(req.session.accountId, `You spent ${creditsRequired} credits on generating images using ${json.historyData.model}`, 'generator')
			}
			json.credits = result.newCredits
			
			// Add beep setting to response
			json.misc_generationReadyBeep = userProfile?.settings?.misc_generationReadyBeep ?? true
		} else {
			// For users not spending credits (including non-logged in users),
			// set default beep setting
			json.misc_generationReadyBeep = true
		}

		historyData = json.historyData

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
		} else if (image._id == "extreme") {
			ratings.extreme = true
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

// app.get('/set-timestampRated/', async function(req, res) {

// 	let allBooruImages = await mongolib.getSchemaDocuments("userBooru")

// 	for (const image of allBooruImages) {
// 		let result = await mongolib.updateSchemaDocumentOnce("userBooru", {
// 			booru_id: image.booru_id
// 		}, { // make the timestampRated be 24hrs ago:
// 			timestampRated: Date.now() - (24 * 60 * 60 * 1000)
// 		})
// 	}

// 	res.send({
// 		status: 'success'
// 	})
// })

// Helper functions for booru search
const getBaseMatchStage = (safety, blockedAccounts, followedAccounts = null) => {
    let matchStage = {
        safety: { $in: safety },
        account_id: { $nin: blockedAccounts }
    };
    
    if (followedAccounts) {
        matchStage.account_id = { $in: followedAccounts };
    }
    
    return { $match: matchStage };
};

const getPaginationStages = (skip, limit) => [
    { $skip: skip },
    { $limit: limit }
];

const getTrendingScoreStage = (trendingAgo, tempBoostTimestamp) => ({
    $addFields: {
        recentVoteCount: {
            $subtract: [
                {
                    $size: {
                        $filter: {
                            input: { $ifNull: ["$upvotes", []] },
                            as: "vote",
                            cond: { $gt: ["$$vote.timestamp", trendingAgo] }
                        }
                    }
                },
                {
                    $size: {
                        $filter: {
                            input: { $ifNull: ["$downvotes", []] },
                            as: "vote",
                            cond: { $gt: ["$$vote.timestamp", trendingAgo] }
                        }
                    }
                }
            ]
        },
        totalVotes: {
            $subtract: [
                { $size: { $ifNull: ["$upvotes", []] } },
                { $size: { $ifNull: ["$downvotes", []] } }
            ]
        },
        commentCount: {
            $size: { $ifNull: ["$comments", []] }
        },
        recentCommentCount: {
            $size: {
                $filter: {
                    input: { $ifNull: ["$comments", []] },
                    as: "comment",
                    cond: { $gt: [{ $toLong: "$$comment.timestamp" }, trendingAgo] }
                }
            }
        }
    }
});

const getSortStage = (sortType) => {
    switch (sortType) {
        case "recent":
            return { $sort: { timestamp: -1 } };
        case "votes":
            return { $sort: { totalVotes: -1, _id: 1 } };
        case "trending":
            return { $sort: { score: -1, _id: 1 } };
        case "following":
            return { $sort: { timestamp: -1 } };
        default:
            return { $sort: { timestamp: -1 } };
    }
};

const fetchAccounts = async (booruImages, type) => {
    let accountIds = [];
    for (const image of booruImages) {
        if (image[type]?.length > 0) {
            accountIds.push(...image[type].map(vote => vote.accountId));
        }
    }
    accountIds = Array.from(new Set(accountIds));
    return await mongolib.getSchemaDocuments("userProfile", {
        accountId: { $in: accountIds }
    });
};

app.get('/booru/', async function(req, res) {
    try {
        let search = req.param('search') || "";
        const page = parseInt(req.param('page')) || 1;
        let safety = req.param('safety') || ["sfw"];
        const sort = req.param('sort') || "trending";
        const totalPerPage = 48;

        // Constants for trending algorithm
        const tempBoostBias = 20;
        const tempBoostHours = 2;
        const trendingAgoHours = 24;
        const tempBoostTimestamp = Date.now() - (tempBoostHours * 60 * 60 * 1000);
        const trendingAgo = Date.now() - (trendingAgoHours * 60 * 60 * 1000);
        const noVoteBoost = 100;
        const voteBias = -0.05;
        const commentBias = 0.1;
        const recentVoteBias = 3;
        const recentCommentBias = 15;

        // Handle URL parameters
        if (!req.url.includes('?')) {
            res.redirect(`/booru/?page=${page}&search=${search}&safety=${safety}&sort=${sort}`);
            return;
        }

        // Process safety parameter
        if (!Array.isArray(safety)) {
            safety = safety.split(',');
        }

        let reportedSearch = false;
        if (safety.includes('reported')) {
            safety = ["sfw", "suggestive", "nsfw", "extreme"];
            reportedSearch = true;
        }

        // Get user profile and settings
        const userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
            accountId: req.session.accountId
        });

        // Process tag blacklist
        let tagBlacklist = userProfile?.settings?.booru_tag_blacklist ?? "";
        if (tagBlacklist.length > 2) {
            tagBlacklist = tagBlacklist.split(' ')
                .map(tag => `-${tag}`)
                .join(' ');
            search = `${tagBlacklist} ${search}`;
        }

        const blockedAccounts = userProfile?.blockedAccounts ?? [];
        const followedAccounts = userProfile?.followedAccounts ?? [];
        const skip = (page - 1) * totalPerPage;

        // Process search tags
        // let searchTags = search ? (search.includes(' ') ? search.split(' ') : search.split(',')) : [];
		// above is incorrect, it needs to always split by commas and spaces, but ensure there is only one space between tags, it needs to be an array:
		let searchTags = search
		searchTags = searchTags.split(',').map(tag => tag.trim()).join(' ')
		searchTags = searchTags.split(' ').map(tag => tag.trim()).filter(tag => tag.trim() !== '');
		searchTags = searchTags.filter(tag => tag.trim() !== '');
		searchTags = searchTags.map(tag => tag.trim()).filter(tag => tag.trim() !== '');
        // Filter out empty strings and trim whitespace
        searchTags = searchTags.filter(tag => tag.trim() !== '');
        if (searchTags.length === 1 && searchTags[0] === ",") {
            searchTags = [];
        }

        // Build MongoDB query
        let pipeline = [];
        
        if (reportedSearch) {
            pipeline = [
                { $match: { reports: { $exists: true, $ne: [] } } },
                ...getPaginationStages(skip, totalPerPage)
            ];
        } else {
            // Base match stage
            pipeline.push(getBaseMatchStage(safety, blockedAccounts, sort === "following" ? followedAccounts : null));

            // Add tag filtering if needed
            if (searchTags.length > 0) {
                const positiveTags = searchTags.filter(tag => !tag.startsWith('-'));
                const negativeTags = searchTags.filter(tag => tag.startsWith('-')).map(tag => tag.slice(1));

                console.log('Positive tags:', positiveTags);
                console.log('Negative tags:', negativeTags);

                if (positiveTags.length > 0) {
                    const tagPromises = positiveTags.map(tag => 
                        userBooruTagsSchema.findOne({ tag }).then(found => found?.booru_ids || [])
                    );
                    const allBooruIds = await Promise.all(tagPromises);
                    const commonBooruIds = allBooruIds.reduce((acc, val) => 
                        acc.length && val.length ? acc.filter(x => val.includes(x)) : []
                    );

                    // console.log('Found booru IDs for positive tags:', commonBooruIds);

                    if (commonBooruIds.length > 0) {
                        pipeline[0].$match.booru_id = { $in: commonBooruIds };
                    }
                }

                if (negativeTags.length > 0) {
                    const negativePromises = negativeTags.map(tag =>
                        userBooruTagsSchema.findOne({ tag }).then(found => found?.booru_ids || [])
                    );
                    const negativeBooruIds = await Promise.all(negativePromises);
                    const allNegativeIds = Array.from(new Set(negativeBooruIds.flat()));
                    
                    // console.log('Found booru IDs for negative tags:', allNegativeIds);

                    if (allNegativeIds.length > 0) {
                        pipeline[0].$match.booru_id = {
                            ...pipeline[0].$match.booru_id,
                            $nin: allNegativeIds
                        };
                    }
                }
            }

            // Add sorting and scoring stages
            if (sort === "trending") {
                pipeline.push(getTrendingScoreStage(trendingAgo, tempBoostTimestamp));
                pipeline.push({
                    $addFields: {
                        score: {
                            $add: [
                                { $multiply: ["$recentVoteCount", recentVoteBias] },
                                { $multiply: ["$totalVotes", voteBias] },
                                { $multiply: ["$recentCommentCount", recentCommentBias] },
                                { $multiply: ["$commentCount", commentBias] },
                                { $cond: { if: { $gt: [{ $toLong: "$timestampRated" }, tempBoostTimestamp] }, then: tempBoostBias, else: 0 } },
                                { $cond: { if: { $and: [{ $eq: [{ $size: { $ifNull: ["$upvotes", []] } }, 0] }, { $eq: [{ $size: { $ifNull: ["$downvotes", []] } }, 0] }] }, then: noVoteBoost, else: 0 } }
                            ]
                        }
                    }
                });
            } else if (sort === "votes") {
                pipeline.push({
                    $addFields: {
                        totalVotes: {
                            $subtract: [
                                { $size: { $ifNull: ["$upvotes", []] } },
                                { $size: { $ifNull: ["$downvotes", []] } }
                            ]
                        }
                    }
                });
            }

            // Add sort and pagination stages
            pipeline.push(getSortStage(sort));
            pipeline.push(...getPaginationStages(skip, totalPerPage));
        }
        
        // First, let's check if there are any documents at all        
        const booruImages = await mongolib.aggregateSchemaDocuments("userBooru", pipeline);

        // Get total count for pagination
        const countPipeline = [...pipeline];
        countPipeline.pop(); // Remove limit
        countPipeline.pop(); // Remove skip
        countPipeline.push({ $count: 'count' });
        const totalImages = await mongolib.aggregateSchemaDocuments("userBooru", countPipeline);
        const totalImagesCount = totalImages.length > 0 ? totalImages[0].count : 0;
        const totalPages = Math.ceil(totalImagesCount / totalPerPage);

        // Fetch related accounts
        const booruAccounts = await mongolib.getSchemaDocuments("userProfile", {
            accountId: { $in: Array.from(new Set(booruImages.map(image => image.account_id))) }
        });

        const upvoteAccounts = await fetchAccounts(booruImages, 'upvotes');
        const downvoteAccounts = await fetchAccounts(booruImages, 'downvotes');

        // Render response
        res.render('booru/home', {
            session: req.session,
            booruImages,
            userProfile: userProfile || {},
            booruSearchScript,
            totalPages,
            booruAccounts,
            upvoteAccounts,
            downvoteAccounts
        });

    } catch (error) {
        console.log(`Error loading tags data: ${error}`);
        res.status(500).send('Error loading booru tags data');
    }
});

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
					}
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
				$limit: 23
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

		let data = null
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

		let hoursAgoBooru = Date.now() - (12 * 60 * 60 * 1000)

		let imageCountAggregate = await mongolib.aggregateSchemaDocuments("userBooru", [{
				$match: {
					account_id: req.session.accountId,
					timestamp: {
						$gt: hoursAgoBooru.toString()
					}
				}
			},
		])

		imageCount = imageCountAggregate.length

		maxBooruImages = 50

		console.log(`Last 12 hrs: ${imageCount} - ${userProfile.username}`)

		if (imageCount >= maxBooruImages) {
			// Calculate the time until the user can post again
			let timeTillNextPost = Math.ceil(hoursAgoBooru - Date.now());
			let timeTillNextPostString = "";

			if (timeTillNextPost > 60 * 60 * 1000) {
				let hours = Math.floor(timeTillNextPost / (60 * 60 * 1000));
				let mins = Math.floor((timeTillNextPost % (60 * 60 * 1000)) / (60 * 1000));
				timeTillNextPostString = `${hours} hour${hours !== 1 ? "s" : ""} and ${mins} minute${mins !== 1 ? "s" : ""}`;
			} else {
				let mins = Math.floor(timeTillNextPost / (60 * 1000));
				timeTillNextPostString = `${mins} minute${mins !== 1 ? "s" : ""}`;
			}

			res.send({
				status: "error",
				message: `You've reached the limit of ${maxBooruImages} images in the last 12 hours. You can post again in ${timeTillNextPostString}.`
			});
			return;
		}




		// check if the user has posted a post in the last 3 days with the exact same prompt, count it, if its above 10, dont allow the post:
		let antiSamePromptSpamDaysAgoBooru = Date.now() - (2 * 24 * 60 * 60 * 1000)

		let samePromptCountAggregate = await mongolib.aggregateSchemaDocuments("userBooru", [{
				$match: {
					account_id: req.session.accountId,
					timestamp: {
						$gt: antiSamePromptSpamDaysAgoBooru.toString()
					},
					prompt: data.prompt
				}
			},
		])

		samePromptCount = samePromptCountAggregate.length

		maxSamePrompt = 1

		console.log(`Same prompt: ${samePromptCount} - ${userProfile.username}`)

		if (samePromptCount >= maxSamePrompt) {
			res.send({
				status: "error",
				message: `You've reached the limit of ${maxSamePrompt} images with the same prompt in the last 2 days.`
			});
			return;
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
		image_url = image_url.replace("https://www.jscammie.com/", "")
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

		scoreTags = "score_10, score_9, score_8, score_7, score_6, score_5, score_4, score_3, score_2, score_1, score_0"
		scoreUpTags = "score_10_up, score_9_up, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up, score_3_up, score_2_up, score_1_up, score_0_up"
		scoreUpTags2 = "score_10up, score_9up, score_8up, score_7up, score_6up, score_5up, score_4up, score_3up, score_2up, score_1up, score_0up"
		qualityTags = "masterpiece, amazing_quality, best_quality, absurdres, very_aesthetic, high_quality, detailed, perfect_quality, high_resolution"
		qualityTags2 = "8k, ultra-detailed, absurd_res, 4k, high_detail, amazing_lighting, perfect_detail, hi_res, highest_quality_textures"
		qualityTags3 = "extreme_detail, studio_quality, max_detail, refined_detail, insanely_detailed, highres, highly_detailed_background, quality"

		blockedTags = scoreTags + ", " + scoreUpTags + ", " + scoreUpTags2 + ", " + qualityTags + ", " + qualityTags2 + ", " + qualityTags3
		blockedTags = blockedTags.split(", ")

		tags = tags.filter(tag => !blockedTags.includes(tag))

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
			content_url: `https://www.jscammie.com/${newImageUrlBase}`,
			safety: "na",
			timestamp: Date.now(),
			timestampRated: Date.now(),
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

app.post('/follow-account/', async function(req, res) {

	try {

		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		if (userProfile == null) {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		let accountToFollow = req.body.accountId

		if (userProfile.followedAccounts.includes(accountToFollow)) {
			
			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$pull: {
					followedAccounts: accountToFollow
				}
			})

		} else {
		
			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$push: {
					followedAccounts: accountToFollow
				}
			})
		
		}

		let userProfileUpdated = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		res.json({ followedAccounts: userProfileUpdated.followedAccounts });
	
	} catch (error) {
		console.log(`Error following account: ${error}`);
		res.status(500).send('Error following account');
	}
})

app.post('/block-account/', async function(req, res) {

	try {

		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		if (userProfile == null) {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		let accountToBlock = req.body.accountId

		if (userProfile.blockedAccounts.includes(accountToBlock)) {

			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$pull: {
					blockedAccounts: accountToBlock
				}
			})

		} else {

			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$push: {
					blockedAccounts: accountToBlock
				}
			})

		}

		let userProfileUpdated = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		//  {blockedAccounts: userProfileUpdated.blockedAccounts}
		res.json({ blockedAccounts: userProfileUpdated.blockedAccounts });

	} catch (error) {

		console.log(`Error blocking account: ${error}`);
		res.status(500).send('Error blocking account');

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
			await mongolib.modifyUserCredits(creatorProfile.accountId, 5, '+', `Your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a> was rated ${rating.toUpperCase()}`)
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

			// set the timestamp to be date.time() so the trending algorithm will boost it:
			await mongolib.updateSchemaDocumentOnce("userBooru", {
				booru_id: booru_id
			}, {
				timestampRated: `${Date.now()}`,
			})

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

app.post('/booru/delete', async function(req, res) {
	booru_id = req.body.booru_id
	reason = req.body.reason

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
	if (foundBooruImage.account_id != req.session.accountId && userProfile.badges?.moderator != true) {
		res.send({
			status: "error",
			message: "User does not own the image"
		})
		return
	}

	let localImage = ""

	// could be https: or http:
	if (foundBooruImage.content_url.startsWith("https://")) {
		localImage = foundBooruImage.content_url.replace("https://www.jscammie.com/", "")
	} else {
		localImage = foundBooruImage.content_url.replace("http://www.jscammie.com/", "")
	}


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

	if (reason != "self-delete") {
		await mongolib.createUserNotification(foundBooruImage.account_id, `Your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a> was deleted, Reason: ${reason}`, 'moderation')
	}
	
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

	res.send({
		status: "success",
		message: "Booru image deleted"
	})
})

app.post('/booru/ban/:accountId', async function(req, res) {
	accountId = req.param('accountId')

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
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

	if (targetProfile == 'error') {
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
		if (userProfile == null) {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		let creatorProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: foundBooruImage.account_id
		})
		if (creatorProfile == null) {
			res.send({
				status: 'error',
				message: 'Creator not found'
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

		creatorCreditsToGain = 1.75
		creatorExpToGain = 2

		userCreditsToGain = 0.5
		userExpToGain = 0.5

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

					await mongolib.modifyUserCredits(account_id, userCreditsToGain, '+', `You Upvoted a <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`)
					await mongolib.modifyUserExp(account_id, userExpToGain, '+')

					if (creatorProfile != null) {
						await mongolib.modifyUserCredits(creatorProfile.accountId, creatorCreditsToGain, '+', `Someone upvoted your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`)
						await mongolib.modifyUserExp(creatorProfile.accountId, creatorExpToGain, '+')
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

				// disable downvotes for now:
				res.send({
					status: "error",
					message: "Downvotes are disabled"
				})
				return

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

	console.log(`Posting comment: ${booru_id}`)
	console.log(`Comment: ${req.body.comment}`)
	console.log(`Account: ${req.session.accountId}`)

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
			status: 'error',
			message: 'User not found'
		})
		return
	}

	await mongolib.updateSchemaDocumentOnce(
		"userBooru",
		{ booru_id: booru_id }, // Find the document by `booru_id`
		{
			$push: {
				comments: {
					commentId: `${req.session.accountId}-${Date.now()}-${booru_id}`,
					booruId: booru_id,
					accountId: req.session.accountId,
					comment: comment,
					timestamp: Date.now(),
					upvotes: [],
				}
			}
		}
	);



	let creatorProfile = await userProfileSchema.findOne({
		accountId: foundBooruImage.account_id
	})

	if (creatorProfile.settings?.notification_booruComment ?? true) {
		await mongolib.createUserNotification(foundBooruImage.account_id, `${foundAccount.username} commented on your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`, 'booru')
	}

	res.send({
		status: "success",
		message: "Comment added"
	})
})


app.get('/booru/comment/delete/:commentId', async function(req, res) {

	try {

		const commentId = req.param('commentId');

		const foundBooru = await mongolib.getSchemaDocumentOnce("userBooru", {
			"comments.commentId": commentId
		});

		if (!foundBooru) {
			res.send({
				status: "error",
				message: "Comment not found"
			});
			return;
		}

		const foundComment = foundBooru.comments.find(comment => comment.commentId === commentId);

		if (!foundComment) {
			res.send({
				status: "error",
				message: "Comment not found"
			});
			return;
		}

		const foundAccount = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		});

		if (foundAccount == null) {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		if (foundComment.accountId !== req.session.accountId && foundAccount.badges?.moderator !== true) {
			res.send({
				status: "error",
				message: "Account does not own the comment, or is not moderator"
			});
			return;
		}

		await mongolib.updateSchemaDocumentOnce(
			"userBooru",
			{ booru_id: foundBooru.booru_id },
			{
				$pull: { comments: { commentId: commentId } }
			}
		);

		await mongolib.createUserNotification(foundComment.accountId, `Your comment was deleted`, 'moderation');

		res.send({
			status: "success",
			message: "Comment deleted"
		});
	
	} catch (error) {
		console.log(`Error deleting comment: ${error}`);
		res.status(500).send('Error deleting comment');
	}

})


app.post('/booru/comment/vote', async function (req, res) {
    try {
        const { vote: voteType, commentId } = req.body;
        const accountId = req.session.accountId;

        if (!["upvote", "downvote"].includes(voteType)) {
            return res.status(400).send({ status: "error", message: "Invalid vote type" });
        }

        // Step 1: Find the booru document containing the comment
        const foundBooru = await mongolib.getSchemaDocumentOnce("userBooru", {
            "comments.commentId": commentId
        });

        if (!foundBooru) {
            return res.status(404).send({ status: "error", message: "Comment not found" });
        }

        // Step 2: Find the specific comment within the booru document
        const foundComment = foundBooru.comments.find(comment => comment.commentId === commentId);

        if (!foundComment) {
            return res.status(404).send({ status: "error", message: "Comment not found" });
        }

        // Step 3: Find the user's profile (optional check for account validity)
        const foundAccount = await mongolib.getSchemaDocumentOnce("userProfile", { accountId });
        if (foundAccount.status == "error") {
			return res.status(404).send({ status: "error", message: "Account not found" });
		}

        // Step 4: Prepare the update logic
        const updateQuery = { "comments.commentId": commentId };
        const updateAction = {};

        const alreadyUpvoted = foundComment.upvotes.some(vote => vote.accountId === accountId);
        const alreadyDownvoted = foundComment.downvotes.some(vote => vote.accountId === accountId);

        if (voteType === "upvote") {
            // Remove upvote if already upvoted
            if (alreadyUpvoted) {
                updateAction.$pull = { "comments.$.upvotes": { accountId } };
            } else {
                // Remove downvote if exists, then add upvote
                if (alreadyDownvoted) {
                    updateAction.$pull = { "comments.$.downvotes": { accountId } };
                }
                updateAction.$push = {
                    "comments.$.upvotes": {
                        accountId,
                        timestamp: Date.now()
                    }
                };
            }
        } else if (voteType === "downvote") {
            // Remove downvote if already downvoted
            if (alreadyDownvoted) {
                updateAction.$pull = { "comments.$.downvotes": { accountId } };
            } else {
                // Remove upvote if exists, then add downvote
                if (alreadyUpvoted) {
                    updateAction.$pull = { "comments.$.upvotes": { accountId } };
                }
                updateAction.$push = {
                    "comments.$.downvotes": {
                        accountId,
                        timestamp: Date.now()
                    }
                };
            }
        }

        // Apply the update if any action was created
        if (Object.keys(updateAction).length > 0) {
            await mongolib.updateSchemaDocumentOnce("userBooru", updateQuery, updateAction);
        }

        // Step 5: Get updated comment details
        const updatedBooru = await mongolib.getSchemaDocumentOnce("userBooru", {
            "comments.commentId": commentId
        });

        const updatedComment = updatedBooru.comments.find(comment => comment.commentId === commentId);

        return res.send({
            status: "success",
            message: "Vote processed successfully",
            upvotes: updatedComment.upvotes.length,
            downvotes: updatedComment.downvotes.length
        });
    } catch (error) {
        console.error("Error processing vote:", error);
        return res.status(500).send({ status: "error", message: "Internal server error" });
    }
});


app.get('/booru/comment/get/:booru_id', async function(req, res) {

	try {

		booru_id = req.param('booru_id')

		let foundBooruImage = await mongolib.getSchemaDocumentOnce("userBooru", {
			booru_id: booru_id
		})

		let foundBooruComments = foundBooruImage.comments

		// ensure that foundBooru comments is an array:
		if (!Array.isArray(foundBooruComments)) {
			foundBooruComments = [foundBooruComments]
		}

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
				profileImg: foundAccount.profileImg || "https://www.jscammie.com/noimagefound.png"
			})
		}

		res.send({
			status: "success",
			comments: comments
		})

	} catch(error) {
		console.log(`Error getting comments: ${error}`);
		return
	}

	
})


app.post('/booru/report', async function(req, res) {

	try {

		let booru_id = req.body.booru_id

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

		if (userProfile == null) {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		let reason = req.body.reason

		console.log(`User ${req.session.accountId} reported booru image ${booru_id} for: ${reason}`)
		
		await mongolib.createUserNotification(1039574722163249233, `A user has reported a <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a> for: ${reason}`, 'moderation')

		// reports: { type: Array, default: [] }, [{accountId, timestamp, reason}]
		await mongolib.updateSchemaDocumentOnce("userBooru", {
			booru_id: booru_id
		}, {
			$push: {
				reports: {
					accountId: req.session.accountId,
					timestamp: Date.now(),
					reason: reason
				}
			}
		})

		res.send({
			status: "success",
			message: "Booru image reported"
		})

	} catch (error) {
		console.log(`Error reporting booru: ${error}`);
		res.status(500).send('Error reporting booru');
	}

})

app.post('/booru/favorite', async function(req, res) {

	try {

		let booru_id = req.body.booru_id

		console.log(`favoritePost`, booru_id)

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

		if (userProfile == null) {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
		}

		// favoriteBooruPosts is an array of booru_id objects, each object has a booru_id string and a timestamp:
		const favoriteBooruPosts = userProfile.favoriteBooruPosts

		// check if the booru_id is already in the array:
		const isFavorite = favoriteBooruPosts.some(post => post.booru_id === booru_id)


		if (isFavorite) {
			// remove the booru_id from the array
			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$pull: { favoriteBooruPosts: { booru_id: booru_id } }
			})
		} else {
			// add the booru_id to the array
			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$push: { favoriteBooruPosts: { booru_id: booru_id, timestamp: Date.now() } }
			})
		}

		if (isFavorite) {
			res.send({
				status: "success",
				favorited: false,
				message: "Booru image removed from favorites"
			})
		} else {
			res.send({
				status: "success",
				favorited: true,
				message: "Booru image added to favorites"
			})
		}

	} catch (error) {
		console.log(`Error favoriting booru: ${error}`);
		res.status(500).send('Error favoriting booru');
	}

})


app.get('/booru-remove-all-dislikes', async function(req, res) {

	try {

		let foundBooruImages = await mongolib.getSchemaDocuments("userBooru", {
			downvotes: { $exists: true }
		})

		for (const booruImage of foundBooruImages) {
			await mongolib.updateSchemaDocumentOnce("userBooru", {
				booru_id: booruImage.booru_id
			}, {
				downvotes: []
			})
		}

		res.send({
			status: "success",
			message: "All dislikes removed"
		})

	} catch (error) {
		console.log(`Error removing dislikes: ${error}`);
		res.status(500).send('Error removing dislikes');
	}

})


app.get('/profile/:account_id', async function(req, res) {
	account_id = req.param('account_id')

	let profileProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: account_id
	})

	if (profileProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	let userBooru = await userBooruSchema.find({
		account_id: account_id
	})

	let booruAccounts = Array.from(new Set(userBooru.map(image => image.account_id)))

	booruAccounts = await mongolib.getSchemaDocuments("userProfile", {
		accountId: {
			$in: booruAccounts
		}
	})

	// get a count of all the instances they appear in others userProfile's followedAccounts array
	let followedCount = await mongolib.aggregateSchemaDocuments("userProfile", [
		{
			$match: {
				followedAccounts: account_id
			}
		},
		{
			$count: "followedCount"
		}
	])

	let likedPosts = await mongolib.aggregateSchemaDocuments("userBooru", [
		{
			$match: {
				"upvotes.accountId": account_id
			}
		},
		{
			$sort: {
				timestamp: -1
			}
		},
		{
			$project: {
				booru_id: 1,
				account_id: 1,
				image_id: 1,
				prompt: 1,
				content_url: 1,
				timestamp: 1,
				safety: 1
			}
		}
	])

	// Get all account IDs from the liked posts
	let likedPostsAccounts = Array.from(new Set(likedPosts.map(post => post.account_id)))
	
	// Fetch profiles for all accounts in liked posts
	let likedPostsProfiles = await mongolib.getSchemaDocuments("userProfile", {
		accountId: {
			$in: likedPostsAccounts
		}
	})

	// Create a lookup map for easy access
	let likedPostsProfilesMap = {}
	likedPostsProfiles.forEach(profile => {
		likedPostsProfilesMap[profile.accountId] = profile
	})

	// Prepare the data arrays for liked posts
	let likedPostsData = {
		posts: likedPosts,
		usernames: {},
		profilePics: {}
	}
	
	// Fill the username and profile pic objects with account IDs as keys
	likedPosts.forEach(post => {
		const profile = likedPostsProfilesMap[post.account_id]
		likedPostsData.usernames[post.account_id] = profile ? profile.username : 'User ' + post.account_id
		likedPostsData.profilePics[post.account_id] = profile ? profile.profileImg : 'https://www.jscammie.com/noimagefound.png'
	})





	// use userProfile.favoriteBooruPosts to get the favorite booru posts, however the user may have 0 favorite booru posts, so we need to check for that first:
	let favoriteBooruPostsArray = userProfile?.favoriteBooruPosts ? userProfile.favoriteBooruPosts : []

	// get the booru_id from the favoriteBooruPosts array:
	let favoriteBooruPostsIds = favoriteBooruPostsArray.map(post => post.booru_id)

	// get the booru posts from the userBooru collection:
	let favoriteBooruPosts = await mongolib.getSchemaDocuments("userBooru", {
		booru_id: { $in: favoriteBooruPostsIds }
	})

	// get the profiles for the favorite booru posts:
	let favoriteBooruPostsProfiles = await mongolib.getSchemaDocuments("userProfile", {
		accountId: { $in: favoriteBooruPosts.map(post => post.account_id) }
	})

	// create a lookup map for the favorite booru posts profiles:
	let favoriteBooruPostsProfilesMap = {}
	favoriteBooruPostsProfiles.forEach(profile => {
		favoriteBooruPostsProfilesMap[profile.accountId] = profile
	})

	// prepare the data arrays for the favorite booru posts:
	let favoriteBooruPostsData = {
		posts: favoriteBooruPosts,
		usernames: {},
		profilePics: {}
	}
	
	// fill the username and profile pic objects with account IDs as keys
	favoriteBooruPosts.forEach(post => {
		const profile = favoriteBooruPostsProfilesMap[post.account_id]
		favoriteBooruPostsData.usernames[post.account_id] = profile ? profile.username : 'User ' + post.account_id
		favoriteBooruPostsData.profilePics[post.account_id] = profile ? profile.profileImg : 'https://www.jscammie.com/noimagefound.png'
	})

	// merge the favoriteBooruPostsData with the booruAccounts array, ensuring there is only one instance of each account_id
	booruAccounts = booruAccounts.map(account => {
		return {
			...account,
			...favoriteBooruPostsData.usernames[account.accountId],
			...favoriteBooruPostsData.profilePics[account.accountId]
		}
	})


	followedCount = followedCount[0]?.followedCount || 0

	res.render('profile', {
		session: req.session,
		profileProfile: profileProfile,
		userProfile: userProfile,
		userBooru: userBooru,
		booruSearchScript,
		followedCount: followedCount,
		likedPosts: likedPostsData,
		favoriteBooruPosts: favoriteBooruPostsData,
		booruAccounts: booruAccounts
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

	if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	let creditsHistory = await mongolib.getSchemaDocuments("userCreditsHistory", {
		accountId: req.session.accountId
	})

	if (creditsHistory == null) {
		res.send({
			status: 'error',
			message: 'User not found'
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

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	if (userProfile == null) {
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

	if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

	res.render('settings', {
		session: req.session,
		userProfile: userProfile,
		booruSearchScript
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

		if (userProfile == null) {
			res.send({
				status: 'error',
				message: 'User not found'
			})
			return
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



let possibleSettings = [
	"notification_booruVote",
	"notification_booruComment",
	"notification_booruRating",
	"notification_suggestionPromoted",
	"notification_generatorSpentCredits",
	"misc_generationReadyBeep"
]

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
			if (!possibleSettings.includes(settingWanted)) {
				res.send({	
					status: "error",
					message: "Setting not found"
				})
				return
			}

			// update the setting:
			// the settings may not exist or be blank, so we need to check for that:
			if (newSettings == undefined) {
				newSettings = {}
			}

			console.log(`Setting wanted: ${settingWanted}`)
			console.log(`Toggle value: ${toggleValue}`)

			// manually update the setting:
			let result = await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$set: {
					[`settings.${settingWanted}`]: toggleValue
				},
			})


			console.log(result)

		} else if (settingWanted == 'booru_tag_blacklist') {

			// set the string of booruTagBlacklist in the settings to the "value":
			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$set: {
					'settings.booru_tag_blacklist': settingValue
				}
			})

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

	if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
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

	// return res.status(404).send('Page not found')

	if (req.session.accountId != "1039574722163249233") {
		return res.status(404).send('Page not found')
	}

	allowedAccounts = ["1039574722163249233", "550239177837379594"]

	if (!allowedAccounts.includes(req.session.accountId)) {
		return res.status(404).send('Page not found')
	}

	res.render('modifyusercredits', {
		session: req.session
	});

})


app.get('/paypal-shop', async function(req, res) {

	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

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
    { credits: 17500, price: 5 },
	{ credits: 40000, price: 10 },
	{ credits: 100000, price: 20 }
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
            await mongolib.modifyUserCredits(accountId, selectedOption.credits, '+', `Purchased ${selectedOption.credits} credits for $${selectedOption.price.toFixed(2)}, thank you very much for your support! 🤍`);
            await mongolib.createUserNotification(accountId, `You have purchased ${selectedOption.credits} credits for $${selectedOption.price.toFixed(2)}, thank you very much for your support! 🤍`, 'payment');
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
            await mongolib.modifyUserCredits(accountId, credits, '+', `Purchased ${credits} credits via PayPal, thank you very much for your support! 🤍`);
            await mongolib.createUserNotification(accountId, `You have successfully purchased ${credits} credits, thank you very much for your support! 🤍`, 'payment');

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

		if (userProfile == null) {
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

		if (userProfile == null) {
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

		if (foundCode == null) {
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

		if (userProfile == null) {
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

		if (userProfile == null) {
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

		if (result == null) {
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




app.get('/leaderboard', async function(req, res) {

	try {


		let type = req.param('type')

		switch (type) {
		
			case 'credits':
				let leaderboardInfo = await mongolib.aggregateSchemaDocuments("userProfile", [
					// credits is a string, convert it before sorting:
					{ $addFields: { credits: { $toLong: "$credits" } } },
					{ $sort: { credits: -1 } }, 
					{ $match: { accountId: { $ne: "550239177837379594" } } },
					{ $project: { credits: 1, username: 1, profileImg: 1, accountId: 1 } },
					{ $limit: 100 }
				]);

				res.render('leaderboard', {
					session: req.session,
					leaderboardInfo: leaderboardInfo,
					type: 'credits'
				});
				break;

			case 'exp':
				let leaderboardInfoExp = await mongolib.aggregateSchemaDocuments("userProfile", [
					{ $sort: { exp: -1 } },
					{ $project: { exp: 1, username: 1, profileImg: 1, level: 1, accountId: 1 } },
					{ $limit: 100 }
				]);

				// ensure the exp is a number from Decimal128 object:
				leaderboardInfoExp = leaderboardInfoExp.map(user => {
					user.exp = Number(user.exp.toString())
					return user
				})

				res.render('leaderboard', {
					session: req.session,
					leaderboardInfo: leaderboardInfoExp,
					type: 'exp'
				});
				break;

			case 'booru':
				// Fetch booru images with only required fields
				let booruImages = await mongolib.aggregateSchemaDocuments("userBooru", [
					// make the upvotes, downvotes and comments the length of the array if it exists:
					{ $addFields: { upvotes: { $size: { $ifNull: ["$upvotes", []] } }, comments: { $size: { $ifNull: ["$comments", []] } }, timestamp: { $toLong: "$timestamp" } } },
					{ $project: { account_id: 1, upvotes: 1, comments: 1, timestamp: 1 } }
				]);

				// ignore any booru images that released in the last x hours:
				booruImages = booruImages.filter(image => {
					let timestampCreated = image.timestamp
					let xHoursAgo = Date.now() - 6 * 60 * 60 * 1000
					return timestampCreated < xHoursAgo
				})

				if (!booruImages.length) {
					console.log("No booru images found.");
					return res.render('leaderboard', { session: req.session, leaderboardInfo: [], type: 'booru' });
				}

				// Get unique account IDs
				let accountIds = [...new Set(booruImages.map(img => img.account_id))];

				// Fetch user profiles
				let userProfiles = await mongolib.aggregateSchemaDocuments("userProfile", [
					{ $match: { accountId: { $in: accountIds } } },
					{ $project: { accountId: 1, username: 1, profileImg: 1 } }
				]);

				let userProfilesMap = Object.fromEntries(userProfiles.map(user => [user.accountId, user]));

				// Process booru posts
				let userStats = {};
				for (const image of booruImages) {
					let { account_id, upvotes, comments } = image;
					upvotes = upvotes || 0;
					comments = comments || 0;

					let commentScore = 5 * Math.log2(1 + comments);
					let upvoteScore = 1.9 * upvotes;
					let score = commentScore + upvoteScore;

					if (!userStats[account_id]) {
						userStats[account_id] = { postCount: 0, totalScore: 0, totalVotes: 0 };
					}

					userStats[account_id].postCount++;
					userStats[account_id].totalScore += score;
					userStats[account_id].totalVotes += upvotes + comments;
				}

				// Construct leaderboard data
				let allUserBooruAccounts = await Promise.all(
					Object.entries(userStats)
						.filter(([accountId, stats]) => stats.postCount >= 10)
						.map(async ([accountId, stats]) => {
							let profile = userProfilesMap[accountId] || {};

							// Engagement-based modifier
							let engagementRate = stats.totalVotes / stats.postCount;
							let activityModifier = Math.max(0.5, Math.log10(1 + stats.postCount)) * 80;
							let engagementBoost = Math.log2(1 + stats.totalVotes / (stats.postCount + 5)) * 12;

							// Get the followedAccounts count for the user
							let followedCountResult = await mongolib.aggregateSchemaDocuments("userProfile", [
								{ $match: { followedAccounts: accountId } },
								{ $count: "followedCount" }
							]);

							let followedCount = followedCountResult[0]?.followedCount || 0;
							// if they have 0 followers then set it to 1:
							if (followedCount == 0) {
								followedCount = 1
							}

							return {
								accountId,
								username: profile.username || "Unknown",
								profileImg: profile.profileImg || "",
								score: ((stats.totalScore / activityModifier) + engagementBoost),
								followerCount: followedCount
							};
						})
				);

				let highestFollowerCount = 0
				for (const account of allUserBooruAccounts) {
					if (account.followerCount > highestFollowerCount) {
						highestFollowerCount = account.followerCount
					}
				}

				// alter the score based on the follower count, normalise the score to the number of followers:
				allUserBooruAccounts = allUserBooruAccounts.map(account => {
					// make sure the multiplicative gain is limited, taking into account the highest follower count:
					let followerScore = ((account.followerCount / highestFollowerCount)/7.14) + 0.95
					if (account.accountId == "550239177837379594") { console.log(`${account.username} has a follower score of ${followerScore} and their score would be ${account.score * followerScore}`) }
					account.score = (account.score * followerScore)
					return account;
				})


				allUserBooruAccounts = allUserBooruAccounts
					.sort((a, b) => b.score - a.score)
					.slice(0, 100);

				res.render('leaderboard', {
					session: req.session,
					leaderboardInfo: allUserBooruAccounts,
					type: 'booru'
				});
				break;



			default:

				res.redirect('/leaderboard?type=credits')
		
		}

	} catch(error) {
		console.log(`Error getting leaderboard: ${error}`);
		res.status(500).send('Error getting leaderboard');
	}
})


app.get('/get-all-queue-length', async function(req, res) {

	try {
	
		// hit up the API @app.route('/get-queue-numbers', methods=['GET'])
		// AI_API_URL
		let response = await fetch(`${AI_API_URL}/get-queue-numbers`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json'
			}
		})

		let data = await response.json()

		res.send({
			status: 'success',
			data: data
		})

	} catch(error) {

		console.log(`Error getting all queue length: ${error}`);
		res.send({
			status: 'error',
			message: 'Error getting all queue length'
		})
	
	}

})


app.get('/fix-duplicate-upvotes', async function(req, res) {
	try {

		let dryRun = false
	
		let userBooru = await mongolib.getSchemaDocuments("userBooru", {
			upvotes: { $exists: true }
		})


		for (post of userBooru) {
			let upvotesRemoved = 0
			let upvotes = post.upvotes
			// upvotes is structured like: [{accountId: "123", timestamp: 1234567890}, {accountId: "123", timestamp: 1234567890}]
			// remove duplicates whilst keeping the timestamps:
			let uniqueUpvotes = []
			let uniqueAccountIds = new Set()
			for (upvote of upvotes) {
				if (!uniqueAccountIds.has(upvote.accountId)) {
					uniqueUpvotes.push(upvote)
					uniqueAccountIds.add(upvote.accountId)
				} else {
					upvotesRemoved++
				}
			}
			// update the post with the unique upvotes:
			if (dryRun) {
				console.log(`[DRY RUN] Post has ${upvotes.length} upvotes, ${upvotesRemoved} duplicates removed, ${uniqueUpvotes.length} unique upvotes`)
				console.log(`example upvotes: ${JSON.stringify(uniqueUpvotes)}`)
			} else {
				await mongolib.updateSchemaDocumentOnce("userBooru", {
					_id: post._id
				}, {
					upvotes: uniqueUpvotes
				})
				console.log(`Post has ${upvotes.length} upvotes, ${upvotesRemoved} duplicates removed, ${uniqueUpvotes.length} unique upvotes`)
			}
		}
		res.send({
			status: 'success',
			message: 'Fixed duplicate upvotes'
		})
	} catch(error) {
		console.log(`Error fixing duplicate upvotes: ${error}`);
		res.send({
			status: 'error',
			message: 'Error fixing duplicate upvotes'
		})
	}
})

app.get('/booru-post-title-set', async function(req, res) {

	try {

		let booruPosts = await mongolib.getSchemaDocuments("userBooru", {
			title: { $exists: false }
		})

		console.log(`Found ${booruPosts.length} posts without titles`)

		// get the first 100 posts:
		booruPosts = booruPosts.slice(0, 100)

		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		})

		res.render('booru/booru-post-title-set.ejs', {
			session: req.session,
			booruPosts: booruPosts,
			userProfile: userProfile
		})
	
	} catch(error) {
		console.log(`Error loading booru posts without titles: ${error}`);
		res.send({
			status: 'error',
			message: 'Error loading booru posts without titles'
		})
	}	
})

app.post('/booru-post-title-set', async function(req, res) {
	try {

		let booru_id = req.body.booru_id
		let title = req.body.title

		await mongolib.updateSchemaDocumentOnce("userBooru", {
			booru_id: booru_id
		}, {
			title: title
		})

		res.send({
			status: 'success',
			message: 'Booru post title set'
		})

	} catch(error) {
		console.log(`Error setting booru post titles: ${error}`);
		res.status(500).send({
			status: 'error',
			message: 'Error setting booru post title'
		})
	}
})




// Booru creator stats page
app.get('/booru/creator-stats', async function(req, res) {
    try {
        console.log("Starting creator stats calculation...");
        
        // Check if user is logged in
        if (!req.session.accountId) {
            return res.render('booru/creator-stats', {
                session: req.session,
                userStats: null
            });
        }

        const accountId = req.session.accountId;
        console.log(`Processing stats for account ID: ${accountId}`);
        
        // Time periods for stats calculation
        const now = Date.now();
        const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
        const previousTwentyFourHours = twentyFourHoursAgo - (24 * 60 * 60 * 1000);
        
        const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
        const previousSevenDays = sevenDaysAgo - (7 * 24 * 60 * 60 * 1000);
        
        const twentyEightDaysAgo = now - (28 * 24 * 60 * 60 * 1000);
        const previousTwentyEightDays = twentyEightDaysAgo - (28 * 24 * 60 * 60 * 1000);
                
        // Fetch all user booru posts with timestamps, votes, and comments
        const userBooruPosts = await mongolib.aggregateSchemaDocuments("userBooru", [
            { $match: { account_id: accountId } },
            { $project: {
                booru_id: 1,
                title: 1,
                content_url: 1,
                timestamp: { $toLong: "$timestamp" },
                upvotes: { $cond: { if: { $isArray: "$upvotes" }, then: "$upvotes", else: [] } },
                comments: { $cond: { if: { $isArray: "$comments" }, then: "$comments", else: [] } }
            }}
        ]);
        
        // Get follower count for the user (needed for leaderboard score calculation)
        const followedCountResult = await mongolib.aggregateSchemaDocuments("userProfile", [
            { $match: { followedAccounts: accountId } },
            { $count: "followedCount" }
        ]);
        const userFollowerCount = followedCountResult[0]?.followedCount || 1; // Default to 1 if no followers
        
        // Get highest follower count for normalization (same as in leaderboard)
        const highestFollowerCountData = await mongolib.aggregateSchemaDocuments("userProfile", [
            { $match: { followedAccounts: { $exists: true, $ne: [] } } },
            { $project: { followedCount: { $size: "$followedAccounts" } } },
            { $sort: { followedCount: -1 } },
            { $limit: 1 }
        ]);
        const highestFollowerCount = highestFollowerCountData[0]?.followedCount || userFollowerCount;
        
        // Calculate follower score modifier
        const followerScore = ((userFollowerCount / highestFollowerCount) / 7.14) + 0.95;
        
        console.log(`User followers: ${userFollowerCount}, Highest followers: ${highestFollowerCount}`);
        console.log(`Calculated follower score: ${followerScore}`);
        
        // Calculate total (all-time) Booru score
        const totalStats = {
            posts: userBooruPosts.length,
            upvotes: 0,
            comments: 0,
            totalVotes: 0,
            booruScore: 0,
            rawBooruScore: 0,
            followerBoost: followerScore
        };
        
        // Count all upvotes and comments for total score
        userBooruPosts.forEach(post => {
            totalStats.upvotes += (post.upvotes?.length || 0);
            totalStats.comments += (post.comments?.length || 0);
        });
        
        totalStats.totalVotes = totalStats.upvotes + totalStats.comments;
        
        // Calculate total Booru score using the leaderboard formula
        const totalCommentScore = 5 * Math.log2(1 + totalStats.comments);
        const totalUpvoteScore = 1.9 * totalStats.upvotes;
        const totalBaseScore = totalCommentScore + totalUpvoteScore;
        
        const totalActivityModifier = Math.max(0.5, Math.log10(1 + totalStats.posts)) * 80;
        const totalEngagementBoost = Math.log2(1 + totalStats.totalVotes / (totalStats.posts + 5)) * 12;
        
        totalStats.rawBooruScore = (totalBaseScore / totalActivityModifier) + totalEngagementBoost;
        totalStats.booruScore = totalStats.rawBooruScore * followerScore;
        
        console.log(`Total stats - Posts: ${totalStats.posts}, Upvotes: ${totalStats.upvotes}, Comments: ${totalStats.comments}`);
        console.log(`Total Booru score: ${totalStats.booruScore.toFixed(1)} (raw: ${totalStats.rawBooruScore.toFixed(1)})`);
        
        // Get top posts from the last 28 days
        const topPosts = userBooruPosts
            .filter(post => post.timestamp >= twentyEightDaysAgo)
            .map(post => {
                // Calculate a score based on upvotes and comments
                const score = (post.upvotes?.length || 0) * 2 + (post.comments?.length || 0) * 3;
                return { ...post, score };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 25);
        
        // Initialize stat objects
        const last24Hours = {
            posts: 0,
            upvotes: 0,
            comments: 0,
            postsChange: 0,
            upvotesChange: 0,
            commentsChange: 0,
            engagementRate: 0,
            engagementRateChange: 0,
            booruScore: 0,
            booruScoreChange: 0,
            rawBooruScore: 0,
            followerBoost: followerScore
        };
        
        const last7Days = {
            posts: 0,
            upvotes: 0,
            comments: 0,
            postsChange: 0,
            upvotesChange: 0,
            commentsChange: 0,
            engagementRate: 0,
            engagementRateChange: 0,
            booruScore: 0,
            booruScoreChange: 0,
            rawBooruScore: 0,
            followerBoost: followerScore
        };
        
        const last28Days = {
            posts: 0,
            upvotes: 0,
            comments: 0,
            postsChange: 0,
            upvotesChange: 0,
            commentsChange: 0,
            engagementRate: 0,
            engagementRateChange: 0,
            booruScore: 0,
            booruScoreChange: 0,
            rawBooruScore: 0,
            followerBoost: followerScore
        };
        
        // Initialize counters for previous periods
        const previous24Hours = { posts: 0, upvotes: 0, comments: 0 };
        const previous7Days = { posts: 0, upvotes: 0, comments: 0 };
        const previous28Days = { posts: 0, upvotes: 0, comments: 0 };
        
        // For daily chart data
        const dailyData = {};
        const lastNDays = 28; // Show data for last 28 days
        
        // Process each post
        userBooruPosts.forEach(post => {
            const postDate = new Date(parseInt(post.timestamp));
            const dayKey = postDate.toISOString().split('T')[0]; // YYYY-MM-DD format
            
            // Initialize daily data
            if (!dailyData[dayKey]) {
                dailyData[dayKey] = { posts: 0, upvotes: 0, comments: 0, booruScore: 0, totalVotes: 0 };
            }
            
            // Count the post
            dailyData[dayKey].posts++;
            
            // Count upvotes - filter for upvotes that happened in the time period
            const postUpvotes = post.upvotes || [];
            let dailyUpvotesCount = 0;
            
            postUpvotes.forEach(vote => {
                // Count all upvotes for this post on this day
                if (vote.timestamp) {
                    const voteDate = new Date(parseInt(vote.timestamp));
                    const voteDayKey = voteDate.toISOString().split('T')[0];
                    if (voteDayKey === dayKey) {
                        dailyUpvotesCount++;
                    }
                    
                    // Last 24 hours
                    if (vote.timestamp >= twentyFourHoursAgo) {
                        last24Hours.upvotes++;
                    } else if (vote.timestamp >= previousTwentyFourHours && vote.timestamp < twentyFourHoursAgo) {
                        previous24Hours.upvotes++;
                    }
                    
                    // Last 7 days
                    if (vote.timestamp >= sevenDaysAgo) {
                        last7Days.upvotes++;
                    } else if (vote.timestamp >= previousSevenDays && vote.timestamp < sevenDaysAgo) {
                        previous7Days.upvotes++;
                    }
                    
                    // Last 28 days
                    if (vote.timestamp >= twentyEightDaysAgo) {
                        last28Days.upvotes++;
                    } else if (vote.timestamp >= previousTwentyEightDays && vote.timestamp < twentyEightDaysAgo) {
                        previous28Days.upvotes++;
                    }
                }
            });
            
            // Add upvotes to daily data
            dailyData[dayKey].upvotes += dailyUpvotesCount;
            dailyData[dayKey].totalVotes += dailyUpvotesCount;
            
            // Count comments - filter for comments that happened in the time period
            const postComments = post.comments || [];
            let dailyCommentsCount = 0;
            
            postComments.forEach(comment => {
                // Count all comments for this post on this day
                if (comment.timestamp) {
                    const commentDate = new Date(parseInt(comment.timestamp));
                    const commentDayKey = commentDate.toISOString().split('T')[0];
                    if (commentDayKey === dayKey) {
                        dailyCommentsCount++;
                    }
                    
                    // Last 24 hours
                    if (comment.timestamp >= twentyFourHoursAgo) {
                        last24Hours.comments++;
                    } else if (comment.timestamp >= previousTwentyFourHours && comment.timestamp < twentyFourHoursAgo) {
                        previous24Hours.comments++;
                    }
                    
                    // Last 7 days
                    if (comment.timestamp >= sevenDaysAgo) {
                        last7Days.comments++;
                    } else if (comment.timestamp >= previousSevenDays && comment.timestamp < sevenDaysAgo) {
                        previous7Days.comments++;
                    }
                    
                    // Last 28 days
                    if (comment.timestamp >= twentyEightDaysAgo) {
                        last28Days.comments++;
                    } else if (comment.timestamp >= previousTwentyEightDays && comment.timestamp < twentyEightDaysAgo) {
                        previous28Days.comments++;
                    }
                }
            });
            
            // Add comments to daily data
            dailyData[dayKey].comments += dailyCommentsCount;
            dailyData[dayKey].totalVotes += dailyCommentsCount;
            
            // Count posts by time period
            if (post.timestamp >= twentyFourHoursAgo) {
                last24Hours.posts++;
            } else if (post.timestamp >= previousTwentyFourHours && post.timestamp < twentyFourHoursAgo) {
                previous24Hours.posts++;
            }
            
            if (post.timestamp >= sevenDaysAgo) {
                last7Days.posts++;
            } else if (post.timestamp >= previousSevenDays && post.timestamp < sevenDaysAgo) {
                previous7Days.posts++;
            }
            
            if (post.timestamp >= twentyEightDaysAgo) {
                last28Days.posts++;
            } else if (post.timestamp >= previousTwentyEightDays && post.timestamp < twentyEightDaysAgo) {
                previous28Days.posts++;
            }
        });
        
        // Calculate percentage changes
        last24Hours.postsChange = previous24Hours.posts === 0 
            ? (last24Hours.posts > 0 ? 100 : 0) 
            : Math.round(((last24Hours.posts - previous24Hours.posts) / previous24Hours.posts) * 100);
            
        last24Hours.upvotesChange = previous24Hours.upvotes === 0 
            ? (last24Hours.upvotes > 0 ? 100 : 0) 
            : Math.round(((last24Hours.upvotes - previous24Hours.upvotes) / previous24Hours.upvotes) * 100);

        last24Hours.commentsChange = previous24Hours.comments === 0 
            ? (last24Hours.comments > 0 ? 100 : 0) 
            : Math.round(((last24Hours.comments - previous24Hours.comments) / previous24Hours.comments) * 100);
        
        last7Days.postsChange = previous7Days.posts === 0 
            ? (last7Days.posts > 0 ? 100 : 0) 
            : Math.round(((last7Days.posts - previous7Days.posts) / previous7Days.posts) * 100);
            
        last7Days.upvotesChange = previous7Days.upvotes === 0 
            ? (last7Days.upvotes > 0 ? 100 : 0) 
            : Math.round(((last7Days.upvotes - previous7Days.upvotes) / previous7Days.upvotes) * 100);

        last7Days.commentsChange = previous7Days.comments === 0 
            ? (last7Days.comments > 0 ? 100 : 0) 
            : Math.round(((last7Days.comments - previous7Days.comments) / previous7Days.comments) * 100);
        
        last28Days.postsChange = previous28Days.posts === 0 
            ? (last28Days.posts > 0 ? 100 : 0) 
            : Math.round(((last28Days.posts - previous28Days.posts) / previous28Days.posts) * 100);
            
        last28Days.upvotesChange = previous28Days.upvotes === 0 
            ? (last28Days.upvotes > 0 ? 100 : 0) 
            : Math.round(((last28Days.upvotes - previous28Days.upvotes) / previous28Days.upvotes) * 100);

        last28Days.commentsChange = previous28Days.comments === 0 
            ? (last28Days.comments > 0 ? 100 : 0) 
            : Math.round(((last28Days.comments - previous28Days.comments) / previous28Days.comments) * 100);
        
        // Calculate engagement rates (upvotes per post)
        last24Hours.engagementRate = last24Hours.posts > 0 
            ? last24Hours.upvotes / last24Hours.posts 
            : 0;
            
        const previous24HoursEngagementRate = previous24Hours.posts > 0 
            ? previous24Hours.upvotes / previous24Hours.posts 
            : 0;
            
        last24Hours.engagementRateChange = previous24HoursEngagementRate === 0 
            ? (last24Hours.engagementRate > 0 ? 100 : 0) 
            : Math.round(((last24Hours.engagementRate - previous24HoursEngagementRate) / previous24HoursEngagementRate) * 100);
        
        last7Days.engagementRate = last7Days.posts > 0 
            ? last7Days.upvotes / last7Days.posts 
            : 0;
            
        const previous7DaysEngagementRate = previous7Days.posts > 0 
            ? previous7Days.upvotes / previous7Days.posts 
            : 0;
            
        last7Days.engagementRateChange = previous7DaysEngagementRate === 0 
            ? (last7Days.engagementRate > 0 ? 100 : 0) 
            : Math.round(((last7Days.engagementRate - previous7DaysEngagementRate) / previous7DaysEngagementRate) * 100);
        
        last28Days.engagementRate = last28Days.posts > 0 
            ? last28Days.upvotes / last28Days.posts 
            : 0;
            
        const previous28DaysEngagementRate = previous28Days.posts > 0 
            ? previous28Days.upvotes / previous28Days.posts 
            : 0;
            
        last28Days.engagementRateChange = previous28DaysEngagementRate === 0 
            ? (last28Days.engagementRate > 0 ? 100 : 0) 
            : Math.round(((last28Days.engagementRate - previous28DaysEngagementRate) / previous28DaysEngagementRate) * 100);
        
        // Calculate Booru Score
        {
            const totalVotes24h = last24Hours.upvotes + last24Hours.comments;
            const commentScore24h = 5 * Math.log2(1 + last24Hours.comments);
            const upvoteScore24h = 1.9 * last24Hours.upvotes;
            const baseScore24h = commentScore24h + upvoteScore24h;
            
            // Add grace period for new posts - don't penalize posts less than 24 hours old
            const gracePeriod = 24 * 60 * 60 * 1000; // 24 hours in ms
            const postsWithGracePeriod = userBooruPosts.filter(post => {
                // Count posts older than grace period or newer posts with good engagement
                const postAge = now - post.timestamp;
                // New posts in grace period won't hurt score
                if (postAge < gracePeriod) {
                    return false; // Don't count very new posts for activity penalty
                }
                return post.timestamp >= twentyFourHoursAgo;
            }).length;
            
            const adjustedPostCount = Math.max(1, postsWithGracePeriod); // Ensure at least 1 post
            const activityModifier24h = Math.max(0.5, Math.log10(1 + adjustedPostCount)) * 80;
            const engagementBoost24h = Math.log2(1 + totalVotes24h / (adjustedPostCount + 5)) * 12;
            
            last24Hours.rawBooruScore = (baseScore24h / activityModifier24h) + engagementBoost24h;
            last24Hours.booruScore = last24Hours.rawBooruScore * followerScore;
            
            // Previous 24 hours
            const prevTotalVotes24h = previous24Hours.upvotes + previous24Hours.comments;
            const prevCommentScore24h = 5 * Math.log2(1 + previous24Hours.comments);
            const prevUpvoteScore24h = 1.9 * previous24Hours.upvotes;
            const prevBaseScore24h = prevCommentScore24h + prevUpvoteScore24h;
            
            const prevPostsWithGracePeriod = userBooruPosts.filter(post => {
                const postAge = twentyFourHoursAgo - post.timestamp;
                if (postAge < gracePeriod) {
                    return false;
                }
                return post.timestamp >= previousTwentyFourHours && post.timestamp < twentyFourHoursAgo;
            }).length;
            
            const prevAdjustedPostCount = Math.max(1, prevPostsWithGracePeriod);
            const prevActivityModifier24h = Math.max(0.5, Math.log10(1 + prevAdjustedPostCount)) * 80;
            const prevEngagementBoost24h = Math.log2(1 + prevTotalVotes24h / (prevAdjustedPostCount + 5)) * 12;
            
            previous24Hours.booruScore = ((prevBaseScore24h / prevActivityModifier24h) + prevEngagementBoost24h) * followerScore;
            
            last24Hours.booruScoreChange = previous24Hours.booruScore === 0
                ? (last24Hours.booruScore > 0 ? 100 : 0)
                : Math.round(((last24Hours.booruScore - previous24Hours.booruScore) / previous24Hours.booruScore) * 100);
        }
        
        {
            const totalVotes7d = last7Days.upvotes + last7Days.comments;
            const commentScore7d = 5 * Math.log2(1 + last7Days.comments);
            const upvoteScore7d = 1.9 * last7Days.upvotes;
            const baseScore7d = commentScore7d + upvoteScore7d;
            
            // Add grace period for new posts - don't penalize posts less than 24 hours old
            const gracePeriod = 24 * 60 * 60 * 1000; // 24 hours in ms
            const postsWithGracePeriod = userBooruPosts.filter(post => {
                // Count posts older than grace period or newer posts with good engagement
                const postAge = now - post.timestamp;
                if (postAge < gracePeriod) {
                    return false; // Don't count very new posts for activity penalty
                }
                return post.timestamp >= sevenDaysAgo;
            }).length;
            
            const adjustedPostCount = Math.max(1, postsWithGracePeriod); // Ensure at least 1 post
            const activityModifier7d = Math.max(0.5, Math.log10(1 + adjustedPostCount)) * 80;
            const engagementBoost7d = Math.log2(1 + totalVotes7d / (adjustedPostCount + 5)) * 12;
            
            last7Days.rawBooruScore = (baseScore7d / activityModifier7d) + engagementBoost7d;
            last7Days.booruScore = last7Days.rawBooruScore * followerScore;
            
            // Previous 7 days
            const prevTotalVotes7d = previous7Days.upvotes + previous7Days.comments;
            const prevCommentScore7d = 5 * Math.log2(1 + previous7Days.comments);
            const prevUpvoteScore7d = 1.9 * previous7Days.upvotes;
            const prevBaseScore7d = prevCommentScore7d + prevUpvoteScore7d;
            
            const prevPostsWithGracePeriod = userBooruPosts.filter(post => {
                const postAge = sevenDaysAgo - post.timestamp;
                if (postAge < gracePeriod) {
                    return false;
                }
                return post.timestamp >= previousSevenDays && post.timestamp < sevenDaysAgo;
            }).length;
            
            const prevAdjustedPostCount = Math.max(1, prevPostsWithGracePeriod);
            const prevActivityModifier7d = Math.max(0.5, Math.log10(1 + prevAdjustedPostCount)) * 80;
            const prevEngagementBoost7d = Math.log2(1 + prevTotalVotes7d / (prevAdjustedPostCount + 5)) * 12;
            
            previous7Days.booruScore = ((prevBaseScore7d / prevActivityModifier7d) + prevEngagementBoost7d) * followerScore;
            
            last7Days.booruScoreChange = previous7Days.booruScore === 0
                ? (last7Days.booruScore > 0 ? 100 : 0)
                : Math.round(((last7Days.booruScore - previous7Days.booruScore) / previous7Days.booruScore) * 100);
        }
        
        {
            const totalVotes28d = last28Days.upvotes + last28Days.comments;
            const commentScore28d = 5 * Math.log2(1 + last28Days.comments);
            const upvoteScore28d = 1.9 * last28Days.upvotes;
            const baseScore28d = commentScore28d + upvoteScore28d;
            
            // Add grace period for new posts - don't penalize posts less than 24 hours old
            const gracePeriod = 24 * 60 * 60 * 1000; // 24 hours in ms
            const postsWithGracePeriod = userBooruPosts.filter(post => {
                // Count posts older than grace period or newer posts with good engagement
                const postAge = now - post.timestamp;
                if (postAge < gracePeriod) {
                    return false; // Don't count very new posts for activity penalty
                }
                return post.timestamp >= twentyEightDaysAgo;
            }).length;
            
            const adjustedPostCount = Math.max(1, postsWithGracePeriod); // Ensure at least 1 post
            const activityModifier28d = Math.max(0.5, Math.log10(1 + adjustedPostCount)) * 80;
            const engagementBoost28d = Math.log2(1 + totalVotes28d / (adjustedPostCount + 5)) * 12;
            
            last28Days.rawBooruScore = (baseScore28d / activityModifier28d) + engagementBoost28d;
            last28Days.booruScore = last28Days.rawBooruScore * followerScore;
            
            // Previous 28 days
            const prevTotalVotes28d = previous28Days.upvotes + previous28Days.comments;
            const prevCommentScore28d = 5 * Math.log2(1 + previous28Days.comments);
            const prevUpvoteScore28d = 1.9 * previous28Days.upvotes;
            const prevBaseScore28d = prevCommentScore28d + prevUpvoteScore28d;
            
            const prevPostsWithGracePeriod = userBooruPosts.filter(post => {
                const postAge = twentyEightDaysAgo - post.timestamp;
                if (postAge < gracePeriod) {
                    return false;
                }
                return post.timestamp >= previousTwentyEightDays && post.timestamp < twentyEightDaysAgo;
            }).length;
            
            const prevAdjustedPostCount = Math.max(1, prevPostsWithGracePeriod);
            const prevActivityModifier28d = Math.max(0.5, Math.log10(1 + prevAdjustedPostCount)) * 80;
            const prevEngagementBoost28d = Math.log2(1 + prevTotalVotes28d / (prevAdjustedPostCount + 5)) * 12;
            
            previous28Days.booruScore = ((prevBaseScore28d / prevActivityModifier28d) + prevEngagementBoost28d) * followerScore;
            
            last28Days.booruScoreChange = previous28Days.booruScore === 0
                ? (last28Days.booruScore > 0 ? 100 : 0)
                : Math.round(((last28Days.booruScore - previous28Days.booruScore) / previous28Days.booruScore) * 100);
        }
        
        // Also apply grace period to all-time Booru score
        {
            const gracePeriod = 24 * 60 * 60 * 1000; // 24 hours in ms
            const postsWithGracePeriod = userBooruPosts.filter(post => {
                const postAge = now - post.timestamp;
                return postAge >= gracePeriod; // Only count posts older than grace period
            }).length;
            
            const adjustedPostCount = Math.max(1, postsWithGracePeriod);
            const adjustedActivityModifier = Math.max(0.5, Math.log10(1 + adjustedPostCount)) * 80;
            const adjustedEngagementBoost = Math.log2(1 + totalStats.totalVotes / (adjustedPostCount + 5)) * 12;
            
            totalStats.rawBooruScore = (totalBaseScore / adjustedActivityModifier) + adjustedEngagementBoost;
            totalStats.booruScore = totalStats.rawBooruScore * followerScore;
        }
        
        // Prepare chart data
        const sortedDays = Object.keys(dailyData).sort();
        const recentDays = sortedDays.slice(-lastNDays); // Last N days
        
        // Precalculate follower score to avoid reference errors
        console.log(`Applying follower score ${followerScore} to chart data`);
        
        // Calculate daily Booru Scores for the chart
        recentDays.forEach(day => {
            const data = dailyData[day];
            
            // Base score calculation
            const commentScore = 5 * Math.log2(1 + data.comments);
            const upvoteScore = 1.9 * data.upvotes;
            const baseScore = commentScore + upvoteScore;
            
            // Engagement and activity modifiers
            const activityModifier = Math.max(0.5, Math.log10(1 + data.posts)) * 80;
            const engagementBoost = Math.log2(1 + data.totalVotes / (data.posts + 5)) * 12;
            
            // Calculate raw score
            const rawScore = (baseScore / activityModifier) + engagementBoost;
            
            // Apply follower boost (using the previously calculated followerScore)
            data.booruScore = rawScore * followerScore;
        });
        
        const dailyLabels = recentDays.map(date => {
            const [year, month, day] = date.split('-');
            return `${month}/${day}`;
        });
        
        const dailyUpvotes = recentDays.map(date => dailyData[date].upvotes);
        const dailyComments = recentDays.map(date => dailyData[date].comments);
        const dailyPosts = recentDays.map(date => dailyData[date].posts);
        const dailyEngagement = recentDays.map(date => {
            const posts = dailyData[date].posts;
            return posts > 0 ? (dailyData[date].upvotes / posts) : 0;
        });
        const dailyBooruScores = recentDays.map(date => dailyData[date].booruScore);
        
        const userStats = {
            last24Hours,
            last7Days,
            last28Days,
            dailyLabels,
            dailyUpvotes,
            dailyComments,
            dailyPosts,
            dailyEngagement,
            dailyBooruScores,
            topPosts,
            followerCount: userFollowerCount,
            totalStats
        };
        
        // Render the page with stats
        res.render('booru/creator-stats', {
            session: req.session,
            userStats
        });
        
    } catch (error) {
        console.log(`Error loading creator stats: ${error}`);
        res.status(500).send('Error loading creator statistics');
    }
});

app.post('/image-history/download-page', async (req, res) => {
	try {
		const accountId = req.session.accountId;

		// Fetch user profile
		const userProfile = await mongolib.getSchemaDocumentOnce("userProfile", { accountId });
		
		if (userProfile == null) {
		res.send({
			status: 'error',
			message: 'User not found'
		})
		return
	}

		const { imageIds } = req.body;

		// Fetch user history
		const images = await mongolib.aggregateSchemaDocuments("userHistory", [
		{ $match: { account_id: accountId, image_id: { $in: imageIds } } },
		{ $sort: { timestamp: -1 } }
		]);

		if (images.length === 0) {
		return res.status(404).json({ status: 'error', message: 'No images found' });
		}

		// Extract relative file paths
		const imagePaths = images.map(image => {
		const imageUrl = image.image_url;
		const relativePath = imageUrl.split('.com/')[1];
		if (!relativePath) throw new Error(`Invalid URL format: ${imageUrl}`);
		return relativePath;
		});

		// Prepare temp directory and zip file
		const tempFolder = path.join(__dirname, `temp/${accountId}`);
		const tempFilePath = path.join(tempFolder, `${Date.now()}.zip`);

		if (!fs.existsSync(tempFolder)) {
		fs.mkdirSync(tempFolder, { recursive: true });
		}

		const output = fs.createWriteStream(tempFilePath);
		const zip = archiver('zip', { zlib: { level: 9 } });

		output.on('close', async () => {
		console.log(`Zip file created: ${tempFilePath}`);
		res.setHeader('Content-Disposition', `attachment; filename="jscammie-images-${Date.now()}.zip"`);
		await res.download(tempFilePath, `jscammie-images-${Date.now()}.zip`, () => {
			fs.unlinkSync(tempFilePath); // Clean up temp file
		});
		});

		zip.on('error', err => {
		console.error('Archiver error:', err);
		res.status(500).json({ status: 'error', message: 'Failed to create zip file' });
		});

		zip.pipe(output);

		imagePaths.forEach(imagePath => {
		const fullPath = path.join(__dirname, imagePath);
		if (fs.existsSync(fullPath)) {
			zip.file(fullPath, { name: path.basename(imagePath) });
		} else {
			console.warn(`File not found: ${fullPath}`);
		}
		});

		await zip.finalize();
	} catch (error) {
		console.error('Error in download-page route:', error);
		res.status(500).json({ status: 'error', message: 'Internal server error' });
	}
});




// Profile Upgrades Page
app.get('/profile-upgrades', async function(req, res) {
	let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
		accountId: req.session.accountId
	})

	res.render('profile-upgrades', {
		session: req.session,
		userProfile: userProfile
	});
})

// Calculate upgrade cost for history slots
function calculateHistorySlotsPrice(currentLimit, amount) {
	// Base cost is 2 credits per slot
	const baseCost = 3.1;
	
	// Use exponential scaling based on the number of 5000-slot tiers already purchased
	const tiersPurchased = Math.floor(currentLimit / 1000);
	const exponentialFactor = 1.08; // Price increases by 50% for each tier
	
	// Calculate price per slot using exponential growth
	const pricePerSlot = baseCost * Math.pow(exponentialFactor, tiersPurchased);
	
	// Calculate total upgrade cost and round to nearest thousand
	const exactPrice = amount * pricePerSlot;
	return Math.round(exactPrice / 100) * 100;
}

// Profile Upgrades Price Endpoint
app.post('/profile-upgrades/price', async function(req, res) {
	try {

		const { upgrade, amount } = req.body;
		
		// Get user profile
		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		});

		if (!userProfile) {
			return res.status(404).json({
				status: 'error',
				message: 'User profile not found'
			});
		}

		// Handle different upgrade types
		if (upgrade === 'history-slots') {
			// Calculate price based on current limit
			const currentLimit = userProfile.variables.userHistoryLimit;
			const price = calculateHistorySlotsPrice(currentLimit, amount);
			
			return res.json({
				status: 'success',
				price: price,
				canAfford: userProfile.credits >= price
			});
		} else {
			return res.status(400).json({
				status: 'error',
				message: 'Invalid upgrade type'
			});
		}
	} catch (error) {
		console.error('Error calculating upgrade price:', error);
		return res.status(500).json({
			status: 'error',
			message: 'An error occurred while calculating the price'
		});
	}
});

// Profile Upgrades Purchase Endpoint
app.post('/profile-upgrades/purchase', async function(req, res) {
	try {

		const { upgrade, amount } = req.body;
		
		// Get user profile
		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		});

		if (!userProfile) {
			return res.status(404).json({
				status: 'error',
				message: 'User profile not found'
			});
		}

		// Handle different upgrade types
		if (upgrade === 'history-slots') {
			// Calculate price based on current limit
			const currentLimit = userProfile.variables.userHistoryLimit;
			const upgradeCost = calculateHistorySlotsPrice(currentLimit, amount);
			
			// Check if user has enough credits
			if (userProfile.credits < upgradeCost) {
				return res.status(400).json({
					status: 'error',
					message: 'Not enough credits for this upgrade'
				});
			}

			// Get current limit
			const newLimit = currentLimit + amount;

			// Update user profile with new limit
			await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				'variables.userHistoryLimit': newLimit
			});

			// Subtract credits
			const creditsResult = await mongolib.modifyUserCredits(
				req.session.accountId,
				upgradeCost,
				'-',
				`Purchased ${amount} additional image history slots (${upgradeCost} credits)`
			);

			if (creditsResult === null) {
				return res.status(400).json({
					status: 'error',
					message: 'Failed to process credits for upgrade'
				});
			}

			// Create notification for user
			await mongolib.createUserNotification(
				req.session.accountId,
				`You have purchased ${amount} additional image history slots for ${upgradeCost} credits. Your new limit is ${newLimit} images.`,
				'upgrade'
			);

			return res.json({
				status: 'success',
				message: `Successfully upgraded image history limit to ${newLimit} slots`,
				newLimit: newLimit,
				newCredits: creditsResult
			});
		} else {
			return res.status(400).json({
				status: 'error',
				message: 'Invalid upgrade type'
			});
		}
	} catch (error) {
		console.error('Error processing upgrade purchase:', error);
		return res.status(500).json({
			status: 'error',
			message: 'An error occurred while processing your purchase'
		});
	}
});




const fsp = require('fs/promises');


app.get('/fix-user-history', async function (req, res) {
	try {
		const dryRun = false
		const baseDir = './imagesHistory/';

		const dir = await fsp.opendir(baseDir);
		let totalRemoved = 0;
		let totalDeletedAccounts = 0;

		for await (const dirent of dir) {
			if (!dirent.isDirectory()) continue;
			const accountId = dirent.name;
			const accountPath = path.join(baseDir, accountId);

			const userHistory = await mongolib.getSchemaDocuments('userHistory', { account_id: accountId });
			if (!userHistory.length) {
				// No history > delete entire folder
				if (dryRun) {
					console.log(`[DryRun] Would delete folder: ${accountId}`);
				} else {
					fs.rmSync(accountPath, { recursive: true, force: true });
					console.log(`Deleted folder: ${accountId}`);
				}
				totalDeletedAccounts++;
				continue;
			}

			// Keep only valid image IDs
			const imageIDsToKeep = userHistory.map((image) => image.image_id.toString());
			const files = fs.readdirSync(accountPath);
			let removedCount = 0;

			for (const file of files) {
				const base = file.split('.')[0].split('-')[0];
				if (!imageIDsToKeep.includes(base)) {
					const imagePath = path.join(accountPath, file);
					if (dryRun) {
						// console.log(`[DryRun] Would delete: ${accountId}/${file}`);
					} else {
						fs.unlinkSync(imagePath);
						// console.log(`Deleted: ${accountId}/${file}`);
					}
					removedCount++;
					totalRemoved++;
				}
			}

			if (removedCount > 0) {
				console.log(`Cleaned ${removedCount} files from ${accountId}`);
			}
			// Free memory
			imageIDsToKeep.length = 0;
		}

		res.send({
			status: 'success',
			message: `Cleanup ${dryRun ? '[Dry Run]' : ''} done. Removed ${totalRemoved} files. Deleted ${totalDeletedAccounts} folders.`,
		});
	} catch (err) {
		console.error(err);
		res.status(500).send({
			status: 'error',
			message: err.message,
		});
	}
});
	

// // Prune older images, keeping only the most recent 5000
// app.get('/prune-old-images', async function (req, res) {
//     try {
//         const dryRun = false; // Set to false to actually delete files
//         const maxImagesToKeep = 5000;
//         const baseDir = './imagesHistory/';
//         const batchSize = 100; // Process images in batches
//         const testAccountId = req.query.account_id; // Get optional account_id from query params

//         // Get account(s) to process
//         let accounts;
//         if (testAccountId) {
//             // If testing specific account, only get that one
//             accounts = [{ _id: testAccountId }];
//             console.log(`Test mode: Only processing account ${testAccountId}`);
//         } else {
//             // Otherwise get all accounts
//             accounts = await mongolib.aggregateSchemaDocuments('userHistory', [
//                 { $group: { _id: "$account_id" } }
//             ]);
//         }

//         let totalRemoved = 0;
//         let totalProcessed = 0;

//         // Process each account
//         for (const accountObj of accounts) {
//             const accountId = accountObj._id;
            
//             // Get total images for this account
//             const accountImages = await mongolib.aggregateSchemaDocuments('userHistory', [
//                 { $match: { account_id: accountId } },
//                 { $count: "total" }
//             ]);

//             const totalAccountImages = accountImages[0]?.total || 0;

//             if (totalAccountImages <= maxImagesToKeep) {
//                 console.log(`Account ${accountId} has ${totalAccountImages} images, no pruning needed`);
//                 continue;
//             }

//             console.log(`Processing account ${accountId} with ${totalAccountImages} images`);

//             // Get the cutoff point for this account using image_id
//             const cutoffImage = await mongolib.aggregateSchemaDocuments('userHistory', [
//                 { $match: { account_id: accountId } },
//                 { $sort: { image_id: -1 } },
//                 { $skip: maxImagesToKeep - 1 },
//                 { $limit: 1 }
//             ]);

//             if (!cutoffImage || !cutoffImage[0]) continue;

//             const cutoffImageId = cutoffImage[0].image_id;
//             console.log(`Will remove images older than image_id: ${cutoffImageId} for account ${accountId}`);

//             let processedForAccount = 0;
//             let hasMore = true;

//             // Process images for this account in batches
//             while (hasMore) {
//                 const query = { 
//                     account_id: accountId, 
//                     image_id: { $lt: cutoffImageId } 
//                 };

//                 const entries = await mongolib.getSchemaDocuments('userHistory', query, {
//                     sort: { image_id: -1 },
//                     limit: batchSize
//                 });

//                 if (!entries || entries.length === 0) {
//                     hasMore = false;
//                     continue;
//                 }

//                 const accountPath = path.join(baseDir, accountId);

//                 if (fs.existsSync(accountPath)) {
//                     const files = await fsp.readdir(accountPath);
                    
//                     // Process each image in the batch
//                     for (const image of entries) {
//                         for (const file of files) {
//                             const base = file.split('.')[0].split('-')[0];
//                             if (base === image.image_id.toString()) {
//                                 const imagePath = path.join(accountPath, file);
//                                 if (dryRun) {
//                                     console.log(`[DryRun] Would delete: ${accountId}/${file}`);
//                                 } else {
//                                     try {
//                                         await fsp.unlink(imagePath);
//                                         console.log(`Deleted: ${accountId}/${file}`);
//                                     } catch (err) {
//                                         console.error(`Error deleting file ${imagePath}:`, err);
//                                     }
//                                 }
//                                 totalRemoved++;
//                             }
//                         }

//                         // Remove database entry
//                         if (!dryRun) {
//                             await mongolib.deleteSchemaDocument("userHistory", {
//                                 account_id: accountId,
//                                 image_id: image.image_id
//                             })
//                         }

//                         processedForAccount++;
//                         totalProcessed++;
//                     }
//                 }

//                 if (processedForAccount % 100 === 0) {
//                     console.log(`Account ${accountId}: Processed ${processedForAccount} images, Total removed: ${totalRemoved} files`);
//                 }

//                 // Brief pause between batches to prevent overwhelming the system
//                 await new Promise(resolve => setTimeout(resolve, 100));
//             }

//             console.log(`Finished account ${accountId}: Processed ${processedForAccount} images`);
//         }

//         const testModeMsg = testAccountId ? ` (Test mode for account ${testAccountId})` : '';
//         res.send({
//             status: 'success',
//             message: `Pruning ${dryRun ? '[Dry Run]' : ''}${testModeMsg} done. Removed ${totalRemoved} image files and processed ${totalProcessed} entries.`
//         });
//     } catch (err) {
//         console.error(err);
//         res.status(500).send({
//             status: 'error',
//             message: err.message
//         });
//     }
// });




app.get('/.well-known/pki-validation/BD4ADEC68E8CA80AB663C847A5D5990E.txt', async function(req, res) {
	// send the BD4ADEC68E8CA80AB663C847A5D5990E.txt file:
	res.sendFile(path.join(__dirname, 'BD4ADEC68E8CA80AB663C847A5D5990E.txt'));
})







const http = require('http')
const https = require('https');
const { count } = require('console');

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