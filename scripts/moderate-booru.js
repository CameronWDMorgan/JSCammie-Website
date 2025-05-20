async function positive(prompt) {
	
	let wordsToAddIfNsfw = ['nsfw']
	let detectNsfwWords = ['nude', 'naked', 'sex', 'erotic', 'penis', 'vagina', 'nipples']

	let promptLower = prompt.toLowerCase()

	let containsNsfw = detectNsfwWords.some(word => promptLower.includes(word))

	let stringToAdd = ''
	if (containsNsfw) {
		wordsToAddIfNsfw.forEach(word => {
			if (!promptLower.includes(word)) {
				stringToAdd += word + ', '
			}
		})
		stringToAdd = `, ${stringToAdd}`
	}

	prompt += stringToAdd

	let blacklistedWords = [
		'loli', 'shota', 'underdeveloped', 'underaged', 'rape', 'imminent rape', 'non consensual', 'rape face',
	]

	// remove blacklisted words, ensuring that case doesn't matter
	blacklistedWords.forEach(word => {
		let regex = new RegExp(word, 'gi')
		prompt = prompt.replace(regex, '')
	})

	// remove any double spaces
	prompt = prompt.replace(/\s+/g, ' ')

	// remove any leading or trailing spaces
	prompt = prompt.trim()

	return prompt;
}

module.exports = {
	positive
}