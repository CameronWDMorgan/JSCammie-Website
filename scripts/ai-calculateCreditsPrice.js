function getFastqueuePrice(loraCount, model) {

	let dynamicCreditsPrice = 0
	const baseCreditsPrice = 15

	dynamicCreditsPrice = baseCreditsPrice

	// is it a model with value starting sdxl?
	if (model.startsWith('sdxl')) {
		dynamicCreditsPrice = dynamicCreditsPrice * 2
		loraModifier = 3
	} else {
		loraModifier = 1.5
	}

	// credits price before loras
	priceBeforeLoras = dynamicCreditsPrice

	loraModifier = (loraModifier + (loraCount / 3))
	loraModifier = loraModifier * (priceBeforeLoras / 20)

	dynamicCreditsPrice = Math.round(dynamicCreditsPrice + (loraCount * loraModifier))

	return dynamicCreditsPrice

}

function getExtrasPrice(extras) {

	let extrasPrice = {
		removeWatermark: 0,
		upscale: 0
	}

	// if { removeWatermark: true } is passed, add 150 credits
	if (extras.removeWatermark) {
		extrasPrice.removeWatermark += 100
	}

	if (extras.upscale) {
		extrasPrice.upscale += 250
	}

	return extrasPrice
}

module.exports = {
	getFastqueuePrice,
	getExtrasPrice
}