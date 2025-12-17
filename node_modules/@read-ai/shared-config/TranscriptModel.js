const mongoose = require('mongoose');

// --- NEW SCHEMA DEFINITION FOR HIERARCHICAL PROJECTS ---
const ProjectSchema = new mongoose.Schema({
    project_name: { type: String, required: true }, 
    tasks: [mongoose.Schema.Types.Mixed], 
    associated_decisions: [String], 
}, { _id: false });

// --- Define Sub-Schemas (for nested documents) ---

// FIX: Update EntitySchema to use the new ProjectSchema structure
const EntitySchema = new mongoose.Schema({
    dates: [String],
    people: [String],
    decisions: [String],

    // FIX: Use the new hierarchical schema for projects
    projects: [ProjectSchema], 
}, { _id: false });

const SummarySchema = new mongoose.Schema({
    generated_at: { type: Date, default: Date.now },
    key_points: [String],
    action_items_count: Number,
    decisions_count: Number,
}, { _id: false });

const QualityMetricsSchema = new mongoose.Schema({
    transcription_accuracy: Number,
    normalization_confidence: Number,
}, { _id: false });


// Define Main Schema
const TranscriptSchema = new mongoose.Schema({
    transcript_id: { type: String, required: true, unique: true },
    source: { type: String, required: true },
    source_id: { type: String, required: true },
    meeting_title: { type: String, required: true },
    created_at: { type: Date, default: Date.now },
    start_time: Date,
    participants: [
        {
            name: String,
            email: String,
            role: String,
        },
    ],
    raw_transcript: { type: String, required: true }, 

    normalized_data: {
        summary: SummarySchema,
        extracted_entities: EntitySchema,
        source_specific: mongoose.Schema.Types.Mixed,
        quality_metrics: QualityMetricsSchema,
    }
}, { timestamps: true });


// 1. Export the Schema Name
const MODEL_NAME = 'NormalizedTranscript';

// 2. Register or Retrieve the Model
const NormalizedTranscript = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, TranscriptSchema);

// 3. Export connection function and the model
module.exports = {
    NormalizedTranscript,
    TranscriptSchema,
    mongoose, 
};