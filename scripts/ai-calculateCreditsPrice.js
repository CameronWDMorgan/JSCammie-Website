function getCreditsPrice(loraCount, model) {

	let dynamicGemsPrice = 0
	const baseGemsPrice = 7

	dynamicGemsPrice = baseGemsPrice

	// is it a model with value starting sdxl?
	if (model.startsWith('sdxl')) {
		dynamicGemsPrice += 10
		loraModifier = 3
	} else {
		loraModifier = 1.5
	}

	// gems price before loras
	priceBeforeLoras = dynamicGemsPrice

	loraModifier = (loraModifier + (loraCount / 3))
	loraModifier = loraModifier * (priceBeforeLoras / 20)

	dynamicGemsPrice = Math.round(dynamicGemsPrice + (loraCount * loraModifier))

	return dynamicGemsPrice

}

// exort the function:

module.exports = getCreditsPrice
