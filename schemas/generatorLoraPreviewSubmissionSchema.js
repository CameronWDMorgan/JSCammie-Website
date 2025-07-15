const mongoose = require ("mongoose");
const { Schema } = mongoose;

const generatorLoraPreviewSubmissionSchema = new Schema({
    accountId: { type: String, required: true },
	base64Image: { type: String, required: true },
	status: { type: String, required: false, default: "pending" },
	timestamp: { type: String, required: true },
	loraId: { type: String, required: true },
	prompt: { type: String, required: false, default: "" },
})

// Add index for performance
generatorLoraPreviewSubmissionSchema.index({ accountId: 1 });

const name = "generatorLoraPreviewSubmission"

module.exports = mongoose.models[name] || mongoose.model(name, generatorLoraPreviewSubmissionSchema, name)