const express = require('express');
const axios = require('axios');
const { connectDB } = require('@read-ai/shared-config');
const multer = require('multer');
const mammoth = require('mammoth');
const crypto = require('crypto');
const logger = require('../utilities/logger'); 

const PORT = process.env.ORCHESTRATOR_PORT || 3000;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL;

if (!MCP_SERVER_URL) throw new Error("MCP_SERVER_URL is missing.");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- 1. PIPELINE RUNNER (Modified for Background Processing) ---
// Note: We removed 'res' from arguments because we don't send the response here anymore
const runPipelineBackground = async (data) => {
    const { traceId, transcript, source, source_id, meeting_title, participants } = data;
    try {
        logger.info(`[Pipeline] Background processing started: "${meeting_title}"`, { traceId });

        // Forward to MCP (The heavy lifting)
        await axios.post(`${MCP_SERVER_URL}/api/v1/process-transcript`, {
            trace_id: traceId,
            transcript: transcript,
            source: source,
            source_id: source_id,
            meeting_title: meeting_title,
            participants: participants
        });

        logger.info(`[Pipeline] ✅ Successfully handed off to MCP`, { traceId });

    } catch (error) {
        // Log detailed error info to fix the "undefined" issue
        const errMsg = error.response?.data?.error || error.message;
        logger.error(`[Pipeline] ❌ Failed: ${errMsg}`, { traceId });
    }
};

// --- 2. HELPER: PARSE READ AI JSON ---
const parseReadAIPayload = (body) => {
    if (!body.transcript || !body.transcript.speaker_blocks) {
        throw new Error("Invalid Read AI Payload: Missing speaker_blocks");
    }
    const textTranscript = body.transcript.speaker_blocks
        .map(block => `${block.speaker?.name || "Unknown"}: ${block.words}`)
        .join("\n");

    return {
        transcript: textTranscript,
        meeting_title: body.title || "Read AI Meeting",
        source_id: body.owner?.email || "read_ai_webhook",
        participants: body.participants || []
    };
};

// --- 3. WEBHOOK ENDPOINT (Async/Non-Blocking) ---
app.post('/api/v1/webhook', async (req, res) => {
    const traceId = crypto.randomUUID();
    
    // A. DETECT READ AI
    if (req.body.trigger === "meeting_end") {
        logger.info("⚡ Detected Read AI Webhook", { traceId });
        
        // Step 1: Reply to Read AI IMMEDIATELY
        // This stops them from timing out and disconnecting
        res.status(200).send({ status: "received" });

        // Step 2: Process in Background
        try {
            const data = parseReadAIPayload(req.body);
            // Run without 'await' blocking the response
            runPipelineBackground({ ...data, traceId, source: "read_ai" });
        } catch (err) {
            logger.error("Read AI Parse Error", err.message, { traceId });
        }
        return;
    }

    // B. STANDARD WEBHOOK
    if (!req.body.transcript) return res.status(400).send({ error: "Missing transcript" });
    
    // Reply immediately
    res.status(200).send({ status: "received", trace_id: traceId });

    // Process in background
    runPipelineBackground({
        traceId,
        transcript: req.body.transcript,
        source: "webhook",
        source_id: req.body.email || "anonymous",
        meeting_title: req.body.meeting_title || "Webhook Upload",
        participants: []
    });
});

// --- 4. FILE UPLOAD ENDPOINT (Legacy) ---
app.post('/api/v1/transcript', upload.single('transcriptFile'), async (req, res) => {
    const traceId = crypto.randomUUID();
    if (!req.file) return res.status(400).send({ message: "No file provided" });

    // For file uploads (User Interface), users usually WANT to wait for confirmation.
    // So we keep this synchronous (awaiting the result), unlike the webhook.
    try {
        let rawText = "";
        if (req.file.originalname.endsWith('.docx')) {
            const result = await mammoth.extractRawText({ buffer: req.file.buffer });
            rawText = result.value;
        } else {
            rawText = req.file.buffer.toString('utf8');
        }
        
        // Notify user we are starting
        logger.info(`[Upload] Processing file: ${req.file.originalname}`, { traceId });

        // Run Logic
        await runPipelineBackground({
            traceId,
            transcript: rawText,
            source: "file-upload",
            source_id: req.body.email || "user_upload",
            meeting_title: req.body.meeting_title || req.file.originalname,
            participants: []
        });

        // Reply Success
        res.status(200).send({ message: "File processed successfully", trace_id: traceId });

    } catch (err) {
        logger.error("File Upload Error", err.message, { traceId });
        res.status(500).send({ error: err.message });
    }
});

const startServer = async () => {
    await connectDB();
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Orchestrator running on port ${PORT}`);
    });
};

startServer();