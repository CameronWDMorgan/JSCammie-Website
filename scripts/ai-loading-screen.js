// remove the loading screen when the page is fully loaded:
window.addEventListener('load', function() {
	// get the loading screen element:
	const loadingScreen = document.getElementById('loadingScreen');
	// fade out the loading screen:
	loadingScreen.style.opacity = 0;
});

// loading bar:
let loadingBar = document.getElementById('loadingBar');
document.onreadystatechange = function () {
	if (document.readyState == "interactive") {
		loadingBar.style.width = '50%';
	}
	if (document.readyState == "complete") {
		loadingBar.style.width = '100%';
	}
}

// spin the loading gradient
let loadingGradient = document.getElementsByClassName('loadingGradient')[0];
let loadingGradientDeg = 0;
setInterval(() => {
	loadingGradient.style.backgroundImage = `linear-gradient(${loadingGradientDeg}deg, var(--bg-colour-1), var(--bg-colour-2))`;
	loadingGradientDeg += 1;
}, 100);