require('dotenv').config();

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
const booruRoutes = require('./routes/booru');

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

// Version timestamp for cache busting (regenerated on server restart)
let VERSION_TIMESTAMP = Date.now();

// Make version available to all EJS templates
app.locals.version = VERSION_TIMESTAMP;

// Function to update version and force cache invalidation
function updateVersion() {
	VERSION_TIMESTAMP = Date.now();
	app.locals.version = VERSION_TIMESTAMP;
	console.log(`Version updated to: ${VERSION_TIMESTAMP}`);
	return VERSION_TIMESTAMP;
}

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


// Static file serving with cache control
app.use(express.static(__dirname, {
	setHeaders: function (res, path, stat) {
		// Cache static assets for a short time, but allow revalidation
		if (path.endsWith('.css') || path.endsWith('.js')) {
			// CSS and JS files - short cache with revalidation
			res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
		} else if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.gif') || path.endsWith('.webp') || path.endsWith('.svg')) {
			// Images can be cached longer since they change less frequently
			res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
		} else if (path.endsWith('.html') || path.endsWith('.ejs')) {
			// HTML pages should not be cached
			res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
			res.setHeader('Pragma', 'no-cache');
			res.setHeader('Expires', '0');
		} else {
			// Default for other files
			res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
		}
		
		// Add ETag for all files to enable conditional requests
		res.setHeader('ETag', '"' + stat.mtime.getTime() + '-' + stat.size + '"');
	}
}));

function enforceSecureDomain(req, res, next) {
    // Skip enforcement if host header is missing
    if (!req.headers.host) {
        return next();
    }
    
    if (req.headers.host.slice(0, 4) !== 'www.' || !req.secure && req.get('x-forwarded-proto') !== 'https') {
        const host = req.headers.host.slice(0, 4) !== 'www.' ? 'www.' + req.headers.host : req.headers.host;
        return res.redirect(301, `https://${host}${req.url}`);
    }
    next();
}
app.use(enforceSecureDomain);

app.set('trust proxy', true);

// Middleware to prevent caching of dynamic HTML pages
app.use((req, res, next) => {
	// Only apply no-cache headers to HTML requests (not API endpoints)
	if (req.accepts('html') && !req.path.startsWith('/api/')) {
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
	}
	next();
});

const userProfileSchema = require('./schemas/userProfileSchemaNew.js');
const userSuggestionSchema = require('./schemas/userSuggestionSchema.js');
const userHistorySchema = require('./schemas/userHistorySchema.js');
const UsernameUtils = require('./utils/usernameUtils.js');

const generationLoraSchema = require('./schemas/generationLoraSchema.js');

async function showMessagePage(res, req, message) {
	res.render('message', {
		message: message,
		session: req.session
	})
}

// re-route 404 errors to a showMessagePage function, only if its 404 though:
app.use((req, res, next) => {
	if (res.statusCode === 404) {
		showMessagePage(res, req, '404 Not Found');
	} else {
		next();
	}
})

// setup views directory:
app.set('views', './views')

app.get('/aibeta', (req, res) => {
	res.render('aibeta', {
		session: req.session
	})
})

app.get('/home', (req, res) => {
	// Handle success notifications from OAuth redirects
	let notification = null;
	if (req.query.linked === 'google') {
		notification = {
			type: 'success',
			message: 'Google account successfully linked to your profile!'
		};
	} else if (req.query.linked === 'discord') {
		notification = {
			type: 'success',
			message: 'Discord account successfully linked to your profile!'
		};
	} else if (req.query.login === 'success') {
		notification = {
			type: 'success',
			message: 'Welcome! You have successfully logged in.'
		};
	}
	
	res.render('home', {
		session: req.session,
		notification: notification
	});
})

app.get('/login', async (req, res) => {
	let userProfile = null;
	let connectedProviders = [];
	let activeProviders = [];
	let notification = null;
	
	// Handle logout messages
	if (req.query.message === 'logged_out') {
		notification = {
			type: 'info',
			message: 'You have been logged out successfully.'
		};
	} else if (req.query.message === 'logged_out_all') {
		notification = {
			type: 'info',
			message: 'You have been logged out from all providers successfully.'
		};
	}
	
	// If user is already logged in, get their profile information
	if (req.session.loggedIn && req.session.accountId) {
		try {
			userProfile = await userProfileSchema.findOne({
				accountId: req.session.accountId
			});
			
			if (userProfile && userProfile.oauthProviders) {
				// Get list of connected providers from database
				connectedProviders = Object.keys(userProfile.oauthProviders);
			}
			
			// Get list of active session providers
			if (req.session.discord) activeProviders.push('discord');
			if (req.session.google) activeProviders.push('google');
			
		} catch (error) {
			console.error('Error fetching user profile for login page:', error);
		}
	}
	
	res.render('login', {
		session: req.session,
		userProfile: userProfile,
		connectedProviders: connectedProviders,
		activeProviders: activeProviders,
		notification: notification
	});
})

app.get('/logout', (req, res) => {
	req.session.destroy((err) => {
		if (err) {
			console.error("Session destruction error:", err);
			return res.redirect('back');
		}
		res.redirect('/login?message=logged_out');
	});
});

app.get('/logout-all', (req, res) => {
	// Same as regular logout - destroy entire session
	req.session.destroy((err) => {
		if (err) {
			console.error("Session destruction error:", err);
			return res.redirect('back');
		}
		res.redirect('/login?message=logged_out_all');
	});
});

app.get('/auth/discord', (req, res) => {
	res.render('discordcallback', {
		session: req.session
	})
})

// Google OAuth routes
app.get('/auth/google', (req, res) => {
	const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
		`client_id=${process.env.GOOGLE_OAUTH_CLIENT_ID}&` +
		`redirect_uri=${encodeURIComponent(process.env.GOOGLE_OAUTH_REDIRECT_URI)}&` +
		`response_type=code&` +
		`scope=openid%20profile%20email&` +
		`access_type=offline`;
	
	// Debug logging
	console.log('Google OAuth initiation:', {
		client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ? 'present' : 'missing',
		redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
		session: {
			loggedIn: req.session?.loggedIn,
			accountId: req.session?.accountId
		},
		googleAuthUrl: googleAuthUrl
	});
	
	res.redirect(googleAuthUrl);
});

app.get('/auth/google/callback', async (req, res) => {
	const { code, error } = req.query;
	
	// Debug logging
	console.log('Google OAuth callback received:', {
		code: code ? 'present' : 'missing',
		error: error,
		query: req.query,
		session: {
			loggedIn: req.session?.loggedIn,
			accountId: req.session?.accountId
		}
	});
	
	if (error) {
		console.error('Google OAuth error:', error);
		return res.redirect('/login?error=oauth_error');
	}
	
	if (!code) {
		console.error('No authorization code received from Google');
		return res.redirect('/login?error=no_code');
	}
	
	try {
		const AuthenticationHandler = require('./auth/AuthenticationHandler.js');
		const authHandler = new AuthenticationHandler();
		
		// Exchange code for access token
		const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
				client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
				code: code,
				grant_type: 'authorization_code',
				redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
			}),
		});
		
		if (!tokenResponse.ok) {
			throw new Error(`Token exchange failed: ${tokenResponse.statusText}`);
		}
		
		const tokenData = await tokenResponse.json();
		
		// Get user info from Google
		const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: {
				'Authorization': `Bearer ${tokenData.access_token}`,
			},
		});
		
		if (!userResponse.ok) {
			throw new Error(`User info fetch failed: ${userResponse.statusText}`);
		}
		
		const googleUser = await userResponse.json();
		
		// Process authentication using AuthenticationHandler
		const authResult = await authHandler.handleProviderAuth('google', {
			id: googleUser.id,
			email: googleUser.email,
			name: googleUser.name,
			picture: googleUser.picture
		}, req);
		
		if (authResult.status === 'success') {
			// Set session data
			req.session.accountId = authResult.accountId;
			req.session.loggedIn = true;
			
			// Provide feedback based on whether this was account linking or new login
			if (authResult.isLinked) {
				console.log(`Google account successfully linked to user ${authResult.username} (ID: ${authResult.accountId})`);
				res.redirect('/?linked=google');
			} else {
				console.log(`User ${authResult.username} logged in via Google (ID: ${authResult.accountId})`);
				res.redirect('/?login=success');
			}
		} else if (authResult.status === 'conflict') {
			// Store conflict data in session and redirect to conflict resolution page
			req.session.conflictData = authResult.conflictData;
			res.redirect('/account-conflict');
		} else {
			console.error('Authentication failed:', authResult.message);
			res.redirect('/login?error=auth_failed');
		}
		
	} catch (error) {
		console.error('Google OAuth callback error:', error);
		res.redirect('/login?error=server_error');
	}
});

app.get('/contact', (req, res) => {
	res.render('contact', {
		session: req.session
	})
})

app.post('/toggle-darkmode', (req, res) => {
    // using isDarkMode from the request, toggle the darkmode:
    if (req.body.isDarkMode === 'true') {
        req.session.darkmode = true;
    } else {
        req.session.darkmode = false;
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

app.post('/receive-token', async (req, res) => {
    const { accessToken } = req.body;

    if (!accessToken) {
        return res.status(400).json({ status: 'error', message: 'Access token is required.' });
    }

    try {
        // Exchange the access token for user info using the BOT_TOKEN
        const discordResponse = await fetch(`https://discord.com/api/users/@me`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        if (!discordResponse.ok) {
            const errorBody = await discordResponse.text();
            console.error(`Failed to fetch Discord user: ${discordResponse.statusText}`, errorBody);
            return res.status(discordResponse.status).json({
                status: 'error',
                message: `Discord API error: ${discordResponse.statusText}`
            });
        }

        const discordUser = await discordResponse.json();

        // Validate the user data received from Discord
        if (!discordUser.id || !discordUser.username) {
            console.error('Received empty or invalid user profile data');
            return res.status(400).json({ status: 'error', message: 'Received invalid user data from Discord.' });
        }
        
        // Use the AuthenticationHandler for standardized login/signup process
        const AuthenticationHandler = require('./auth/AuthenticationHandler.js');
        const authHandler = new AuthenticationHandler();
        
        const authResult = await authHandler.handleProviderAuth('discord', {
            id: discordUser.id,
            username: discordUser.username,
            email: discordUser.email,
            avatar_url: discordUser.avatar ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png` : null
        }, req);
        
        // Respond based on the authentication result
        if (authResult.status === 'success') {
            // Log the result for debugging
            if (authResult.isLinked) {
                console.log(`Discord account successfully linked to user ${authResult.username} (ID: ${authResult.accountId})`);
            } else {
                console.log(`User ${authResult.username} logged in via Discord (ID: ${authResult.accountId})`);
            }
            
            res.json({
                status: 'success',
                message: authResult.message,
                accountId: authResult.accountId,
                username: authResult.username,
                isNewUser: authResult.isNewUser || false,
                isLinked: authResult.isLinked || false
            });
        } else if (authResult.status === 'conflict') {
            res.status(409).json({
                status: 'conflict',
                message: authResult.message,
                redirectUrl: authResult.redirectUrl
            });
        } else {
            res.status(500).json({
                status: 'error',
                message: authResult.message || 'An internal error occurred during authentication.'
            });
        }
    } catch (error) {
        console.error('Error during token exchange:', error);
        res.status(500).json({ status: 'error', message: 'Server error during token processing.' });
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

		let results

		// Perform the aggregation with pagination and total count
		results = await userHistorySchema.aggregate([
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
			loraData: modifiedCachedYAMLData // Add Lora data here
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

let aiScripts = {
	calculateCreditsPrice: fs.readFileSync('./scripts/ai/calculateCreditsPrice.js', 'utf8'),
	APIForm: fs.readFileSync('./scripts/ai/API-form.js', 'utf8'),
	imageGeneratorTour: fs.readFileSync('./scripts/ai/imageGeneratorTour.js', 'utf8'),
}

// split on module.exports to remove it and everything after:
aiScripts.calculateCreditsPrice = aiScripts.calculateCreditsPrice.split('module.exports')[0]

// Cooldown mechanism for aiScripts updates (5 minutes)
let lastAiScriptsUpdate = 0;
const AI_SCRIPTS_COOLDOWN = 5 * 60 * 1000; // 5 minutes in milliseconds

function updateAiScripts() {
	const now = Date.now();
	if (now - lastAiScriptsUpdate < AI_SCRIPTS_COOLDOWN) {
		console.log(`aiScripts update skipped - cooldown active (${Math.round((AI_SCRIPTS_COOLDOWN - (now - lastAiScriptsUpdate)) / 1000)}s remaining)`);
		return;
	}
	
	try {
		aiScripts = {
			calculateCreditsPrice: fs.readFileSync('./scripts/ai/calculateCreditsPrice.js', 'utf8'),
			APIForm: fs.readFileSync('./scripts/ai/API-form.js', 'utf8'),
			imageGeneratorTour: fs.readFileSync('./scripts/ai/imageGeneratorTour.js', 'utf8'),
		}
		aiScripts.calculateCreditsPrice = aiScripts.calculateCreditsPrice.split('module.exports')[0]
		lastAiScriptsUpdate = now;
		console.log('aiScripts updated successfully');
	} catch (error) {
		console.error('Error updating aiScripts:', error);
	}
}

// Function to reset cooldown (called when files change)
function resetAiScriptsCooldown() {
	lastAiScriptsUpdate = 0;
	console.log('aiScripts cooldown reset due to file change');
}

// Watch for changes in AI script files to reset cooldown
const aiScriptPaths = [
	'./scripts/ai/calculateCreditsPrice.js',
	'./scripts/ai/API-form.js',
	'./scripts/ai/imageGeneratorTour.js'
];

// Set up file watchers for each AI script
aiScriptPaths.forEach(scriptPath => {
	try {
		fs.watchFile(scriptPath, { interval: 1000 }, (curr, prev) => {
			if (curr.mtime !== prev.mtime) {
				console.log(`File changed: ${scriptPath}`);
				resetAiScriptsCooldown();
			}
		});
		console.log(`Watching for changes: ${scriptPath}`);
	} catch (error) {
		console.error(`Error setting up file watcher for ${scriptPath}:`, error);
	}
});

// Update the aiScripts every 15 seconds (with cooldown protection):
setInterval(updateAiScripts, 15000)

// Cleanup expired notifications every hour
setInterval(async () => {
	try {
		await mongolib.cleanupExpiredNotifications();
	} catch (error) {
		console.log(`Error running notification cleanup: ${error}`);
	}
}, 60 * 60 * 1000); // 1 hour

app.get('/', async function(req, res) {
	try {
		const accountId = req.session.accountId;
		
		// Handle success notifications from OAuth redirects
		let notification = null;
		if (req.query.linked === 'google') {
			notification = {
				type: 'success',
				message: 'Google account successfully linked to your profile!'
			};
		} else if (req.query.linked === 'discord') {
			notification = {
				type: 'success',
				message: 'Discord account successfully linked to your profile!'
			};
		} else if (req.query.login === 'success') {
			notification = {
				type: 'success',
				message: 'Welcome! You have successfully logged in.'
			};
		}

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
			// Preload notifications for faster initial display
	let preloadedNotifications = [];
	let preloadedUnreadCount = 0;
	if (req.session.loggedIn && foundAccount) {
		try {
			// Get recent notifications for display
			const notifications = await mongolib.aggregateSchemaDocuments("userNotification", [
				{
					$match: {
						accountId: accountId,
						$or: [
							{ expiresAt: null },
							{ expiresAt: { $gt: Date.now() } }
						]
					}
				},
				{
					$sort: { 
						priority: -1,
						timestamp: -1 
					}
				},
				{ $limit: 15 } // Get more for better UX
			]);
			preloadedNotifications = notifications || [];

			// Get total unread count (no limit)
			const unreadCount = await mongolib.aggregateSchemaDocuments("userNotification", [
				{
					$match: {
						accountId: accountId,
						read: false,
						$or: [
							{ expiresAt: null },
							{ expiresAt: { $gt: Date.now() } }
						]
					}
				},
				{ $count: "unread" }
			]);
			preloadedUnreadCount = unreadCount[0]?.unread || 0;
		} catch (error) {
			console.log(`Error preloading notifications: ${error}`);
		}
	}

	res.render('ai', {
		userProfile: foundAccount, // Reuse foundAccount instead of querying again
		imageHistoryCount,
		session: req.session,
		scripts,
		lora_data: modifiedCachedYAMLData,
		aiSaveSlots,
		preloadedNotifications,
		preloadedUnreadCount,
		notification: notification
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

		// Calculate width and height based on aspect ratio and model
		let baseDimension = 512; // Default for SD1.5
		if (request.model.startsWith('pdxl') || request.model.startsWith('illustrious')) {
			baseDimension = 1024;
		}

		const aspectRatioParts = request.aspect_ratio.split(':');
		const ratioW = parseInt(aspectRatioParts[0]);
		const ratioH = parseInt(aspectRatioParts[1]);

		let calculatedWidth, calculatedHeight;

		if (ratioW > ratioH) {
			calculatedWidth = baseDimension;
			calculatedHeight = Math.round((baseDimension * ratioH) / ratioW);
		} else if (ratioH > ratioW) {
			calculatedHeight = baseDimension;
			calculatedWidth = Math.round((baseDimension * ratioW) / ratioH);
		} else {
			calculatedWidth = baseDimension;
			calculatedHeight = baseDimension;
		}

		// Ensure dimensions are multiples of 64
		request.width = Math.round(calculatedWidth / 64) * 64;
		request.height = Math.round(calculatedHeight / 64) * 64;


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

				// Check if json.images exists and is iterable
				if (json.images && Array.isArray(json.images)) {
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
				} else {
					console.log('Warning: json.images is undefined, null, or not an array');
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

// Function to calculate Booru Score
function calculateBooruScore(stats, followerCount, SCORING_CONFIG, highestFollowerCount) {
    // Calculate follower score modifier
    const followerScoreModifier = ((followerCount / highestFollowerCount) / 7.14) + 0.95;

    // Calculate average score per post
    let avgScore = stats.postCount > 0 ? stats.totalScore / stats.postCount : 0;

    // Add diminishing returns for volume (prevents spam posting)
    let volumeModifier = stats.postCount > 0 ? Math.pow(stats.postCount, SCORING_CONFIG.VOLUME_DIMINISH_FACTOR) / Math.pow(SCORING_CONFIG.MIN_POST_THRESHOLD, SCORING_CONFIG.VOLUME_DIMINISH_FACTOR) : 0;
		if (stats.postCount < SCORING_CONFIG.MIN_POST_THRESHOLD) {
			volumeModifier = Math.pow(stats.postCount / SCORING_CONFIG.MIN_POST_THRESHOLD, SCORING_CONFIG.VOLUME_DIMINISH_FACTOR);
		}


    // Calculate engagement rate (total engagement per post relative to follower count)
    let totalEngagement = (stats.totalUpvotes || 0) + (stats.totalComments || 0);
    let engagementPerPost = stats.postCount > 0 ? totalEngagement / stats.postCount : 0;
    let effectiveFollowerCount = Math.min(followerCount, SCORING_CONFIG.FOLLOWER_ENGAGEMENT_CAP);
		// ensure effectiveFollowerCount is at least 1 to prevent division by zero
		effectiveFollowerCount = Math.max(1, effectiveFollowerCount);
    let engagementRate = engagementPerPost / effectiveFollowerCount;

    // Final score: base average + volume bonus + engagement rate bonus
    let rawFinalScore = avgScore * volumeModifier + (engagementRate * SCORING_CONFIG.ENGAGEMENT_MULTIPLIER);
    let finalScoreWithFollowerModifier = rawFinalScore * followerScoreModifier;
    
    return {
        rawScore: rawFinalScore,
        finalScore: finalScoreWithFollowerModifier,
        avgScore: avgScore,
        volumeModifier: volumeModifier,
        engagementRate: engagementRate,
        followerScoreModifier: followerScoreModifier
    };
}

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
		await mongolib.createUserNotification(
			foundBooruImage.account_id, 
			`${foundAccount.username} commented on your <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a>`, 
			'booru',
			{
				actionUrl: `https://www.jscammie.com/booru/post/${booru_id}`,
				priority: 'normal',
				metadata: {
					commenterId: req.session.accountId,
					commenterUsername: foundAccount.username,
					booruId: booru_id
				}
			}
		)
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
			let foundAccount = foundAccounts.find(account => account && account.accountId == comment.accountId)
			if (foundAccount == undefined) {
				foundAccount = await mongolib.getSchemaDocumentOnce("userProfile", {
					accountId: comment.accountId
				})
				
				// Handle case where user profile doesn't exist (deleted user, etc.)
				if (foundAccount == null) {
					foundAccount = {
						accountId: comment.accountId,
						username: "Deleted User",
						profileImg: "https://www.jscammie.com/noimagefound.png"
					}
				}
				
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
		res.send({
			status: "error",
			message: "Failed to load comments"
		})
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
		
		await mongolib.createUserNotification(
			1039574722163249233, 
			`A user has reported a <a href="https://www.jscammie.com/booru/post/${booru_id}">Booru Post</a> for: ${reason}`, 
			'moderation',
			{
				priority: 'high',
				actionUrl: `https://www.jscammie.com/booru/post/${booru_id}`,
				metadata: {
					reporterId: req.session.accountId,
					booruId: booru_id,
					reason: reason
				}
			}
		)

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
	const refreshOnly = data.refreshOnly || false;

	// set req.session.notificationsChecked to the current time:
	if (data.popupOpened) {
		req.session.notificationsChecked = Date.now()
		// Mark notifications as read when popup is opened
		await mongolib.markNotificationsAsRead(req.session.accountId);
	}

	// if the req.session.notificationsChecked is not set, set it to the current time:
	if (!req.session.notificationsChecked) {
		req.session.notificationsChecked = Date.now()
	}
	
	// Support pagination for infinite scroll
	const skip = parseInt(data.skip) || 0;
	const limit = refreshOnly ? 5 : 15; // Smaller limit for refresh-only requests

	// Enhanced aggregation with priority sorting and filtering
	let matchQuery = {
		accountId: req.session.accountId,
		// Don't show expired notifications
		$or: [
			{ expiresAt: null },
			{ expiresAt: { $gt: Date.now() } }
		]
	};
	
	// For refresh-only requests, only get new notifications
	if (refreshOnly) {
		matchQuery.notificationId = { $nin: Array.from(receivedNotifications) };
		matchQuery.timestamp = { $gt: req.session.notificationsChecked || 0 };
	} else {
		matchQuery.notificationId = { $nin: Array.from(receivedNotifications) };
	}
	
	let notifications = await mongolib.aggregateSchemaDocuments("userNotification", [
		{ $match: matchQuery },
		{
			$sort: { 
				// Sort by priority first (urgent, high, normal, low), then by timestamp
				priority: -1,
				timestamp: -1 
			}
		},
		{ $skip: skip },
		{ $limit: limit }
	]);

	// No date cutoff - show all notifications regardless of age
	// Users can dismiss notifications they don't want to see anymore

	// Count ALL unread notifications (no date restrictions)
	const unreadCount = await mongolib.aggregateSchemaDocuments("userNotification", [
		{
			$match: {
				accountId: req.session.accountId,
				read: false,
				// Only exclude truly expired notifications
				$or: [
					{ expiresAt: null },
					{ expiresAt: { $gt: Date.now() } }
				]
			}
		},
		{ $count: "unread" }
	]);

	const unreadNotifications = unreadCount[0]?.unread || 0;

	// Get total count of all notifications for pagination
	const totalCount = await mongolib.aggregateSchemaDocuments("userNotification", [
		{
			$match: {
				accountId: req.session.accountId,
				$or: [
					{ expiresAt: null },
					{ expiresAt: { $gt: Date.now() } }
				]
			}
		},
		{ $count: "total" }
	]);

	const totalNotifications = totalCount[0]?.total || 0;

	res.send({ 
		status: 'success', 
		notifications: notifications, 
		notificationsChecked: req.session.notificationsChecked,
		unreadCount: unreadNotifications,
		totalCount: totalNotifications,
		hasMore: (skip + limit) < totalNotifications,
		refreshOnly: refreshOnly
	})
})

// New endpoint to mark specific notifications as read
app.post('/mark-notifications-read', async function(req, res) {
	if (!req.session.loggedIn) {
		res.status(401).send({ status: 'error', message: 'Not logged in' });
		return;
	}

	const { notificationIds } = req.body;
	const result = await mongolib.markNotificationsAsRead(req.session.accountId, notificationIds);
	res.send(result);
});

// New endpoint to dismiss/delete specific notifications
app.post('/dismiss-notifications', async function(req, res) {
	if (!req.session.loggedIn) {
		res.status(401).send({ status: 'error', message: 'Not logged in' });
		return;
	}

	try {
		const { notificationIds } = req.body;
		
		// Delete multiple notifications - need to use deleteMany through aggregation
		await mongolib.aggregateSchemaDocuments("userNotification", [
			{
				$match: {
					accountId: req.session.accountId,
					notificationId: { $in: notificationIds }
				}
			},
			{
				$count: "deleted"
			}
		]);

		// Actually delete them using the schema
		for (const notificationId of notificationIds) {
			await mongolib.deleteSchemaDocument("userNotification", {
				accountId: req.session.accountId,
				notificationId: notificationId
			});
		}

		res.send({ status: 'success', message: 'Notifications dismissed' });
	} catch (error) {
		console.log(`Error dismissing notifications: ${error}`);
		res.status(500).send({ status: 'error', message: 'Error dismissing notifications' });
	}
});

// New endpoint to mark ALL notifications as read
app.post('/mark-all-notifications-read', async function(req, res) {
	if (!req.session.loggedIn) {
		res.status(401).send({ status: 'error', message: 'Not logged in' });
		return;
	}

	try {
		const result = await mongolib.markNotificationsAsRead(req.session.accountId, []);
		res.send(result);
	} catch (error) {
		console.log(`Error marking all notifications as read: ${error}`);
		res.status(500).send({ status: 'error', message: 'Error marking all notifications as read' });
	}
});

// New endpoint to clear ALL notifications
app.post('/clear-all-notifications', async function(req, res) {
	if (!req.session.loggedIn) {
		res.status(401).send({ status: 'error', message: 'Not logged in' });
		return;
	}

	try {
		// Delete all notifications for this user
		const result = await mongolib.aggregateSchemaDocuments("userNotification", [
			{
				$match: { accountId: req.session.accountId }
			},
			{ $count: "total" }
		]);

		const totalToDelete = result[0]?.total || 0;

		// Use MongoDB native deleteMany for efficiency
		const userNotificationSchema = require('./schemas/userNotificationSchema.js');
		await userNotificationSchema.deleteMany({ accountId: req.session.accountId });

		res.send({ 
			status: 'success', 
			message: `Cleared ${totalToDelete} notifications`,
			deletedCount: totalToDelete
		});
	} catch (error) {
		console.log(`Error clearing all notifications: ${error}`);
		res.status(500).send({ status: 'error', message: 'Error clearing all notifications' });
	}
});

// New endpoint to get notification statistics
app.get('/notification-stats', async function(req, res) {
	if (!req.session.loggedIn) {
		res.status(401).send({ status: 'error', message: 'Not logged in' });
		return;
	}

	try {
		const stats = await mongolib.aggregateSchemaDocuments("userNotification", [
			{
				$match: { accountId: req.session.accountId }
			},
			{
				$group: {
					_id: null,
					total: { $sum: 1 },
					unread: { $sum: { $cond: [{ $eq: ["$read", false] }, 1, 0] } },
					byType: {
						$push: {
							type: "$type",
							read: "$read",
							priority: "$priority"
						}
					}
				}
			}
		]);

		const typeStats = {};
		if (stats[0]?.byType) {
			stats[0].byType.forEach(notif => {
				if (!typeStats[notif.type]) {
					typeStats[notif.type] = { total: 0, unread: 0 };
				}
				typeStats[notif.type].total++;
				if (!notif.read) {
					typeStats[notif.type].unread++;
				}
			});
		}

		res.send({
			status: 'success',
			stats: {
				total: stats[0]?.total || 0,
				unread: stats[0]?.unread || 0,
				byType: typeStats
			}
		});
	} catch (error) {
		console.log(`Error getting notification stats: ${error}`);
		res.status(500).send({ status: 'error', message: 'Error getting notification stats' });
	}
});

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

		} else if (settingWanted == 'profile_background_color') {

			// Validate hex color format
			if (!/^#[0-9A-F]{6}$/i.test(settingValue)) {
				res.send({
					status: "error",
					message: "Invalid color format. Please use a valid hex color (e.g., #4875B4)"
				})
				return
			}

			console.log(`Updating profile background color for accountId: ${req.session.accountId} to color: ${settingValue}`)

			// First ensure the settings object exists, then set the profile background color
			let updateResult = await mongolib.updateSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			}, {
				$set: {
					'settings.profile_background_color': settingValue
				}
			})

			console.log(`Update result:`, updateResult)

			// Verify the update by fetching the user profile
			let verifyProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
				accountId: req.session.accountId
			})
			console.log(`Verification - saved color:`, verifyProfile?.settings?.profile_background_color)

		} else if (settingWanted == 'username') {

			try {
				// Use the shared username utility for comprehensive username change
				const result = await UsernameUtils.updateUsernameWithBooruTags(
					req.session.accountId,
					settingValue.trim()
				);

				if (result.status === 'error') {
					res.send({
						status: "error",
						message: result.message
					});
					return;
				}

				res.send({
					status: "success",
					message: result.message
				});
				return;

			} catch (error) {
				console.log(`Error updating username: ${error}`);
				res.send({
					status: "error",
					message: "An error occurred while updating your username"
				});
				return;
			}

		} else {
			res.send({
				status: "error",
				message: "Setting not found"
			})
			return
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

		if (foundCode) {
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
			timestamp: String(Date.now())
		}

		// Only add expires if it has a value
		if (expires) {
			codeObject.expires = expires
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

// Configurable scoring constants - documented for clarity
const SCORING_CONFIG = {
	UPVOTE_WEIGHT: 0.7,           // Base points per upvote
	COMMENT_WEIGHT: 4,            // Base points per comment (higher than upvotes for deeper engagement)
	MIN_POST_THRESHOLD: 10,       // Minimum posts required for leaderboard
	HOURS_EXCLUDE: 6,             // Hours to exclude recent posts (prevent manipulation)
	ENGAGEMENT_MULTIPLIER: 0.9,   // How much engagement rate affects final score (0.3 = moderate, 0.6 = high, 0.9 = very high)
	FOLLOWER_ENGAGEMENT_CAP: 50,  // Cap follower count for engagement rate calculation (prevents division by tiny numbers)
	VOLUME_DIMINISH_FACTOR: 0.625   // Controls how much posting volume is penalized (0.5 = aggressive, 1.0 = no penalty)
};

// Initialize and mount booru routes
booruRoutes.init({
	SCORING_CONFIG
});
app.use('/booru', booruRoutes);
app.use('/', booruRoutes); // For routes like create-booru-image that need root level access

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
					type: 'credits',
					totalUsers: leaderboardInfo.length
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
					type: 'exp',
					totalUsers: leaderboardInfoExp.length
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
					let xHoursAgo = Date.now() - SCORING_CONFIG.HOURS_EXCLUDE * 60 * 60 * 1000
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

				// Process booru posts with simplified scoring
				let userStats = {};
				for (const image of booruImages) {
					let { account_id, upvotes, comments } = image;
					upvotes = upvotes || 0;
					comments = comments || 0;

					// Simplified base score calculation
					let baseScore = (upvotes * SCORING_CONFIG.UPVOTE_WEIGHT) + (comments * SCORING_CONFIG.COMMENT_WEIGHT);

					if (!userStats[account_id]) {
						userStats[account_id] = { 
							postCount: 0, 
							totalScore: 0, 
							totalUpvotes: 0, 
							totalComments: 0 
						};
					}

					userStats[account_id].postCount++;
					userStats[account_id].totalScore += baseScore;
					userStats[account_id].totalUpvotes += upvotes;
					userStats[account_id].totalComments += comments;
				}

				// Get highest follower count for normalization
				const highestFollowerCountData = await mongolib.aggregateSchemaDocuments("userProfile", [
					{ $match: { followedAccounts: { $exists: true, $ne: [] } } },
					{ $project: { followedCount: { $size: "$followedAccounts" } } },
					{ $sort: { followedCount: -1 } },
					{ $limit: 1 }
				]);
				const highestFollowerCount = highestFollowerCountData[0]?.followedCount || 1; // Default to 1 if no data

				// Construct leaderboard data with improved scoring
				let allUserBooruAccounts = await Promise.all(
					Object.entries(userStats)
						.filter(([accountId, stats]) => stats.postCount >= SCORING_CONFIG.MIN_POST_THRESHOLD)
						.map(async ([accountId, stats]) => {
							let profile = userProfilesMap[accountId] || {};

							// Get follower count
							let followedCountResult = await mongolib.aggregateSchemaDocuments("userProfile", [
								{ $match: { followedAccounts: accountId } },
								{ $count: "followedCount" }
							]);

							let followerCount = followedCountResult[0]?.followedCount || 1; // Default to 1 to avoid division by zero

							const scoreData = calculateBooruScore(stats, followerCount, SCORING_CONFIG, highestFollowerCount);

							return {
								accountId,
								username: profile.username || "Unknown",
								profileImg: profile.profileImg || "",
								score: scoreData.finalScore, // Use the final score from the new function
								followerCount: followerCount,
								postCount: stats.postCount,
								avgScore: scoreData.avgScore.toFixed(2),
								engagementRate: scoreData.engagementRate.toFixed(3)
							};
						})
				);

				allUserBooruAccounts = allUserBooruAccounts
					.sort((a, b) => b.score - a.score)

				res.render('leaderboard', {
					session: req.session,
					leaderboardInfo: allUserBooruAccounts,
					type: 'booru',
					totalUsers: allUserBooruAccounts.length,
					scoringConfig: SCORING_CONFIG
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

app.post('/image-history/submit-lora-preview', async (req, res) => {

	try {
	
		let { imageHistoryID, loraID } = req.body;

		// Check if the user exists:
		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: req.session.accountId
		});
		if (!userProfile) {
			return res.status(404).json({ status: 'error', message: 'User not found' });
		}
		
		// check that the image history exists and belongs to the user:
		let imageHistory = await mongolib.getSchemaDocumentOnce("userHistory", {
			image_id: imageHistoryID,
			account_id: req.session.accountId
		});
		if (!imageHistory) {
			return res.status(404).json({ status: 'error', message: 'Image history not found or does not belong to user.' });
		}

		// check that the lora exists inside of the lora yaml:
		const category = loraID.split('-')[0];
		if (!modifiedCachedYAMLData || !modifiedCachedYAMLData[category] || !modifiedCachedYAMLData[category][loraID]) {
			return res.status(400).json({ status: 'error', message: 'Invalid Lora ID.' });
		}

		// Check if a submission for this accountId and loraId already exists
		const existingSubmission = await mongolib.getSchemaDocumentOnce("generatorLoraPreviewSubmission", {
			accountId: req.session.accountId,
			loraId: loraID
		});

		if (existingSubmission) {
			return res.status(400).json({ status: 'error', message: 'You have already submitted a preview for this Lora.' });
		}

		// Construct the image path
		const imagePath = path.join(__dirname, 'imagesHistory', req.session.accountId, `${imageHistoryID}.png`);

		// Read the image file
		let imageBuffer;
		try {
			imageBuffer = fs.readFileSync(imagePath);
		} catch (error) {
			console.error('Error reading image file:', error);
			return res.status(500).json({ status: 'error', message: 'Error reading image file.' });
		}

		// Convert image to base64
		const base64Image = imageBuffer.toString('base64');

		// Create the submission document
		const submissionData = {
			accountId: req.session.accountId,
			base64Image: base64Image,
			timestamp: String(Date.now()),
			loraId: loraID,
			prompt: imageHistory.prompt || "", // Add the prompt from the image history
		};

		const creationResult = await mongolib.createSchemaDocument("generatorLoraPreviewSubmission", submissionData);

		if (creationResult.status === 'error') {
			console.error('Error creating submission document:', creationResult.message);
			return res.status(500).json({ status: 'error', message: 'Error saving submission.' });
		}

		return res.status(200).json({ status: 'success', message: 'Lora preview submitted successfully.' });
		
	} catch (error) {
		console.error('Error in submit-lora-preview route:', error);
		res.status(500).json({ status: 'error', message: 'Internal server error' });
	}
});



app.get('/admin/lora-preview-moderation', async (req, res) => {
    try {
        if (!req.session.loggedIn) {
            return res.redirect('/login');
        }

        const userProfile = await mongolib.getSchemaDocumentOnce("userProfile", { accountId: req.session.accountId });

        if (!userProfile || userProfile.badges?.moderator !== true) {
            // return res.status(403).send('Access Denied. You must be a moderator to view this page.');
             return showMessagePage(res, req, 'Access Denied. You must be a moderator to view this page.');
        }

        const pendingSubmissions = await mongolib.getSchemaDocuments("generatorLoraPreviewSubmission", { status: "pending" });

        // Enhance submissions with user details and Lora details
        const enrichedSubmissions = await Promise.all(pendingSubmissions.map(async (submission) => {
            const account = await mongolib.getSchemaDocumentOnce("userProfile", { accountId: submission.accountId });
            let loraDetails = null;
            let existingLoraImageUrl = null;
            
            if (modifiedCachedYAMLData) {
                const loraCategory = submission.loraId.split('-')[0];
                if (modifiedCachedYAMLData[loraCategory] && modifiedCachedYAMLData[loraCategory][submission.loraId]) {
                    loraDetails = modifiedCachedYAMLData[loraCategory][submission.loraId];
                    // Check if the lora already has an image
                    if (loraDetails.image) {
                        existingLoraImageUrl = loraDetails.image;
                    }
                }
            }
            return {
                ...submission.toObject(), // Convert Mongoose document to plain object
                account: account ? { username: account.username, accountId: account.accountId } : { username: 'Unknown User', accountId: submission.accountId },
                loraDetails: loraDetails ? { name: loraDetails.name } : null, // Only pass necessary details like name
                existingLoraImageUrl: existingLoraImageUrl
            };
        }));

        res.render('admin/lora-preview-moderation', {
            session: req.session,
            userProfile: userProfile, // Pass the moderator's profile
            submissions: enrichedSubmissions,
            // Assuming _headerAll, _navbar, _footer are handled by the EJS file structure or a main layout
        });

    } catch (error) {
        console.error('Error loading Lora preview moderation page:', error);
        // res.status(500).send('Internal Server Error');
        showMessagePage(res, req, 'Internal Server Error while loading moderation page.');
    }
});

app.post('/admin/lora-preview-moderation/reject', async (req, res) => {

	try {

		let { accountId, loraId, rejectionReason } = req.body;

		// Check if the user exists:
		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: accountId
		});

		if (!userProfile) {
			return res.status(404).json({ status: 'error', message: 'User not found' });
		}

		// Check if the lora exists:
		let lora = modifiedCachedYAMLData[loraId.split('-')[0]]?.[loraId];

		if (!lora) {
			return res.status(404).json({ status: 'error', message: 'Lora not found' });
		}

		// delete the submission:
		await mongolib.deleteSchemaDocument("generatorLoraPreviewSubmission", {
			accountId: accountId,
			loraId: loraId
		});

		// send a notification to the user:
		await mongolib.createUserNotification(accountId, `Your Lora preview submission for <strong>${loraId}</strong> has been rejected. Reason: ${rejectionReason}`, 'lora_preview_rejected');

		return res.status(200).json({ status: 'success', message: `Submission for ${loraId} rejected.` });

	} catch (error) {
		console.error('Error rejecting Lora preview:', error);
		res.status(500).json({ status: 'error', message: 'Internal Server Error' });
	}

})


app.post('/admin/lora-preview-moderation/approve', async (req, res) => {
	try {
		let { accountId, loraId } = req.body;

		// Check if the user exists:
		let userProfile = await mongolib.getSchemaDocumentOnce("userProfile", {
			accountId: accountId
		});

		if (!userProfile) {
			return res.status(404).json({ status: 'error', message: 'User not found' });
		}

		// Check if the lora exists:
		let lora = modifiedCachedYAMLData[loraId.split('-')[0]]?.[loraId];

		if (!lora) {
			return res.status(404).json({ status: 'error', message: 'Lora not found' });
		}

		// Fetch the submission to get the base64Image
		const submission = await mongolib.getSchemaDocumentOnce("generatorLoraPreviewSubmission", {
			accountId: accountId,
			loraId: loraId
		});

		if (!submission) {
			return res.status(404).json({ status: 'error', message: 'Submission not found' });
		}

		// save the image to the loraimages folder, using the pdxl or illustrious etc etc in the lora name to determine the folder, and the FULL lora name to determine the filename:
		// example filename and structure: loraimages/illustrious/style/style-illustriousabstractpurple.png
		
		// Extract category from loraId (part before first dash)
		const category = loraId.split('-')[0];
		
		// Extract model type from loraId (part after first dash, before any other identifiers)
		const loraIdParts = loraId.split('-');
		let modelType = ''; // default fallback
		if (loraIdParts.length > 1) {
			const secondPart = loraIdParts[1].toLowerCase();
			if (secondPart.startsWith('illustrious')) {
				modelType = 'illustrious';
			} else if (secondPart.startsWith('pdxl') || secondPart.startsWith('pony')) {
				modelType = 'pdxl';
			} else if (secondPart.startsWith('flux')) {
				modelType = 'flux';
			}
		}
		
		const loraImageFilename = `${loraId}.png`;
		let loraImagePath;
		if (modelType === '') {
			loraImagePath = path.join(__dirname, 'loraimages', category, loraImageFilename);
		} else {
			loraImagePath = path.join(__dirname, 'loraimages', modelType, category, loraImageFilename);
		}

		console.log(`Saving lora image to ${loraImagePath}`);
		fs.mkdirSync(path.dirname(loraImagePath), { recursive: true });
		
		// Convert base64 to buffer and save
		const imageBuffer = Buffer.from(submission.base64Image, 'base64');
		fs.writeFileSync(loraImagePath, imageBuffer);
		console.log(`Lora image saved to ${loraImagePath}`);

		// send a notification to the user:
		await mongolib.createUserNotification(accountId, `Your Lora preview submission for <strong>${loraId}</strong> has been approved, 333 Credits have been added to your account.`, 'lora_preview_approved');

		// add 500 credits to the user:
		await mongolib.modifyUserCredits(accountId, 333, '+', `Lora preview approved. 333 credits added.`);

		// delete the submission:
		await mongolib.deleteSchemaDocument("generatorLoraPreviewSubmission", {
			accountId: accountId,
			loraId: loraId
		});

		return res.status(200).json({ status: 'success', message: `Submission for ${loraId} approved.` });

	} catch (error) {
		console.error('Error approving Lora preview:', error);
		res.status(500).json({ status: 'error', message: 'Internal Server Error' });
	}
})

// Admin endpoint to force version update (for cache busting)
app.post('/admin/update-version', async (req, res) => {
	try {
		if (!req.session.loggedIn) {
			return res.status(401).json({ status: 'error', message: 'Not logged in' });
		}

		const userProfile = await mongolib.getSchemaDocumentOnce("userProfile", { accountId: req.session.accountId });

		if (!userProfile || userProfile.badges?.moderator !== true) {
			return res.status(403).json({ status: 'error', message: 'Access denied. Moderator privileges required.' });
		}

		const newVersion = updateVersion();
		
		res.json({ 
			status: 'success', 
			message: 'Version updated successfully. All users will get the latest version on their next page load.', 
			newVersion: newVersion 
		});

	} catch (error) {
		console.error('Error updating version:', error);
		res.status(500).json({ status: 'error', message: 'Internal Server Error' });
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


// app.get('/fix-user-history', async function (req, res) {
// 	try {
// 		const dryRun = false
// 		const baseDir = './imagesHistory/';

// 		const dir = await fsp.opendir(baseDir);
// 		let totalRemoved = 0;
// 		let totalDeletedAccounts = 0;

// 		for await (const dirent of dir) {
// 			if (!dirent.isDirectory()) continue;
// 			const accountId = dirent.name;
// 			const accountPath = path.join(baseDir, accountId);

// 			const userHistory = await mongolib.getSchemaDocuments('userHistory', { account_id: accountId });
// 			if (!userHistory.length) {
// 				// No history > delete entire folder
// 				if (dryRun) {
// 					console.log(`[DryRun] Would delete folder: ${accountId}`);
// 				} else {
// 					fs.rmSync(accountPath, { recursive: true, force: true });
// 					console.log(`Deleted folder: ${accountId}`);
// 				}
// 				totalDeletedAccounts++;
// 				continue;
// 			}

// 			// Keep only valid image IDs
// 			const imageIDsToKeep = userHistory.map((image) => image.image_id.toString());
// 			const files = fs.readdirSync(accountPath);
// 			let removedCount = 0;

// 			for (const file of files) {
// 				const base = file.split('.')[0].split('-')[0];
// 				if (!imageIDsToKeep.includes(base)) {
// 					const imagePath = path.join(accountPath, file);
// 					if (dryRun) {
// 						// console.log(`[DryRun] Would delete: ${accountId}/${file}`);
// 					} else {
// 						fs.unlinkSync(imagePath);
// 						// console.log(`Deleted: ${accountId}/${file}`);
// 					}
// 					removedCount++;
// 					totalRemoved++;
// 				}
// 			}

// 			if (removedCount > 0) {
// 				console.log(`Cleaned ${removedCount} files from ${accountId}`);
// 			}
// 			// Free memory
// 			imageIDsToKeep.length = 0;
// 		}

// 		res.send({
// 			status: 'success',
// 			message: `Cleanup ${dryRun ? '[Dry Run]' : ''} done. Removed ${totalRemoved} files. Deleted ${totalDeletedAccounts} folders.`,
// 		});
// 	} catch (err) {
// 		console.error(err);
// 		res.status(500).send({
// 			status: 'error',
// 			message: err.message,
// 		});
// 	}
// });
	

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




// Sitemap routes
const SitemapGenerator = require('./utils/sitemap/sitemapGenerator');
const sitemapGenerator = new SitemapGenerator();

// Serve individual sitemaps
app.get('/sitemap-static.xml', (req, res) => {
	const filePath = path.join(__dirname, 'sitemap-static.xml');
	if (fs.existsSync(filePath)) {
		res.set('Content-Type', 'application/xml');
		res.sendFile(filePath);
	} else {
		res.status(404).send('Sitemap not found');
	}
});

app.get('/sitemap-posts.xml', (req, res) => {
	const filePath = path.join(__dirname, 'sitemap-posts.xml');
	if (fs.existsSync(filePath)) {
		res.set('Content-Type', 'application/xml');
		res.sendFile(filePath);
	} else {
		res.status(404).send('Sitemap not found');
	}
});

app.get('/sitemap-users.xml', (req, res) => {
	const filePath = path.join(__dirname, 'sitemap-users.xml');
	if (fs.existsSync(filePath)) {
		res.set('Content-Type', 'application/xml');
		res.sendFile(filePath);
	} else {
		res.status(404).send('Sitemap not found');
	}
});

app.get('/sitemap-searches.xml', (req, res) => {
	const filePath = path.join(__dirname, 'sitemap-searches.xml');
	if (fs.existsSync(filePath)) {
		res.set('Content-Type', 'application/xml');
		res.sendFile(filePath);
	} else {
		res.status(404).send('Sitemap not found');
	}
});

// Admin route to manually regenerate sitemaps
app.get('/admin/regenerate-sitemaps', async function(req, res) {
	// Only allow admin users to regenerate sitemaps
	if (!req.session.loggedIn) {
		return res.status(401).send({ status: 'error', message: 'Not logged in' });
	}

	// Check if user is admin (you may need to adjust this check based on your admin system)
	const userProfile = await mongolib.getSchemaDocumentOnce('userProfile', { accountId: req.session.accountId });
	if (!userProfile || !userProfile.badges?.owner) {
		return res.status(403).send({ status: 'error', message: 'Insufficient permissions' });
	}

	try {
		const result = await sitemapGenerator.generateAllSitemaps();
		res.send(result);
	} catch (error) {
		console.error('Error regenerating sitemaps:', error);
		res.status(500).send({ status: 'error', message: 'Failed to generate sitemaps' });
	}
});

// Auto-regenerate sitemaps daily at 3 AM
setInterval(async () => {
	const now = new Date();
	if (now.getHours() === 3 && now.getMinutes() === 0) {
		console.log('Daily sitemap regeneration starting...');
		try {
			const result = await sitemapGenerator.generateAllSitemaps();
			console.log('Daily sitemap regeneration completed:', result);
		} catch (error) {
			console.error('Daily sitemap regeneration failed:', error);
		}
	}
}, 60000); // Check every minute

// Generate initial sitemaps on startup (after a delay to ensure database is ready)
setTimeout(async () => {
	console.log('Generating initial sitemaps...');
	try {
		const shouldRegenerate = await sitemapGenerator.shouldRegenerateSitemaps();
		if (shouldRegenerate) {
			const result = await sitemapGenerator.generateAllSitemaps();
			console.log('Initial sitemap generation completed:', result);
		} else {
			console.log('Sitemaps are up to date, skipping initial generation');
		}
	} catch (error) {
		console.error('Initial sitemap generation failed:', error);
	}
}, 10000); // Wait 10 seconds after startup

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