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
        this.generateButton.disabled = isGenerating;
        this.generateButton.textContent = isGenerating ? 'Generating Image' : 'Generate Image';
        this.generateButton.classList[isGenerating ? 'add' : 'remove']('generating');
        // if its set to false, hide the your position in queue message:
        if (!isGenerating) {
            this.hideQueuePosition();
        }
    },

    setError(message) {
        this.response.innerText = `An error occurred: ${message}`;
        this.setGenerating(false);
        this.cancelButton.style.display = 'none';
    },

    updateQueuePosition(position, queueLength) {
        this.queuePosition.style.display = 'block';
        const currentTime = new Date().getTime();
        
        // Initialize time tracking on first call
        if (lastRecordedTime === null) {
            lastRecordedTime = currentTime;
            lastPosition = position;
            stagnantPositionCount = 0;
            lastLowestPosition = position;
            positionChangeCount = 0;
            
            // Use historical data if available to avoid showing "Calculating..."
            if (timeForNextPositionLower.length > 0) {
                // Calculate ETA using existing historical data
                const avgTimePerPosition = timeForNextPositionLower.reduce((sum, time) => sum + time, 0) / 
                    timeForNextPositionLower.length;
                
                const boundedTimePerPosition = Math.min(Math.max(avgTimePerPosition, 8000), 120000);
                let estimatedTimeRemaining = (boundedTimePerPosition * position * ETA_SAFETY_MULTIPLIER) + ETA_FIXED_BUFFER;
                
                // For position 1, especially in fast queue, avoid adding too much buffer
                if (position === 1) {
                    // Fast queue should have minimal buffer - no artificial minimum
                    estimatedTimeRemaining = position === 1 && queueLength === 1 ? 
                        boundedTimePerPosition : // Only use actual processing time estimate for fast queue
                        Math.max(estimatedTimeRemaining, 15000); // Reduced from 30s to 15s for other cases
                }
                
                const etaMinutes = Math.floor(estimatedTimeRemaining / 60000);
                const etaSeconds = Math.floor((estimatedTimeRemaining % 60000) / 1000);
                
                const etaString = etaMinutes > 0 ? `${etaMinutes}m ${etaSeconds}s` : `${etaSeconds}s`;
                this.positionNumber.innerText = `ETA: ${etaString}`;
            } else {
                this.positionNumber.innerText = `ETA: Calculating...`;
            }
            return;
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
        
        // Calculate ETA using available data - even if we don't have enough position changes
        let etaString = "Calculating...";
        if (timeForNextPositionLower.length > 0) {
            // Calculate simple average
            const avgTimePerPosition = timeForNextPositionLower.reduce((sum, time) => sum + time, 0) / 
                timeForNextPositionLower.length;
            
            // Apply more realistic bounds to avoid underestimating
            // Minimum 8 seconds per position, maximum 2 minutes per position
            const boundedTimePerPosition = Math.min(Math.max(avgTimePerPosition, 8000), 120000);
            
            // Calculate estimated time remaining based on current position
            // For fastqueue positions (where you might start at position 2), this is more accurate
            let estimatedTimeRemaining = (boundedTimePerPosition * position * ETA_SAFETY_MULTIPLIER) + ETA_FIXED_BUFFER;
            
            // provide more accurate estimate without buffers
            estimatedTimeRemaining = boundedTimePerPosition * position;
            

            const etaMinutes = Math.floor(estimatedTimeRemaining / 60000);
            const etaSeconds = Math.floor((estimatedTimeRemaining % 60000) / 1000);
            
            // Format nicely
            if (etaMinutes > 0) {
                etaString = `${etaMinutes}m ${etaSeconds}s`;
            } else {
                etaString = `${etaSeconds}s`;
            }
        } else if (positionChangeCount < MIN_POSITION_CHANGES_FOR_ETA) {
            etaString = "Calculating...";
        }
        
        // Update for next iteration
        lastPosition = position;
        
        // Display ETA
        this.positionNumber.innerText = `ETA: ${etaString}`;
    },

    hideQueuePosition() {
        this.queuePosition.style.display = 'none';
    },

    setQueueStatus(message) {
        this.response.innerText = message;
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
        fastqueue: funcElementById('fastqueueButton').classList.contains('active'),
        creditsRequired: Number(funcElementById('currentCreditsPrice').innerText) || 0,
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
    UIState.setGenerating(true);

    uploadsToBooru = 0
    everHiddenCancel = false;
    cancelledGeneration = false
    
    // Reset ETA calculations for new generation
    resetETACalculation();

    try {
        const data = await buildRequestData();
        console.log('Request Data:', data);

        const response = await fetch(`${API_BASE}/generate`, {
            method: 'POST',
            headers: getDefaultHeaders(),
            body: JSON.stringify(data)
        });

        const jsonResponse = await response.json();
        
        if (jsonResponse.status === "error") {
            UIState.setError(jsonResponse.message);
            return;
        }

        if (cancelledGeneration) return;

        await handleQueueAndGeneration(jsonResponse);

    } catch (error) {
        console.error('Generation error:', error);
        UIState.setError(error.message);
    }
});

const checkQueuePosition = async () => {
    try {
        const response = await fetch(`${API_BASE}/queue_position/${requestId}`, {
            method: 'GET',
            headers: getDefaultHeaders()
        });

        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
        }

        // Safely attempt to parse JSON
        try {
            return await response.json();
        } catch (jsonError) {
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
    
    UIState.response.innerText = "Your image is ready and will be displayed shortly...";
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
            await new Promise(resolve => setTimeout(resolve, 2000 * retryCount)); // Exponential backoff
        }
    }

    if (!results) {
        UIState.setError("Failed to load image results after multiple attempts.");
        return;
    }

    await displayResults(results);
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

let everHiddenCancel = false;

// Update queue handling functions
const handleQueueAndGeneration = async (jsonResponse) => {
    if (jsonResponse.status !== "queued") return;
    if (cancelledGeneration) return;

    UIState.queuePosition.style.display = 'block';
    UIState.updateQueuePosition(jsonResponse.position, jsonResponse.queue_length || '?');
    UIState.response.innerText = "Your image is being generated, please wait...";

    let isCompleted = false;
    let retryCount = 0;
    let queueLoops = 0;
    let nextCheckMS = 1500;
    let connectionActive = true;

    while (!isCompleted && retryCount < 5) {
        try {

            console.log(`Queue loop running - retryCount: ${retryCount}, isCompleted: ${isCompleted}`);

            if (cancelledGeneration) {
                console.log("Queue checking stopped: cancelledGeneration is true");
                return;
            }


            requestId = jsonResponse.request_id;

            const positionData = await checkQueuePosition();

            console.log("Queue position response:", positionData);

            if (!positionData) {
                retryCount++;
                console.warn(`Retrying queue check... (${retryCount}/5)`);
                
                if (!connectionActive) {
                    UIState.response.innerText = `Temporary error, retrying... (${retryCount}/5)`;
                }

                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                continue; // Skip to the next loop iteration instead of breaking
            }

            
            if (!handlePositionResponse(positionData, queueLoops)) {
                break;
            }

            if (positionData.status === "completed") {
                await handleCompletedGeneration();
                isCompleted = true;
            } else if (positionData.status === "waiting") {
                retryCount = 0; // Reset retry count on successful connection
                connectionActive = true;
                UIState.updateQueuePosition(positionData.position, positionData.queue_length);
                await new Promise(resolve => setTimeout(resolve, nextCheckMS));
            }

            queueLoops++;

        } catch (error) {
            retryCount++;
            if (cancelledGeneration) return;
            console.error('Queue check error:', error);
            
            // Only show the temporary error message if we haven't established a connection yet
            if (!connectionActive) {
                UIState.response.innerText = `Temporary error, retrying... (${retryCount}/5)`;
            } else {
                // If we had a connection before, maintain the current UI state without error message
                console.log(`Temporary network hiccup, silently retrying... (${retryCount}/5)`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
    }

    if (!isCompleted) {
        UIState.setError('Maximum retry attempts reached');
    }

    UIState.setGenerating(false);
    UIState.response.innerText = '';
    UIState.cancelButton.style.display = 'none';
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
        everHiddenCancel = true;
        UIState.cancelButton.style.display = 'none';
    } else if (queueLoops > 2 && !everHiddenCancel) {
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

        cancelledGeneration = true;
        
        if (cancelResponse.status == "cancelled") {
            UIState.response.innerText = "Generation has been cancelled";
            UIState.setGenerating(false);
            UIState.cancelButton.style.display = 'none';
        } else {
            UIState.setError(cancelResponse.message);
        }
    } catch (error) {
        UIState.setError(error.message);
    }
});

document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        console.log("User returned, resuming queue check...");
        handleQueueAndGeneration({ status: "queued", position: "?", request_id });
    }
});

setInterval(async () => {
    try {
        const response = await fetch(`${API_BASE}/get-all-queue-length`, {
            method: 'GET',
            headers: getDefaultHeaders()
        });

        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
        }

        const queueLengths = await response.json();
        
        console.log("Queue lengths:", queueLengths);

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

        // Check if data exists and has the expected format
        if (queueLengths.status === 'success' && queueLengths.data) {
            // Calculate ETAs for both queues
            const normalQueueETA = calculateQueueETA(queueLengths.data.queue_0);
            const fastQueueETA = calculateQueueETA(queueLengths.data.queue_1);

            // Format the ETAs nicely in minutes and seconds
            const formatETA = (ms) => {
                if (!ms && ms !== 0) return "0s";
                const minutes = Math.floor(ms / 60000);
                const seconds = Math.floor((ms % 60000) / 1000);
                return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            };

            funcElementById('bothQueueETA').innerHTML = `<a style="color: yellow;">Estimated Wait Times:</a><br>
            <a style="color: white;">Regular Queue: ${formatETA(normalQueueETA)}</a><br>
            <a style="color: lightblue; box-shadow: 0 0 10px 0 rgba(0, 0, 0, 0.5);">Fast Queue: ${formatETA(fastQueueETA)}</a>`;
        } else {
            console.warn('Invalid queue length data format');
            funcElementById('bothQueueETA').innerText = 'Queue info unavailable';
        }
    } catch (error) {
        console.error('Queue length fetch failed:', error);
    }
}, 5000);