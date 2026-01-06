const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { connectDB } = require('@read-ai/shared-config');
const multer = require('multer');
const mammoth = require('mammoth'); // Dependency required for DOCX

const PORT = process.env.ORCHESTRATOR_PORT || 3000;
//const MCP_SERVER_URL = `http://localhost:${process.env.MCP_PORT || 3001}`;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL;

if (!MCP_SERVER_URL) {
  throw new Error("MCP_SERVER_URL is not defined");
}


const app = express();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// FIX: Increase the Express body size limit to 50MB
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// --- DOCUMENT PROCESSING FUNCTION (DOCX & TXT) ---
const extractTextFromFile = async (file) => {
    const fileExtension = file.originalname.split('.').pop().toLowerCase();
    const buffer = file.buffer;

    console.log(`[File Processor] Detected file type: ${fileExtension}`);

    switch (fileExtension) {
        case 'txt':
            // Simple text file: direct conversion
            return buffer.toString('utf8');
            
        case 'docx':
            // DOCX file: use mammoth
            try {
                const result = await mammoth.extractRawText({ buffer: buffer });
                return result.value;
            } catch (e) {
                // If mammoth fails, throw a clear error.
                throw new Error(`DOCX Parsing Failed (mammoth error): ${e.message}`);
            }

        case 'pdf':
        case 'doc':
        case 'png':
        case 'jpg':
        case 'jpeg':
            // Throw error for unsupported file types
            throw new Error(`Only .txt and .docx files are currently supported.`);

        default:
            throw new Error(`Unsupported file type: ${fileExtension}. Please upload a .txt or .docx file.`);
    }
};


// --- ORCHESTRATOR API ENDPOINT ---

app.post('/api/v1/transcript', upload.single('transcriptFile'), async (req, res) => {
    
    if (!req.file) {
        return res.status(400).send({ message: "Transcript file upload ('transcriptFile' key) is required." });
    }

    const source = req.body.source || 'file-upload'; 
    const source_id = req.body.source_id || new Date().toISOString();
    const meeting_title = req.body.meeting_title || req.file.originalname;

    let participants = [];
    try {
        if (req.body.participants) {
            participants = JSON.parse(req.body.participants);
        }
    } catch (e) {
        console.error("Failed to parse participants JSON:", e);
    }
    
    let rawTranscript;
    try {
        // Use the file processing layer to get clean text
        rawTranscript = await extractTextFromFile(req.file); 
        
        if (!rawTranscript || rawTranscript.trim().length < 50) {
            throw new Error("Extracted transcript text is too short or empty. Check file content.");
        }
    } catch (error) {
        console.error('File Processing Failed:', error.message);
        return res.status(400).send({ message: `File Processing Failed: ${error.message}` });
    }
    
    console.log(`\n[Orchestrator] Pipeline started for: ${meeting_title}`);
    console.log(`[Orchestrator] Successfully extracted ${rawTranscript.length} characters of text.`);


    try {
        // --- 1. NORMALIZATION STEP (MCP Server) ---
        const normalizationResponse = await axios.post(`${MCP_SERVER_URL}/api/v1/normalize`, {
            transcript: rawTranscript, 
            source,
            source_id,
            meeting_title,
            participants,
            raw_transcript: rawTranscript, // Pass raw text for saving to DB
        });
        const normalizedData = normalizationResponse.data.normalized_json;
        console.log('-> 1. Normalization complete.');

        // --- 2. NOTION CONTEXT QUERY (THIS IS NOW HANDLED BY MCP SERVER) ---
        
        // --- 3. TASK GENERATION/APPROVAL (MCP Server) ---
        // const generationResponse = await axios.post(`${MCP_SERVER_URL}/api/v1/generate-tasks`, {
        //     normalized_data: normalizedData,
        //     // Removed notion_context: The MCP Server fetches it internally now.
        // });
        // console.log('-> 3. Task generation initiated on MCP.');

        const response = await axios.post(
            `${MCP_SERVER_URL}/api/v1/process-transcript`, 
            {
                transcript: rawTranscript,
                source,
                source_id,
                meeting_title,
                participants,
                raw_transcript: rawTranscript
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 300000
            }
        );

        const finalTasks = response.data;

        res.status(202).send({ 
            message: 'Transcript accepted and processing pipeline initiated.',
            transcript_id: normalizedData.transcript_id,
            results: finalTasks.requests || [],
        });

    } catch (error) {
        console.error('Orchestrator pipeline failed:', error.message);
        const status = error.response ? error.response.status : 500;
        const errorMessage = error.response ? error.response.data.message : 'Internal Server Error';
        res.status(status).send({ message: `Pipeline failed: ${errorMessage}` });
    }
});

// Start the server
const startServer = async () => {
    await connectDB();
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Orchestrator Service running on port ${PORT}`);
    });
};

startServer();