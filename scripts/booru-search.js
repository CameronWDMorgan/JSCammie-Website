function votePost(voteType, booru_id) {
	// get the vote type and the booru_id
	let voteData = {
		vote: voteType,
		booru_id: booru_id
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
			document.getElementById(`upvoteButton${booru_id}`).innerHTML = `${data.upvotes} ⬆️`
			document.getElementById(`downvoteButton${booru_id}`).innerHTML = `${data.downvotes} ⬇️`
		} else if (data.status == "error") {
			alert(data.message)
		}
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
        if (sortQuery) {
            document.getElementById("searchSorting").value = sortQuery;
        } else {
            document.getElementById("searchSorting").value = "trending";
        }

        searchButton.onclick = function() {
            let safetyQuery = safetyArray.join(",");
            let searchValue = searchInput.value;
            let sortQuery = searchSorting.value;
            window.location.href = `https://www.jscammie.com/booru/?page=1&search=${searchValue}&safety=${safetyQuery}&sort=${sortQuery}`;
        }
    }

}


// wait until readystate is complete to fire the input event listener:
document.onreadystatechange = function () {
	if (document.readyState === "complete") {
		document.getElementById("searchInput").dispatchEvent(new Event('input'));
	}
};