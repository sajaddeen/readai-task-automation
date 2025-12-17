const mongoose = require('mongoose');
const path = require('path');
// Load environment variables from the root .env file
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') }); 

const NormalizedTranscript = require('./TranscriptModel');

const connectDB = async () => {
    try {
        const mongoUri = process.env.MONGO_URI;
        if (!mongoUri) {
            throw new Error("MONGO_URI is not defined in the environment variables.");
        }
        await mongoose.connect(mongoUri);
        console.log('MongoDB connected successfully.');
    } catch (err) {
        console.error('MongoDB connection error:', err.message);
        process.exit(1); 
    }
};

module.exports = { 
    connectDB,
    NormalizedTranscript 
};