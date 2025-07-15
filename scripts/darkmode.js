// public/js/dark-mode.js

// Function to initialize and handle dark mode toggling
function initializeDarkMode() {
    const darkModeButton = document.getElementById('darkModeButton');
    const darkModeIcon = document.getElementById('darkModeIcon');
    const docuBody = document.body;

    // Function to apply the dark mode state
    const applyDarkMode = (isDarkMode) => {
        if (isDarkMode) {
            docuBody.classList.add('dark-mode');
            if (darkModeIcon) darkModeIcon.textContent = '☀️';
        } else {
            docuBody.classList.remove('dark-mode');
            if (darkModeIcon) darkModeIcon.textContent = '🌙';
        }

        // Trigger ETA update if the function exists
        if (typeof window.updateQueueETA === 'function') {
            window.updateQueueETA();
        }
    };

    // Function to toggle dark mode
    const toggleDarkMode = () => {
        const isDarkMode = !docuBody.classList.contains('dark-mode');
        
        // Apply the new state
        applyDarkMode(isDarkMode);
        
        // Save to local storage
        localStorage.setItem('darkMode', isDarkMode);

        // Send the state to the server
        fetch('/toggle-darkmode', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                isDarkMode: isDarkMode.toString()
            })
        })
        .then(response => response.json())
        .then(data => {
            console.log('Dark mode preference saved to server:', data.darkmode);
        })
        .catch(error => {
            console.error('Error saving dark mode preference:', error);
        });
    };

    // Attach event listener to the dark mode button
    if (darkModeButton) {
        darkModeButton.addEventListener('click', toggleDarkMode);
    }

    // Function to set dark mode programmatically (e.g., from server-side session)
    window.setDarkMode = (isDarkMode) => {
        // Temporarily disable transitions to prevent flickering
        document.body.classList.add('no-transition');
        const topNavBar = document.querySelector('.topNavBar');
        if (topNavBar) {
            topNavBar.classList.add('no-transition');
        }

        applyDarkMode(isDarkMode === 'true');

        // Re-enable transitions after a short delay
        setTimeout(() => {
            document.body.classList.remove('no-transition');
            if (topNavBar) {
                topNavBar.classList.remove('no-transition');
            }
        }, 50);
    };

    // Initial check on page load to apply saved theme
    document.addEventListener('DOMContentLoaded', () => {
        const savedDarkMode = localStorage.getItem('darkMode') === 'true';
        const serverDarkMode = document.getElementById('isDarkMode')?.textContent;

        if (serverDarkMode) {
            // Server-side preference takes priority
            window.setDarkMode(serverDarkMode);
        } else {
            // Fallback to local storage if no server-side preference is found
            applyDarkMode(savedDarkMode);
        }
    });

}

// Initialize the dark mode functionality
initializeDarkMode();