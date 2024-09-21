function getFastqueuePrice(loraCount, model) {

	let dynamicCreditsPrice = 0
	const baseCreditsPrice = 20

	dynamicCreditsPrice = baseCreditsPrice

	// is it a model with value starting sdxl?
	if (model.startsWith('sdxl')) {
		dynamicCreditsPrice = dynamicCreditsPrice * 1.5
		loraModifier = 2.5
	} else if (model.startsWith('flux')) {
		dynamicCreditsPrice = dynamicCreditsPrice * 2.5
		loraModifier = 3
	} else {
		loraModifier = 1.25
	}

	// credits price before loras
	priceBeforeLoras = dynamicCreditsPrice

	loraModifier = (loraModifier + (loraCount / 2))
	loraModifier = loraModifier * (priceBeforeLoras / 12)

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
		extrasPrice.removeWatermark += 500
	}

	if (extras.upscale) {
		extrasPrice.upscale += 750
	}

	return extrasPrice
}

module.exports = {
	getFastqueuePrice,
	getExtrasPrice
}