document.addEventListener('DOMContentLoaded', function() {
    var displayCanvas = document.getElementById('displayCanvas');
    var displayCtx = displayCanvas.getContext('2d');
    var maskCanvas = document.getElementById('maskCanvas'); // Changed to 'maskCanvas'
    var maskCtx = maskCanvas.getContext('2d');
    var inpaintingImage = document.getElementById('inpaintingImage');
    var img = new Image();
    var drawing = false;
    var inpaintingControls = document.getElementById('inpaintingControls');


    function handleImage(e) {
        var reader = new FileReader();
        reader.onload = function(event) {
            img.onload = function() {
                // Original image dimensions
                var originalWidth = img.width;
                var originalHeight = img.height;
    
                // Set up the canvases
                displayCanvas.width = maskCanvas.width = originalWidth;
                displayCanvas.height = maskCanvas.height = originalHeight;
    
                // Draw the image on the display canvas
                displayCtx.drawImage(img, 0, 0);
    
                // Clear the mask canvas
                maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    
                // Calculate scaled height
                var canvasContainerWidth = document.querySelector('.canvas-container').offsetWidth;
                var scaleRatio = Math.min(canvasContainerWidth / originalWidth, 1); // Ensure the image is not scaled up
                var scaledHeight = originalHeight * scaleRatio;
    
                // Set margin-bottom based on the scaled height
                var marginBottom = scaledHeight + 'px';
                inpaintingControls.style.marginBottom = marginBottom;
            }
            img.src = event.target.result;
        }
        reader.readAsDataURL(e.target.files[0]);
    }
    

    var penSize = document.getElementById('penSize');
    var eraserCheckbox = document.getElementById('eraserCheckbox');

    // Set the default pen size
    maskCtx.lineWidth = 50

    penSize.addEventListener('input', function() {
        maskCtx.lineWidth = penSize.value;
    });
    // initiate input event manually

    

    eraserCheckbox.addEventListener('change', function() {
        if (eraserCheckbox.checked) {
            maskCtx.globalCompositeOperation = 'destination-out'; // Eraser mode
        } else {
            maskCtx.globalCompositeOperation = 'source-over'; // Drawing mode
        }
    });

    function draw(e) {
        if (!drawing) return;
        e.preventDefault(); // Prevent scrolling when touching the canvas
    
        // Get the bounding rectangle of the canvas
        var rect = displayCanvas.getBoundingClientRect();
    
        // Calculate the mouse position relative to the canvas
        var scaleX = displayCanvas.width / rect.width;    // relationship bitmap vs. element for X
        var scaleY = displayCanvas.height / rect.height;  // relationship bitmap vs. element for Y
    
        var x = (e.clientX - rect.left) * scaleX; // scale mouse coordinates after they have
        var y = (e.clientY - rect.top) * scaleY;  // been adjusted to be relative to element
    
        maskCtx.lineCap = 'round';
        maskCtx.strokeStyle = 'red';
        if(maskCtx.lineWidth < 20) {
            maskCtx.lineWidth = 20;
        }
    
        maskCtx.lineTo(x, y);
        maskCtx.stroke();
        maskCtx.beginPath();
        maskCtx.moveTo(x, y);

        // Update display canvas
        displayCtx.drawImage(img, 0, 0); // Redraw image
        displayCtx.drawImage(maskCanvas, 0, 0); // Draw mask on top
    }

    function startDrawing(e) {
        drawing = true;
        draw(e);
    }

    function endDrawing() {
        drawing = false;
        maskCtx.beginPath();
    }

    window.getMaskWithBlackBackground = function() {
        var finalCanvas = document.createElement('canvas');
        var finalCtx = finalCanvas.getContext('2d');

        finalCanvas.width = maskCanvas.width;
        finalCanvas.height = maskCanvas.height;

        finalCtx.fillStyle = 'black';
        finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
        finalCtx.drawImage(maskCanvas, 0, 0);

        return finalCanvas.toDataURL(); // Return the final mask as a data URL
    };


    // MOBILE SUPPORT:

    function getTouchPos(canvasDom, touchEvent) {
        var rect = canvasDom.getBoundingClientRect();
        return {
            x: (touchEvent.touches[0].clientX - rect.left),
            y: (touchEvent.touches[0].clientY - rect.top)
        };
    }
    
    function drawLine(ctx, x, y) {
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'red';
        if(ctx.lineWidth < 50) {
            ctx.lineWidth = 50;
        }
    
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
    }
    
    function drawFromTouch(e) {
        if (!drawing) return;
        e.preventDefault(); // Prevent scrolling when touching the canvas
    
        var touch = getTouchPos(maskCanvas, e);
        var x = touch.x * (displayCanvas.width / maskCanvas.offsetWidth);
        var y = touch.y * (displayCanvas.height / maskCanvas.offsetHeight);
    
        drawLine(maskCtx, x, y);
    
        // Update display canvas
        displayCtx.drawImage(img, 0, 0); // Redraw image
        displayCtx.drawImage(maskCanvas, 0, 0); // Draw mask on top
    }
    
    maskCanvas.addEventListener('touchstart', function(e) {
        drawing = true;
        drawFromTouch(e);
    });
    
    maskCanvas.addEventListener('touchmove', drawFromTouch);
    
    maskCanvas.addEventListener('touchend', function() {
        drawing = false;
        maskCtx.beginPath();
    });

    maskCanvas.addEventListener('mousedown', startDrawing);
    maskCanvas.addEventListener('mouseup', endDrawing);
    maskCanvas.addEventListener('mousemove', draw);
    inpaintingImage.addEventListener('change', handleImage);
});
