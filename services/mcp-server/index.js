const express = require('express');
const bodyParser = require('body-parser');
const { connectDB } = require('@read-ai/shared-config');
const mongoose = require('mongoose');
const { Client } = require('@notionhq/client');
const { WebClient } = require('@slack/web-api');
const crypto = require('crypto');
const axios = require('axios');
const { simplifyAnyPage } = require('../utilities/notionHelper');
const { findBestDatabaseMatch } = require('../utilities/dbFinder');

// IMPORTANT: We rely on the global mongoose instance exported from shared-config
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

const SLACK_CHANNEL = process.env.SLACK_APPROVAL_CHANNEL;
const NOTION_TASK_DB_ID = process.env.NOTION_TASK_DB_ID;
const PORT = process.env.MCP_PORT || 3001;
const app = express();

console.log(`[Config Check] OpenAI API Key is loaded: ${!!process.env.OPENAI_API_KEY}`); 

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true })); 


// --- AI AGENT 1: TRANSCRIPT NORMALIZATION (LIVE) ---

const normalizeTranscript = async (transcript, initialData) => {
    
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        throw new Error("OpenAI API Key is missing from environment variables.");
    }
    
    // Schema definition (matches the updated Mongoose Schema)
   const jsonFormatSchema = {
  "transcript_id": crypto.randomBytes(16).toString("hex"),
  "source": initialData.source,
  "source_id": initialData.source_id,
  "meeting_title": initialData.meeting_title,
  "created_at": new Date().toISOString(),
  "start_time": new Date(Date.now() - 3600000).toISOString(),

  "participants": [
    {
      "name": "string",
      "email": "string",
      "role": "string"
    }
  ],

  "summary": {
    "generated_at": new Date().toISOString(),
    "key_points": ["string"],
    "action_items_count": "number",
    "decisions_count": "number"
  },

  "extracted_entities": {
    "dates": ["string"],
    "people": ["string"],
    "decisions": ["string"],

    "projects": [
      {
        "project_name": "Island Way | Ridge Oak | Unknown",

        "tasks": [
          {
            "task_title": "string",
            "proposal_type": "Create new Task | Update existing Task",
            "linked_jtbd": {
              "name": "string",
              "url": "string"
            },
            "owner": "string",
            "status": "In progress | Done | To do",
            "priority_level": "High | Medium | Low",
            "source": "Virtual Meeting",
            "focus_this_week": "Yes | No",
            "notes": "2–4 sentence paragraph explaining action, context, dependencies, next step"
          }
        ],

        "associated_decisions": ["string"]
      }
    ]
  },

  "source_specific": {},

  "quality_metrics": {
    "transcription_accuracy": 0.95,
    "normalization_confidence": "number"
  }
};

    
const prompt = `
You are an expert task-extraction AI working for Prouvé projects.
Your responsibility is to analyze a meeting transcript and extract
CLEAR, ACTIONABLE, REVIEW-READY task proposals.

CRITICAL RULES:
- You are in PROPOSE-ONLY MODE
- Do NOT assume tasks are approved
- Do NOT create or update anything
- Every task must belong to EXACTLY ONE project
- Supported projects: Island Way, Ridge Oak
- If unsure of project → choose the MOST LIKELY one

TASK QUALITY REQUIREMENTS:
- Task titles must be concise and outcome-focused
- Notes must be 2–4 complete sentences
- Notes must explain:
  1) What needs to be done
  2) Why it matters
  3) Any dependencies or blockers
  4) The next concrete step

DUPLICATE AWARENESS:
- If a task sounds like it already exists, mark it as:
  "proposal_type": "Update existing Task"
- Otherwise use:
  "proposal_type": "Create new Task"

JTBD LINKING:
- ALWAYS attempt to link an existing JTBD
- Provide BOTH name and URL
- If unknown, use:
  { "name": "TBD", "url": "TBD" }

OWNER ASSIGNMENT:
- Infer the most logical owner from participants
- If unclear, assign "Unassigned"

OUTPUT REQUIREMENTS:
- Output MUST be VALID JSON
- MUST strictly follow the provided schema
- DO NOT add commentary or explanations outside JSON
- DO NOT omit required fields
- Participants MUST be an array of objects

SPECIAL INSTRUCTION:
Every extracted task MUST appear under:
extracted_entities.projects[].tasks[]

Transcript:
${transcript}

Output JSON Schema:
${JSON.stringify(jsonFormatSchema)}
`;


    try {
        console.log("--- RAW TRANSCRIPT SENT TO AI ---");
        console.log("-----------------------------------");
        console.log('  -> Sending request to OpenAI for normalization via native fetch...');
        
        const fetchResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`, 
            },
            body: JSON.stringify({
                model: "gpt-5.2",
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" }
            }),
        });

        if (!fetchResponse.ok) {
            const errorText = await fetchResponse.text();
            throw new Error(`OpenAI API Error: ${fetchResponse.status} - ${errorText}`);
        }

        const completion = await fetchResponse.json();
        if (!completion || !completion.choices || completion.choices.length === 0 || !completion.choices[0].message.content) {
             throw new Error("OpenAI returned an empty or invalid completion object structure.");
        }
        
        const normalizedJson = JSON.parse(completion.choices[0].message.content);
        
        normalizedJson.transcript_id = jsonFormatSchema.transcript_id;
        normalizedJson.created_at = jsonFormatSchema.created_at;
        normalizedJson.start_time = jsonFormatSchema.start_time;

        return normalizedJson;

    } catch (error) {
        console.error("OpenAI Normalization Error:", error.message);
        throw new Error(`Failed to normalize transcript with AI Agent. Error: ${error.message}`);
    }
};

// --- STEP 3: NOTION QUERY HANDLER ---

const queryNotionDB = async (extractedProjects) => {
    if (!NOTION_TASK_DB_ID || !process.env.NOTION_API_KEY) {
        console.warn("\n⚠️ NOTION KEYS MISSING: Skipping Notion DB query.");
        return { existing_tasks: [] };
    }

    const projectNames = extractedProjects.map(p => p.project_name).filter(Boolean);
    
    if (projectNames.length === 0) {
        return { existing_tasks: [] };
    }

    const projectFilters = projectNames.map(name => ({
        property: 'Project',
        rich_text: {
            contains: name
        }
    }));
    
    const filter = {
        or: projectFilters
    };

    console.log(`\n[Notion] Querying database for ${projectNames.length} project(s)...`);
    
    try {
        const response = await notion.dataSources.query({
            database_id: NOTION_TASK_DB_ID,
            filter: filter,
            properties: ['Title', 'Status', 'Project'], 
        });

        const existingTasks = response.results.map(page => ({
            task_id: page.id,
            title: page.properties.Title?.title[0]?.plain_text || 'No Title',
            project: page.properties.Project?.rich_text[0]?.plain_text || 'Unassigned',
            status: page.properties.Status?.select?.name || 'Unknown',
            action: 'UPDATE', 
        }));

        console.log(`  -> Found ${existingTasks.length} existing task(s) in Notion.`);
        return { existing_tasks: existingTasks };

    } catch (error) {
        console.error('NOTION DB QUERY ERROR:', error.message);
        return { existing_tasks: [] };
    }
};

// --- NOTION/SLACK HANDLERS (Simplified/Mocked) ---

const updateNotionDB = async (taskList) => {
    console.log(`\n[Notion] Mock: Updating database with ${taskList.length} tasks...`);
};

// --- AI AGENT 2 (STEP 4): TASK GENERATION/COMPARISON ---

const generateTaskList = async (normalizedData, notionContext) => {
    
    // 1. Flatten the hierarchical AI-extracted tasks into a single list
    const allAIExtractedTasks = normalizedData.extracted_entities.projects.flatMap(p => 
        p.tasks.map(taskTitle => ({
            title: taskTitle,
            project: p.project_name,
            transcript_id: normalizedData.transcript_id
        }))
    );
    
    const taskList = [];

    // 2. Identify and mark New Tasks
    for (const aiTask of allAIExtractedTasks) {
        // Check if a similar task title exists in the Notion context
        const existingNotionTask = notionContext.existing_tasks.find(notionTask => 
            // Simple string matching for title similarity
            notionTask.title.toLowerCase().includes(aiTask.title.toLowerCase()) || 
            aiTask.title.toLowerCase().includes(notionTask.title.toLowerCase())
        );

        if (existingNotionTask) {
            // Task already exists (Match Found)
            // ACTION: UPDATE - Preserve the existing status from Notion
            taskList.push({
                ...existingNotionTask,
                update_details: `Mentioned again in meeting: ${normalizedData.meeting_title}. Current Status: ${existingNotionTask.status}`,
                action: 'UPDATE',
                transcript_id: normalizedData.transcript_id
            });

            // Remove it from the existing_tasks list so we don't process it twice
            notionContext.existing_tasks = notionContext.existing_tasks.filter(
                t => t.task_id !== existingNotionTask.task_id
            );

        } else {
            // Task is brand new (No Match Found)
            // ACTION: CREATE - Assign a default 'To Do' status
            taskList.push({
                temp_id: crypto.randomBytes(4).toString('hex'),
                title: aiTask.title,
                project: aiTask.project,
                description: `ACTION ITEM from meeting: ${normalizedData.meeting_title}.`,
                action: 'CREATE',
                status: 'To do', // Default status for new tasks
                transcript_id: aiTask.transcript_id
            });
        }
    }
    
    console.log(`  -> Generated Task List: ${taskList.filter(t => t.action === 'CREATE').length} new, ${taskList.filter(t => t.action === 'UPDATE').length} updates.`);
    return taskList;
};


// --- SLACK FUNCTIONS ---

const formatTasksForSlack = (taskList, meetingTitle) => {
    // ... (unchanged)
    const newTasksCount = taskList.filter(t => t.action === 'CREATE').length;
    const existingTasksCount = taskList.filter(t => t.action === 'UPDATE').length;
    
    // Summary text logic
    const summaryText = taskList
        .slice(0, 5)
        .map(t => `• *${t.action}*: ${t.title} (${t.project || 'Unassigned'}) - Status: ${t.status || 'N/A'}`)
        .join('\n');

    return [
        {
            type: "header",
            text: { type: "plain_text", text: `📝 Tasks Proposed from Meeting: ${meetingTitle}`, }
        },
        {
            type: "section",
            text: { type: "mrkdwn", text: `The AI agent identified *${newTasksCount} new task(s)* and *${existingTasksCount} existing task(s)* requiring review.`, }
        },
        {
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: { type: "plain_text", text: "Review Tasks", emoji: true },
                    style: "primary",
                    value: JSON.stringify({ action: "review_tasks", transcript_id: taskList[0]?.transcript_id || "unknown" }),
                    action_id: "open_task_review_modal"
                }
            ]
        }
    ];
};

const sendToSlackForApproval = async (taskList, meetingTitle) => {
    if (!SLACK_CHANNEL || !process.env.SLACK_BOT_TOKEN) {
        console.warn("\n⚠️ SLACK KEYS MISSING: Skipping Slack message send.");
        return;
    }
    console.log(`[Slack] Mock: Sent ${taskList.length} tasks for review to ${SLACK_CHANNEL}`);
};

// --- NOTION: LIST ALL DATABASES ---

const listAllNotionDatabases = async () => {
    try {
        console.log("\n[Notion] Listing all databases via Search API...");

        let allDBs = [];
        let cursor = undefined;

        do {
            const response = await notion.search({
                query: "", // empty to list everything
                filter: {
                    property: "object",
                    value: "data_source"
                },
                start_cursor: cursor,
                page_size: 100
            });

            if (response.results) {
                response.results.forEach(item => {
                    allDBs.push({
                        id: item.id,
                        title: item.title?.map(t => t.plain_text).join("") || "(No title)",
                        object: item.object
                    });
                });
            }

            cursor = response.has_more ? response.next_cursor : undefined;
        } while (cursor);

        console.log(`[Notion] Found ${allDBs.length} databases:`, allDBs);
        return allDBs;

    } catch (error) {
        console.error("[Notion] Failed to list databases:", error.message);
        throw error;
    }
};

const fetchAllRowsInDataSource = async (data_source_id) => {
  const allPages = [];
  let cursor;

  do {
    const response = await notion.dataSources.query({
      data_source_id,
      start_cursor: cursor,
      page_size: 100
    });

    allPages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return allPages;
};

// Test route: fetch all pages in a Notion database by ID
app.get('/api/v1/notion-data-source-rows', async (req, res) => {
  try {
    const { db_id } = req.query;
    if (!db_id) {
      return res.status(400).send({ message: "Missing query param: db_id" });
    }

    const pages = await fetchAllRowsInDataSource(db_id);

    res.status(200).send({
      count: pages.length,
      pages: pages.map(simplifyAnyPage)
    });
  } catch (error) {
    console.error("Error fetching rows:", error.message);
    res.status(500).send({ error: error.message });
  }
});



app.get('/api/v1/list-notion-databases', async (req, res) => {
    try {
        const databases = await listAllNotionDatabases();
        res.status(200).send({ databases });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});


// --- MCP SERVER API ENDPOINTS ---

app.post('/api/v1/slack-interaction', async (req, res) => {
    res.status(200).send({ message: "Mock interaction received." });
});


app.post('/api/v1/slack-approved-tasks', async (req, res) => {
    const approvedTasks = req.body.tasks; 
    
    if (!approvedTasks || approvedTasks.length === 0) {
        return res.status(400).send({ message: "No tasks provided for update." });
    }
    try {
        await updateNotionDB(approvedTasks);
        res.status(200).send({ message: 'Notion database updated based on Slack approval.' });
    } catch (error) {
        console.error('Failed to process approved tasks:', error.message);
        res.status(500).send({ message: 'Failed to update Notion DB.' });
    }
});


app.post('/api/v1/normalize', async (req, res) => {
    const { transcript, source, source_id, meeting_title, participants, raw_transcript } = req.body; 
    
    if (!transcript) {
        return res.status(400).send({ message: "Transcript is required for normalization." });
    }

    try {
        const initialData = { source, source_id, meeting_title, participants };
        
        const normalizedJson = await normalizeTranscript(transcript, initialData);

        // --- DB Saving ---
        const TranscriptModel = mongoose.model('NormalizedTranscript');
        
        const transcriptDocument = {
            transcript_id: normalizedJson.transcript_id,
            source: source,
            source_id: source_id,
            meeting_title: meeting_title,
            participants: participants,
            raw_transcript: raw_transcript,
            normalized_data: { 
                summary: normalizedJson.summary,
                extracted_entities: normalizedJson.extracted_entities,
                quality_metrics: normalizedJson.quality_metrics,
                source_specific: normalizedJson.source_specific || {},
            }
        };

        const newTranscript = new TranscriptModel(transcriptDocument);
        await newTranscript.save();
        
        console.log(`  -> Saved normalized data to DB with ID: ${normalizedJson.transcript_id}`);

        res.status(200).send({ normalized_json: normalizedJson });
    } catch (error) {
        console.error('Normalization process failed:', error.message);
        res.status(500).send({ message: `Normalization failed: ${error.message}` });
    }
});

app.post('/api/v1/generate-tasks', async (req, res) => {
    const { normalized_data } = req.body;
    
    const extractedProjects = normalized_data.extracted_entities.projects || [];

    try {
        // STEP 3: Retrieve project data from Notion DB
        const actualNotionContext = await queryNotionDB(extractedProjects);

        // STEP 4: Generate/Compare Task List
        const taskList = await generateTaskList(normalized_data, actualNotionContext);

        await sendToSlackForApproval(taskList, normalized_data.meeting_title); 

        res.status(200).send({ message: 'Task list generated and sent to Slack for approval.' });

    } catch (error) {
        console.error('Task Generation process failed:', error.message);
        res.status(500).send({ message: 'Failed to generate task list.', error: error.message });
    }
});



// full process

// ----------------- PROCESS TRANSCRIPT ENDPOINT -----------------

app.post('/api/v1/process-transcript', async (req, res) => {
  try {
    const { transcript, source, source_id, meeting_title, participants, raw_transcript } = req.body;

    if (!transcript) {
      return res.status(400).send({ error: "Transcript text is required." });
    }

    // --- 1) Normalize with GPT ---
    const normalized = await normalizeTranscript(transcript, {
      source,
      source_id,
      meeting_title,
      participants
    });

    // Get project name out of normalized data
    const projectBlock =
      normalized.extracted_entities.projects &&
      normalized.extracted_entities.projects[0];

    const projectName =
      projectBlock && projectBlock.project_name
        ? projectBlock.project_name.trim()
        : null;

    if (!projectName) {
      return res.status(400).send({ error: "No project name found in normalized data." });
    }

   // --- 2) Load all Notion databases ---
const allSources = await listAllNotionDatabases();

if (!allSources || allSources.length === 0) {
  return res.status(500).send({ error: "No Notion databases found." });
}

// --- 3) Find best matching DB using GPT ---
let chosenTitle = await findBestDatabaseMatch(projectName, allSources);

// Fallback: simple contains match
if (!chosenTitle) {
  chosenTitle = allSources.find(ds =>
    ds.title.toLowerCase().includes(projectName.toLowerCase())
  )?.title;
}

if (!chosenTitle) {
  return res.status(404).send({ error: "No matching Notion DB found." });
}

const match = allSources.find(ds => ds.title === chosenTitle);

console.log(
  `[Notion] Best DB match for project "${projectName}": "${match.title}" (ID: ${match.id})`
);

    // --- 3) Get all rows from Notion ---
    console.log(`[Notion] Fetching all rows from DB: ${match.id}`);
    const allPages = await fetchAllRowsInDataSource(match.id);

    const pages = allPages.map(simplifyAnyPage);
    console.log(`  -> Retrieved ${pages.length} pages from Notion DB.`);

    // Simplify each page (so we only use title, status, notes, url)
    const existingTasks = pages.map(page => ({
  id: page.id || "",
  title: page.task || "",           // simplified helper gives `task`
  status: page.status || "",
  notes: page.notes || "",          // if you later add notes in simplifyAnyPage
  url: `https://www.notion.so/${(page.id || "").replace(/-/g, "")}`
}));

    // --- 4) Build array of normalized proposals ---
    const proposals = normalized.extracted_entities.projects.flatMap(p =>
      p.tasks.map(t => ({
        title: t.task_title,
        project: p.project_name,
        notes: t.notes,
        status: t.status,
      }))
    );

    // --- 5) Semantic compare with GPT for UPDATE vs CREATE ---
    const finalOutput = [];

    for (const proposal of proposals) {
      try {
        // Prompt tailored to your comparison rules
        const comparePrompt = `
You are the Prouvé Sync Manager.
Compare the following task proposal:

${JSON.stringify(proposal)}

Against these existing Notion tasks:

${JSON.stringify(existingTasks)}

Return ONLY a JSON object with exactly this schema:
{
  "display_line": "string",
  "action": "CREATE | UPDATE",
  "notion_url": "string",
  "title": "string",
  "project": "string",
  "notes": "string",
  "status": "string"
}
Do not add any extra text or explanation.
`;

        // Call GPT for semantic comparison
        const gptResponse = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: "gpt-5.2",
              messages: [
                { role: "system", content: "You compare tasks." },
                { role: "user", content: comparePrompt },
              ],
              temperature: 0.0,
            }),
          }
        );

        const jsonResp = await gptResponse.json();
        const content = jsonResp.choices?.[0]?.message?.content;

        // Parse must be JSON only, no markdown
        const parsed = JSON.parse(content);

        finalOutput.push(parsed);
      } catch (err) {
        console.error("Comparison error:", err);
      }
    }

    // --- 6) Return results ---
    return res.status(200).send(finalOutput);
  } catch (error) {
    console.error("PROCESS ERROR:", error.message);
    return res.status(500).send({ error: error.message });
  }
});


// Start the server
const startServer = async () => {
    if (!NOTION_TASK_DB_ID || !process.env.NOTION_API_KEY) {
        console.warn("\n⚠️ NOTION KEYS MISSING: Notion integration will be mocked.");
    }
    
    await connectDB();
    app.listen(PORT, () => {
        console.log(`🧠 MCP Server running on port ${PORT}`);
    });
};

startServer();