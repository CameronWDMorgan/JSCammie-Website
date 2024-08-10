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

// add Clear-Site-Data: "cache" as a header to clear the cache on ANY page load:
app.use((req, res, next) => {
    res.setHeader('Clear-Site-Data', '"cache"');
    next();
});

app.use(express.json());

const userProfileSchema = require('./schemas/userProfileSchema.js');
const userSuggestionSchema = require('./schemas/userSuggestionSchema.js');
const { type } = require('os');

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
    // sort by upvotes - downvotes, then sort by wether the status is Pending, Approved, or Denied:
    suggestions = suggestions.sort((a, b) => (b.upvotes.length - b.downvotes.length) - (a.upvotes.length - a.downvotes.length))
    

    // sort them by status, with the order being: Added in the middle, Pending at the top, Rejected at the bottom:

    suggestions = suggestions.sort((a, b) => {
        let statusOrder = {
            'pending': 0,
            'added': 1,
            'rejected': 2
        }

        return statusOrder[a.status.toLowerCase()] - statusOrder[b.status.toLowerCase()]
    })

    // userProfile:

    if(req.session.loggedIn){
        userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})
    } else {
        userProfile = {}
    }

    console.log(userProfile.badges)

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
    if(userSuggestions.length >= 2) {
        res.send({status: 'error', message: 'You have already submitted 2 suggestions'})
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

    res.send({status: 'success', message: `${req.body.vote} Vote submitted`, votes: { upvotes: suggestion.upvotes.length, downvotes: suggestion.downvotes.length }})
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
    .then(json => console.log(json));
    timeAfterTest = Date.now()
    console.log(`1st ATTEMPT: Time taken: ${timeAfterTest - timeBeforeTest}ms`)

    // test again:
    timeBeforeTest = Date.now()
    fetch('https://www.jscammie.com/autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'small' })
    })
    .then(res => res.json())
    .then(json => console.log(json));
    timeAfterTest = Date.now()
    console.log(`2nd ATTEMPT: Time taken: ${timeAfterTest - timeBeforeTest}ms`)

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

setInterval(updateYAMLCache, 60000);

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

            // set the image path in the loraData:
            if(lora.includes('sdxl')) {
                // if there is no lora image then set it to the default image:
                if (!fs.existsSync(`.\\loraimages\\sdxl\\${category}\\${lora}.png`)) {
                    fs.writeFileSync(`.\\loraimages\\sdxl\\${category}\\${lora}.png`, defaultImage)
                }
                loraData.image = `http://www.jscammie.com/loraimages/sdxl/${category}/${lora}.png`
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
        console.log(`Cached YAML data updated with images for ${category}`)
    }
    console.log('Cached YAML data updated with images')
    modifiedCachedYAMLData = cachedYAMLData
    // console.log(cachedYAMLData)
}

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



        scripts = {
            calculateCreditsPrice: fs.readFileSync('./scripts/ai-calculateCreditsPrice.js', 'utf8'),
            aiForm: fs.readFileSync('./scripts/ai-form.js', 'utf8'),
        }

        // remove the following from calculateCreditsPrice:
        /* 
        module.exports = {
            getFastqueuePrice,
            getExtrasPrice
        }
        */

        scripts.calculateCreditsPrice = scripts.calculateCreditsPrice.replace("module.exports = { getFastqueuePrice, getExtrasPrice }", "")


        res.render('beta/ai', { 
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
    res.send({ userProfile: userProfile})
})

app.post('/dailies', async (req, res) => {
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

    switch (dailyType) {
        case'3hr':
            dailiesTime = Number(timestamp3hr)
            differenceRequired = 10800000
            creditsEarned = 100
            break
        case'12hr':
            dailiesTime = Number(timestamp12hr)
            differenceRequired = 43200000
            creditsEarned = 300
            break
    }

    let dailiesTimeDifference = dailiesTime + differenceRequired

    if (dailiesTimeDifference > currentTimestamp) {
        console.log(`dailyType: ${dailyType}, username: ${userProfile.username}, currentTimestamp: ${currentTimestamp}, differenceRequired: ${differenceRequired}, dailiesTime: ${dailiesTime}, dailiesTimeDifference: ${dailiesTimeDifference}`)
        res.send({ status: 'error', message: 'Dailies already claimed' })
        return
    }

    if (dailyType == '3hr') {
        await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { 'dailies.timestamp3hr': currentTimestamp, credits: userProfile.credits + creditsEarned })
    } else if (dailyType == '12hr') {
        await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { 'dailies.timestamp12hr': currentTimestamp, credits: userProfile.credits + creditsEarned })
    }

    res.send({ status: 'success', message: 'Dailies claimed' })
})


let aiScripts = {
    calculateCreditsPrice: fs.readFileSync('./scripts/ai-calculateCreditsPrice.js', 'utf8'),
    aiForm: fs.readFileSync('./scripts/ai-form.js', 'utf8'),
}

aiScripts.calculateCreditsPrice = aiScripts.calculateCreditsPrice.replace("module.exports = { getFastqueuePrice, getExtrasPrice }", "")

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
        if(cleanedPrompt.includes(":")) {
            res.send({status: "error", message: "Please remove any ':' from the prompt. To apply strengths (both positive or negative), use this format: 'word+', 'word++', '(word1, word2)+', '(word1, word2)++' or 'word1-', 'word2--', '(word1, word2)-', '(word1, word2)--'."})
            return
        }

        if (request.negativeprompt.includes(":")) {
            res.send({status: "error", message: "Please remove any ':' from the negative prompt. To apply strengths (both positive or negative), use this format: 'word+', 'word++', '(word1, word2)+', '(word1, word2)++' or 'word1-', 'word2--', '(word1, word2)-', '(word1, word2)--'."})
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

            let fastqueueCreditsRequired = null

            if (request.fastqueue == true) {
                fastqueueCreditsRequired = getFastqueuePrice(request.lora.length, request.model)
                request.creditsRequired += fastqueueCreditsRequired
            }

            let extrasCreditsRequired = {removeWatermark: null}

            // if any value in the extras object is true, then proceed with the if statement:
            if (Object.values(request.extras).includes(true)) {
                extrasCreditsRequired = getExtrasPrice(request.extras)
                
                // add all the values in the extrasCreditsRequired object to the request.creditsRequired:
                for (const [key, value] of Object.entries(extrasCreditsRequired)) {
                    request.creditsRequired += value
                }
            }

            // console.log all the keys and values of fastqueueCreditsRequired and extrasCreditsRequired:
            console.log("Fastqueue Credits required:")
            for (const [key, value] of Object.entries(fastqueueCreditsRequired)) {
                console.log(`${key}: ${value}`)
            }

            console.log("Extras Credits required:")
            for (const [key, value] of Object.entries(extrasCreditsRequired)) {
                console.log(`${key}: ${value}`)
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

app.get('/result/:request_id', async function(req, res){
    try {
        request_id = req.param('request_id')
        const response = await fetch(`${AI_API_URL}/result/${request_id}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });

        const json = await response.json();

        if (json.accountId !== "0" && json.fastqueue === true && json.status !== "error") {
            // get the user profile:
            let userProfile = await userProfileSchema.findOne({accountId: req.session.accountId})

            creditsRequired = json.creditsRequired

            // set credits to be the default value if it is not found:
            if (userProfile.credits == null || userProfile.credits == undefined) {
                creditsCurrent = 500
            } else {
                creditsCurrent = userProfile.credits
            }

            creditsFinal = creditsCurrent - creditsRequired

            await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { credits: creditsFinal })

            console.log(`${userProfile.username} credits decremented by ${creditsRequired}`)
            json.credits = userProfile.credits - creditsRequired
        }

        if (json.accountId !== "0" && req.session.loggedIn) {
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
                creditsCurrent += randomCredits
            }
            console.log(`${userProfile.username} credits incremented by ${randomCredits}`)
                await userProfileSchema.findOneAndUpdate({ accountId: req.session.accountId }, { credits: creditsCurrent })
                json.credits = creditsCurrent
        }

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