function getFastqueuePrice(loraCount, model) {

	let dynamicCreditsPrice = 0
	const baseCreditsPrice = 25

	dynamicCreditsPrice = baseCreditsPrice

	// is it a model with value starting sdxl?
	if (model.startsWith('sdxl')) {
		dynamicCreditsPrice = dynamicCreditsPrice * 1.75
		loraModifier = 3.5
	} else if (model.startsWith('flux')) {
		dynamicCreditsPrice = dynamicCreditsPrice * 2.5
		loraModifier = 5
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

function getExtrasPrice(extras, model='') {

	let extrasPrice = {
		removeWatermark: 0,
		upscale: 0,
		doubleImages: 0,
		removeWatermarkBonus: 0,
		upscaleBonus: 0,
		doubleImagesBonus: 0,
		removeBackground: 0,
	}

	// if { removeWatermark: true } is passed, add 150 credits
	if (extras.removeWatermark) {
		extrasPrice.removeWatermark += 300
	}

	if (extras.upscale) {
		extrasPrice.upscale += 150
		if (model.startsWith('sdxl')) {
			extrasPrice.upscale += 200
		}
		if (model.startsWith('flux')) {
			extrasPrice.upscale += 300
		}
	}

	if (extras.doubleImages) {
		extrasPrice.doubleImages += getFastqueuePrice(1, model)
		extrasPrice.doubleImages = Math.round(extrasPrice.doubleImages * 2)
		if (model.startsWith('flux')) {
			extrasPrice.doubleImages = Math.round(extrasPrice.doubleImages * 1.25)
		}
	}

	// if both upscale and doubleImages are passed, multiply them to create the bonus:
	if (extras.upscale && extras.doubleImages) {
		extrasPrice.upscaleBonus = Math.round(extrasPrice.upscale * 0.5)
		extrasPrice.doubleImagesBonus = Math.round(extrasPrice.doubleImages * 1.5)
	}

	if (extras.removeBackground) {
		extrasPrice.removeBackground += 75
	}

	return extrasPrice
}

module.exports = {
	getFastqueuePrice,
	getExtrasPrice
}