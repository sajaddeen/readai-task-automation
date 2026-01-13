const express = require('express');
const axios = require('axios');
const { connectDB } = require('@read-ai/shared-config');
const multer = require('multer');
const mammoth = require('mammoth');
const crypto = require('crypto');
const logger = require('./utilities/logger'); 

const PORT = process.env.ORCHESTRATOR_PORT || 3000;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL; // e.g., http://localhost:3001

if (!MCP_SERVER_URL) throw new Error("MCP_SERVER_URL is missing.");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Increase limit because Read AI payloads are large
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- 1. SHARED PIPELINE (Calls your MCP Server) ---
const runPipeline = async (data, res) => {
    const { traceId, transcript, source, source_id, meeting_title, participants } = data;
    try {
        logger.info(`[Pipeline] Forwarding to MCP: "${meeting_title}"`, { traceId });

        // This calls your EXISTING Slack Bot logic
        await axios.post(`${MCP_SERVER_URL}/api/v1/process-transcript`, {
            trace_id: traceId,
            transcript: transcript, // Clean text
            source: source,
            source_id: source_id,
            meeting_title: meeting_title,
            participants: participants
        });

        res.status(200).send({ message: 'Pipeline started.' });
    } catch (error) {
        logger.error("Pipeline Failed", error.message, { traceId });
        res.status(500).send({ error: error.message });
    }
};

// --- 2. HELPER: CONVERT READ AI JSON TO TEXT ---
const parseReadAIPayload = (body) => {
    // Check if it's actually Read AI data
    if (!body.transcript || !body.transcript.speaker_blocks) {
        throw new Error("Invalid Read AI Payload");
    }

    // Convert structured blocks to simple "Speaker: Text" format
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

// --- 3. THE WEBHOOK ENDPOINT ---
app.post('/api/v1/webhook', async (req, res) => {
    const traceId = crypto.randomUUID();
    
    // A. DETECT READ AI (Trigger: "meeting_end")
    if (req.body.trigger === "meeting_end") {
        logger.info("⚡ Detected Read AI Webhook", { traceId });
        try {
            const data = parseReadAIPayload(req.body);
            await runPipeline({ ...data, traceId, source: "read_ai" }, res);
        } catch (err) {
            logger.error("Read AI Parse Error", err.message, { traceId });
            res.status(400).send({ error: "Invalid Read AI Data" });
        }
        return;
    }

    // B. STANDARD WEBHOOK (Fallback)
    logger.info("Standard Webhook received", { traceId });
    if (!req.body.transcript) return res.status(400).send({ error: "Missing transcript" });

    await runPipeline({
        traceId,
        transcript: req.body.transcript,
        source: "webhook",
        source_id: req.body.email || "anonymous",
        meeting_title: req.body.meeting_title || "Webhook Upload",
        participants: []
    }, res);
});

// --- 4. FILE UPLOAD ENDPOINT (Legacy) ---
app.post('/api/v1/transcript', upload.single('transcriptFile'), async (req, res) => {
    const traceId = crypto.randomUUID();
    if (!req.file) return res.status(400).send({ message: "No file provided" });

    try {
        let rawText = "";
        if (req.file.originalname.endsWith('.docx')) {
            const result = await mammoth.extractRawText({ buffer: req.file.buffer });
            rawText = result.value;
        } else {
            rawText = req.file.buffer.toString('utf8');
        }

        await runPipeline({
            traceId,
            transcript: rawText,
            source: "file-upload",
            source_id: req.body.email || "user_upload",
            meeting_title: req.body.meeting_title || req.file.originalname,
            participants: []
        }, res);

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