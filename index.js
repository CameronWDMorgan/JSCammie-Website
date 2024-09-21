require( 'console-stamp' )( console, { 
    format: ':date(HH:MM:ss)' 
} );

const express = require('express')
const app = express()
const port = 80
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs')
const bodyParser = require('body-parser')

const cors = require('cors');
app.use(cors());

let cookieSession = require('cookie-session')

app.set('view engine', 'ejs');

const ExifReader = require('exifreader');

// load getCreditsPrice(loraCount, model) function from scripts/ai-calculateCreditsPrice.js
const customFunctions = require('./scripts/ai-calculateCreditsPrice.js')
const getFastqueuePrice = customFunctions.getFastqueuePrice
const getExtrasPrice = customFunctions.getExtrasPrice

// dotenv for environment variables:
require('dotenv').config();

// connect to mongodb:
//connects to the mongodb database
mongoose.connect(process.env.MONGODB_URI)
mongoose.set('strictQuery', false)

app.use(bodyParser.urlencoded({limit: '50mb', extended: false}));
app.use(bodyParser.json({limit: '50mb'}));
app.use(express.json({ limit: '50mb' })); // Increase limit if needed


app.use(cookieSession({
    name: 'session',
    keys: [process.env.COOKIE_KEY1, process.env.COOKIE_KEY2],
    secure: true, // Ensure this is true if your site is served over HTTPS
    httpOnly: true, // Helps prevent attacks such as cross-site scripting
    maxAge: (24 * 60 * 60 * 1000) * 30 // 24 hours - 30 days
}))

app.use( async (req, res, next) => {
    if (req.session) {
        // Update some session property to ensure the session is considered modified.
        req.session.nowInMinutes = Math.floor(Date.now() / 60e3);

        // Optionally, explicitly refresh maxAge if needed (this step might be redundant).
        req.sessionOptions.maxAge = (24 * 60 * 60 * 1000) * 30; // Resets the expiration to 30 days from now
    }
    next();
});

app.use(express.static(__dirname));

// fixed the www redirect to work:
function wwwRedirect(req, res, next) {
    if (req.headers.host.slice(0, 4) !== 'www.') {
        return res.redirect(301, 'https://www.' + req.headers.host + req.url);
    }
    next();
}

app.set('trust proxy', true);
app.use(wwwRedirect);

function requireHTTPS(req, res, next) {
    if (!req.secure && req.get('x-forwarded-proto') !== 'https') {
      return res.redirect('https://' + req.get('host') + req.url);
    }
    next();
}
  
app.use(requireHTTPS);

app.use(express.json());

const userProfileSchema = require('./schemas/userProfileSchema.js');
const userSuggestionSchema = require('./schemas/userSuggestionSchema.js');
const userHistorySchema = require('./schemas/userHistorySchema.js');

const generationLoraSchema = require('./schemas/generationLoraSchema.js');

const { type, networkInterfaces } = require('os');

// setup views directory:
app.set('views', './views')

app.get('/aibeta', (req, res) => {
    res.render('aibeta', {session: req.session})
})

app.get('/home', (req, res) => {
    res.render('home', {session: req.session})
})

app.get('/login', (req, res) => {
    // send login.ejs:
    res.render('login', {session: req.session})
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
    res.json({ darkmode: req.session.darkmode });
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

    if(!req.session.loggedIn){
        res.redirect('/login')
        return
    }

    let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    res.render('profile', { userProfile: userProfile, session: req.session })

})

app.post('/receive-token', async (req, res) => {
    const accessToken = req.body.accessToken;

    let discordUser

    fetch('https://discord.com/api/users/@me', {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    })
    .then(res => res.json())
    .then(async json => {
        discordUser = json

        newProfile = {
            accountId: discordUser.id,
            username: discordUser.username,
            timestamp: Date.now(),
        }
    
        await userProfileSchema.findOneAndUpdate({accountId: discordUser.id}, newProfile, {upsert: true})
    
        req.session.accountId = discordUser.id
        req.session.loggedIn = true

        // make them join the discord server:
        const addUserResponse = await fetch(`https://discord.com/api/guilds/${process.env.GUILD_ID}/members/${discordUser.id}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bot ${process.env.BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                access_token: accessToken
            })
        });
        
        res.sendStatus(200)
    })

})

app.get('/suggestions', async (req, res) => {
    let suggestions = await userSuggestionSchema.find()
    
    // userProfile:

    if(req.session.loggedIn){
        userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})
    } else {
        userProfile = {}
    }

    res.render('suggestions/suggestions', { suggestions: suggestions, session: req.session, userProfile: userProfile})
})

app.get('/submit-suggestion', (req, res) => {
    // check they are logged in:
    if(!req.session.loggedIn){
        res.redirect('/login')
        return
    }

    res.render('suggestions/submit-suggestion', { session: req.session })
})

app.post('/promote-suggestion', async (req, res) => {
    // check if they are logged in:
    if(!req.session.loggedIn){
        res.redirect('/login')
        return
    }

    let suggestionId = req.body.suggestionId
    let accountId = req.session.accountId

    let currentUser = await userProfileSchema.findOne({accountId: accountId})
    let suggestion = await userSuggestionSchema.findOne({suggestionId: suggestionId})

    if(suggestion === null) {
        res.send({status: 'error', message: 'Suggestion not found'})
        return
    }

    // check if the suggestion is already promoted:
    if(suggestion.promoted === true) {
        res.send({status: 'error', message: 'Suggestion already promoted'})
        return
    }

    creditsRequired = BigInt(750)

    // check if the user has more than 300 credits:
    if(BigInt(currentUser.credits) < creditsRequired) {
        res.send({status: 'error', message: `You do not have enough credits to promote this suggestion (${creditsRequired} credits)`})
        return
    }

    // promote the suggestion:
    await userSuggestionSchema.findOneAndUpdate({suggestionId: suggestionId}, {promoted: true})
    let newCredits = BigInt(currentUser.credits) - creditsRequired
    await userProfileSchema.findOneAndUpdate({accountId: accountId}, {credits: newCredits})

    res.send({status: 'success', message: 'Suggestion promoted (refresh to see changes)'})
})

app.post('/toggle-suggestion-safety', async (req, res) => {

    // check if they are logged in:
    if(!req.session.loggedIn){
        res.redirect('/login')
        return
    }

    let suggestionId = req.body.suggestionId
    let accountId = req.session.accountId

    let suggestion = await userSuggestionSchema.findOne({suggestionId: suggestionId})

    if(suggestion === null) {
        res.send({status: 'error', message: 'Suggestion not found'})
        return
    }

    let currentUser = await userProfileSchema.findOne({accountId: accountId})

    // check if the user is the author of the suggestion, or a owner:
    if (suggestion.accountId !== accountId && currentUser.badges?.owner !== true) {
        res.send({status: 'error', message: 'You are not the author of this suggestion'})
        return
    }
    

    let newSafety = 'sfw'

    if(suggestion.safety.toLowerCase() === 'sfw') {
        newSafety = 'nsfw'
    }

    await userSuggestionSchema.findOneAndUpdate({suggestionId: suggestionId}, {safety: newSafety})

    res.send({status: 'success', message: `Suggestion safety flipped to ${newSafety}`})
})

app.post('/submit-suggestion', async (req, res) => {

    // check if they are logged in:
    if(!req.session.loggedIn){
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

    if(highestSuggestion !== null) {
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
    let userSuggestions = await userSuggestionSchema.find({accountId: accountId})
    // remove any that dont have a status of pending:
    userSuggestions = userSuggestions.filter(suggestion => suggestion.status.toLowerCase() === 'pending')
    console.log(userSuggestions.length)
    if(userSuggestions.length >= 10) {
        res.send({status: 'error', message: 'You have already submitted 10 suggestions'})
        return
    }

    await userSuggestionSchema.create(newSuggestion)

    // wait 2 seconds:
    await new Promise(resolve => setTimeout(resolve, 2000))

    res.redirect('suggestions')
})

app.post('/vote-suggestion', async (req, res) => {

    // check if they are logged in:
    if(!req.session.loggedIn){
        res.redirect('/login')
        return
    }

    console.log(req.body)

    let suggestionId = req.body.suggestionId
    let accountId = req.session.accountId

    let suggestion = await userSuggestionSchema.findOne({suggestionId: suggestionId})

    if(suggestion === null) {
        res.send({status: 'error', message: 'Suggestion not found'})
        return
    }

    let upvoted = false
    let downvoted = false

    // check if the user has already upvoted or downvoted the suggestion:
    if(suggestion.upvotes.includes(accountId)) {
        upvoted = true
    }

    if(suggestion.downvotes.includes(accountId)) {
        downvoted = true
    }

    // if the user has already downvoted and have chosen to downvote, do nothing:
    if(downvoted && req.body.vote === 'downvote') {
        res.send({status: 'error', message: 'You have already downvoted this suggestion'})
        return
    }

    // if the user has already upvoted and have chosen to upvote, do nothing:
    if(upvoted && req.body.vote === 'upvote') {
        res.send({status: 'error', message: 'You have already upvoted this suggestion'})
        return
    }

    // if the user has already upvoted and have chosen to downvote, remove the upvote:
    if(upvoted && req.body.vote === 'downvote') {
        await userSuggestionSchema.findOneAndUpdate({suggestionId: suggestionId}, { $pull: { upvotes: accountId } })
    }

    // if the user has already downvoted and have chosen to upvote, remove the downvote:
    if(downvoted && req.body.vote === 'upvote') {
        await userSuggestionSchema.findOneAndUpdate({suggestionId: suggestionId}, { $pull: { downvotes: accountId } })
    }

    if (req.body.vote === 'upvote') {
        await userSuggestionSchema.findOneAndUpdate({suggestionId: suggestionId}, { $push: { upvotes: accountId } })
    } else if (req.body.vote === 'downvote') {
        await userSuggestionSchema.findOneAndUpdate({suggestionId: suggestionId}, { $push: { downvotes: accountId } })
    }

    suggestion = await userSuggestionSchema.findOne({suggestionId: suggestionId})

    // if suggestion doesnt exist, send error:
    if(suggestion === null) {
        res.send({status: 'error', message: 'Suggestion not found', votes: { upvotes: "Doesnt exist", downvotes: "Doesnt exist" }})
        return
    }

    res.send({status: 'success', message: `${req.body.vote} Vote submitted`, votes: { upvotes: suggestion.upvotes, downvotes: suggestion.downvotes }})
})

app.post('/remove-suggestion', async (req, res) => {

    // check if they are logged in:
    if(!req.session.loggedIn){
        res.redirect('/login')
        return
    }

    let suggestionId = req.body.suggestionId
    let accountId = req.session.accountId

    let currentUser = await userProfileSchema.findOne({accountId: accountId})
    let suggestion = await userSuggestionSchema.findOne({suggestionId: suggestionId})

    if(suggestion === null) {
        res.send({status: 'error', message: 'Suggestion not found'})
        return
    }

    // check if the user is the author of the suggestion, or a owner:
    if (suggestion.accountId !== accountId && currentUser.badges?.owner !== true) {
        res.send({status: 'error', message: 'You are not the author of this suggestion'})
        return
    }

    await userSuggestionSchema.findOneAndDelete({suggestionId: suggestionId})

    res.send({status: 'success', message: 'Suggestion removed'})
})

app.post('/update-suggestion-status', async (req, res) => {

    // check if they are logged in:
    if(!req.session.loggedIn){
        res.redirect('/login')
        return
    }

    let suggestionId = req.body.suggestionId
    let accountId = req.session.accountId

    let currentUser = await userProfileSchema.findOne({accountId: accountId})
    let suggestion = await userSuggestionSchema.findOne({suggestionId: suggestionId})

    if(suggestion === null) {
        res.send({status: 'error', message: 'Suggestion not found'})
        return
    }

    // check if the user is a owner:
    if(currentUser.badges?.owner !== true) {
        res.send({status: 'error', message: 'You are not a owner'})
        return
    }

    let newStatus = req.body.status

    await userSuggestionSchema.findOneAndUpdate({suggestionId: suggestionId}, {status: newStatus})

    res.send({status: 'success', message: 'Suggestion status updated'})
})

app.get('/suggestion/:suggestionId', async (req, res) => {
    let suggestionId = req.params.suggestionId

    let suggestion = await userSuggestionSchema.findOne({suggestionId: suggestionId})

    if(suggestion === null) {
        res.send('Suggestion not found')
        return
    }

    res.render('suggestions/suggestion', { suggestion: suggestion, session: req.session })
})


app.get('/image-history', async (req, res) => {
    let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    if (userProfile == null) {
        res.send('User not found')
        return
    }

    if(req.session.accountId == "1039574722163249233") {
        // make sure its sorted by _id getTimestamp:
        userHistory = await userHistorySchema.find({account_id: req.session.accountId}).sort({ _id: -1 })
    } else {
        userHistory = await userHistorySchema.find({account_id: req.session.accountId}).sort({ _id: -1 })
    }
        
    res.render('image-history', { userHistory: userHistory, session: req.session })
    
})

app.post('/image-history/delete-image', async (req, res) => {
    let image_id = req.body.image_id

    let image = await userHistorySchema.findOne({image_id: image_id, account_id: req.session.accountId})

    if(image === null) {
        res.send({status: 'error', message: 'Image not found'})
        return
    }

    if(image.account_id !== req.session.accountId) {
        res.send({status: 'error', message: 'You are not the author of this image'})
        return
    }

    await userHistorySchema.findOneAndDelete({image_id: image_id})

    res.send({status: 'success', message: 'Image removed'})
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
        res.json({ html: joinedFields });
    } catch (error) {
        console.error(error);
        res.status(500).send(`Error processing image data: ${error.message}`);
    }
});


// ? ai stuffs:

const { parse } = require('csv-parse/sync');

// Function to load tags from a CSV file
async function loadTags() {
    const csvContent = fs.readFileSync(path.resolve(__dirname, 'tags.csv'), { encoding: 'utf-8' });
    const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    // Sort the records by the usage count (which is at index 2) in descending order.
    records.sort((a, b) => b.post_count - a.post_count);

    let allTags = []

    records.forEach(record => {
        const tag = record.name;
        const score = parseInt(record.post_count); // Get the usage count and parse it as an integer.
        allTags.push({ tag: tag, score: score });
    });

    // sort the tags by score
    allTags.sort((a, b) => b.score - a.score);

    // console.log the top 10 tags:
    topx = allTags.slice(0, 5)
    // console.log(topx)

    return allTags;
}

let allTags = null

app.post('/autocomplete', async (req, res) => {
    if (allTags === null) {
        allTags = await loadTags();
    }

    const { query } = req.body;
    const tagsThatMatch = [];

    // Check if query is defined and not an empty string
    if (query && typeof query === 'string') {
        const lowercaseQuery = query.toLowerCase();

        for (const tagObj of allTags) {
            if (tagObj && tagObj.tag && tagObj.tag.toLowerCase().includes(lowercaseQuery)) {
                tagsThatMatch.push(tagObj);
            }
        }

        // sort the tags by score:
        tagsThatMatch.sort((a, b) => b.score - a.score);

        // get the top 10 tags:
        const topx = tagsThatMatch.slice(0, 5);

        // console.log(topx);
        res.json(topx);
    } else {
        // Handle the case when query is undefined or not a string
        res.status(400).json({ error: 'Invalid query parameter' });
    }
});

// ? test the autocomplete function:
try {
    timeBeforeTest = Date.now()
    fetch('https://www.jscammie.com/autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'large' })
    })
    .then(res => res.json())
    // .then(json => console.log(json));
    timeAfterTest = Date.now()
    // console.log(`1st ATTEMPT: Time taken: ${timeAfterTest - timeBeforeTest}ms`)

    // test again:
    timeBeforeTest = Date.now()
    fetch('https://www.jscammie.com/autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'small' })
    })
    .then(res => res.json())
    // .then(json => console.log(json));
    timeAfterTest = Date.now()
    // console.log(`2nd ATTEMPT: Time taken: ${timeAfterTest - timeBeforeTest}ms`)

} catch (error) {
    console.log(error)
}

let cachedYAMLData = null
// let AI_API_URL = "https://neversfw.ngrok.dev"
let AI_API_URL = "http://localhost:5003"

// Function to sort an object by its keys
function sortObjectByKey(obj) {
    return Object.keys(obj).sort().reduce((acc, key) => {
        acc[key] = obj[key];
        return acc;
    }, {});
}

// Function to fetch, sort, and cache YAML data
function updateYAMLCache() {
    try {
        fetch(`${AI_API_URL}/get-lora-yaml`)
            .then(response => response.json())
            .then(data => {
                // Sort the data
                Object.keys(data).forEach(category => {
                    data[category] = sortObjectByKey(data[category]);
                });

                cachedYAMLData = sortObjectByKey(data);
            })
            .catch(err => console.log('Error fetching YAML data:', err));
    } catch (error) {
        console.log(error)
    }

    if (cachedYAMLData !== null) {
        console.log('YAML data updated and cached');
        loraImagesCache()
    }
    
    
}

updateYAMLCache()

setTimeout(() => {
    updateYAMLCache()
}, 1000)

setInterval(updateYAMLCache, 5000);

async function loraImagesCache() {

    for (const [category, loras] of Object.entries(cachedYAMLData)) {
        // get the default image:
        const defaultImage = fs.readFileSync('.\\loraimages\\default.png')

        for (const [lora, loraData] of Object.entries(loras)) {

            // ensure directories exist:
            if (!fs.existsSync(`.\\loraimages\\${category}`)) {
                fs.mkdirSync(`.\\loraimages\\${category}`, { recursive: true })
            }
            if (!fs.existsSync(`.\\loraimages\\sdxl\\${category}`)) {
                fs.mkdirSync(`.\\loraimages\\sdxl\\${category}`, { recursive: true })
            }
            if (!fs.existsSync(`.\\loraimages\\flux\\${category}`)) {
                fs.mkdirSync(`.\\loraimages\\flux\\${category}`, { recursive: true })
            }

            // set the image path in the loraData:
            if(lora.includes('sdxl')) {
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
        let allLoras = await generationLoraSchema.find()

        for (const lora of allLoras) {
            // get the category and loraId:
            let category = lora.loraId.split('-')[0]
            let loraId = lora.loraId

            // get the loraData from the cachedYAMLData:
            let loraData = cachedYAMLData[category][loraId]

            loraData.usesCount = lora.usesCount
            loraData.lastUsed = lora.lastUsed

            // add the loraData back to the cachedYAMLData:
            cachedYAMLData[category][loraId] = loraData
        }

        console.log('Cached YAML data updated with images, usesCount, and lastUsed')
    } catch (error) {
        console.log(error)
    }
    

    modifiedCachedYAMLData = cachedYAMLData
    // console.log(cachedYAMLData)
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

app.get('/beta/ai', async function(req, res){
    try {

        reqIdString = `${req.session.accountId}`
        foundAccount = await userProfileSchema.findOne({accountId: reqIdString})

        if(foundAccount !== null) {
            if(foundAccount.aiSaveSlots !== null) {
                aiSaveSlots = foundAccount.aiSaveSlots
            } else {
                aiSaveSlots = []
                await userProfileSchema.findOneAndUpdate({ accountId: reqIdString },
                    {
                        aiSaveSlots: []
                    }
                )
            }
        } else {
            aiSaveSlots = []
        }

        let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

        let scripts = ""

        scripts = betaAiScripts

        res.render('aibeta', { 
            userProfile,
            session: req.session,
            scripts: scripts,
            lora_data: modifiedCachedYAMLData,
            aiSaveSlots: aiSaveSlots,
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error loading tags data');
    }
})

app.get('/userProfile', async (req, res) => {
    let userProfile = await userProfileSchema.findOne({ accountId: req.session.accountId });
    // check if the user exists, its a mongodb document that is returned:
    if (userProfile == null) {
        res.send({ status: 'error', message: 'User not found' })
        return
    }
    res.send({ userProfile: userProfile})
})

app.post('/dailies', async (req, res) => {

    if(!req.session.loggedIn){
        res.redirect('/login')
        return
    }

    let userProfile = await userProfileSchema.findOne({ accountId: req.session.accountId });

    // check if the user exists, its a mongodb document that is returned:
    if (userProfile == null) {
        res.send({ status: 'error', message: 'User not found' })
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
        case'3hr':
            dailiesTime = Number(timestamp3hr)
            differenceRequired = 10800000
            creditsEarned = 50
            break
        case'12hr':
            dailiesTime = Number(timestamp12hr)
            differenceRequired = 43200000
            creditsEarned = 100
            break
        case'24hr':
            dailiesTime = Number(timestamp24hr)
            differenceRequired = 86400000
            creditsEarned = 200
            break
        case'168hr':
            dailiesTime = Number(timestamp168hr)
            differenceRequired = 604800000
            creditsEarned = 500
            break
    }

    let dailiesTimeDifference = dailiesTime + differenceRequired

    if (dailiesTimeDifference > currentTimestamp) {
        console.log(`dailyType: ${dailyType}, username: ${userProfile.username}, currentTimestamp: ${currentTimestamp}, differenceRequired: ${differenceRequired}, dailiesTime: ${dailiesTime}, dailiesTimeDifference: ${dailiesTimeDifference}`)
        res.send({ status: 'error', message: 'Dailies already claimed' })
        return
    }

    newCredits = BigInt(userProfile.credits) + BigInt(creditsEarned)
    newCredits = newCredits.toString()

    if (dailyType == '3hr') {        
        await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { 'dailies.timestamp3hr': currentTimestamp, credits: newCredits })
    } else if (dailyType == '12hr') {
        await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { 'dailies.timestamp12hr': currentTimestamp, credits: newCredits })
    } else if (dailyType == '24hr') {
        await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { 'dailies.timestamp24hr': currentTimestamp, credits: newCredits })
    } else if (dailyType == '168hr') {
        await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { 'dailies.timestamp168hr': currentTimestamp, credits: newCredits })
    }
    res.send({ status: 'success', message: 'Dailies claimed' })
})

// update the aiScripts every 15 seconds:
setInterval(() => {
    aiScripts = {
        calculateCreditsPrice: fs.readFileSync('./scripts/ai-calculateCreditsPrice.js', 'utf8'),
        aiForm: fs.readFileSync('./scripts/ai-form.js', 'utf8'),
    }
    aiScripts.calculateCreditsPrice = aiScripts.calculateCreditsPrice.replace("module.exports = { getFastqueuePrice, getExtrasPrice }", "")
}, 15000)

app.get('/', async function(req, res){
    try {

        reqIdString = `${req.session.accountId}`
        foundAccount = await userProfileSchema.findOne({accountId: reqIdString})

        if(foundAccount !== null) {
            if(foundAccount.aiSaveSlots !== null) {
                aiSaveSlots = foundAccount.aiSaveSlots
            } else {
                aiSaveSlots = []
                await userProfileSchema.findOneAndUpdate({ accountId: reqIdString },
                    {
                        aiSaveSlots: []
                    }
                )
            }
        } else {
            aiSaveSlots = []
        }

        let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

        scripts = aiScripts

        res.render('ai', { 
            userProfile,
            session: req.session,
            scripts: scripts,
            lora_data: modifiedCachedYAMLData,
            aiSaveSlots: aiSaveSlots,
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error loading tags data');
    }
})

app.post('/token-length', async function(req, res){
    try {
        const response = await fetch(`${AI_API_URL}/token-length`, {
            method: 'POST',
            body: JSON.stringify(req.body),
            headers: { 'Content-Type': 'application/json' },
        });

        const json = await response.json();

        res.send(json);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error getting token length');
    }
})

app.post('/generate', async function(req, res){
    try {
        let request = req.body;  // Use 'let' or 'const' to ensure 'request' is scoped to this function

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
        if(cleanedPrompt.includes("<SPLIT>")) {
            res.send({status: "error", message: "BRUH LMAO"})
            return
        }

        if(request.negativeprompt.includes("<SPLIT>")) {
            res.send({status: "error", message: "BRUH LMAO"})
            return
        }

        let bannedTags = ['olivialewdz']
        // remove any banned tags from the prompt, use regex:
        cleanedPrompt = cleanedPrompt.replace(new RegExp(bannedTags.join("|"), "gi"), "");

        request.prompt = cleanedPrompt; // Update the prompt in the request object to be sent

        let filteredLastRequest = {
            prompt: cleanedPrompt,
            negativeprompt: request.negativeprompt,
            model: request.model,
            loras: request.lora,
            aspectRatio: request.aspect_ratio,
            favoriteLoras: request.favoriteLoras,
            strengthenabled: request.strengthenabled,
            autocompleteenabled: request.autocompleteenabled,
            steps: request.steps,
            quantity: request.quantity,
            cfguidance: request.guidance,
            seed: request.seed,
            scheduler: request.scheduler
        };
        req.session.lastRequestSD = filteredLastRequest;



        if (request.fastqueue == true || request.extras?.removeWatermark == true || request.extras?.upscale == true) {

            let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

            if (userProfile == null) {
                res.send({status: "error", message: "User not found"})
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
                extrasCreditsRequired = getExtrasPrice(request.extras)
                
                // add all the values in the extrasCreditsRequired object to the request.creditsRequired:
                for (const [key, value] of Object.entries(extrasCreditsRequired)) {
                    request.creditsRequired += value
                }
            }

            if (userProfile.credits < request.creditsRequired) {
                res.send({status: "error", message: "You do not have enough credits to generate an image with those settings!"})
                return
            }

            if (userProfile == null) {
                res.send({status: "error", message: "User not found"})
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
            headers: { 'Content-Type': 'application/json' },
        });

        const jsonResponse = await postResponse.json();
        res.send(jsonResponse);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error generating image');
    }
});


app.get('/cancel_request/:request_id', async function(req, res){
    try {
        request_id = req.param('request_id')
        const response = await fetch(`${AI_API_URL}/cancel_request/${request_id}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });

        const json = await response.json();

        res.send(json);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error cancelling request');
    }
})

app.get('/queue_position/:request_id', async function(req, res){
    try {
        request_id = req.param('request_id')
        const response = await fetch(`${AI_API_URL}/queue_position/${request_id}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });

        const json = await response.json();

        res.send(json);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error getting queue position');
    }
})

let imagesHistorySaveLocation = "E:/JSCammie/imagesHistory/"

app.get('/result/:request_id', async function(req, res){
    try {
        request_id = req.param('request_id')
        const response = await fetch(`${AI_API_URL}/result/${request_id}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });

        const json = await response.json();

        let usedLoras = json.historyData.loras

        console.log(typeof usedLoras)
        console.log(usedLoras)

        // convert the usedLoras "object" to an array, here is an example of the output `[ 'concept-sdxlantilongtorso', 'effect-sdxldetailifier' ]`:
        usedLoras = usedLoras.flat()

        console.log(typeof usedLoras)
        console.log(usedLoras)

        // for each lora in the usedLoras array, generationLoraSchema.findOneAndUpdate increase the usesCount by 1, update lastUsed to be the current timestamp, and upsert it if it doesnt exist:
        // first check if usedLoras is not empty:
        if (usedLoras.length > 0) {
            // the usesCount and lastUsed are strings, so they need to be converted to number / BigInt before they can be incremented THEN converted back to string:
            for (const lora of usedLoras) {
                currentLora = await generationLoraSchema.findOne({loraId: lora})
                if (currentLora == null) {
                    await generationLoraSchema.create({loraId: lora, usesCount: "1", lastUsed: `${Date.now()}`})
                } else {
                    usesCount = BigInt(currentLora.usesCount) + BigInt(1)
                    usesCount = usesCount.toString()
                    await generationLoraSchema.findOneAndUpdate({ loraId: lora }, { usesCount: usesCount, lastUsed: `${Date.now()}` })
                }
            }
        }



        if (json.historyData.account_id != "0") {

            // console.log(json.historyData)

            if (!fs.existsSync(imagesHistorySaveLocation)) {
                fs.mkdirSync(imagesHistorySaveLocation, { recursive: true });
            }
            if (!fs.existsSync(`${imagesHistorySaveLocation}${json.historyData.account_id}/`)) {
                fs.mkdirSync(`${imagesHistorySaveLocation}${json.historyData.account_id}/`, { recursive: true });
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
            
                        // Insert the new image history document into the database
                        await userHistorySchema.create(newImageHistory);
            
                        // Increment the image ID for the next iteration
                        nextImageId = BigInt(nextImageId) + BigInt(1);
                    }
                } catch (err) {
                    console.error('Error saving image or updating database:', err);
                }
            }
            
        }
        

        if (json.historyData.account_id !== "0" && json.fastqueue === true && json.status !== "error") {
            // get the user profile:
            let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

            creditsRequired = json.creditsRequired

            // set credits to be the default value if it is not found:
            if (userProfile.credits == null || userProfile.credits == undefined) {
                creditsCurrent = 500
            } else {
                creditsCurrent = userProfile.credits
            }

            // creditsFinal = creditsCurrent - creditsRequired
            creditsFinal = BigInt(creditsCurrent) - BigInt(creditsRequired)
            creditsFinal = creditsFinal.toString()

            await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { credits: creditsFinal })

            // console.log(`${userProfile.username} credits decremented by ${creditsRequired}`)
            json.credits = userProfile.credits - creditsRequired
        }

        if (json.historyData.account_id !== "0" && req.session.loggedIn && json.status !== "error") {
            let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})
            if (userProfile.credits == null || userProfile.credits == undefined) {
                creditsCurrent = 500
            } else {
                creditsCurrent = userProfile.credits
            }

            // have a random change to get a credit, 1 in 2 chance:
            randomChance = Math.round(Math.floor(Math.random() * 2))
            randomCredits = 1
            randomChance2 = Math.round(Math.floor(Math.random() * 1000))

            if (randomChance2 == 1) {
                randomCredits += 25
            }

            // if the random number is 1, add the credits to the user:
            if (randomChance == 1) {
                creditsCurrent = BigInt(creditsCurrent) + BigInt(randomCredits)
            }
            creditsCurrent = creditsCurrent.toString()
            // console.log(`${userProfile.username} credits incremented by ${randomCredits}`)
            await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { credits: creditsCurrent })
            json.credits = creditsCurrent
        }        

        historyData = json.historyData

        res.send(json);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error getting result');
    }
})

app.post('/enhance_prompt', async function(req, res){
    try {
        const response = await fetch(`http://127.0.0.1:5001/enhance_prompt`, {
            method: 'POST',
            body: JSON.stringify(req.body),
            headers: { 'Content-Type': 'application/json' },
        });
        
        const json = await response.json();

        res.send(json);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error enhancing prompt');
    }
})

app.get('/chat', async function(req, res){
    res.render('chat', { session: req.session });
})

app.post('/chat', async function(req, res){
    try {

        const response = await fetch(`http://127.0.0.1:5005/chat`, {
            method: 'POST',
            body: JSON.stringify(req.body),
            headers: { 'Content-Type': 'application/json' },
        });

        const json = await response.json();

        res.send(json);

    } catch (error) {
        console.error(error);
        res.status(500).send('Error chatting');
    }
})

app.post('/ai-save-create', async function(req, res){

    userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    if(userProfile == null) {
        res.send({error: 'User profile not found'})
        return
    }

    let noSaves = false

    // using mongoose push empty save slot to user profile,
    // using the defaults in the schema apart from the saveSlotId which needs to be +1 of the last one:
    if(userProfile.aiSaveSlots.length == Array(0)) {
        noSaves = true
        userProfile.aiSaveSlots = []
        
    }

    // get the last save slot id and add 1 to it to get the next save slot id:

    if(noSaves) {
        nextSaveSlotId = 0
    } else {
        mostRecentSaveSlotId = Number(userProfile.aiSaveSlots[userProfile.aiSaveSlots.length - 1].saveSlotId)
        nextSaveSlotId = mostRecentSaveSlotId + 1
    }

    String(nextSaveSlotId)

    await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId },
        {
            $push: { aiSaveSlots: { 
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
            } }
        }
    )

    res.send({success: 'Created'})

})

app.post('/ai-save-update', async function(req, res){

    userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    if(userProfile == null) {
        res.send({error: 'User profile not found'})
        return
    }

    if(userProfile.aiSaveSlots === null) {
        userProfile.aiSaveSlots = []
    }

    saveSlotId = req.body.saveSlotId

    // update the save slot using the saveSlotId to find it in the array of save slots: 
    await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId, "aiSaveSlots.saveSlotId": saveSlotId },
        {
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
        }
    )

    res.send({success: 'Updated'})
    
})

app.get('/ai-saves-get', async function(req, res){

    userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    if(userProfile == null) {
        res.send({error: 'User profile not found'})
        return
    }

    res.send({aiSaveSlots: userProfile.aiSaveSlots})

})

app.post('/ai-save-delete/', async function(req, res){

    userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    if(userProfile == null) {
        res.send({error: 'User profile not found'})
        return
    }

    // delete the specific array item from the userprofile.aiSaveSlots array
    saveSlotId = req.body.saveSlotId
    await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId },
        {
            $pull: { aiSaveSlots: { saveSlotId: saveSlotId } }
        }
    )
    res.send({success: 'Deleted'})
})

app.get('/ai', async function(req, res){
    res.redirect('/')
})


const userBooruSchema = require('./schemas/userBooruSchema.js');
const userBooruTagsSchema = require('./schemas/userBooruTagsSchema.js');

let booruSearchScript = fs.readFileSync('./scripts/booru-search.js', 'utf8')

setInterval(() => {
    booruSearchScript = fs.readFileSync('./scripts/booru-search.js', 'utf8')
}, 15000)



let booruFolder = "E:/JSCammie/booruImages/"


app.get('/booru/post/:booru_id', async function(req, res){
    booru_id = req.param('booru_id')

    let foundBooruImage = await userBooruSchema.findOne({booru_id: booru_id})

    if (foundBooruImage == null) {
        res.redirect('/booru/')
        return
    }

    // find the user profile:
    let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    let postProfile = await userProfileSchema.findOne({accountId: foundBooruImage.account_id})

    let foundBooruImages = await userBooruSchema.aggregate([
        { $match: { account_id: foundBooruImage.account_id } },
        {
            $group: {
                _id: "$safety",
                count: { $sum: 1 }
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

    

    res.render('booru/post', { session: req.session, booruImage: foundBooruImage, booruSearchScript, userProfile, postProfile })

})

function splitTags(tags) {
    // make all the tags lowercase:
    tags = tags.map(tag => tag.toLowerCase())
    // replace every space with a dash:
    tags = tags.map(tag => tag.replace(/ /g, '_'))
    // remove any empty tags:
    tags = tags.filter(tag => tag !== "")
    return tags
}

app.get('/booru/', async function(req, res){
    search = req.param('search') || ""
    page = req.param('page') || 1
    safety = req.param('safety') || ["sfw"]
    sort = req.param('sort') || "recent"

    totalPerPage = 24

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

    let booruImages = []

    if (search === "") {
        // booruImages = await userBooruSchema.find().sort({timestamp: -1}).skip(skip).limit(30)
        // filter by the safety:
        if (sort == "recent") {
            booruImages = await userBooruSchema.find({safety: { $in: safety }}).sort({timestamp: -1}).skip(skip).limit(totalPerPage)
        } else if (sort == "votes") {
            // there are 2 votes, upvotes and downvotes, get the difference of the array.length of upvotes and downvotes:
            booruImages = await userBooruSchema.aggregate([
                { $match: { safety: { $in: safety } } },
                {
                    $addFields: {
                        votes: { $subtract: [ { $size: "$upvotes" }, { $size: "$downvotes" } ] }
                    }
                },
                { $sort: { votes: -1 } },
                { $skip: skip },
                { $limit: totalPerPage }
            ])
        }
        // get the total count of the pages:
        totalImages = await userBooruSchema.find({safety: { $in: safety }}).countDocuments()
    } else {

        searchTags = search.split(' ')
        searchTags = splitTags(searchTags)

        console.log(`searchTags: ${searchTags}`)

        const regex = searchTags.map(tag => tag.replace(/[()]/g, '')).map(tag => `(?=.*${tag})`).join('')

        let allFoundBooruIds = [];

        // set all tags to be lowercase:
        searchTags = searchTags.map(tag => tag.toLowerCase())

        const promises = searchTags.map(async (tag) => {
            let foundTag = await userBooruTagsSchema.findOne({ tag: tag });
            if (foundTag !== null) {
                return foundTag.booru_ids; // return the booru_ids array
            }
            return [];
        });

        const allFoundBooruIdsArrays = await Promise.all(promises);

        // Filter to get only booru_ids that appear in all arrays
        let allBooruIds = allFoundBooruIdsArrays.reduce((acc, val) => acc.filter(x => val.includes(x)));

        console.log(allBooruIds);

        

        // now get the booruImages that have the booru_ids in allBooruIds:
        if (sort == "recent") {
            booruImages = await userBooruSchema.find({booru_id: { $in: allBooruIds }, safety: { $in: safety }}).sort({timestamp: -1}).skip(skip).limit(totalPerPage)
        } else if (sort == "votes") {
            booruImages = await userBooruSchema.aggregate([
                {
                    $match: {
                        booru_id: { $in: allBooruIds },
                        safety: { $in: safety }
                    }
                },
                {
                    $addFields: {
                        votes: { $subtract: [ { $size: "$upvotes" }, { $size: "$downvotes" } ] }
                    }
                },
                { $sort: { votes: -1 } },
                { $skip: skip },
                { $limit: totalPerPage }
            ])
        }


        // get the total count of the pages:
        totalImages = await userBooruSchema.aggregate([
            {
                $match: {
                    prompt: { $regex: regex, $options: 'i' },
                    safety: { $in: safety }
                }
            },
            { $count: 'count' }
        ]);

        if (totalImages.length == 0) {
            totalImages = 0
        } else {
            totalImages = totalImages[0].count
        }

    }

    // get the total count of the pages:
    totalPages = Math.ceil(totalImages / totalPerPage)

    console.log(`totalPages: ${totalPages}`)
    
    let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    if (req.session.loggedIn) {
        res.render('booru/home', { session: req.session, booruImages: booruImages, userProfile: userProfile, booruSearchScript: booruSearchScript, totalPages: totalPages });
        return
    } else {
        res.render('booru/home', { session: req.session, booruImages: booruImages, userProfile: userProfile, booruSearchScript: booruSearchScript, totalPages: totalPages });
    }

})

app.get('/mergetagstolowercase', async function(req, res){

    let tags = await userBooruTagsSchema.find()

    let uppercaseTags = tags.filter(tag => tag.tag !== tag.tag.toLowerCase())

    for (const tag of uppercaseTags) {
        // if there is a tag that is lowercase in the userBooruTagsSchema, then add the booru_ids to the lowercase tag, making sure to not have merges, then delete the uppercase tag:
        let lowercaseTag = await userBooruTagsSchema.findOne({tag: tag.tag.toLowerCase()})

        if (lowercaseTag == null) {
            await userBooruTagsSchema.findOneAndUpdate({tag: tag.tag}, {tag: tag.tag.toLowerCase(), count: tag.count, booru_ids: tag.booru_ids})
            await userBooruTagsSchema.findOneAndDelete({tag: tag.tag})
        } else {
            // merge the booru_ids to the lowercase tag:
            differentBooruIds = tag.booru_ids.filter(booru_id => !lowercaseTag.booru_ids.includes(booru_id))
            let newCount = lowercaseTag.booru_ids.length + differentBooruIds.length
            newCount = newCount.toString()
            await userBooruTagsSchema.findOneAndUpdate({tag: tag.tag.toLowerCase()}, {count: newCount, $push: {booru_ids: { $each: differentBooruIds } } })
            await userBooruTagsSchema.findOneAndDelete({tag: tag.tag})
        }

    }

    res.send({status: "success"})
})

app.post('/tags-autocomplete', async function(req, res){
    try {

        // let tags = await userBooruTagsSchema.find().sort({count: -1})
        // count is a string so use aggregate to convert it to a number, then sort by count, also limit to 10:
        let lastWord = req.body.lastWord

        let tags = await userBooruTagsSchema.aggregate([
            {
                $match: {
                    tag: { $regex: lastWord, $options: 'i' } // Filters tags that contain the lastWord (case insensitive)
                }
            },
            {
                $addFields: {
                    count: { $toInt: "$count" }
                }
            },
            { 
                $sort: { count: -1 } 
            },
            { 
                $limit: 10 
            }
        ]);


        res.send({tags: tags})
    } catch (error) {
        console.log(error);
        res.status(500).send('Error getting tags');
    }
})

he = require('he')

app.post('/create-booru-image', async function(req, res){
    try {
        data = req.body

        // check if the user account exists:
        let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

        if(userProfile == null) {
            res.send({error: 'User profile not found'})
            return
        }

        // check if the folder for the user exists:
        if (!fs.existsSync(`${booruFolder}/${req.session.accountId}/`)) {
            fs.mkdirSync(`${booruFolder}/${req.session.accountId}/`, { recursive: true });
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

        // make all the tags lowercase:
        

        for (const tag of tags) {
            // check if the tag exists in the userBooruTagsSchema:
            let foundTag = await userBooruTagsSchema.findOne({tag: tag})

            if (foundTag == null) {
                newCount = BigInt(1)
                newCount = newCount.toString()
            } else {
                newCount = BigInt(foundTag.count) + BigInt(1)
                newCount = newCount.toString()
            }

            await userBooruTagsSchema.findOneAndUpdate({tag: tag},
                { // count is a string, make sure to convert it to a BigInt before incrementing, then back:
                    tag: tag,
                    count: newCount,
                    $push: {booru_ids: `${req.session.accountId}-${nextImageId}`},
                },
                {upsert: true}
            )
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

        res.send({status: "success", message: "Booru image created", booru_id: `${req.session.accountId}-${nextImageId}`})

    } catch (error) {
        console.log(error);
        res.status(500).send('Error creating booru image');
    }
})

// href="/booru/setRating/${value.booru_id}/nsfw"
app.get('/booru/setRating/:booru_id/:rating', async function(req, res){
    booru_id = req.param('booru_id')
    rating = req.param('rating')

    let foundBooruImage = await userBooruSchema.findOne({booru_id: booru_id})

    if (foundBooruImage == null) {
        res.send({status: "error", message: "Booru image not found"})
        return
    }

    let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    let creatorProfile = await userProfileSchema.findOne({accountId: foundBooruImage.account_id})

    // if the user is not logged in, send them back to the previous page:
    if (!req.session.loggedIn) {
        res.redirect('back')
        return
    }

    // check if the user has badges.moderator:
    if (userProfile.badges?.moderator !== true) {
        res.send({status: "error", message: "User does not have permission to set the rating"})
        return
    }
    

    // if foundBooruImage.safety is na, then give the creatorProfile 25 credits:
    if (foundBooruImage.safety == "na") {
        currentCredits = BigInt(creatorProfile.credits)
        newCredits = currentCredits + BigInt(15)
        newCredits = newCredits.toString()
        await userProfileSchema.findOneAndUpdate({ accountId: foundBooruImage.account_id }, { credits: newCredits })
    }

    await userBooruSchema.findOneAndUpdate({ booru_id: booru_id }, { safety: rating })

    // send them back to the previous page:
    res.redirect('back')
})

// <a href="/booru/delete/${value.booru_id}">Delete</a>
app.get('/booru/delete/:booru_id', async function(req, res){
    booru_id = req.param('booru_id')

    let foundBooruImage = await userBooruSchema.findOne({booru_id: booru_id})

    let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

    if (foundBooruImage == null) {
        res.send({status: "error", message: "Booru image not found"})
        return
    }

    // check if the user either owns the image, or has badges.moderator:
    if (foundBooruImage.account_id !== req.session.accountId && userProfile.badges?.moderator !== true) {
        res.send({status: "error", message: "User does not own the image"})
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
    await userBooruSchema.findOneAndDelete({ booru_id: booru_id })

    // delete the image from the userBooruTagsSchema:
    // find every booruTagsSchema where the array booru_ids contains the booru_id:
    let foundTags = await userBooruTagsSchema.find({booru_ids: booru_id})

    for (const tag of foundTags) {
        await userBooruTagsSchema.findOneAndUpdate({tag: tag.tag},
            { $pull: {booru_ids: booru_id} }
        )
        // if the booru_ids array is empty, delete the tag:
        if (tag.booru_ids.length == 0) {
            await userBooruTagsSchema.findOneAndDelete({tag: tag.tag})
        }
    }

    res.redirect('back')
})

// upvotes and downvotes logic:
app.post('/booru/vote', async function(req, res){
try {
    let data = req.body
    let vote = data.vote
    let booru_id = data.booru_id
    let account_id = req.session.accountId

    let foundBooruImage = await userBooruSchema.findOne({booru_id: booru_id})

    if (foundBooruImage == null) {
        res.send({status: "error", message: "Booru image not found"})
        return
    }

    let userProfile = await userProfileSchema.findOne({accountId: account_id})

    if (userProfile == null) {
        res.send({status: "error", message: "User not found"})
        return
    }

    switch (vote) {
        case 'upvote':
            // check if the user has already upvoted:
            if (foundBooruImage.upvotes.includes(account_id)) {
                res.send({status: "error", message: "User has already upvoted"})
                return
            }
            // check if the user has already downvoted:
            if (foundBooruImage.downvotes.includes(account_id)) {
                // remove the downvote:
                await userBooruSchema.findOneAndUpdate({ booru_id: booru_id }, {
                    $pull: { downvotes: account_id }
                })                
            }
            // add the upvote:
            await userBooruSchema.findOneAndUpdate({ booru_id: booru_id }, {
                $push: { upvotes: account_id }
            })
            break
        case 'downvote':
            // check if the user has already downvoted:
            if (foundBooruImage.downvotes.includes(account_id)) {
                res.send({status: "error", message: "User has already downvoted"})
                return
            }
            // check if the user has already upvoted:
            if (foundBooruImage.upvotes.includes(account_id)) {
                // remove the upvote:
                await userBooruSchema.findOneAndUpdate({ booru_id: booru_id }, {
                    $pull: { upvotes: account_id }
                })                
            }
            // add the downvote:
            await userBooruSchema.findOneAndUpdate({ booru_id: booru_id }, {
                $push: { downvotes: account_id }
            })
            break
        }

        let newBooruImage = await userBooruSchema.findOne({booru_id: booru_id})

        res.send({status: "success", message: "Vote added", upvotes: newBooruImage.upvotes.length, downvotes: newBooruImage.downvotes.length})

} catch (error) {
    console.log(error);
    res.status(500).send('Error voting');
}
})

app.get('/profile/:account_id', async function(req, res){
    account_id = req.param('account_id')

    console.log(account_id)

    let profileProfile = await userProfileSchema.findOne({accountId: account_id})

    if (profileProfile == null) {
        res.send({status: "error", message: "User not found"})
        return
    }

    let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId })

    let userBooru = await userBooruSchema.find({account_id: account_id})

    res.render('profile', { session: req.session, profileProfile: profileProfile, userProfile: userProfile, userBooru: userBooru });
})





const http = require('http')
const https = require('https');

// https only enabled when not in DEVELOPMENT mode, as the certificates are not valid for localhost/not in the repo:
if (process.env.DEVELOPMENT !== 'true') {
    const caBundle = fs.readFileSync(process.env.CA_BUNDLE_PATH)
    const caString = caBundle.toString();
    const ca = caString.split('-----END CERTIFICATE-----\r\n').map(cert => cert +'-----END CERTIFICATE-----\r\n')
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
        console.log(`Example app listening at https://localhost:443`)
    })

}


const httpServer = http.createServer(app)

httpServer.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`)
})