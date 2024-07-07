$(document).ready(function() {

    var strengthEnabled = true;

    // create an event listener for the strengthArrowkeysCheckbox checkbox to toggle the strengthEnabled variable
    document.getElementById('strengthArrowkeysCheckbox').addEventListener('change', function() {
        strengthEnabled = !this.checked;
    })

    // Function to wrap or modify the word around the cursor with the example tag
    function wrapOrModifyWordAroundCursor(selector, increment) {
        var textarea = $(selector);
        var text = textarea.val();
        var cursorPos = textarea.get(0).selectionStart;
        
        // Regular expression to match the word at the cursor with optional wrapping
        var wordAtCursorRegex = /(?:\((\w+):(\d+\.\d+)\))|(\b\w+\b)/g;
        
        // Function to find the word at the cursor position
        var findWordAtCursor = function(text, cursorPos) {
            var result = { word: '', number: 1.1, isWrapped: false, startIndex: -1, endIndex: -1 };
            var match;
            
            // Reset the lastIndex of the regex to ensure proper search
            wordAtCursorRegex.lastIndex = 0;
            
            while ((match = wordAtCursorRegex.exec(text)) !== null) {
                var matchStart = match.index;
                var matchEnd = wordAtCursorRegex.lastIndex;
                
                // Check if the cursor is within the current match
                if (cursorPos >= matchStart && cursorPos < matchEnd) {
                    result.word = match[1] || match[3];
                    result.number = match[2] ? parseFloat(match[2]) : 1.1;
                    result.isWrapped = !!match[1];
                    result.startIndex = matchStart;
                    result.endIndex = matchEnd;
                    break;
                }
            }
            
            return result;
        };

        var wordDetails = findWordAtCursor(text, cursorPos);
        
        if (wordDetails.word) {
            var newWord;
            var newCursorPos;
            
            if (wordDetails.isWrapped) {
                // Increment or decrement the number in the tag
                var newNumber = wordDetails.number + (increment ? 0.1 : -0.1);
                newNumber = Math.max(newNumber, 0); // Ensure the number is not negative
                newWord = '(' + wordDetails.word + ':' + newNumber.toFixed(1) + ')';
            } else {
                // Wrap the word with the tag
                newWord = '(' + wordDetails.word + ':1.1)';
            }

            // Replace the word in the text
            textarea.val(text.substring(0, wordDetails.startIndex) + newWord + text.substring(wordDetails.endIndex));
            
            // Set the cursor position just before the closing parenthesis
            newCursorPos = wordDetails.startIndex + newWord.length - 1;
            textarea.get(0).selectionStart = textarea.get(0).selectionEnd = newCursorPos;
        }
    }

    // Dynamically check the strengthEnabled state within the event handler
    $('#prompt, #negativeprompt').on("keydown", function(event) {
        // Now checks strengthEnabled inside the handler
        if (strengthEnabled && event.ctrlKey && (event.keyCode === 38 || event.keyCode === 40)) {
            event.preventDefault();
            wrapOrModifyWordAroundCursor('#' + this.id, event.keyCode === 38);
        }
    });
})