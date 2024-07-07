$(document).ready(function() {

    var autocompleteEnabled = true; // Initially, autocomplete is enabled.


    // Right after setting the checkbox state
    document.getElementById('autocompleteCheckbox').addEventListener('change', function() {
        autocompleteEnabled = !this.checked;
        // Potentially reset or refresh autocomplete here if needed
    });

    // autocompleteCheckbox trigger change event to set the initial state
    document.getElementById('autocompleteCheckbox').dispatchEvent(new Event('change'));


    function checkAutocompleteEnabled() {
        document.getElementById('autocompleteCheckbox').dispatchEvent(new Event('change'));
        if (!autocompleteEnabled) {
            // document.getElementById('autocomplete-div').style.display = 'none';
            document.getElementById('autocomplete-div').style.marginBottom = '0px';
            return false;
        }
    }



    function getVerticalDistance(element1, element2) {
        var rect1 = element1.getBoundingClientRect();
        var rect2 = element2.getBoundingClientRect();

        // Calculate the vertical distance from the bottom of element1 to the top of element2
        return rect2.top - rect1.bottom;
    }

    function fetchTagsData(term) {
        console.log('fetchTagsData', term);
        if(!term) {
            return
        }
        return $.ajax({
            url: '/autocomplete',
            method: 'POST',
            data: JSON.stringify({ query: term }),
            contentType: 'application/json',
            dataType: 'json'
        });
    }

    function split(val) {
        return val.split(/,\s*/);
    }
    function extractLast(term) {
        return split(term).pop();
    }

    function setupAutocomplete(selector, tagsData) {
        $(selector)
            .on("keydown", function(event) {
                if (checkAutocompleteEnabled() == false) {
                    return;
                }

                if (event.ctrlKey && (event.keyCode === 38 || event.keyCode === 40)) {
                    autocompleteEnabled = false; // Disable autocomplete when adjusting AI strength
                }
                if (event.keyCode === $.ui.keyCode.TAB && $(this).autocomplete("instance").menu.active) {
                    event.preventDefault();
                }
            })
            .on("keyup", function(event) {
                if (checkAutocompleteEnabled() == false) {
                    return;
                }
                if (event.keyCode === 17) { // CTRL key
                    autocompleteEnabled = true; // Re-enable autocomplete after CTRL key is released
                }
            }).autocomplete({
                source: function(request, response) {
                    if (checkAutocompleteEnabled() == false) {
                        response([]);
                        return;
                    }

                    var textarea = $(selector);
                    var cursorPos = textarea.get(0).selectionStart;
                    var text = textarea.val();
                    var leftText = text.substring(0, cursorPos);
                    var rightText = text.substring(cursorPos);

                    var leftWordMatch = leftText.match(/[\w]+$/);
                    var rightWordMatch = rightText.match(/^[\w]*/);

                    var searchTerm = (leftWordMatch ? leftWordMatch[0] : '') + (rightWordMatch ? rightWordMatch[0] : '');
                    searchTerm = searchTerm.toLowerCase();

                    if (searchTerm.length < 2 || searchTerm === undefined) {
                        response([]);
                        return;
                    } else {
                        fetchTagsData(searchTerm).done(function(tagsData) {
                            let suggestions = [];
    
                            tagsData.forEach(tagData => {
                                const tag = tagData.tag.replace(/\\/g, '\\\\').replace(/_/g, ' ');
                                const score = tagData.score;
                                suggestions.push(`${tag} (${score})`);
                            });
    
                            response(suggestions);
                        });
                    }
                },

                select: function(event, ui) {
                    if (checkAutocompleteEnabled() == false) {
                        return;
                    }

                    var textarea = $(selector);
                    var cursorPos = textarea.get(0).selectionStart;
                    var text = textarea.val();
                    var leftText = text.substring(0, cursorPos);
                    var rightText = text.substring(cursorPos);
                
                    var leftWordMatch = leftText.match(/[\w]+$/);
                    var rightWordMatch = rightText.match(/^[\w]*/);
                
                    var replaceLength = (leftWordMatch ? leftWordMatch[0].length : 0) + (rightWordMatch ? rightWordMatch[0].length : 0);
                    // example tags are "1girl_(63474386)" and "Amy_Rose_(sonic)_(3753564)" needs to become "1girl", "Amy Rose \(sonic\)":
                    var actualTag = ui.item.value
                        .replace(/ \(\d+\)/g, '')  // Remove numeric IDs
                        .replace(/_/g, ' ')        // Replace underscores with spaces
                        .replace(/\\/g, '\\\\')    // Escape backslashes
                        .replace(/\(/g, '\\(')     // Escape open parenthesis
                        .replace(/\)/g, '\\)');    // Escape close parenthesis
                
                    // Determine the appropriate text to append
                    var appendText = "";
                    if (rightText.startsWith(" ")) {
                        appendText = ","; // Add just a comma if rightText starts with a space
                    } else {
                        appendText = ", "; // Add comma and space otherwise
                    }
                
                    var newText = leftText.substring(0, leftText.length - (leftWordMatch ? leftWordMatch[0].length : 0)) + actualTag + appendText + rightText.substring(rightWordMatch ? rightWordMatch[0].length : 0);
                    textarea.val(newText);
                
                    // Update the cursor position to be after the inserted tag and appendText
                    var newCursorPos = cursorPos - replaceLength + actualTag.length + appendText.length;
                    textarea.get(0).selectionStart = textarea.get(0).selectionEnd = newCursorPos;

                    return false;
                },

                open: function() {
                    if (checkAutocompleteEnabled() == false) {
                        return;
                    }
                    var menu = $(this).data('ui-autocomplete').menu.element;
                    var autocompleteDiv = $('#autocomplete-div');
        
                    // Delay the execution to ensure the menu is fully rendered
                    setTimeout(function() {
                        // Position the menu at the top-left corner of the autocomplete-div
                        menu.offset({
                            top: autocompleteDiv.offset().top,
                            left: autocompleteDiv.offset().left
                        });
                    }, 0);
                },
                response: function(event, ui) {
                    if (checkAutocompleteEnabled() == false) {
                        return;
                    }
                    var menu = $(this).data('ui-autocomplete').menu.element;
                    var autocompleteDiv = $('#autocomplete-div');
                    var autocompleteDivDocument = document.getElementById('autocomplete-div');
        
                    // Delay the execution to ensure the menu's height is updated
                    setTimeout(function() {
                        autocompleteDivDocument.style.marginBottom = (menu.height() + 20) + 'px';
                    }, 0);
                },
                close: function( event, ui ) {
                    // reset the height of the autocomplete-div to 0:
                    document.getElementById('autocomplete-div').style.marginBottom = '0px';
                },
                search: function() {

                    if (checkAutocompleteEnabled() == false) {
                        return;
                    }

                    var term = extractLast(this.value);
                    if (term.length < 2) {
                        return false;
                    }
                },
                focus: function (event, ui) {
                    event.preventDefault();

                    if (checkAutocompleteEnabled() == false) {
                        return;
                    }
                    
                    var menu = $(this).data('ui-autocomplete').menu.element;
                    menu.find('li').removeClass('custom-highlight');
                    
                    var index = ui.item ? menu.find('li:contains("' + ui.item.value + '")').index() : -1;
                    if(index !== -1){
                        menu.find('li').eq(index).addClass('custom-highlight');
                    }
                },
            }).data('ui-autocomplete')._renderItem = function (ul, item) {
            
                var term = extractLast(this.term);
                var re = new RegExp("(" + $.ui.autocomplete.escapeRegex(term) + ")", "gi");
                var highlightedValue = item.label.replace(re, "<strong>$1</strong>");
                return $("<li>")
                    .addClass('ui-menu-item')
                    .append("<div class='ui-menu-item-wrapper'>" + highlightedValue + "</div>")
                    .appendTo(ul);

            };

        $(selector).on('autocompleteclose', function () {
            document.getElementById('autocomplete-div').style.marginBottom = '0px';
            $(this).data('ui-autocomplete').menu.element.find('li').css({
                'background-color': '',
                'color': '',
                'font-weight': ''
            });
        });
    }

    // Setup autocomplete without fetching tags data
    setupAutocomplete('#prompt', []);
    setupAutocomplete('#negativeprompt', []);

});