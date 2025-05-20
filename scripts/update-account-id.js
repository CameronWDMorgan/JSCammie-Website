const mongoose = require('mongoose');
require('dotenv').config();
const userHistorySchema = require('../schemas/userHistorySchema.js');

// Get the user IDs from command line arguments or use default values
const OLD_ACCOUNT_ID = "375148020922318850";
const NEW_ACCOUNT_ID = "1359302259489378314";

async function updateImageUrls() {
  try {
    // Connect to MongoDB
    console.log('Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to database');

    // Find all documents with the new account ID
    console.log(`Finding documents with account_id: ${NEW_ACCOUNT_ID}`);
    const documents = await userHistorySchema.find({ account_id: NEW_ACCOUNT_ID });
    
    console.log(`Found ${documents.length} documents with the new account ID`);
    
    let updatedCount = 0;
    
    // Update each document's image_url if it contains the old account ID
    for (const doc of documents) {
      if (doc.image_url && doc.image_url.includes(OLD_ACCOUNT_ID)) {
        const newImageUrl = doc.image_url.replace(OLD_ACCOUNT_ID, NEW_ACCOUNT_ID);
        
        await userHistorySchema.updateOne(
          { _id: doc._id },
          { $set: { image_url: newImageUrl } }
        );
        
        updatedCount++;
        
        if (updatedCount % 100 === 0) {
          console.log(`Updated ${updatedCount} image URLs so far...`);
        }
      }
    }
    
    console.log(`Updated ${updatedCount} image URLs out of ${documents.length} documents`);
    
    // Disconnect from the database
    await mongoose.disconnect();
    console.log('Disconnected from database');
  } catch (error) {
    console.error('Error updating image URLs:', error);
  }
}

// Only keeping this function for reference
async function updateAccountIds() {
  try {
    // Connect to MongoDB
    console.log('Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to database');

    // Find all documents with the old account ID
    console.log(`Finding documents with account_id: ${OLD_ACCOUNT_ID}`);
    const result = await userHistorySchema.updateMany(
      { account_id: OLD_ACCOUNT_ID },
      { $set: { account_id: NEW_ACCOUNT_ID } }
    );

    console.log(`Updated ${result.modifiedCount} document(s) out of ${result.matchedCount} found.`);
    
    // Disconnect from the database
    await mongoose.disconnect();
    console.log('Disconnected from database');
  } catch (error) {
    console.error('Error updating account IDs:', error);
  }
}

// Run the update function for image URLs only
updateImageUrls(); 