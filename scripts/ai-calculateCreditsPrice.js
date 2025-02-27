function getFastqueuePrice(loraCount, model) {

	let dynamicCreditsPrice = 0
	const baseCreditsPrice = 20

	dynamicCreditsPrice = baseCreditsPrice

	// split the model on the -, if there isnt a - then make it sd15:
	model = model.split('-')[0] || 'sd15'

	console.log(`Model: ${model}`)

	switch(model) {
		case 'sd15':
			loraModifier = 1.3
			break
		case 'pdxl':
			dynamicCreditsPrice = dynamicCreditsPrice * 2.5
			loraModifier = 4
			break
		case 'flux':
			dynamicCreditsPrice = dynamicCreditsPrice * 3
			loraModifier = 5
			break
		case 'illustrious':
			dynamicCreditsPrice = dynamicCreditsPrice * 2.5
			loraModifier = 4
			break
		default:
			loraModifier = 1.25
	}

	// console.log(`Lora Modifier: ${loraModifier}`)
	// console.log(`Lora Count: ${loraCount}`)
	// console.log(`Base Credits Price: ${baseCreditsPrice}`)

	// credits price before loras
	priceBeforeLoras = dynamicCreditsPrice

	loraModifier = loraModifier * (priceBeforeLoras / 14)

	if (loraCount > 0) {
		dynamicCreditsPrice = Math.round(dynamicCreditsPrice + (loraCount * loraModifier))
	}

	// console.log(`Price Before Loras: ${priceBeforeLoras}`)
	// console.log(`Price After Loras: ${dynamicCreditsPrice}`)


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