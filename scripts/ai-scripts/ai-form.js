function getDefaultHeaders() {
    return {
        'Content-Type': 'application/json',
    };
}

// document.getElementById('generatorForm').addEventListener('submit', async function(event) {
// make it only work with the button of ID generateButton
document.getElementById('generateButton').addEventListener('click', async function(event) {
    event.preventDefault();

    // Disable the button and change its text
    const generateButton = document.getElementById('generateButton');
    generateButton.disabled = true;
    generateButton.textContent = 'Generating Image';
    generateButton.classList.add('generating'); // Add the 'generating' class when the process starts
    
    const API_BASE = ''; // Set the base URL to the specified IP address

    let accountId = document.getElementById('user-session').value

    let targetWidth = 512
    let targetHeight = 512

    targetQuantity = 4
    targetSteps = 20

    let request_type = "txt2img"

    loraNSFWWarning = true

    lora_strengths = []

    let data = {
        prompt: document.getElementById('prompt').value,
        negativeprompt: document.getElementById('negative_prompt').value,
        aspect_ratio: document.getElementById('aspect_ratio').value,
        steps: targetSteps,
        lora: [],
        lora_strengths,
        seed: document.getElementById('seed').value,
        model: document.getElementById('model').value,
        quantity: targetQuantity,
        guidance: document.getElementById('guidance').value,
        request_type: request_type,
        accountId: accountId,
        fastpass: document.getElementById('fastpass').value,
        scheduler: document.getElementById('scheduler').value,
    };

    console.log(data)

    let nextCheckMSOG = 750
    let nextCheckMS = nextCheckMSOG

    try {
        document.getElementById('response').innerText = "Requesting Image, please wait...";

        // POSTs to the autosaving thingy, uses mongodb
        // fetch('/ai-generate', {
        //     method: 'POST',
        //     headers: getDefaultHeaders(), // Set the headers for the POST request
        //     body: JSON.stringify(data)
        // })

        const response = await fetch(`${API_BASE}/generate`, {
            method: 'POST',
            headers: getDefaultHeaders(), // Set the headers for the POST request
            body: JSON.stringify(data)
        });

        const jsonResponse = await response.json();

        console.log(jsonResponse)

        // cancel button functionality:
        // document.getElementById('cancelButton').addEventListener('click', async function() {
        //     event.preventDefault();
        //     // Disable the button and change its text
        //     generateButton.disabled = true;
        //     generateButton.textContent = 'Cancelling...';
        //     generateButton.classList.add('generating'); // Add the 'generating' class when the process starts

        //     try {
        //         const response = await fetch(`${API_BASE}/cancel_request/${jsonResponse.request_id}`, {
        //             method: 'GET',
        //             headers: getDefaultHeaders() // Set the headers for the POST request
        //         });

        //         let cancelResponse = await response.json();

        //         if (cancelResponse.status === "cancelled") {
        //             document.getElementById('response').innerText = "Generation has been cancelled";
        //             generateButton.disabled = false;
        //             generateButton.textContent = 'Generate Image';
        //             generateButton.classList.remove('generating');
        //             document.getElementById('cancelButton').style.display = 'none';
        //             return
        //         } else {
        //             document.getElementById('response').innerText = "An error occurred: " + cancelResponse.message;
        //             generateButton.disabled = false;
        //             generateButton.textContent = 'Generate Image';
        //             generateButton.classList.remove('generating');
        //             document.getElementById('cancelButton').style.display = 'none';
        //         }
        //     } catch (error) {
        //         console.error('An error occurred:', error);
        //         document.getElementById('response').innerText = "An error occurred: " + error.message;
        //         generateButton.disabled = false;
        //         generateButton.textContent = 'Generate Image';
        //         generateButton.classList.remove('generating');
        //         document.getElementById('cancelButton').style.display = 'none';
        //     }
        // });

        // if (jsonResponse.status === "error") {
        //     document.getElementById('response').innerText = "An error occurred: " + jsonResponse.message;
        //     generateButton.disabled = false;
        //     generateButton.textContent = 'Generate Image';
        //     generateButton.classList.remove('generating');
        //     document.getElementById('cancelButton').style.display = 'none';
        // }        


        if (jsonResponse.status === "queued") {
            // Display initial queue position to the user
            document.getElementById('queuePosition').style.display = 'block';
            document.getElementById('positionNumber').innerText = jsonResponse.position;
            document.getElementById('response').innerText = "Your image is being generated, please wait...";
            // document.getElementById('cancelButton').style.display = 'block';
            

            // Replace setInterval with a while loop
            let isCompleted = false;
            // Initialize retry parameters
            const maxRetries = 5;
            let retryCount = 0;

            // Existing code before the while loop remains unchanged

            while (!isCompleted) {
                try {
                    const positionResponse = await fetch(`${API_BASE}/queue_position/${jsonResponse.request_id}`, {
                        method: 'GET',
                        headers: getDefaultHeaders() // Set the headers for the GET request
                    });
                    
                    const positionData = await positionResponse.json();
                    
                    console.log(positionData);

                    if(positionData.status == "error") {
                        document.getElementById('response').innerText = "An error occurred: " + positionData.message;
                        generateButton.disabled = false;
                        generateButton.classList.remove('generating'); // Remove the class when there's an error
                        // document.getElementById('cancelButton').style.display = 'none';
                        break; // Exit the loop if there's an error
                    }
                
                    if(positionData.status == "not found") {
                        document.getElementById('queuePosition').style.display = 'none';
                        document.getElementById('response').innerText = "An error occurred: " + positionData.message;
                        generateButton.disabled = false;
                        generateButton.classList.remove('generating'); // Remove the class when there's an error
                        // document.getElementById('cancelButton').style.display = 'none';
                        break; // Exit the loop if there's an error
                    }
                    
                    if (positionData.status == "waiting") {
                        retryCount = 0;
                        document.getElementById('positionNumber').innerText = `${positionData.position}/${positionData.queue_length}`;
                        nextCheckMS = nextCheckMSOG * 2; // Increase the check interval
                        await new Promise(resolve => setTimeout(resolve, nextCheckMS)); // Wait for 1 second before the next check
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

                            base64Images = results.images;

                            document.getElementById('imagesContainer').innerHTML = '';

                            // get the time in ms:
                            const time = new Date().getTime();

                            base64Images.forEach((image, index) => {
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

                                container.appendChild(downloadButton);
                                container.appendChild(img2imgButton);
                                container.appendChild(inpaintingButton);

                                document.getElementById('imagesContainer').appendChild(container);
                            });

                            let additionalInfo = results.additionalInfo;
                            let executionshort = additionalInfo.executiontime.toFixed(2);

                            // document.getElementById('additionalInfo').innerHTML = 
                            //     `<p>Seed: ${additionalInfo.seed}<br>` +
                            //     `Execution Time: ${executionshort}s<br>` +
                            //     `Loras: ${additionalInfo.loras}<br>`;

                            document.getElementById('additionalInfo').innerHTML =
                                `<p>Seed: ${additionalInfo.seed}<br>` +
                                `Execution Time: ${executionshort}s</p>`;

                        
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
                            // document.getElementById('cancelButton').style.display = 'none';
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
            // document.getElementById('cancelButton').style.display = 'none';
            // populateImagesSrcList();
        }
    } catch (error) {
        console.error('An error occurred:', error);
        document.getElementById('response').innerText = "An error occurred: " + error.message;
        generateButton.disabled = false;
        generateButton.textContent = 'Generate Image';
        generateButton.classList.remove('generating');
        // document.getElementById('cancelButton').style.display = 'none';
    }
})