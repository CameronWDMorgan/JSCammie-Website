function getPhraseAtCursor(textarea) {
    let text = textarea.value;
    let cursorPos = textarea.selectionStart;

    // Get the last part of the text before the cursor
    let leftText = text.slice(0, cursorPos);

    // Split by commas, trim, and get the last part
    let phrases = leftText.split(',').map(phrase => phrase.trim());
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
    // Replace spaces with underscores to match the format
    // term = term.replace(/ /g, '_');
    // console.log(`fetchTagsData: "${term}"`);
    if (!term) {
        return;
    }
    if (term.length < 2) {
        return;
    }
    return $.ajax({
        url: '/autocomplete',
        method: 'POST',
        data: JSON.stringify({ query: term }),
        contentType: 'application/json',
        dataType: 'json'
    });
}

function initializePromptAutocomplete() {
    let promptTextarea = document.getElementById("prompt");
    let negativePromptTextarea = document.getElementById("negativeprompt");

    [promptTextarea, negativePromptTextarea].forEach(textarea => {
        textarea.addEventListener("input", function () {
            let { phrase: phraseAtCursor, start, end } = getPhraseAtCursor(textarea);

            if (!phraseAtCursor || phraseAtCursor.trim() === "") {
                // clear the autocomplete div if the phrase is empty
                let searchResultsDiv = document.getElementById("autocomplete-div");
                searchResultsDiv.innerHTML = "";
                return;
            }

            console.log("Phrase at cursor:", phraseAtCursor);

            index = 0

            // Perform a search for the full phrase at the cursor
            fetchTagsDataForPrompt(phraseAtCursor)
                .then(data => {
                    let searchResultsDiv = document.getElementById("autocomplete-div");
                    searchResultsDiv.innerHTML = ""; // Clear previous results

                    let searchTags = [];

                    data.forEach(tag => {
                        // Only add tags that match the phrase and don't already exist in the results
                        if (!searchTags.includes(tag) && tag.tag.toLowerCase().includes(phraseAtCursor.toLowerCase())) {
                            searchTags.push(tag);
                        }
                    });

                    // remove any empty tags:
                    searchTags = searchTags.filter(tag => tag.tag !== "");

                    index = 0

                    // Display the tag along with its score, but only paste the tag
                    searchTags.forEach(result => {
                        index = index + 1
                        let resultDiv = document.createElement('button');

                        // set the autocomplete-item class to be autocomplete-item-1 for the 1st item, autocomplete-item-5 for the top 5 items, etc.
                        resultDiv.classList.add("autocomplete-item")
                        if (index == 1) {
                            resultDiv.classList.add("autocomplete-item-1")
                        } else if (index <= 5) {
                            resultDiv.classList.add("autocomplete-item-5")
                        } else if (index <= 10) {
                            resultDiv.classList.add("autocomplete-item-10")
                        }

                        // Extract tag and score, replace underscores with spaces for display
                        let cleanedTag = result.tag.replace(/\(\d+\)\s*/, '').toLowerCase();
                        cleanedTag = cleanedTag.replace(/_/g, ' '); // Unescaped for display
                        let tagWithScore = `(${result.score}) ${cleanedTag}`; // Show score in the button

                        // Display the tag with score
                        resultDiv.innerText = tagWithScore;

                        resultDiv.addEventListener('click', function (e) {
                            e.preventDefault();

                            let searchValue = textarea.value;

                            // Escape brackets in the tag for insertion, keep spaces as is
                            let escapedTag = escapeBrackets(cleanedTag);

                            // Replace the exact phrase at the cursor with the cleaned & escaped tag, keeping text before and after the cursor intact
                            textarea.value = searchValue.slice(0, start) + `${escapedTag}, ` + searchValue.slice(end);

                            // set the cursor position to the end of the tag:
                            textarea.focus()
                            textarea.selectionStart = start + escapedTag.length + 2
                            textarea.selectionEnd = start + escapedTag.length + 2


                            // Trigger an input event to update the textarea:
                            textarea.dispatchEvent(new Event('input'));
                        });

                        searchResultsDiv.appendChild(resultDiv);
                    });

                    if (searchTags.length === 0) {
                        searchResultsDiv.innerHTML = `<div>No results found for "${phraseAtCursor}"</div>`;
                    }
                })
                .catch(error => console.error('Error fetching tags:', error)); // Handle fetch error
        });
    });
}

// Initialize the autocomplete feature once everything else is loaded:
document.addEventListener("DOMContentLoaded", function () {
    initializePromptAutocomplete();
});