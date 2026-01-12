const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { connectDB } = require('@read-ai/shared-config');
const multer = require('multer');
const mammoth = require('mammoth');
const crypto = require('crypto');

const logger = require('../utilities/logger');

const PORT = process.env.ORCHESTRATOR_PORT || 3000;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL;

if (!MCP_SERVER_URL) {
  throw new Error("MCP_SERVER_URL is not defined in Environment Variables");
}

const app = express();
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// --- DOCUMENT PROCESSING FUNCTION ---
const extractTextFromFile = async (file, traceId) => {
    const fileExtension = file.originalname.split('.').pop().toLowerCase();
    const buffer = file.buffer;

    logger.info(`[File Processor] Detected file type: ${fileExtension}`, { traceId });

    switch (fileExtension) {
        case 'txt':
            return buffer.toString('utf8');
        case 'docx':
            try {
                const result = await mammoth.extractRawText({ buffer: buffer });
                return result.value;
            } catch (e) {
                throw new Error(`DOCX Parsing Failed: ${e.message}`);
            }
        case 'pdf': 
            throw new Error("PDF support coming soon. Please use .txt or .docx");
        default:
            throw new Error(`Unsupported file type: .${fileExtension}`);
    }
};

// --- API ENDPOINT ---
app.post('/api/v1/transcript', upload.single('transcriptFile'), async (req, res) => {
    
    // 1. Generate Trace ID (The birth of the request!)
    const traceId = crypto.randomUUID();

    if (!req.file) {
        logger.warn("Upload attempted without file.", { traceId });
        return res.status(400).send({ message: "File required ('transcriptFile')." });
    }

    const source = req.body.source || 'file-upload'; 
    const source_id = req.body.source_id || new Date().toISOString();
    const meeting_title = req.body.meeting_title || req.file.originalname;
    
    // Safe Parse Participants
    let participants = [];
    if (req.body.participants) {
        try { participants = JSON.parse(req.body.participants); } 
        catch (e) { logger.warn("Failed to parse participants JSON", { traceId }); }
    }

    try {
        // 2. Extract Text
        const rawTranscript = await extractTextFromFile(req.file, traceId);
        
        if (!rawTranscript || rawTranscript.trim().length < 50) {
            throw new Error("Extracted text is empty or too short (<50 chars).");
        }

        logger.info(`Pipeline started for: "${meeting_title}" (${rawTranscript.length} chars)`, { traceId });

        // 3. Send to MCP Server (OPTIMIZED)
        // We only call /process-transcript. It handles normalization internally.
        // Critically: We pass 'trace_id' so logs connect across services!
        const response = await axios.post(
            `${MCP_SERVER_URL}/api/v1/process-transcript`, 
            {
                trace_id: traceId, 
                transcript: rawTranscript,
                source,
                source_id,
                meeting_title,
                participants,
                raw_transcript: rawTranscript
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 300000 // 5 minutes
            }
        );

        logger.info("Pipeline initiated successfully.", { traceId });

        // 4. Respond to Client
        res.status(202).send({ 
            message: 'Transcript accepted and processing pipeline initiated.',
            trace_id: traceId,
            status: 'processing'
        });

    } catch (error) {
        // If axios error, extract the real message
        const status = error.response?.status || 500;
        const msg = error.response?.data?.error || error.message;
        
        // Logger sends this to Slack automatically!
        await logger.error("Orchestrator Pipeline Failed", error, { traceId });
        
        res.status(status).send({ 
            message: `Pipeline failed: ${msg}`,
            trace_id: traceId 
        });
    }
});

// Start Server
const startServer = async () => {
    await connectDB();
    app.listen(PORT, "0.0.0.0", () => {
        // Use console.log for startup as logger might rely on connection
        console.log(`🚀 Orchestrator Service running on port ${PORT}`);
    });
};

startServer();