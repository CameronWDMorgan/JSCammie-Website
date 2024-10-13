function getDefaultHeaders() {
    return {
        'Content-Type': 'application/json',
    };
}

// document.getElementById('generatorForm').addEventListener('submit', async function(event) {
// make it only work with the button of ID generateButton
document.getElementById('generateButton').addEventListener('click', async function(event) {
    event.preventDefault();

    console.log("test")

    // get the formData from the form:
    const formData = new FormData(document.getElementById('generatorForm'));

    // Disable the button and change its text
    const generateButton = document.getElementById('generateButton');
    generateButton.disabled = true;
    generateButton.textContent = 'Generating Image';
    generateButton.classList.add('generating'); // Add the 'generating' class when the process starts
    
    const API_BASE = ''; // Set the base URL to the specified IP address

    let accountId = document.getElementById('user-session').value
    
    let targetSteps = formData.get('steps')
    let targetModel = formData.get('model')

    let targetWidth = 512
    let targetHeight = 512

    aspect_ratio = formData.get('aspectRatio')


    // targetQuantity = formData.get('quantity')

    let targetQuantity = 4

    if (targetModel.startsWith('flux')) {
        targetQuantity = 2
    }

    targetSteps = Number(targetSteps)

    // get the loras from the masterLoraData object, filter by .selected:
    let selectedLoras = Object.keys(masterLoraData).filter(lora => masterLoraData[lora].selected)



    let savedloras = {
        style: Object.keys(selectedLoras.filter(lora => lora.includes('style-'))),
        effect: Object.keys(selectedLoras.filter(lora => lora.includes('effect-'))),
        concept: Object.keys(selectedLoras.filter(lora => lora.includes('concept-'))),
        clothing: Object.keys(selectedLoras.filter(lora => lora.includes('clothing-'))),
        character: Object.keys(selectedLoras.filter(lora => lora.includes('character-'))),
        pose: Object.keys(selectedLoras.filter(lora => lora.includes('pose-'))),
        background: Object.keys(selectedLoras.filter(lora => lora.includes('background-')))
    };

    let targetGuidance = formData.get('cfguidance')


    let imageBase64


    console.log(`H${targetHeight} W${targetWidth} S${targetSteps} Q${targetQuantity} M${targetModel}`)

    // Get the image file from the file input
    const imageInput = document.getElementById('uploadedImage');
    if (imageInput.files && imageInput.files[0]) {
        formData.append('image', imageInput.files[0]);
    }

    let combinedLora = []

    let advancedCheckbox = "on"

    let inpainting_toggle = formData.get('inpaintingCheckbox')

    let inpaintingCheckbox = false

    if(inpainting_toggle == "on") {
        inpaintingCheckbox = true;
        
        // Get the mask with a black background
        const maskDataUrl = getMaskWithBlackBackground();
    
        // Append the mask image to the FormData
        formData.append('mask', maskDataUrl);

        // Get the original image from the file input:
        originalImage = document.getElementById('inpaintingImage').files[0];

        strength = formData.get('inpaintingStrength')
    } else {
        strength = formData.get('img2imgStrength')
    }    
        
    console.log(`LORAS: ${selectedLoras}`);

    // lora strengths (.strength) are stored in the masterLoraData object:
    let lora_strengths = []
    selectedLoras.forEach(lora => {
        lora_strengths.push(Number(masterLoraData[lora].strength))
    });

    function getBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = error => reject(error);
            reader.readAsDataURL(file);
        });
    }

    if(document.getElementById('img2imgCheckbox').checked) {
        let file = document.getElementById('uploadedImage').files[0];
        imageBase64 = await getBase64(file)
    }
    if(document.getElementById('inpaintingCheckbox').checked) {
        let file = originalImage
        imageBase64 = await getBase64(file)
    }

    let request_type = "txt2img"

    if(document.getElementById('img2imgCheckbox').checked) {
        request_type = "img2img"
    } 
    if(document.getElementById('inpaintingCheckbox').checked) {
        request_type = "inpainting"
    }

    function getFavoritedLoraIds() {
        return Object.keys(favorites).filter(key => favorites[key]);
    }

    let favouritedLoras = getFavoritedLoraIds()

    console.log(favouritedLoras)

    let schedulerValue = document.getElementById('scheduler').value

    promptValue = formData.get('prompt')

    fastqueueClasses = document.getElementById('fastqueueButton').classList
    if (fastqueueClasses.contains('active')) {
        fastqueue = true
    } else {
        fastqueue = false
    }

    creditsRequired = document.getElementById('currentCreditsPrice').innerText

    extras = {
        removeWatermark: document.getElementById('removeWatermarkCheckbox').checked ?? false,
        upscale: document.getElementById('upscaleCheckbox').checked ?? false
    }

    let data = {
        prompt: promptValue,
        negativeprompt: formData.get('negativeprompt'),
        aspect_ratio: aspect_ratio,
        steps: targetSteps,
        seed: formData.get('seed'),
        model: targetModel,
        quantity: targetQuantity,
        lora: selectedLoras,
        lora_strengths: lora_strengths,
        favoriteLoras: favouritedLoras, 
        image: imageBase64,
        strength: strength,
        guidance: targetGuidance,
        savedloras: savedloras,
        request_type: request_type,
        advancedMode: advancedCheckbox,
        inpainting: inpaintingCheckbox,
        inpaintingMask: formData.get('mask'),
        accountId: accountId,
        fastpass: formData.get('fastpass'),
        scheduler: schedulerValue,
        fastqueue: fastqueue,
        creditsRequired: 0,
        extras: extras
    };

    console.log(data)

    let nextCheckMSOG = 750
    var nextCheckMS = nextCheckMSOG

    try {
        document.getElementById('response').innerText = "Requesting Image, please wait...";

        const response = await fetch(`${API_BASE}/generate`, {
            method: 'POST',
            headers: getDefaultHeaders(), // Set the headers for the POST request
            body: JSON.stringify(data)
        });

        const jsonResponse = await response.json();

        console.log(jsonResponse)

        // cancel button functionality:
        document.getElementById('cancelButton').addEventListener('click', async function() {
            event.preventDefault();
            // Disable the button and change its text
            generateButton.disabled = true;
            generateButton.textContent = 'Cancelling...';
            generateButton.classList.add('generating'); // Add the 'generating' class when the process starts

            try {
                const response = await fetch(`${API_BASE}/cancel_request/${jsonResponse.request_id}`, {
                    method: 'GET',
                    headers: getDefaultHeaders() // Set the headers for the POST request
                });

                let cancelResponse = await response.json();

                if (cancelResponse.status === "cancelled") {
                    document.getElementById('response').innerText = "Generation has been cancelled";
                    generateButton.disabled = false;
                    generateButton.textContent = 'Generate Image';
                    generateButton.classList.remove('generating');
                    document.getElementById('cancelButton').style.display = 'none';
                    return
                } else {
                    document.getElementById('response').innerText = "An error occurred: " + cancelResponse.message;
                    generateButton.disabled = false;
                    generateButton.textContent = 'Generate Image';
                    generateButton.classList.remove('generating');
                    document.getElementById('cancelButton').style.display = 'none';
                }
            } catch (error) {
                console.error('An error occurred:', error);
                document.getElementById('response').innerText = "An error occurred: " + error.message;
                generateButton.disabled = false;
                generateButton.textContent = 'Generate Image';
                generateButton.classList.remove('generating');
                document.getElementById('cancelButton').style.display = 'none';
            }
        });

        if (jsonResponse.status === "error") {
            document.getElementById('response').innerText = "An error occurred: " + jsonResponse.message;
            generateButton.disabled = false;
            generateButton.textContent = 'Generate Image';
            generateButton.classList.remove('generating');
            document.getElementById('cancelButton').style.display = 'none';
        }        


        if (jsonResponse.status === "queued") {
            // Display initial queue position to the user
            document.getElementById('queuePosition').style.display = 'block';
            document.getElementById('positionNumber').innerText = jsonResponse.position;
            document.getElementById('response').innerText = "Your image is being generated, please wait...";
            

            // Replace setInterval with a while loop
            let isCompleted = false;
            // Initialize retry parameters
            const maxRetries = 5;
            let retryCount = 0;

            // Existing code before the while loop remains unchanged

            let everHiddenCancel = false

            let queueLoops = 0

            while (!isCompleted) {
                try {
                    const positionResponse = await fetch(`${API_BASE}/queue_position/${jsonResponse.request_id}`, {
                        method: 'GET',
                        headers: getDefaultHeaders() // Set the headers for the GET request
                    });
                    
                    const positionData = await positionResponse.json();
                    
                    console.log(positionData);

                    if (Number(positionData.position) < 3 ) {
                        everHiddenCancel = true
                    }

                    

                    if (everHiddenCancel) {
                        document.getElementById('cancelButton').style.display = 'none';
                    } else {
                        if (queueLoops > 2) {
                            document.getElementById('cancelButton').style.display = 'block';
                        }
                    }

                    queueLoops += 1

                    if(positionData.status == "error") {
                        document.getElementById('response').innerText = "An error occurred: " + positionData.message;
                        generateButton.disabled = false;
                        generateButton.classList.remove('generating'); // Remove the class when there's an error
                        document.getElementById('cancelButton').style.display = 'none';
                        break; // Exit the loop if there's an error
                    }
                
                    if(positionData.status == "not found") {
                        document.getElementById('queuePosition').style.display = 'none';
                        document.getElementById('response').innerText = "An error occurred: " + positionData.message;
                        generateButton.disabled = false;
                        generateButton.classList.remove('generating'); // Remove the class when there's an error
                        document.getElementById('cancelButton').style.display = 'none';
                        break; // Exit the loop if there's an error
                    }
                    
                    if (positionData.status == "waiting") {
                        retryCount = 0;
                        document.getElementById('positionNumber').innerText = `${positionData.position}/${positionData.queue_length}`;
                        await new Promise(resolve => setTimeout(resolve, nextCheckMS)); // Wait for 1 second before the next check
                        nextCheckMS = 1250
                    } else if (positionData.status === "completed") {
                        retryCount = 0;
                        document.getElementById('response').innerText = "Your image is ready and will be displayed shortly...";
                        isCompleted = true; // Set the flag to exit the loop
                        document.getElementById('queuePosition').style.display = 'none';
                        const resultResponse = await fetch(`${API_BASE}/result/${positionData.request_id}`, {
                            method: 'GET',
                            headers: getDefaultHeaders()
                        });
                
                        if (resultResponse.ok) {

                            

                            const results = await resultResponse.json();

                            // update the creditsDisplay IF the results.fastqueue is true:
                            if (results.fastqueue == true) {
                                document.getElementById('creditsDisplay').innerText = results.credits;
                            }

                            base64Images = results.images;

                            document.getElementById('imagesContainer').innerHTML = '';

                            // get the time in ms:
                            const time = new Date().getTime();

                            const audio = new Audio('https://www.jscammie.com/generationdone.wav');
                            audio.play();

                            for (const [key, value] of Object.entries(results)) {
                                console.log(`${key}: ${value}`);
                            }

                            // get the image history data:
                            let allImageHistory = results.allImageHistory

                            notAllowedBooruImageSpam = ["416790733031211009"]

                            if (notAllowedBooruImageSpam.includes(accountId)) {
                                textElement = document.createElement('p');
                                textElement.innerText = "You've been flagged for spamming images to the booru, DO NOT upload images IF they are low quality / do not match the prompt used OR in general have alot of errors!";
                                textElement.style.color = 'rgb(255, 200, 200)';
                                // append in a div OUTSIDE/ABOVE the imagesContainer:
                                document.getElementById('imagesContainer').parentNode.insertBefore(textElement, document.getElementById('imagesContainer'));
                            }

                            base64Images.forEach((image, index) => {


                                // create a details summary that the buttons are in:
                                const details = document.createElement('details');
                                details.style.display = 'inline-block';

                                // create a summary for the details:
                                const summary = document.createElement('summary');
                                summary.innerText = `Image #${index}'s Options`;
                                details.appendChild(summary);




                                let downloadName, downloadText, mediaElement;
                                const time = new Date().getTime(); // Assuming 'time' variable needs to be defined
                            
                                if (data.request_type === "txt2video") {
                                    // Update for video
                                    image.base64 = 'data:video/mp4;base64,' + image.base64;
                                    downloadName = `video-${time}-${index}.mp4`;
                                    downloadText = 'Download Video';
                            
                                    // Create video element for MP4
                                    mediaElement = document.createElement('video');
                                    mediaElement.controls = true;
                                    const sourceElement = document.createElement('source');
                                    sourceElement.src = image.base64;
                                    sourceElement.type = 'video/mp4';
                                    // set the video to auto play and loop:
                                    mediaElement.autoplay = true;
                                    mediaElement.loop = true;
                                    // set the width and height to follow the css width and height limits:
                                    mediaElement.style.width = '100%';
                                    mediaElement.style.height = 'auto';


                                    mediaElement.appendChild(sourceElement);
                                } else {
                                    // Update for image
                                    image.base64 = 'data:image/png;base64,' + image.base64;
                                    downloadName = `image-${time}-${index}.png`;
                                    downloadText = 'Download Image';
                            
                                    // Create image element for PNG
                                    mediaElement = document.createElement('img');
                                    mediaElement.src = image.base64;
                                }
                            
                                mediaElement.style.display = 'inline';
                                mediaElement.style.width = 'auto';
                                mediaElement.style.height = 'auto';
                            
                                const container = document.createElement('div');
                                container.style.display = 'inline-block';
                                container.style.margin = '10px';
                                container.appendChild(mediaElement);
                            
                                // Create download button
                                const downloadButton = document.createElement('button');
                                downloadButton.innerText = downloadText;
                                downloadButton.style.display = 'block';
                                downloadButton.style.marginTop = '10px';
                            
                                // Function to trigger download
                                downloadButton.onclick = function() {
                                    // Convert base64 to blob and trigger download
                                    fetch(image.base64)
                                        .then(res => res.blob())
                                        .then(blob => {
                                            const blobUrl = window.URL.createObjectURL(blob);
                                            const tempLink = document.createElement('a');
                                            tempLink.href = blobUrl;
                                            tempLink.download = downloadName;
                                            document.body.appendChild(tempLink);
                                            tempLink.click();
                                            document.body.removeChild(tempLink);
                                            window.URL.revokeObjectURL(blobUrl);
                                        });
                                };


                                // Create img2img button
                                const img2imgButton = document.createElement('button');
                                img2imgButton.innerText = 'Send to Img2Img';
                                img2imgButton.style.display = 'block';
                                img2imgButton.style.marginTop = '5px';
                                img2imgButton.onclick = function() {
                                    document.getElementById('img2imgCheckbox').checked = true;
                                    document.getElementById('img2imgCheckbox').dispatchEvent(new Event('click'));
                                    document.getElementById('img2imgCheckbox').dispatchEvent(new Event('change'));
                                    // Assuming uploadedImage is an input of type 'file'
                                    const dataUrlToFile = async (dataUrl, fileName) => {
                                        const res = await fetch(dataUrl);
                                        const blob = await res.blob();
                                        return new File([blob], fileName, { type: 'image/png' });
                                    };
                                    dataUrlToFile(image.base64, downloadName).then(file => {
                                        const dataTransfer = new DataTransfer();
                                        dataTransfer.items.add(file);
                                        document.getElementById('uploadedImage').files = dataTransfer.files;
                                    });
                                };

                                // Create inpainting button
                                const inpaintingButton = document.createElement('button');
                                inpaintingButton.innerText = 'Send to Inpainting';
                                inpaintingButton.style.display = 'block';
                                inpaintingButton.style.marginTop = '5px';
                                inpaintingButton.onclick = async function() {
                                    // fire the click event for the inpainting checkbox:
                                    document.getElementById('inpaintingCheckbox').checked = true;
                                    document.getElementById('inpaintingCheckbox').dispatchEvent(new Event('click'));
                                    document.getElementById('inpaintingCheckbox').dispatchEvent(new Event('change'));
                                    const dataUrlToFile = async (dataUrl, fileName) => {
                                        const res = await fetch(dataUrl);
                                        const blob = await res.blob();
                                        return new File([blob], fileName, { type: 'image/png' });
                                    };
                                    await dataUrlToFile(image.base64, downloadName).then(file => {
                                        const dataTransfer = new DataTransfer();
                                        dataTransfer.items.add(file);
                                        document.getElementById('inpaintingImage').files = dataTransfer.files;
                                    });
                                    document.getElementById('inpaintingImage').dispatchEvent(new Event('change'));
                                };

                                let booruData; // Declare this globally so it's accessible in both functions

                                function showBooruPopup(booruDataCurrent) {
                                    event.preventDefault();

                                    const booruPopupContent = document.getElementById('booruPopupContent');
                                    const overlay = document.getElementById('overlayBooru');

                                    // If the user clicks outside the popup, close it:
                                    overlay.onclick = function() {
                                        closeBooruPopup();
                                    }

                                    // Assign booruData for this image, waiting until the user clicks confirm
                                    booruData = {
                                        prompt: `${booruDataCurrent.prompt}`,
                                        negative_prompt: `${booruDataCurrent.negative_prompt}`,
                                        aspect_ratio: `${booruDataCurrent.aspect_ratio}`,
                                        model: `${booruDataCurrent.model}`,
                                        loras: `${booruDataCurrent.loras}`,
                                        lora_strengths: `${booruDataCurrent.lora_strengths}`,
                                        steps: `${booruDataCurrent.steps}`,
                                        cfg: `${booruDataCurrent.cfg}`,
                                        seed: `${booruDataCurrent.seed}`,
                                        image_url: `${booruDataCurrent.image_url}`
                                    };

                                    // Insert the popup content
                                    booruPopupContent.innerHTML = `
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
                                            <li>Quality Generations are preferred! (Don't upload a billion variations ^-^;)</li>
                                        </ul>
                                        <p>If you agree to these rules/terms, then feel free to click below</p>
                                        <button id="confirmUploadButton" onclick="uploadToBooru()">Upload to Booru</button>
                                    `;

                                    document.getElementById('overlayBooru').style.display = 'block';
                                    document.getElementById('booruPopupContent').style.display = 'block';

                                    // Listen for the ESC key to close the popup
                                    document.addEventListener('keydown', escCloseBooruPopup);
                                }

                                async function uploadToBooru() {
                                    // Use the booruData stored when the popup was shown
                                    const response = await fetch('/create-booru-image', {
                                        method: 'POST',
                                        headers: getDefaultHeaders(),
                                        body: JSON.stringify(booruData)
                                    });

                                    const jsonResponse = await response.json();

                                    if (jsonResponse.status === "success") {
                                        alert('Image uploaded to Booru successfully!');
                                        closeBooruPopup(); // Close the popup once the upload is successful
                                    } else {
                                        alert('Failed to upload image to Booru.');
                                    }
                                }

                                function closeBooruPopup() {
                                    document.getElementById('overlayBooru').style.display = 'none';
                                    document.getElementById('booruPopupContent').style.display = 'none';
                                    document.removeEventListener('keydown', escCloseBooruPopup); // Remove the keydown listener
                                }

                                function escCloseBooruPopup(event) {
                                    if (event.key === 'Escape') {
                                        closeBooruPopup();
                                    }
                                }

                                // Assuming this is where the button creation happens in a loop for each image:
                                if (allImageHistory[index] !== undefined) {

                                    let uploadToBooruButton = document.createElement('button');

                                    uploadToBooruButton.innerText = 'Upload to Booru';
                                    uploadToBooruButton.style.display = 'block';
                                    uploadToBooruButton.style.marginTop = '5px';
                                    uploadToBooruButton.id = `uploadToBooruButton-${index}`;

                                    uploadToBooruButton.onclick = function() {
                                        const booruDataCurrent = allImageHistory[index];
                                        showBooruPopup(booruDataCurrent); // Pass the current image data to the popup

                                        // Embed the upload function directly in the onclick handler for the confirm button
                                        document.getElementById('confirmUploadButton').onclick = async function() {
                                            // Construct booruData dynamically
                                            let booruData = {
                                                prompt: booruDataCurrent.prompt,
                                                negative_prompt: booruDataCurrent.negative_prompt,
                                                aspect_ratio: booruDataCurrent.aspect_ratio,
                                                model: booruDataCurrent.model,
                                                loras: booruDataCurrent.loras,
                                                lora_strengths: booruDataCurrent.lora_strengths,
                                                steps: booruDataCurrent.steps,
                                                cfg: booruDataCurrent.cfg,
                                                seed: booruDataCurrent.seed,
                                                image_url: booruDataCurrent.image_url
                                            };

                                            // Upload the image to the Booru
                                            const response = await fetch('/create-booru-image', {
                                                method: 'POST',
                                                headers: getDefaultHeaders(),
                                                body: JSON.stringify(booruData)
                                            });

                                            const jsonResponse = await response.json();

                                            if (jsonResponse.status === "success") {
                                                alert('Image uploaded to Booru successfully!');
                                                closeBooruPopup(); // Close the popup after upload success
                                                uploadToBooruButton.style.display = 'none'; // Hide the button after upload
                                            } else {
                                                alert('Failed to upload image to Booru.');
                                            }
                                        };
                                    };

                                    container.appendChild(uploadToBooruButton);

                                }

                                
                                // append the buttons to the details:
                                details.appendChild(downloadButton);
                                details.appendChild(img2imgButton);
                                details.appendChild(inpaintingButton);

                                container.appendChild(details);

                                document.getElementById('imagesContainer').appendChild(container);
                            });

                            let additionalInfo = results.additionalInfo;
                            let executionshort = additionalInfo.executiontime.toFixed(2);

                            // document.getElementById('additionalInfo').innerHTML = 
                            //     `<p>Seed: ${additionalInfo.seed}<br>` +
                            //     `Execution Time: ${executionshort}s<br>` +
                            //     `Loras: ${additionalInfo.loras}<br>`;

                            document.getElementById('additionalInfo').innerHTML =
                                `<p>Seed: ${additionalInfo.seed}<br>`
                                // `Execution Time: ${executionshort}s</p>`;

                        
                        } else {
                            // Handle errors or different response types
                            console.error('Failed to get images:', await resultResponse.text());
                        }
                        generateButton.disabled = false;
                    }
                } catch (error) {
                    console.error('An error occurred during position check:', error);
                
                    // Check if the error is related to the server being unavailable
                    const isServerDown = error.message.includes('server not responding') || error.status === 503;
                
                    if (isServerDown) {
                        // If the server is down, wait for a longer period before retrying
                        const retryDelayInSeconds = 5; // Adjust this value based on your needs
                        console.log(`Server is down, retrying in ${retryDelayInSeconds} seconds...`);
                        await new Promise(resolve => setTimeout(resolve, retryDelayInSeconds * 1000));
                        continue; // Retry the loop after the delay
                    } else {
                        // Handle other errors with the existing retry strategy
                        if (retryCount < maxRetries) {
                            retryCount++;
                            console.log(`Retry attempt ${retryCount} due to error: ${error.message}`);
                            document.getElementById('response').innerText = `Temporary error, retrying... (${retryCount}/${maxRetries})`;
                            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // Exponential back-off could be considered here
                            continue; // Skip the rest of the loop and retry
                        } else {
                            // Handle the error after max retries have been reached
                            document.getElementById('response').innerText = "An error occurred after multiple retries: " + error.message;
                            generateButton.disabled = false;
                            generateButton.textContent = 'Generate Image';
                            generateButton.classList.remove('generating');
                            document.getElementById('cancelButton').style.display = 'none';
                            break; // Exit the loop if max retries reached
                        }
                    }
                }
            }
            // After the loop, you can re-enable the button if needed
            generateButton.disabled = false;
            generateButton.textContent = 'Generate Image';
            generateButton.classList.remove('generating');
            document.getElementById('response').innerText = ''
            document.getElementById('cancelButton').style.display = 'none';
            populateImagesSrcList();
        }
    } catch (error) {
        console.error('An error occurred:', error);
        document.getElementById('response').innerText = "An error occurred: " + error.message;
        generateButton.disabled = false;
        generateButton.textContent = 'Generate Image';
        generateButton.classList.remove('generating');
        document.getElementById('cancelButton').style.display = 'none';
    }
})