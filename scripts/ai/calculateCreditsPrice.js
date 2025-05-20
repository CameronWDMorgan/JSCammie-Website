function getFastqueuePrice(loraCount, model) {
	const baseCreditsPrice = 18
	let dynamicCreditsPrice = baseCreditsPrice
	let loraModifier = 0
	let priceBeforeLoras = 0

	// Normalize model input - extract base model name
	model = (model || '').split('-')[0] || 'sd15'

	// Apply model-specific pricing adjustments
	switch(model) {

		case 'pdxl':
			dynamicCreditsPrice = dynamicCreditsPrice * 3.5
			loraModifier = 5
			break
		case 'flux':
			dynamicCreditsPrice = dynamicCreditsPrice * 5
			loraModifier = 5
			break
		case 'illustrious':
			dynamicCreditsPrice = dynamicCreditsPrice * 3.5
			loraModifier = 4
			break
		default:
			loraModifier = 1.25
	}

	// Store base price before lora additions
	priceBeforeLoras = dynamicCreditsPrice

	// Scale lora modifier based on the base price
	loraModifier = loraModifier * (priceBeforeLoras / 14)

	// Add price for each lora used
	if (loraCount > 0) {
		dynamicCreditsPrice = dynamicCreditsPrice + (loraCount * loraModifier)
	}

	// Round to nearest whole number
	dynamicCreditsPrice = Math.round(dynamicCreditsPrice)

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
		extrasPrice.upscale += 50
		if (model.startsWith('sdxl')) {
			extrasPrice.upscale = Math.round(extrasPrice.upscale * 2.5)
		}
		if (model.startsWith('illustrious')) {
			extrasPrice.upscale = Math.round(extrasPrice.upscale * 2.5)
		}
	}

	if (extras.doubleImages) {
		extrasPrice.doubleImages += getFastqueuePrice(1, model)
		extrasPrice.doubleImages = Math.round(extrasPrice.doubleImages * 2.5)
		if (model.startsWith('flux')) {
			extrasPrice.doubleImages = Math.round(extrasPrice.doubleImages * 1.25)
		}
	}

	// if both upscale and doubleImages are passed, multiply them to create the bonus:
	if (extras.upscale && extras.doubleImages) {
		extrasPrice.upscaleBonus = Math.round(extrasPrice.upscale * 1)
		extrasPrice.doubleImagesBonus = Math.round(extrasPrice.doubleImages * 1)
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