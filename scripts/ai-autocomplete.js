function getPhraseAtCursor(textarea) {
    let text = textarea.value;
    let cursorPos = textarea.selectionStart;

    // Get the last part of the text before the cursor
    let leftText = text.slice(0, cursorPos);

    // Split by commas, trim, and get the last part
    // let phrases = leftText.split(',').map(phrase => phrase.trim());
    // ensure it splits on <rp> tags aswell as commas:
    let phrases = leftText.split(',').map(phrase => phrase.trim());
    phrases = phrases.map(phrase => phrase.split('<rp>').map(phrase => phrase.trim())).flat();
    let currentPhrase = phrases[phrases.length - 1];

    // Return both the phrase and its position for replacement purposes
    let startPos = leftText.lastIndexOf(currentPhrase);
    let endPos = startPos + currentPhrase.length;

    return {
        phrase: currentPhrase,
        start: startPos,
        end: endPos
    };
}

function escapeBrackets(tag) {
    // Escape brackets for correct insertion into the textarea
    return tag.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function fetchTagsDataForPrompt(term) {

    if (!term || term.length < 2) {
        return Promise.resolve([]);
    }

    return $.ajax({
        url: '/autocomplete',
        method: 'POST',
        data: JSON.stringify({ query: term }),
        contentType: 'application/json',
        dataType: 'json'
    });
    
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function initializePromptAutocomplete() {
    let promptTextarea = document.getElementById("prompt");
    let negativePromptTextarea = document.getElementById("negativeprompt");
    let selectedIndex = -1;
    const MAX_RESULTS = 25;

    function handleKeyboardNavigation(e, searchResultsDiv) {
        const results = searchResultsDiv.getElementsByClassName('autocomplete-item');
        if (!results.length) return;

        // Remove highlight from current selection
        if (selectedIndex >= 0 && selectedIndex < results.length) {
            results[selectedIndex].classList.remove('selected');
        }

        switch(e.key) {
            case 'ArrowDown':
                e.preventDefault();
                selectedIndex = (selectedIndex + 1) % results.length;
                break;
            case 'ArrowUp':
                e.preventDefault();
                selectedIndex = selectedIndex <= 0 ? results.length - 1 : selectedIndex - 1;
                break;
            case 'Enter':
                if (selectedIndex >= 0 && selectedIndex < results.length) {
                    e.preventDefault();
                    results[selectedIndex].click();
                    selectedIndex = -1;
                    return;
                }
                break;
            case 'Escape':
                searchResultsDiv.style.display = 'none';
                selectedIndex = -1;
                return;
            default:
                return;
        }

        // Add highlight to new selection
        if (selectedIndex >= 0 && selectedIndex < results.length) {
            results[selectedIndex].classList.add('selected');
            results[selectedIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    const debouncedSearch = debounce(async (textarea, phraseAtCursor, start, end) => {
        let searchResultsDiv = document.getElementById("autocomplete-div");
        
        if (!phraseAtCursor || phraseAtCursor.trim() === "") {
            searchResultsDiv.innerHTML = "";
            searchResultsDiv.style.display = "none";
            return;
        }

        // make it a grid of 2 columns
        if (searchResultsDiv.style.display !== "grid") {
            searchResultsDiv.style.display = "grid";
            searchResultsDiv.style.gridTemplateColumns = "1fr 1fr";
        }
        
        // Add loading indicator at the top without clearing existing results
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'autocomplete-loading';
        loadingDiv.innerHTML = 'Loading...';
        searchResultsDiv.insertBefore(loadingDiv, searchResultsDiv.firstChild);
        searchResultsDiv.classList.add("loading");

        try {
            const data = await fetchTagsDataForPrompt(phraseAtCursor);
            searchResultsDiv.classList.remove("loading");
            
            // Remove the loading indicator
            if (searchResultsDiv.firstChild && searchResultsDiv.firstChild.classList.contains('autocomplete-loading')) {
                searchResultsDiv.removeChild(searchResultsDiv.firstChild);
            }

            let searchTags = [];
            data.forEach(tag => {
                if (!searchTags.includes(tag) && tag.tag.toLowerCase().includes(phraseAtCursor.toLowerCase())) {
                    searchTags.push(tag);
                }
            });

            searchTags = searchTags.filter(tag => tag.tag !== "").slice(0, MAX_RESULTS);

            // Now clear the results and show new ones
            searchResultsDiv.innerHTML = "";

            if (searchTags.length === 0) {
                searchResultsDiv.innerHTML = `<div class="no-results">No results found for "${phraseAtCursor}"</div>`;
                return;
            }

            searchTags.forEach((result, index) => {
                let resultDiv = document.createElement('button');
                resultDiv.classList.add("autocomplete-item");
                if (index === 0) {
                    resultDiv.classList.add("autocomplete-item-1");
                } else if (index < 5) {
                    resultDiv.classList.add("autocomplete-item-5");
                } else if (index < 10) {
                    resultDiv.classList.add("autocomplete-item-10");
                }

                let cleanedTag = result.tag.replace(/\(\d+\)\s*/, '').toLowerCase();
                cleanedTag = cleanedTag.replace(/_/g, ' ');
                let tagWithScore = `(${result.score}) ${cleanedTag}`;

                resultDiv.innerText = tagWithScore;

                resultDiv.addEventListener('click', function (e) {
                    e.preventDefault();
                    let searchValue = textarea.value;
                    let escapedTag = escapeBrackets(cleanedTag);
                    textarea.value = searchValue.slice(0, start) + `${escapedTag}, ` + searchValue.slice(end);
                    textarea.focus();
                    textarea.selectionStart = start + escapedTag.length + 2;
                    textarea.selectionEnd = start + escapedTag.length + 2;
                    textarea.dispatchEvent(new Event('input'));
                    searchResultsDiv.style.display = "none";
                    selectedIndex = -1;
                });

                searchResultsDiv.appendChild(resultDiv);
            });
        } catch (error) {
            console.error('Error fetching tags:', error);
            // Only show error if there are no existing results
            if (!searchResultsDiv.querySelector('.autocomplete-item')) {
                searchResultsDiv.innerHTML = '<div class="autocomplete-error">Error fetching results</div>';
            } else {
                // Remove just the loading indicator if there are existing results
                if (searchResultsDiv.firstChild && searchResultsDiv.firstChild.classList.contains('autocomplete-loading')) {
                    searchResultsDiv.removeChild(searchResultsDiv.firstChild);
                }
            }
        }
    }, 300);

    [promptTextarea, negativePromptTextarea].forEach(textarea => {
        textarea.addEventListener("input", function () {
            let { phrase: phraseAtCursor, start, end } = getPhraseAtCursor(textarea);
            debouncedSearch(textarea, phraseAtCursor, start, end);
        });

        textarea.addEventListener("keydown", function(e) {
            const searchResultsDiv = document.getElementById("autocomplete-div");
            if (searchResultsDiv.style.display === "block") {
                handleKeyboardNavigation(e, searchResultsDiv);
            }
        });

        // Hide autocomplete when clicking outside
        document.addEventListener('click', function(e) {
            const searchResultsDiv = document.getElementById("autocomplete-div");
            if (!textarea.contains(e.target) && !searchResultsDiv.contains(e.target)) {
                searchResultsDiv.style.display = 'none';
                selectedIndex = -1;
            }
        });
    });
}

// Initialize the autocomplete feature once everything else is loaded:
document.addEventListener("DOMContentLoaded", function () {
    initializePromptAutocomplete();
});