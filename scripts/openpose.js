document.addEventListener("DOMContentLoaded", function () {
    const canvas = document.getElementById('stickCanvas');
    const ctx = canvas.getContext('2d');
    const joints = []; // This will hold the joint objects
    const colors = {
        "nose": "#FF0000",
        "neck": "#FF5500",
        "RShoulder": "#FFAA00",
        "RElbow": "#FFFF00",
        "RWrist": "#AAFF00",
        "LShoulder": "#55FF00",
        "LElbow": "#00FF00",
        "LWrist": "#00FF55",
        "RHip": "#00FFAA",
        "RKnee": "#00FFFF",
        "RAnkle": "#00AAFF",
        "LHip": "#0055FF",
        "LKnee": "#0000FF",
        "LAnkle": "#5500FF",
        "REye": "#AA00FF",
        "LEye": "#FF00FF",
        "REar": "#FF00AA",
        "LEar": "#FF0055"
    };
    let selectedJoint = null;
    let drag = false;
    let isDraggingFigure = false;
    let dragStartX = 0;
    let dragStartY = 0;

    setInterval(() => {
        let aspectRatio = document.getElementById('aspectRatio').value;
        if(aspectRatio == "Square") {
            canvas.width = 512;
            canvas.height = 512;
        } else if (aspectRatio == "Landscape") {
            canvas.width = 756;
            canvas.height = 512;
        } else if (aspectRatio == "Portrait") {
            canvas.width = 512;
            canvas.height = 756;
        }
        redraw()
    }, 1000);

    

    // Function to draw a joint
    function drawJoint(joint) {
        ctx.fillStyle = joint.color;
        ctx.beginPath();
        ctx.arc(joint.x, joint.y, 5, 0, 2 * Math.PI);
        ctx.fill();
    }

    // Function to draw a bone between two joints
    function drawBone(joint1, joint2) {
        ctx.strokeStyle = joint2.color; // Color based on the second joint
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(joint1.x, joint1.y);
        ctx.lineTo(joint2.x, joint2.y);
        ctx.stroke();
    }

    // Function to check if a point is inside a joint's area
    function isInsideJoint(joint, x, y) {
        return Math.sqrt((joint.x - x) ** 2 + (joint.y - y) ** 2) < 5;
    }

    // Function to redraw the entire figure
    function redraw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Draw all bones
        drawBone(joints[1], joints[0]); // Neck to nose
        drawBone(joints[1], joints[2]); // Neck to right shoulder
        drawBone(joints[2], joints[3]); // Right shoulder to right elbow
        drawBone(joints[3], joints[4]); // Right elbow to right wrist
        drawBone(joints[1], joints[5]); // Neck to left shoulder
        drawBone(joints[5], joints[6]); // Left shoulder to left elbow
        drawBone(joints[6], joints[7]); // Left elbow to left wrist
        drawBone(joints[1], joints[8]); // Neck to right hip
        drawBone(joints[8], joints[9]); // Right hip to right knee
        drawBone(joints[9], joints[10]); // Right knee to right ankle
        drawBone(joints[1], joints[11]); // Neck to left hip
        drawBone(joints[11], joints[12]); // Left hip to left knee
        drawBone(joints[12], joints[13]); // Left knee to left ankle
        drawBone(joints[0], joints[14]); // Nose to right eye
        drawBone(joints[0], joints[15]); // Nose to left eye
        drawBone(joints[14], joints[16]); // Right eye to right ear
        drawBone(joints[15], joints[17]); // Left eye to left ear

        // Draw all joints
        joints.forEach(drawJoint);
    }

    // Initialize the stick figure with default positions
    function initializeFigure() {
        const canvasXCenter = canvas.width / 2;
        const canvasYCenter = canvas.height / 2;

        // Define adjusted offsets from the center of the canvas for each joint
        const offsets = {
            nose: { x: 0, y: -300 },
            neck: { x: 0, y: -250 },
            LShoulder: { x: -50, y: -250 },
            LElbow: { x: -100, y: -200 },
            LWrist: { x: -150, y: -150 },
            RShoulder: { x: 50, y: -250 },
            RElbow: { x: 100, y: -200 },
            RWrist: { x: 150, y: -150 },
            LHip: { x: -30, y: -100 },
            LKnee: { x: -30, y: 0 },
            LAnkle: { x: -30, y: 100 },
            RHip: { x: 30, y: -100 },
            RKnee: { x: 30, y: 0 },
            RAnkle: { x: 30, y: 100 },
            REye: { x: 15, y: -310 },
            LEye: { x: -15, y: -310 },
            REar: { x: 45, y: -315 },
            LEar: { x: -45, y: -315 }
        };

        // Clear any existing joints
        joints.length = 0;

        // Use the offsets to position each joint
        for (let jointName in offsets) {
            joints.push({
                x: canvasXCenter + offsets[jointName].x,
                y: canvasYCenter + offsets[jointName].y,
                color: colors[jointName],
                name: jointName
            });
        }

        redraw();
    }



    initializeFigure();

    canvas.addEventListener('mousedown', function (e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;    // relationship bitmap vs. element for X
        const scaleY = canvas.height / rect.height;  // relationship bitmap vs. element for Y
    
        const x = (e.clientX - rect.left) * scaleX; // scale mouse coordinates after they have
        const y = (e.clientY - rect.top) * scaleY;  // been adjusted to be relative to element
    
        isDraggingFigure = true;
        dragStartX = x;
        dragStartY = y;
    
        // Check if we've clicked on a joint
        joints.forEach(joint => {
            if (isInsideJoint(joint, x, y)) {
                selectedJoint = joint;
                drag = true;
                isDraggingFigure = false; // We're dragging an individual joint, not the figure
            }
        });
    });
    
    canvas.addEventListener('mousemove', function (e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
    
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
    
        if (drag && selectedJoint) {
            selectedJoint.x = x;
            selectedJoint.y = y;
            redraw();
        } else if (isDraggingFigure) {
            const dx = x - dragStartX;
            const dy = y - dragStartY;
    
            joints.forEach(joint => {
                joint.x += dx;
                joint.y += dy;
            });
    
            dragStartX = x;
            dragStartY = y;
            redraw();
        }
    });
    
    canvas.addEventListener('mouseup', function (e) {
        drag = false;
        isDraggingFigure = false;
        selectedJoint = null;
    });
    
    canvas.addEventListener('mouseleave', function (e) {
        drag = false;
        isDraggingFigure = false;
        selectedJoint = null;
    });
    

    // Function to set the canvas background to black and return a data URL
    window.getOpenPoseCanvasDataUrl = function() {
        // Store the current composite operation before changing it
        const originalCompositeOperation = ctx.globalCompositeOperation;

        // Set the background to black and redraw the figure
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw the figure
        redraw();

        // Get the data URL of the canvas
        const dataUrl = canvas.toDataURL();

        // Clear the canvas and reset the composite operation
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = originalCompositeOperation;

        // Redraw the figure to restore it to its original state without the black background
        redraw();

        // Return the data URL
        return dataUrl;
    };

});