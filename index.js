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

app.use((req, res, next) => {
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

const userProfileSchema = require('./schemas/userProfileSchema.js')

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

        res.sendStatus(200)
    })

})

app.get('/upload', (req, res) => {

    if(!req.session.loggedIn){
        res.redirect('/login')
        return
    }

    res.render('upload', {
        session: req.session
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
        const buffer = buffer.from(base64, 'base64');
        
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

        res.render('beta/ai', { 
            session: req.session,
            lora_data: modifiedCachedYAMLData,
            aiSaveSlots: aiSaveSlots,
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error loading tags data');
    }
})

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

        res.render('ai', { 
            session: req.session,
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
            $set: { "aiSaveSlots.$.prompt": req.body.prompt,
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