async function votePost(voteType, booru_id) {
	// Check if user has already upvoted this post
	let upvoteButton = document.getElementById(`upvoteButton${booru_id}`);
	let hasUpvoted = upvoteButton && upvoteButton.classList.contains('voted');
	
	// If user is trying to remove their upvote, ask if they want to pay 5 credits
	if (voteType === 'upvote' && hasUpvoted) {
		try {
			let response = await globalAlert({
				message: "Removing your upvote will cost 5 credits. Do you want to continue?",
				question: true,
				options: {
					yes: function() {},
					no: function() {}
				}
			});
			
			// If user said no, don't proceed
			if (response !== 'yes') {
				return;
			}
		} catch (error) {
			console.error('Error showing alert:', error);
			return;
		}
	}

	// get the vote type and the booru_id
	let voteData = {
		vote: voteType,
		booru_id: booru_id,
		removeUpvote: voteType === 'upvote' && hasUpvoted // Flag to indicate upvote removal
	}

	// send the vote data to the server:
	fetch("/booru/vote", {
		method: "POST",
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(voteData)
	})
	.then(response => response.json())
	.then(data => {
		console.log(data)
		if (data.status == "success") {
			// Update vote counts
			let upvoteButton = document.getElementById(`upvoteButton${booru_id}`);
			if (upvoteButton) {
				upvoteButton.innerHTML = `${data.upvotes} ⬆️`;
				
				// Toggle the voted class based on whether user has upvoted
				if (data.userVoted) {
					upvoteButton.classList.add('voted');
				} else {
					upvoteButton.classList.remove('voted');
				}
			}
			
			let downvoteButton = document.getElementById(`downvoteButton${booru_id}`);
			if (downvoteButton) {
				downvoteButton.innerHTML = `${data.downvotes} ⬇️`;
				
				// Handle downvote styling if you have it
				if (data.userDownvoted) {
					downvoteButton.classList.add('downvoted');
				} else {
					downvoteButton.classList.remove('downvoted');
				}
			}

			// Update the master data if it exists
			if (typeof masterBooruData !== 'undefined' && masterBooruData[booru_id]) {
				masterBooruData[booru_id].upvotes = data.upvotesList || [];
			}

			// Update user credits display if they paid to remove upvote
			if (data.creditsDeducted) {
				updateUserProfileAndDisplay();
			}
		} else if (data.status == "error") {
			globalAlert({
				message: data.message,
				question: true,
				options: {
					okay: function() {}
				}
			});
		}
	})
	.catch(error => {
		console.error('Error voting on post:', error);
		globalAlert({
			message: "Error voting on post. Please try again later.",
			question: true,
			options: {
				okay: function() {}
			}
		});
	})
}

let searchTags = []

function booruSearchInitialize(settingsMode=false) {
    let searchInput = document.getElementById("searchInput");
    let searchTags = {};

    searchInput.addEventListener("input", function() {

        let searchValue = searchInput.value;
        let lastWord;

        // open the id="autoCompleteDropdown" details element when the search input is focused:
        let autoCompleteDropdown = document.getElementById("autoCompleteDropdown");

        if (searchValue.length > 1) {
            autoCompleteDropdown.open = true;
        } else {
            autoCompleteDropdown.open = false;
        }


        // if there isn't a space, then the last word is the search term:
        if (!searchValue.includes(" ")) {
            lastWord = searchValue;
        } else {
            let searchArray = searchValue.split(" ");
            lastWord = searchArray[searchArray.length - 1];
        }

        console.log(lastWord);

        fetch("/tags-autocomplete", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({lastWord: lastWord})
        })
        .then(response => response.json())
        .then(data => {
            searchTags = data.tags;

            let searchResults

			searchResults = searchTags

            console.log(searchResults);

            let searchResultsDiv = document.getElementById("searchResultsDiv");
            searchResultsDiv.innerHTML = ""; // clear previous results

            // dynamically generate and append buttons for each search result
            function decodeHTMLEntities(text) {
                var textArea = document.createElement('textarea');
                textArea.innerHTML = text;
                return textArea.value;
            }

            // Updated code with decoding
            searchResults.forEach(result => { 
                let resultDiv = document.createElement('button');
                resultDiv.className = 'autocompleteTags';

                let decodedTag = decodeHTMLEntities(result.tag);

                resultDiv.innerText = `(${result.count}) ${decodedTag}`;

                resultDiv.addEventListener('click', function() {
                    let searchValue = searchInput.value;
                    if (lastWord === "") {
                        searchInput.value = searchValue + `${decodedTag} `;
                    } else {
                        // Fix: Replace only the last occurrence of the partial word
                        const lastWordPosition = searchValue.lastIndexOf(lastWord);
                        if (lastWordPosition !== -1) {
                            const beforeLastWord = searchValue.substring(0, lastWordPosition);
                            searchInput.value = beforeLastWord + `${decodedTag} `;
                        } else {
                            // Fallback in case lastWord is not found
                            searchInput.value = searchValue.replace(lastWord, `${decodedTag} `);
                        }
                    }

                    let event = new Event('input');
                    searchInput.dispatchEvent(event);

                    // re-focus the search input after selecting a tag so the cursor is at the end of the input (plus a space:)
                    searchInput.focus();
                });

                searchResultsDiv.appendChild(resultDiv);
            });
        })
        .catch(error => console.error('Error fetching tags:', error)); // Handle fetch error

    });

    if (settingsMode == false) {
         let searchButton = document.getElementById("searchButton");

        let searchSorting = document.getElementById("searchSorting");

        let safetyCheckboxes = document.getElementById("safetyCheckboxes");

        let safetyArray = [];

        // for each safety checkbox, add an event listener to add or remove the value from the safetyArray:
        safetyCheckboxes.childNodes.forEach(checkbox => {
            checkbox.addEventListener("change", function() {
                if (checkbox.checked) {
                    safetyArray.push(checkbox.value);
                } else {
                    safetyArray = safetyArray.filter(safety => safety != checkbox.value);
                }
            });
        });

        let urlParams = new URLSearchParams(window.location.search);
        let searchQuery = urlParams.get("search");
        if (searchQuery) {
            searchInput.value = searchQuery;
        }

        let safetyQuery = urlParams.get("safety");
        if (safetyQuery) {
            safetyArray = safetyQuery.split(",");
            safetyArray.forEach(safety => {
                document.getElementById(`${safety}Checkbox`).checked = true;
            });
        } else {
            document.getElementById("sfwCheckbox").checked = true;
        }

        let sortQuery = urlParams.get("sort");
        let followingQuery = urlParams.get("following");
        
        // If following=true is in URL, set sort to following
        if (followingQuery === 'true') {
            document.getElementById("searchSorting").value = "following";
        } else if (sortQuery) {
            document.getElementById("searchSorting").value = sortQuery;
        } else {
            document.getElementById("searchSorting").value = "trending";
        }

        searchButton.onclick = function() {
            let safetyQuery = safetyArray.join(",");
            let searchValue = searchInput.value;
            let sortQuery = searchSorting.value;
            
            // Build URL with proper parameter handling
            let urlParams = new URLSearchParams();
            urlParams.set('page', '1');
            
            if (searchValue && searchValue.trim()) {
                urlParams.set('search', searchValue.trim());
            }
            
            if (safetyQuery) {
                urlParams.set('safety', safetyQuery);
            } else {
                urlParams.set('safety', 'sfw'); // Default to SFW if no safety selected
            }
            
            if (sortQuery) {
                urlParams.set('sort', sortQuery);
            }
            
            // Add following parameter if following sort is selected
            if (sortQuery === 'following') {
                urlParams.set('following', 'true');
            }
            
            let url = `https://www.jscammie.com/booru/?${urlParams.toString()}`;
            window.location.href = url;
        }
    }

}


// wait until readystate is complete to fire the input event listener:
document.onreadystatechange = function () {
	if (document.readyState === "complete") {
		document.getElementById("searchInput").dispatchEvent(new Event('input'));
	}
};