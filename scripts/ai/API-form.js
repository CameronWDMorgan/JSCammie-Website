// Utility functions
const getDefaultHeaders = () => ({
    'Content-Type': 'application/json',
});

const getBase64 = (file) => 
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

// DOM helper functions
const funcElementById = (id) => document.getElementById(id);
const getValue = (id) => funcElementById(id)?.value;
const getCheckboxState = (id) => funcElementById(id)?.checked ?? false;
const API_BASE = ''
let requestId = null
let cancelledGeneration = false
let uploadsToBooru = 0

// ETA calculation variables
let timeForNextPositionLower = []
let lastLowestPosition = 9999
let lastRecordedTime = null
let lastPosition = null
let stagnantPositionCount = 0
let positionChangeCount = 0
const MIN_POSITION_CHANGES_FOR_ETA = 1  // Only show ETA after 1 position change instead of 2
const MAX_HISTORY_LENGTH = 15  // Increased history length for better accuracy
const POSITION_UPDATE_TIMEOUT = 10000  // 10 seconds max without position update
const ETA_SAFETY_MULTIPLIER = 1.5  // Increased from 1.25 to 1.5 to avoid underestimation
const ETA_FIXED_BUFFER = 30000  // Add 30 seconds fixed buffer to all estimates

// Global status message for integration with queue display
let currentStatusMessage = null;
let currentStatusType = 'info'; // 'info', 'success', 'error', 'generating'
let isQueueCheckingActive = false; // Flag to prevent multiple queue checking loops

// Function to reset ETA calculation variables
const resetETACalculation = () => {
    // Don't reset timeForNextPositionLower to preserve average time data between generations
    lastLowestPosition = 9999
    lastRecordedTime = null
    lastPosition = null
    stagnantPositionCount = 0
    positionChangeCount = 0
}

// State management
const UIState = {
    generateButton: funcElementById('generateButton'),
    response: funcElementById('response'),
    queuePosition: funcElementById('queuePosition'),
    positionNumber: funcElementById('positionNumber'),
    cancelButton: funcElementById('cancelButton'),
    imagesContainer: funcElementById('imagesContainer'),

    setGenerating(isGenerating) {
        console.log("setGenerating called:", isGenerating, "Stack trace:", new Error().stack);
        this.generateButton.disabled = isGenerating;
        this.generateButton.textContent = isGenerating ? 'Generating Image' : 'Generate Image';
        this.generateButton.classList[isGenerating ? 'add' : 'remove']('generating');
        // if its set to false, hide the your position in queue message:
        if (!isGenerating) {
            this.hideQueuePosition();
            this.setStatus(null); // Clear status when not generating
        }
    },

    setError(message) {
        this.setStatus(message, 'error');
        this.setGenerating(false);
        this.cancelButton.style.display = 'none';
        requestId = null; // Clear request ID when error occurs
    },

    setStatus(message, type = 'info') {
        currentStatusMessage = message;
        currentStatusType = type;
        // Don't update response.innerText anymore - let the queue display handle it
    },

    updateQueuePosition(position, queueLength) {
        this.queuePosition.style.display = 'none'; // Hide the separate position display
        const currentTime = new Date().getTime();
        
        // Initialize time tracking on first call
        if (lastRecordedTime === null) {
            lastRecordedTime = currentTime;
            lastPosition = position;
            stagnantPositionCount = 0;
            lastLowestPosition = position;
            positionChangeCount = 0;
            return; // Don't update display here, let the 5-second interval handle it
        }
        
        const timeDiff = currentTime - lastRecordedTime;
        
        // Record time data in these cases:
        // 1. Position decreased (queue progressed)
        // 2. Position stayed same but significant time passed
        if (position < lastPosition) {
            // Position decreased - good data point
            const positionDiff = lastPosition - position;
            const timePerPosition = timeDiff / positionDiff;
            
            // Increment the position change counter - only count distinct updates, not the difference
            positionChangeCount += 1;
            
            // Add time entry - no weights, simple data collection
            timeForNextPositionLower.push(timePerPosition);
            
            // Reset stagnant counter since queue moved
            stagnantPositionCount = 0;
            lastLowestPosition = position;
            lastRecordedTime = currentTime;
        } else if (position === lastPosition && timeDiff > POSITION_UPDATE_TIMEOUT) {
            // Position stagnant for too long - might be slower than usual
            stagnantPositionCount++;
            
            // Only add stagnant data points if we have some history already
            // and we haven't added too many stagnant entries yet
            if (stagnantPositionCount <= 2 && timeForNextPositionLower.length > 0) {
                // Calculate average from existing data
                let avgTime = timeForNextPositionLower.reduce((sum, time) => sum + time, 0) / 
                    timeForNextPositionLower.length;
                
                // Add a slightly inflated entry
                timeForNextPositionLower.push(avgTime * 1.2);  // 20% slower
            }
            
            // Reset time counter for next check
            lastRecordedTime = currentTime;
        }
        
        // Limit history to most recent entries
        if (timeForNextPositionLower.length > MAX_HISTORY_LENGTH) {
            timeForNextPositionLower.shift();
        }
        
        // Update for next iteration
        lastPosition = position;
        
        // Store current position and ETA for the 5-second update to use
        window.currentQueuePosition = position;
        window.currentQueueLength = queueLength;
    },

    updateMainQueueDisplayWithPosition(position, etaString) {
        // This method is no longer used - everything is handled in the 5-second interval
    },

    formatIndividualETA(position, etaString) {
        // This method is no longer used as we're integrating with the main display
        return '';
    },

    hideQueuePosition() {
        this.queuePosition.style.display = 'none';
        
        // Remove individual position section from the main queue display
        const bothQueueETAElement = funcElementById('bothQueueETA');
        if (bothQueueETAElement && bothQueueETAElement.innerHTML.includes('individualPositionSection')) {
            const updatedContent = bothQueueETAElement.innerHTML.replace(
                /<div id="individualPositionSection"[^>]*>[\s\S]*?<\/div>/,
                ''
            );
            bothQueueETAElement.innerHTML = updatedContent;
        }
    },

    setQueueStatus(message) {
        this.setStatus(message, 'generating');
    }
};

// Request data builder
const buildRequestData = async () => {
    const requestType = getCheckboxState('inpaintingCheckbox') ? 'inpainting' : 
                       getCheckboxState('img2imgCheckbox') ? 'img2img' : 'txt2img';

    let imageBase64 = null;
    let strength = getValue(requestType === 'inpainting' ? 'inpaintingStrength' : 'img2imgStrength');

    if (requestType !== 'txt2img') {
        const imageFile = funcElementById(requestType === 'inpainting' ? 'inpaintingImage' : 'uploadedImage').files[0];
        imageBase64 = await getBase64(imageFile);
    }

    const selectedLoras = Object.keys(masterLoraData).filter(lora => masterLoraData[lora].selected);
    const loraStrengths = selectedLoras.map(lora => Number(masterLoraData[lora].strength));

    const regionalPromptSettings = getCheckboxState('regionalPromptCheckbox') ? {
        status: 'true',
        regionalPromptSplitPosition: getValue('regionalPromptSplitPosition'),
        regionalPromptAStrength: getValue('regionalPromptAStrength'),
        regionalPromptBStrength: getValue('regionalPromptBStrength'),
    } : { status: 'false' };

    return {
        prompt: getValue('prompt').replace(/\n/g, ' '),
        negativeprompt: getValue('negativeprompt'),
        aspect_ratio: getValue('aspectRatio'),
        steps: Number(getValue('steps')),
        seed: getValue('seed'),
        model: getValue('model'),
        quantity: 4,
        lora: selectedLoras,
        lora_strengths: loraStrengths,
        image: imageBase64,
        strength,
        guidance: getValue('cfguidance'),
        savedloras: buildSavedLoras(selectedLoras),
        request_type: requestType,
        advancedMode: 'on',
        inpainting: requestType === 'inpainting',
        inpaintingMask: requestType === 'inpainting' ? getMaskWithBlackBackground() : null,
        accountId: getValue('user-session'),
        fastpass: false,
        scheduler: getValue('scheduler'),
        fastqueue: funcElementById('fastqueueButton')?.classList?.contains('active') ?? false,
        creditsRequired: Number(funcElementById('currentCreditsPrice')?.innerText) || 0,
        extras: {
            removeWatermark: getCheckboxState('removeWatermarkCheckbox'),
            upscale: getCheckboxState('upscaleCheckbox'),
            doubleImages: getCheckboxState('doubleImagesCheckbox'),
            removeBackground: getCheckboxState('removeBackgroundCheckbox'),
        },
        regionalPromptSettings,
    };
};

const buildSavedLoras = (selectedLoras) => {
    const categories = ['style', 'effect', 'concept', 'clothing', 'character', 'pose', 'background'];
    return Object.fromEntries(
        categories.map(category => [
            category,
            selectedLoras.filter(lora => lora.includes(`${category}-`))
        ])
    );
};

// Button handlers
const createImageButtons = (container, image, mediaInfo, index, booruData) => {
    const details = document.createElement('details');
    details.style.display = 'inline-block';
    
    const summary = document.createElement('summary');
    summary.innerText = `Image #${index}'s Options`;
    details.appendChild(summary);

    const buttons = [
        createDownloadButton(image, mediaInfo.fileName),
        createImg2ImgButton(image, mediaInfo.fileName),
        createInpaintingButton(image, mediaInfo.fileName)
    ];

    if (booruData) {
        // buttons.push(createBooruButton(index, booruData));
        // add the button outside of the dropdown, so its at the top and always visible:
        container.appendChild(createBooruButton(index, booruData));
    }

    buttons.forEach(button => details.appendChild(button));
    container.appendChild(details);
};

// Main generation handler
funcElementById('generateButton').addEventListener('click', async function(event) {
    event.preventDefault();
    console.log("Generate button clicked, setting generating state...");
    
    // Prevent duplicate requests if already generating
    if (isQueueCheckingActive || requestId) {
        console.log("Generation already in progress, ignoring click");
        return;
    }
    
    // Clear any previous state immediately
    cancelledGeneration = false;
    isQueueCheckingActive = false;
    requestId = null; // Clear old request ID to prevent interference
    
    UIState.setGenerating(true);

    uploadsToBooru = 0
    
    // Reset ETA calculations for new generation
    resetETACalculation();

    try {
        console.log("Building request data...");
        const data = await buildRequestData();
        console.log('Request Data built successfully:', data);

        console.log("Sending generation request...");
        const response = await fetch(`${API_BASE}/generate`, {
            method: 'POST',
            headers: getDefaultHeaders(),
            body: JSON.stringify(data)
        });

        console.log("Response received, parsing JSON...");
        const jsonResponse = await response.json();
        console.log("JSON Response:", jsonResponse);
        
        if (jsonResponse.status === "error") {
            console.log("Error in response, calling setError...");
            UIState.setError(jsonResponse.message);
            return;
        }

        if (cancelledGeneration) {
            console.log("Generation was cancelled, returning...");
            return;
        }

        console.log("Starting queue and generation handling...");
        await handleQueueAndGeneration(jsonResponse);
        console.log("handleQueueAndGeneration completed");

    } catch (error) {
        console.error('Generation error caught:', error);
        UIState.setError(error.message);
        // Clear state on error
        isQueueCheckingActive = false;
        requestId = null;
    }
    
    console.log("Generate button handler completed");
});

const checkQueuePosition = async () => {
    try {
        if (!requestId) {
            console.warn('checkQueuePosition called with no requestId');
            return null;
        }

        const response = await fetch(`${API_BASE}/queue_position/${requestId}`, {
            method: 'GET',
            headers: getDefaultHeaders()
        });

        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
        }

        // Safely attempt to parse JSON
        try {
            const data = await response.json();
            console.log(`Queue position check for ${requestId}:`, data);
            return data;
        } catch (jsonError) {
            console.error('Failed to parse queue position response as JSON:', jsonError);
            throw new Error("Invalid JSON response received");
        }
    } catch (error) {
        console.error('Queue position fetch failed:', error);
        return null; // Prevents crashing the main loop
    }
};

const checkImageCompletion = async () => {
    try {
        const response = await fetch(`${API_BASE}/result/${requestId}`, {
            method: 'GET',
            headers: getDefaultHeaders()
        });

        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error("Image completion check failed:", error);
        return null;
    }
};

const handleCompletedGeneration = async () => {
    // Reset ETA calculations for completed generation
    resetETACalculation();
    
    UIState.setStatus("Your image is ready and will be displayed shortly...", 'success');
    UIState.queuePosition.style.display = 'none';

    let retryCount = 0;
    let results = null;

    while (retryCount < 5) {
        try {
            const resultResponse = await fetch(`${API_BASE}/result/${requestId}`, {
                method: 'GET',
                headers: getDefaultHeaders()
            });

            if (!resultResponse.ok) {
                throw new Error(`HTTP Error: ${resultResponse.status}`);
            }

            // Safely parse JSON response
            try {
                results = await resultResponse.json();
            } catch (jsonError) {
                throw new Error("Invalid JSON response received");
            }

            if (results) {
                break; // Exit loop if results are successfully fetched
            }
        } catch (error) {
            retryCount++;
            console.warn(`Failed to fetch generation results, retrying... (${retryCount}/5)`);
            if (retryCount >= 5) {
                console.error(`Failed to fetch results after ${retryCount} attempts:`, error);
            }
            await new Promise(resolve => setTimeout(resolve, 2000 * retryCount)); // Exponential backoff
        }
    }

    if (!results) {
        UIState.setError("Failed to load image results after multiple attempts.");
        // Don't clear requestId here - let the caller handle it
        return false; // Indicate failure
    }

    try {
        await displayResults(results);
        console.log("Results displayed successfully");
        return true; // Indicate success
    } catch (displayError) {
        console.error("Failed to display results:", displayError);
        UIState.setError("Failed to display generated images.");
        return false; // Indicate failure
    }
};

const createMediaElement = (image, isVideo = false) => {
    const time = new Date().getTime();
    const index = Math.random().toString(36).substr(2, 9);
    const mediaType = isVideo ? 'video' : 'img';
    
    const element = document.createElement(mediaType);
    if (isVideo) {
        element.controls = true;
        element.autoplay = true;
        element.loop = true;
        const source = document.createElement('source');
        source.src = 'data:video/mp4;base64,' + image;
        source.type = 'video/mp4';
        element.appendChild(source);
    } else {
        // Handle the case where image might be an object with base64 property or a string
        const base64Data = typeof image === 'object' ? image.base64 : image;
        element.src = base64Data.startsWith('data:') ? base64Data : 'data:image/png;base64,' + base64Data;
    }
    
    element.style.cssText = 'display: inline; width: auto; height: auto; max-width: 100%;';
    return { element, fileName: `${mediaType}-${time}-${index}.${isVideo ? 'mp4' : 'png'}` };
};

const displayResults = async (results) => {
    // Update credits if using fastqueue
    if (results.fastqueue) {
        funcElementById('creditsDisplay').innerText = results.credits;
    }

    // Clear previous images
    UIState.imagesContainer.innerHTML = '';

    // Play completion sound if enabled
    if (results.misc_generationReadyBeep) {
        const audio = new Audio('https://www.jscammie.com/generationdone.wav');
        audio.play().catch(error => console.log('Audio playback failed:', error));
    }

    // Display images
    results.images.forEach((image, index) => {
        const container = document.createElement('div');
        container.style.cssText = 'display: inline-block; margin: 10px;';

        const isVideo = results.request_type === "txt2video";
        const mediaInfo = createMediaElement(image.base64 || image, isVideo);
        
        container.appendChild(mediaInfo.element);

        // Create buttons container
        const buttonsContainer = document.createElement('div');
        buttonsContainer.style.marginTop = '10px';
        
        createImageButtons(
            buttonsContainer, 
            { base64: image.base64 || image }, 
            mediaInfo, 
            index, 
            results.allImageHistory?.[index]
        );
        
        container.appendChild(buttonsContainer);
        UIState.imagesContainer.appendChild(container);
    });

    // Display additional info
    if (results.additionalInfo) {
        funcElementById('additionalInfo').innerHTML = `<p>Seed: ${results.additionalInfo.seed}</p>`;
    }
};

// Update the createDownloadButton function to handle the new image format
const createDownloadButton = (image, fileName) => {
    const button = document.createElement('button');
    button.innerText = fileName.includes('video') ? 'Download Video' : 'Download Image';
    button.style.cssText = 'display: block; margin-top: 10px;';
    
    button.onclick = async () => {
        try {
            // Handle both string and object formats of base64 data
            const base64Data = image.base64 || image;
            const base64String = base64Data.startsWith('data:') ? base64Data : `data:image/png;base64,${base64Data}`;
            
            const response = await fetch(base64String);
            const blob = await response.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(blobUrl);
        } catch (error) {
            console.error('Download error:', error);
            options = {
                message: 'Failed to download image.',
                question: true,
                options: {
                    okay: function() {}
                }
            }
            let alertResponse = await globalAlert(options);
        }
    };
    
    return button;
};

// Update the Img2Img and Inpainting button functions to handle the new image format
const createImg2ImgButton = (image, fileName) => {
    const button = document.createElement('button');
    button.innerText = 'Send to Img2Img';
    button.style.cssText = 'display: block; margin-top: 5px;';
    
    button.onclick = async () => {
        const img2imgCheckbox = funcElementById('img2imgCheckbox');
        img2imgCheckbox.checked = true;
        img2imgCheckbox.dispatchEvent(new Event('click'));
        img2imgCheckbox.dispatchEvent(new Event('change'));

        try {
            const base64Data = image.base64 || image;
            const base64String = base64Data.startsWith('data:') ? base64Data : `data:image/png;base64,${base64Data}`;
            
            const response = await fetch(base64String);
            const blob = await response.blob();
            const file = new File([blob], fileName, { type: 'image/png' });
            
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            funcElementById('uploadedImage').files = dataTransfer.files;
        } catch (error) {
            console.error('Img2Img conversion error:', error);
            alert('Failed to convert to Img2Img');
        }
    };
    
    return button;
};

const createInpaintingButton = (image, fileName) => {
    const button = document.createElement('button');
    button.innerText = 'Send to Inpainting';
    button.style.cssText = 'display: block; margin-top: 5px;';
    
    button.onclick = async () => {
        const inpaintingCheckbox = funcElementById('inpaintingCheckbox');
        inpaintingCheckbox.checked = true;
        inpaintingCheckbox.dispatchEvent(new Event('click'));
        inpaintingCheckbox.dispatchEvent(new Event('change'));

        try {
            const base64Data = image.base64 || image;
            const base64String = base64Data.startsWith('data:') ? base64Data : `data:image/png;base64,${base64Data}`;
            
            const response = await fetch(base64String);
            const blob = await response.blob();
            const file = new File([blob], fileName, { type: 'image/png' });
            
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            const inpaintingImage = funcElementById('inpaintingImage');
            inpaintingImage.files = dataTransfer.files;
            inpaintingImage.dispatchEvent(new Event('change'));
        } catch (error) {
            console.error('Inpainting conversion error:', error);
            alert('Failed to convert to inpainting');
        }
    };
    
    return button;
};

// Booru-related functionality
const createBooruButton = (index, booruData) => {
    const button = document.createElement('button');
    button.innerText = 'Upload to Booru';
    button.style.cssText = 'display: block; margin-top: 5px;';
    button.id = 'booruButton-' + index;
    booruData.index = index;
    button.onclick = () => showBooruPopup(booruData);
    return button;
};

const showBooruPopup = (booruData) => {
    const overlay = funcElementById('overlayBooru');
    const popupContent = funcElementById('booruPopupContent');

    overlay.style.display = 'block';
    popupContent.style.display = 'block';

    popupContent.innerHTML = `
        <button class="closeButton" onclick="closeBooruPopup()">×</button>
        <h1>Upload to Booru</h1>
        <p>By uploading to the booru you agree to the following:</p>
        <ul>
            <li>Child/Cub/Loli NSFW content are NOT ALLOWED!!!</li>
            <br>
            <li>Aged-Up Characters that look over the age of 18 are allowed, if they do not look over 18, the post will be removed!</li>
            <br>
            <li>By default, all content is hidden until a moderator approves it and gives it a safety rating (sfw, suggestive, nsfw).</li>
            <br>
            <li>ALL SETTINGS used to create an image are visible, if your content shows a word like "loli", even if it's sfw, it will be removed!</li>
            <br>
            <li>DO NOT SPAM THE BOORU WITH 1240987 IMAGES OF THE SAME OC IN SAME POSE / LOCATION</li>
            <br>
            <li>Realistic Feral are not allowed, only 2d/stylized 3d feral content are allowed</li>
        </ul>
        <p>If you agree to these rules/terms, then feel free to click below to upload to the booru, failure to comply with these rules will make you unable to post on the booru.</p>
        <button id="confirmUploadButton">Upload to Booru</button>
    `;

    funcElementById('confirmUploadButton').onclick = () => uploadToBooru(booruData);
    overlay.onclick = closeBooruPopup;
    document.addEventListener('keydown', handleBooruEscapeKey);
};

const uploadToBooru = async (booruData) => {
    try {
        const response = await fetch('/create-booru-image', {
            method: 'POST',
            headers: getDefaultHeaders(),
            body: JSON.stringify(booruData)
        });

        const result = await response.json();

        uploadsToBooru += 1;
        let uploadCapHit = false;

        // if uploadsToBooru is 2, then remove the upload to booru buttons off all images:
        if (uploadsToBooru >= 2) {
            uploadCapHit = true
        }
        
        if (result.status == "success") {
            let options = {
                message: 'Image uploaded to Booru successfully!',
                question: true,
                options: {
                    okay: function() {}
                }
            }
            await globalAlert(options);
            closeBooruPopup();
            // remove the button:
            // first deselect the button so the enter key doesn't trigger it again:
            booruData.selected = false;
            // then remove the button:
            const button = funcElementById('booruButton-' + booruData.index);
            button.parentNode.removeChild(button);

            if (uploadCapHit) {
                const buttons = document.querySelectorAll('button[id^="booruButton-"]');
                buttons.forEach(button => button.remove());
            }

        } else if (result.status == "error") {
            await globalAlert({ message: result.message, question: true, options: { okay: function() {} } });
        } else {
            await globalAlert({ message: 'Failed to upload image to Booru.', question: true, options: { okay: function() {} } });
        }
    } catch (error) {
        console.error('Booru upload error:', error);
        globalAlert({ message: `Failed to upload image to Booru. ${error}`, question: true, options: { okay: function() {} } });
    }
};

const closeBooruPopup = () => {
    funcElementById('overlayBooru').style.display = 'none';
    funcElementById('booruPopupContent').style.display = 'none';
    document.removeEventListener('keydown', handleBooruEscapeKey);
};

const handleBooruEscapeKey = (event) => {
    if (event.key === 'Escape') {
        closeBooruPopup();
    }
};

// Update queue handling functions
const handleQueueAndGeneration = async (jsonResponse) => {
    console.log("handleQueueAndGeneration called with:", jsonResponse);
    
    if (jsonResponse.status !== "queued") {
        console.log("Status is not 'queued', returning early. Status:", jsonResponse.status);
        return;
    }
    if (cancelledGeneration) {
        console.log("Generation cancelled, returning early");
        return;
    }
    
    // Prevent multiple queue checking loops
    if (isQueueCheckingActive) {
        console.log("Queue checking already active, skipping duplicate request");
        return;
    }
    
    isQueueCheckingActive = true;
    console.log("Starting queue checking loop");

    UIState.queuePosition.style.display = 'block';
    UIState.updateQueuePosition(jsonResponse.position, jsonResponse.queue_length || '?');
    UIState.setStatus("Your image is being generated, please wait...", 'generating');

    let isCompleted = false;
    let retryCount = 0;
    let queueLoops = 0;
    let nextCheckMS = 1500;
    let connectionActive = true;

    // Set requestId here and keep it until generation is actually complete
    requestId = jsonResponse.request_id;

    console.log("Entering queue checking while loop...");
    while (!isCompleted && retryCount < 5) {
        try {
            console.log(`Queue loop running - retryCount: ${retryCount}, isCompleted: ${isCompleted}`);

            if (cancelledGeneration) {
                console.log("Queue checking stopped: cancelledGeneration is true");
                isQueueCheckingActive = false;
                requestId = null; // Only clear requestId on cancellation
                return;
            }

            const positionData = await checkQueuePosition();

            console.log("Queue position response:", positionData);

            if (!positionData) {
                retryCount++;
                console.warn(`Retrying queue check... (${retryCount}/5)`);
                
                if (!connectionActive) {
                    UIState.setStatus(`Temporary error, retrying... (${retryCount}/5)`, 'error');
                }

                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                continue; // Skip to the next loop iteration instead of breaking
            }

            
            if (!handlePositionResponse(positionData, queueLoops)) {
                break;
            }

            if (positionData.status === "completed") {
                const completionSuccess = await handleCompletedGeneration();
                if (completionSuccess) {
                    isCompleted = true;
                    // Only clear requestId after successful completion and result display
                    requestId = null;
                } else {
                    // If completion failed, continue retrying (don't set isCompleted = true)
                    console.log("Completion failed, will retry...");
                    retryCount++;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } else if (positionData.status === "waiting") {
                retryCount = 0; // Reset retry count on successful connection
                connectionActive = true;
                UIState.updateQueuePosition(positionData.position, positionData.queue_length);
                await new Promise(resolve => setTimeout(resolve, nextCheckMS));
            }

            queueLoops++;

        } catch (error) {
            retryCount++;
            if (cancelledGeneration) {
                isQueueCheckingActive = false;
                requestId = null; // Only clear requestId on cancellation
                return;
            }
            console.error('Queue check error:', error);
            
            // Only show the temporary error message if we haven't established a connection yet
            if (!connectionActive) {
                UIState.setStatus(`Temporary error, retrying... (${retryCount}/5)`, 'error');
            } else {
                // If we had a connection before, maintain the current UI state without error message
                console.log(`Temporary network hiccup, silently retrying... (${retryCount}/5)`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
    }

    if (!isCompleted) {
        UIState.setError('Maximum retry attempts reached');
        // Only clear requestId if we truly failed (not just a temporary error)
        requestId = null;
    }

    UIState.setGenerating(false);
    UIState.setStatus(null); // Clear status when done
    UIState.cancelButton.style.display = 'none';
    
    // Clear the flag when queue checking is complete
    isQueueCheckingActive = false;
    // Don't clear requestId here - only clear it on cancellation or actual completion
    console.log("Queue checking loop completed");
};


const handlePositionResponse = (positionData, queueLoops) => {
    if (positionData.status === "error") {
        UIState.setError(positionData.message);
        return false;
    }

    if (positionData.status === "not found") {
        UIState.queuePosition.style.display = 'none';
        UIState.setError(positionData.message);
        return false;
    }

    const position = Number(positionData.position);
    
    if (position < 3) {
        UIState.cancelButton.style.display = 'none';
    } else if (queueLoops > 2) {
        UIState.cancelButton.style.display = 'block';
    }

    if (positionData.status === "waiting") {
        UIState.updateQueuePosition(position, positionData.queue_length);
    }

    return true;
};

// Initialize cancel button handler
funcElementById('cancelButton').addEventListener('click', async function(event) {
    event.preventDefault();
    UIState.setGenerating(true);
    UIState.generateButton.textContent = 'Cancelling...';

    try {
        const response = await fetch(`${API_BASE}/cancel_request/${requestId}`, {
            method: 'GET',
            headers: getDefaultHeaders()
        });

        const cancelResponse = await response.json();

        // Set cancellation flags immediately
        cancelledGeneration = true;
        isQueueCheckingActive = false;
        
        if (cancelResponse.status == "cancelled") {
            UIState.setStatus("Generation has been cancelled", 'info');
            UIState.setGenerating(false);
            UIState.cancelButton.style.display = 'none';
            requestId = null; // Clear request ID when cancelled
        } else {
            UIState.setError(cancelResponse.message);
            requestId = null; // Clear request ID even on cancel error
        }
    } catch (error) {
        // Ensure state is cleared even if cancel request fails
        cancelledGeneration = true;
        isQueueCheckingActive = false;
        requestId = null;
        UIState.setError(error.message);
    }
});

document.addEventListener("visibilitychange", () => {
    // Only attempt resume if the page becomes visible
    if (document.hidden) {
        return;
    }

    // More strict conditions for resuming queue check to prevent race conditions
    if (requestId && !cancelledGeneration && !isQueueCheckingActive) {
        console.log("User returned, checking if resume is needed for requestId:", requestId);
        
        // Additional safety: only resume after a longer delay and with more checks
        setTimeout(async () => {
            // Re-verify all conditions haven't changed during the delay
            if (!isQueueCheckingActive && requestId && !cancelledGeneration) {
                console.log("Checking if generation is still pending...");
                
                // First check if the generation is actually still pending
                try {
                    const positionData = await checkQueuePosition();
                    if (positionData && (positionData.status === "waiting" || positionData.status === "completed")) {
                        if (positionData.status === "completed") {
                            console.log("Generation completed while away, fetching results...");
                            await handleCompletedGeneration();
                            requestId = null;
                        } else {
                            console.log("Generation still pending, resuming queue check...");
                            handleQueueAndGeneration({ status: "queued", position: positionData.position, request_id: requestId });
                        }
                    } else {
                        console.log("Generation not found or errored, clearing requestId");
                        requestId = null;
                    }
                } catch (error) {
                    console.error("Error checking generation status on resume:", error);
                    // Don't clear requestId here - might be a temporary network issue
                }
            } else {
                console.log("Resume not needed - state changed during delay");
            }
        }, 2000); // Increased delay to 2 seconds to avoid interfering with fresh requests
    } else {
        console.log("User returned but resume not needed:", {
            requestId: !!requestId,
            cancelledGeneration,
            isQueueCheckingActive
        });
    }
});

// Queue ETA update function - extracted from setInterval
const updateQueueETA = async () => {
    console.log("Queue ETA interval running..."); // Debug log
    
    const bothQueueETAElement = funcElementById('bothQueueETA');
    
    if (!bothQueueETAElement) {
        console.warn('bothQueueETA element not found in DOM');
        return;
    }
    
    try {
        let queueLengthsResponse;
        let individualPositionData = null;
        
        // Always fetch general queue lengths
        queueLengthsResponse = await fetch(`${API_BASE}/get-all-queue-length`, {
            method: 'GET',
            headers: getDefaultHeaders()
        });
        
        // Only fetch individual position if we're NOT in active queue checking
        // (to avoid duplicate requests during generation)
        if (!isQueueCheckingActive && requestId && !cancelledGeneration) {
            console.log("Fetching individual position for inactive generation");
            individualPositionData = await fetch(`${API_BASE}/queue_position/${requestId}`, {
                method: 'GET',
                headers: getDefaultHeaders()
            }).catch(() => null);
        } else if (isQueueCheckingActive) {
            console.log("Queue checking active, skipping individual position fetch");
        }

        console.log("Response status:", queueLengthsResponse.status, "OK:", queueLengthsResponse.ok);

        if (!queueLengthsResponse.ok) {
            throw new Error(`HTTP Error: ${queueLengthsResponse.status}`);
        }

        const queueLengths = await queueLengthsResponse.json();
        let individualPosition = null;
        
        // Parse individual position if we got a response
        if (individualPositionData && individualPositionData.ok) {
            try {
                individualPosition = await individualPositionData.json();
                if (individualPosition.status !== "waiting") {
                    individualPosition = null; // Only show if still waiting
                }
            } catch (e) {
                individualPosition = null;
            }
        }
        
        // If we're in active queue checking, use the stored position data
        if (isQueueCheckingActive && window.currentQueuePosition) {
            individualPosition = {
                position: window.currentQueuePosition,
                queue_length: window.currentQueueLength,
                status: "waiting"
            };
            console.log("Using stored position data during active generation:", individualPosition);
        }
        
        console.log("Queue lengths response:", queueLengths);
        console.log("Individual position:", individualPosition);

        // Use the historical ETA data if available, otherwise fall back to estimates
        const calculateQueueETA = (queueLength) => {
            // Ensure queue length is a valid number
            let length = parseInt(queueLength) || 0;

            // add +1 to the length
            if (length == 0) {
                length = 1;
            }
            
            if (timeForNextPositionLower.length > 0) {
                // Calculate using historical data like in updateQueuePosition
                const avgTimePerPosition = timeForNextPositionLower.reduce((sum, time) => sum + time, 0) / 
                    timeForNextPositionLower.length;
                
                // Apply realistic bounds like in the main ETA calculation
                const boundedTimePerPosition = Math.min(Math.max(avgTimePerPosition, 8000), 120000);
                
                // Calculate estimated time in milliseconds
                return boundedTimePerPosition * length;
            } else {
                // Fall back to the simple estimate if no historical data
                return length * 11000; // 11 seconds per position estimate
            }
        };

        // Calculate individual position ETA if we have position data
        const calculateIndividualETA = (position) => {
            if (!position || !timeForNextPositionLower.length) return "Calculating...";
            
            const avgTimePerPosition = timeForNextPositionLower.reduce((sum, time) => sum + time, 0) / 
                timeForNextPositionLower.length;
            const boundedTimePerPosition = Math.min(Math.max(avgTimePerPosition, 8000), 120000);
            const estimatedTimeRemaining = boundedTimePerPosition * position;
            
            const etaMinutes = Math.floor(estimatedTimeRemaining / 60000);
            const etaSeconds = Math.floor((estimatedTimeRemaining % 60000) / 1000);
            
            return etaMinutes > 0 ? `${etaMinutes}m ${etaSeconds}s` : `${etaSeconds}s`;
        };

        // Format the ETAs nicely in minutes and seconds
        const formatETA = (ms) => {
            if (!ms && ms !== 0) return "0s";
            const minutes = Math.floor(ms / 60000);
            const seconds = Math.floor((ms % 60000) / 1000);
            return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        };

        // Create status message section if we have a status
        const createStatusSection = () => {
            if (!currentStatusMessage) return '';
            
            let statusColor = '#60a5fa'; // default blue
            let statusIcon = 'ℹ️';
            let statusBgColor = 'rgba(96, 165, 250, 0.1)';
            let statusBorderColor = '#60a5fa';
            
            switch (currentStatusType) {
                case 'generating':
                    statusColor = '#f59e0b';
                    statusIcon = '🎨';
                    statusBgColor = 'rgba(245, 158, 11, 0.1)';
                    statusBorderColor = '#f59e0b';
                    break;
                case 'success':
                    statusColor = '#10b981';
                    statusIcon = '✅';
                    statusBgColor = 'rgba(16, 185, 129, 0.1)';
                    statusBorderColor = '#10b981';
                    break;
                case 'error':
                    statusColor = '#ef4444';
                    statusIcon = '❌';
                    statusBgColor = 'rgba(239, 68, 68, 0.1)';
                    statusBorderColor = '#ef4444';
                    break;
            }

            return `
                <div style="
                    background: ${statusBgColor}; 
                    padding: 12px; 
                    border-radius: 8px; 
                    border-left: 3px solid ${statusBorderColor};
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                    text-align: center;
                    margin-bottom: 15px;
                ">
                    <div style="color: ${statusColor}; font-weight: bold; font-size: 16px;">
                        ${statusIcon} ${currentStatusMessage}
                    </div>
                </div>`;
        };

        // Create individual position section HTML if we have position data
        const createIndividualPositionSection = (position, etaString) => {
            if (!position) return '';
            
            let emoji = "⏳";
            let positionMessage = "";
            
            if (position === 1) {
                emoji = "🎨";
                positionMessage = "You're next! ";
            } else if (position <= 3) {
                emoji = "🚀";
                positionMessage = "Almost there! ";
            } else if (position <= 10) {
                emoji = "⭐";
                positionMessage = "Looking good! ";
            } else {
                emoji = "⏰";
                positionMessage = "Hang tight! ";
            }

            // Calculate progress based on actual position in the queue
            // Use the queue length from the current data if available
            let queueLength = 50; // Default fallback
            
            // Try to get queue length from the API response data
            if (individualPosition && individualPosition.queue_length) {
                queueLength = individualPosition.queue_length;
            } else if (window.currentQueueLength) {
                queueLength = window.currentQueueLength;
            }
            
            // Calculate completion percentage: how much of the total wait is done
            // Position 5 of 5 = 0% complete (just joined)
            // Position 1 of 5 = 80% complete (still need generation time)
            // This shows progress through the total waiting process
            const maxProgressBeforeGeneration = 80; // Reserve 20% for actual generation
            const progressPercentage = Math.max(5, 
                ((queueLength - position) / queueLength) * maxProgressBeforeGeneration
            );

            return `
                <div id="individualPositionSection" style="
                    background: linear-gradient(135deg, #1e293b, #334155); 
                    padding: 12px; 
                    border-radius: 8px; 
                    border-left: 3px solid #fbbf24;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                    text-align: center;
                    margin-top: 10px;
                ">
                    <div style="color: #94a3b8; font-size: 12px; margin-bottom: 4px;">
                        ${emoji} Your Position in Queue
                    </div>
                    <div style="color: #e2e8f0; font-size: 14px; margin-bottom: 6px;">
                        <span style="color: #fbbf24; font-weight: bold;">#${position}</span> 
                        <span style="color: #94a3b8;">of ${queueLength} in line</span>
                    </div>
                    <div style="color: #fbbf24; font-weight: bold; font-size: 16px;">
                        ${positionMessage}ETA: ${etaString}
                    </div>
                    <div style="
                        width: 100%; 
                        height: 4px; 
                        background: #374151; 
                        border-radius: 2px; 
                        margin-top: 8px;
                        overflow: hidden;
                    ">
                        <div style="
                            height: 100%; 
                            background: linear-gradient(90deg, #fbbf24, #f59e0b); 
                            width: ${Math.round(progressPercentage)}%; 
                            border-radius: 2px;
                            transition: width 0.5s ease;
                            animation: shimmer 2s infinite;
                        "></div>
                    </div>
                    <div style="color: #64748b; font-size: 11px; margin-top: 4px;">
                        ${Math.round(progressPercentage)}% complete
                    </div>
                </div>
                <style>
                @keyframes shimmer {
                    0% { opacity: 0.8; }
                    50% { opacity: 1; }
                    100% { opacity: 0.8; }
                }
                </style>`;
        };

        // Check if data exists and has the expected format
        if (queueLengths.status === 'success' && queueLengths.data) {
            console.log("Processing successful response with data:", queueLengths.data);
            
            const normalQueueLength = queueLengths.data.queue_0 || queueLengths.data['0'] || 0;
            const fastQueueLength = queueLengths.data.queue_1 || queueLengths.data['1'] || 0;
            
            console.log("Parsed queue lengths - Normal:", normalQueueLength, "Fast:", fastQueueLength);
            
            // Calculate ETAs for both queues
            const normalQueueETA = calculateQueueETA(normalQueueLength);
            const fastQueueETA = calculateQueueETA(fastQueueLength);
            
            console.log("Calculated ETAs - Normal:", formatETA(normalQueueETA), "Fast:", formatETA(fastQueueETA));

            // Add encouraging messaging based on queue status
            let fastQueueMessage = "";
            if (fastQueueLength <= 2) {
                fastQueueMessage = " ✨ <span style='color: #00ff88;'>Ready to go!</span>";
            } else if (fastQueueLength <= 5) {
                fastQueueMessage = " 🏃‍♂️ <span style='color: #88ff00;'>Moving quickly!</span>";
            } else {
                fastQueueMessage = " ⚡ <span style='color: #ffaa00;'>Faster option</span>";
            }

            let regularQueueMessage = "";
            if (normalQueueLength <= 10) {
                regularQueueMessage = " ✨ <span style='color: #88ff88;'>Pretty quick!</span>";
            } else if (normalQueueLength <= 30) {
                regularQueueMessage = " ⏰ <span style='color: #ffcc44;'>Great for multitasking!</span>";
            } else {
                regularQueueMessage = " 📚 <span style='color: #ff8844;'>Time to relax!</span>";
            }

            // Calculate costs
            const extras = {
                removeWatermark: getCheckboxState('removeWatermarkCheckbox'),
                upscale: getCheckboxState('upscaleCheckbox'),
                doubleImages: getCheckboxState('doubleImagesCheckbox'),
                removeBackground: getCheckboxState('removeBackgroundCheckbox'),
            };
            
            const extrasObject = window.getExtrasPrice ? window.getExtrasPrice(extras) : {};
            const extrasPrice = (extrasObject.removeWatermark || 0) + 
                               (extrasObject.upscale || 0) + 
                               (extrasObject.doubleImages || 0) + 
                               (extrasObject.removeBackground || 0);
            const fastQueuePrice = window.getFastqueuePrice ? window.getFastqueuePrice(Object.keys(masterLoraData).filter(lora => masterLoraData[lora].selected).length, getValue('model')) : 25;
            const isFastQueueSelected = funcElementById('fastqueueButton')?.classList?.contains('active') ?? false;

            // Create individual position section if we have position data
            const individualSection = individualPosition ? 
                createIndividualPositionSection(
                    individualPosition.position, 
                    calculateIndividualETA(individualPosition.position)
                ) : '';

            // Create the complete display all at once with clickable queue options
            const completeDisplay = `
                <div style="background: linear-gradient(135deg, #1a1a2e, #16213e); padding: 15px; border-radius: 10px; border: 1px solid #333;">
                    <div style="color: #ffd700; font-weight: bold; font-size: 16px; text-align: center; margin-bottom: 10px;">
                        🎨 Generation Queue Status
                    </div>
                    ${createStatusSection()}
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <div id="regularQueueOption" style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 6px; border-left: 3px solid #60a5fa; cursor: pointer; transition: all 0.3s ease; ${!isFastQueueSelected ? 'border: 2px solid #60a5fa; box-shadow: 0 0 10px rgba(96, 165, 250, 0.3);' : 'border: 1px solid transparent;'}">
                            <span style="color: #e2e8f0;">🔄 Regular Queue:</span><br>
                            <span style="color: #60a5fa; font-weight: bold;">${formatETA(normalQueueETA)}</span> 
                            <span style="color: #94a3b8;">(${normalQueueLength} creators ahead)</span>${regularQueueMessage}<br>
                            <span style="color: #ffd700; font-weight: bold;">💰 ${extrasPrice} Credits</span>
                        </div>
                        <div id="fastQueueOption" style="background: rgba(0,255,136,0.05); padding: 10px; border-radius: 6px; border-left: 3px solid #00ff88; cursor: pointer; transition: all 0.3s ease; ${isFastQueueSelected ? 'border: 2px solid #00ff88; box-shadow: 0 0 10px rgba(0, 255, 136, 0.3);' : 'border: 1px solid transparent;'}">
                            <span style="color: #e2e8f0;">⚡ Fast Queue:</span><br>
                            <span style="color: #00ff88; font-weight: bold;">${formatETA(fastQueueETA)}</span> 
                            <span style="color: #94a3b8;">(${fastQueueLength} creators ahead)</span>${fastQueueMessage}<br>
                            <span style="color: #ffd700; font-weight: bold;">💰 ${extrasPrice + fastQueuePrice} Credits</span>
                        </div>
                    </div>
                    ${individualSection}
                    <div style="text-align: center; margin-top: 10px; font-size: 12px; color: #64748b;">
                        💡 Times are estimated and update in real-time • Click to select queue
                    </div>
                </div>`;

            bothQueueETAElement.innerHTML = completeDisplay;
            
            // Add click event listeners
            const regularQueueDiv = document.getElementById('regularQueueOption');
            const fastQueueDiv = document.getElementById('fastQueueOption');
            
            if (regularQueueDiv) {
                regularQueueDiv.addEventListener('click', () => {
                    if (isFastQueueSelected) {
                        const fastqueueButton = funcElementById('fastqueueButton');
                        if (fastqueueButton) {
                            fastqueueButton.click();
                        }
                    }
                });
            }
            
            if (fastQueueDiv) {
                fastQueueDiv.addEventListener('click', () => {
                    if (!isFastQueueSelected) {
                        const fastqueueButton = funcElementById('fastqueueButton');
                        if (fastqueueButton) {
                            fastqueueButton.click();
                        }
                    }
                });
            }
            
            console.log("Updated queue display HTML successfully");
            
        } else if (queueLengths.queue_0 !== undefined || queueLengths.queue_1 !== undefined) {
            console.log("Processing alternative format - queue_0:", queueLengths.queue_0, "queue_1:", queueLengths.queue_1);
            
            const normalQueueLength = queueLengths.queue_0 || 0;
            const fastQueueLength = queueLengths.queue_1 || 0;
            
            // Calculate ETAs for both queues
            const normalQueueETA = calculateQueueETA(normalQueueLength);
            const fastQueueETA = calculateQueueETA(fastQueueLength);

            // Add encouraging messaging based on queue status
            let fastQueueMessage = "";
            if (fastQueueLength <= 2) {
                fastQueueMessage = " ✨ <span style='color: #00ff88;'>Ready to go!</span>";
            } else if (fastQueueLength <= 5) {
                fastQueueMessage = " 🏃‍♂️ <span style='color: #88ff00;'>Moving quickly!</span>";
            } else {
                fastQueueMessage = " ⚡ <span style='color: #ffaa00;'>Faster option</span>";
            }

            let regularQueueMessage = "";
            if (normalQueueLength <= 10) {
                regularQueueMessage = " ✨ <span style='color: #88ff88;'>Pretty quick!</span>";
            } else if (normalQueueLength <= 30) {
                regularQueueMessage = " ⏰ <span style='color: #ffcc44;'>Great for multitasking!</span>";
            } else {
                regularQueueMessage = " 📚 <span style='color: #ff8844;'>Time to relax!</span>";
            }

            // Calculate costs
            const extras = {
                removeWatermark: getCheckboxState('removeWatermarkCheckbox'),
                upscale: getCheckboxState('upscaleCheckbox'),
                doubleImages: getCheckboxState('doubleImagesCheckbox'),
                removeBackground: getCheckboxState('removeBackgroundCheckbox'),
            };
            
            const extrasObject = window.getExtrasPrice ? window.getExtrasPrice(extras) : {};
            const extrasPrice = (extrasObject.removeWatermark || 0) + 
                               (extrasObject.upscale || 0) + 
                               (extrasObject.doubleImages || 0) + 
                               (extrasObject.removeBackground || 0);
            const fastQueuePrice = window.getFastqueuePrice ? window.getFastqueuePrice(Object.keys(masterLoraData).filter(lora => masterLoraData[lora].selected).length, getValue('model')) : 25;
            const isFastQueueSelected = funcElementById('fastqueueButton')?.classList?.contains('active') ?? false;

            // Create individual position section if we have position data
            const individualSection = individualPosition ? 
                createIndividualPositionSection(
                    individualPosition.position, 
                    calculateIndividualETA(individualPosition.position)
                ) : '';

            // Create the complete display all at once with clickable queue options
            const completeDisplay = `
                <div style="background: linear-gradient(135deg, #1a1a2e, #16213e); padding: 15px; border-radius: 10px; border: 1px solid #333;">
                    <div style="color: #ffd700; font-weight: bold; font-size: 16px; text-align: center; margin-bottom: 10px;">
                        🎨 Generation Queue Status
                    </div>
                    ${createStatusSection()}
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <div id="regularQueueOption" style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 6px; border-left: 3px solid #60a5fa; cursor: pointer; transition: all 0.3s ease; ${!isFastQueueSelected ? 'border: 2px solid #60a5fa; box-shadow: 0 0 10px rgba(96, 165, 250, 0.3);' : 'border: 1px solid transparent;'}">
                            <span style="color: #e2e8f0;">🔄 Regular Queue:</span><br>
                            <span style="color: #60a5fa; font-weight: bold;">${formatETA(normalQueueETA)}</span> 
                            <span style="color: #94a3b8;">(${normalQueueLength} creators ahead)</span>${regularQueueMessage}<br>
                            <span style="color: #ffd700; font-weight: bold;">💰 ${extrasPrice} Credits</span>
                        </div>
                        <div id="fastQueueOption" style="background: rgba(0,255,136,0.05); padding: 10px; border-radius: 6px; border-left: 3px solid #00ff88; cursor: pointer; transition: all 0.3s ease; ${isFastQueueSelected ? 'border: 2px solid #00ff88; box-shadow: 0 0 10px rgba(0, 255, 136, 0.3);' : 'border: 1px solid transparent;'}">
                            <span style="color: #e2e8f0;">⚡ Fast Queue:</span><br>
                            <span style="color: #00ff88; font-weight: bold;">${formatETA(fastQueueETA)}</span> 
                            <span style="color: #94a3b8;">(${fastQueueLength} creators ahead)</span>${fastQueueMessage}<br>
                            <span style="color: #ffd700; font-weight: bold;">💰 ${extrasPrice + fastQueuePrice} Credits</span>
                        </div>
                    </div>
                    ${individualSection}
                    <div style="text-align: center; margin-top: 10px; font-size: 12px; color: #64748b;">
                        💡 Times are estimated and update in real-time • Click to select queue
                    </div>
                </div>`;

            bothQueueETAElement.innerHTML = completeDisplay;
            
            // Add click event listeners
            const regularQueueDiv = document.getElementById('regularQueueOption');
            const fastQueueDiv = document.getElementById('fastQueueOption');
            
            if (regularQueueDiv) {
                regularQueueDiv.addEventListener('click', () => {
                    if (isFastQueueSelected) {
                        const fastqueueButton = funcElementById('fastqueueButton');
                        if (fastqueueButton) {
                            fastqueueButton.click();
                        }
                    }
                });
            }
            
            if (fastQueueDiv) {
                fastQueueDiv.addEventListener('click', () => {
                    if (!isFastQueueSelected) {
                        const fastqueueButton = funcElementById('fastqueueButton');
                        if (fastqueueButton) {
                            fastqueueButton.click();
                        }
                    }
                });
            }
            
            console.log("Updated queue display HTML successfully (alternative format)");
            
        } else {
            // Fallback for other formats or errors - still show status if available
            const statusSection = createStatusSection();
            if (statusSection) {
                bothQueueETAElement.innerHTML = `
                    <div style="background: linear-gradient(135deg, #1a1a2e, #16213e); padding: 15px; border-radius: 10px; border: 1px solid #333;">
                        <div style="color: #ffd700; font-weight: bold; font-size: 16px; text-align: center; margin-bottom: 10px;">
                            🎨 Generation Status
                        </div>
                        ${statusSection}
                        <div style="text-align: center; margin-top: 10px; font-size: 12px; color: #64748b;">
                            💡 Checking queue status...
                        </div>
                    </div>`;
            } else if (!bothQueueETAElement.innerHTML.includes('Generation')) {
                bothQueueETAElement.innerHTML = `
                    <div style="background: linear-gradient(135deg, #1a1a2e, #16213e); padding: 15px; border-radius: 10px; border: 1px solid #333;">
                        <div style="color: #ffd700; font-weight: bold; font-size: 16px; text-align: center; margin-bottom: 10px;">
                            🎨 Queue Status
                        </div>
                        <div style="text-align: center; color: #ff8844;">
                            Queue information temporarily unavailable
                        </div>
                    </div>`;
            }
        }
    } catch (error) {
        console.error('Queue length fetch failed:', error);
        const bothQueueETAElement = funcElementById('bothQueueETA');
        if (bothQueueETAElement) {
            // Only show error message if element is empty or doesn't have queue info
            if (!bothQueueETAElement.innerHTML.includes('Estimated Wait')) {
                bothQueueETAElement.innerHTML = `<a style="color: yellow;">Queue Status:</a><br>
                <a style="color: red;">Failed to fetch queue info (${error.message})</a>`;
            }
        }
    }
};

// Run queue ETA update immediately on page load
updateQueueETA();

// Then set up the interval for subsequent updates
setInterval(updateQueueETA, 5000);