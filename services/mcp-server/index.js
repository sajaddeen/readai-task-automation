const express = require('express');
const bodyParser = require('body-parser');
// FIX: We no longer need the OpenAI package, only the mongoose instance and connection
const { connectDB } = require('@read-ai/shared-config');
const mongoose = require('mongoose');
const { Client } = require('@notionhq/client');
const { WebClient } = require('@slack/web-api');
const crypto = require('crypto');
const axios = require('axios');
// Ensure these utility files exist in your project structure
const { simplifyAnyPage } = require('../utilities/notionHelper');
const { findBestDatabaseMatch } = require('../utilities/dbFinder');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

const SLACK_CHANNEL = process.env.SLACK_APPROVAL_CHANNEL;
const NOTION_TASK_DB_ID = process.env.NOTION_TASK_DB_ID; // Fallback ID (Optional if dynamic works)
const PORT = process.env.MCP_PORT || 3001;
const app = express();

console.log(`[Config Check] OpenAI API Key is loaded: ${!!process.env.OPENAI_API_KEY}`); 

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true })); 


// --- NEW: SLACK MESSAGING HELPER WITH BUTTONS ---

const sendTaskListToSlack = async (taskList, meetingTitle, targetDbId) => {
    if (!SLACK_CHANNEL || !process.env.SLACK_BOT_TOKEN) {
        console.warn("\n⚠️ SLACK CONFIG MISSING: Skipping Slack notification.");
        return;
    }

    const blocks = [];

    // --- MAIN HEADER ---
    blocks.push({
        type: "header",
        text: {
            type: "plain_text",
            text: `📝 Sync Report: ${meetingTitle}`,
            emoji: true
        }
    });

    blocks.push({ type: "divider" });

    // --- GENERATE VERTICAL LIST BLOCKS (Proposal X of Y) ---
    
    // We iterate through ALL tasks to maintain the "X of Y" count
    taskList.forEach((task, index) => {
        const proposalCount = `${index + 1} of ${taskList.length}`;
        
        // Prepare Button Payload (Includes new fields)
        // CRITICAL: We pass the 'targetDbId' (which is the Data Source ID found by dbFinder)
        // into the button so the interaction handler knows where to write.
        const buttonPayload = JSON.stringify({
            ...task,
            targetDbId: targetDbId || NOTION_TASK_DB_ID,
            // Sanitize notes to fit in button payload limit (3000 chars max usually)
            notes: task.notes.length > 500 ? task.notes.substring(0, 500) + "..." : task.notes
        });

        // Format Linked JTBD (Slack Link format: <url|text>)
        const jtbdDisplay = task.linked_jtbd_url && task.linked_jtbd_url.startsWith('http') 
            ? `<${task.linked_jtbd_url}|${task.linked_jtbd}>`
            : task.linked_jtbd || "TBD";

        // Format Existing Task URL (for Updates)
        const existingTaskLine = task.action === 'UPDATE' && task.notion_url && task.notion_url !== "New Task"
            ? `*Existing task:* <${task.notion_url}|Open Notion Page>`
            : "";

        // Determine Type Label
        const typeLabel = task.action === 'CREATE' ? "Create new Task" : "Update existing Task";

        // --- THE FORMATTING MAGIC IS HERE ---
        // Matches your requested structure exactly
        const detailsText = 
`*Proposal ${proposalCount}*

*Project:* ${task.project || "Unassigned"}

*Proposal type:* ${typeLabel}
*Task title:* ${task.title}

${existingTaskLine}
*Linked JTBD:* ${jtbdDisplay}

*Owner:* ${task.owner}
*Status:* ${task.status}
*Start Date:* ${task.start_date || "—"}
*Due Date:* ${task.due_date || "—"}

*Priority Level:* ${task.priority || "Medium"}
*Source:* Virtual Meeting
*Focus This Week?:* ${task.focus_this_week || "No"}

*Notes:*
${task.notes}`;

        // 1. Add the text block
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: detailsText
            }
        });

        // 2. Action Buttons
        const btnText = task.action === 'CREATE' ? "✅ Accept & Create" : "✅ Accept & Update";
        
        blocks.push({
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: { type: "plain_text", text: btnText },
                    style: "primary",
                    action_id: "accept_task",
                    value: buttonPayload
                },
                {
                    type: "button",
                    text: { type: "plain_text", text: "⏭️ Skip" },
                    action_id: "skip_task",
                    value: "skip"
                },
                {
                    type: "button",
                    text: { type: "plain_text", text: "💬 Feedback" },
                    action_id: "feedback_task",
                    value: "feedback"
                }
            ]
        });

        blocks.push({ type: "divider" });
    });

    // Handle empty list case
    if (taskList.length === 0) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: "_No tasks identified in this transcript._" }
        });
    }

    try {
        await slackClient.chat.postMessage({
            channel: SLACK_CHANNEL,
            text: `Sync Report: ${meetingTitle}`,
            blocks: blocks
        });
        console.log(`✅ Detailed task report sent to Slack (${taskList.length} proposals).`);
    } catch (error) {
        console.error("❌ Failed to send Slack message:", error.message);
    }
};


// --- AI AGENT 1: TRANSCRIPT NORMALIZATION (LIVE) ---

const normalizeTranscript = async (transcript, initialData) => {
    
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        throw new Error("OpenAI API Key is missing from environment variables.");
    }
    
    // Schema definition - UPDATED FOR DATES AND FOCUS
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
            
            // NEW FIELDS
            "start_date": "YYYY-MM-DD or null",
            "due_date": "YYYY-MM-DD or null",
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

CRITICAL NEW RULES (DATES & FOCUS):
1. **Dates**: Extract concrete dates for 'start_date' and 'due_date' (YYYY-MM-DD). If strictly unknown, use null.
2. **Focus This Week**: Set to "Yes" ONLY if the speaker explicitly says "this week", "urgent", "immediate", or "do it now". Otherwise "No".

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
    // Note: This logic assumes a fallback to the ENV var. 
    // In the full dynamic flow (process-transcript), this function is skipped 
    // because we query directly using the dynamic ID in that endpoint.
    if (!NOTION_TASK_DB_ID || !process.env.NOTION_API_KEY) {
        return { existing_tasks: [] };
    }
    
    console.log(`\n[Notion] Querying database (Fallback)...`);
    
    try {
        const response = await notion.dataSources.query({
            data_source_id: NOTION_TASK_DB_ID,
            properties: ['Tasks', 'Status'], 
        });

        const existingTasks = response.results.map(page => ({
            task_id: page.id,
            title: page.properties.Tasks?.title[0]?.plain_text || 'No Title',
            project: 'Unassigned',
            status: page.properties.Status?.status?.name || 'Unknown',
            action: 'UPDATE', 
        }));

        console.log(`  -> Found ${existingTasks.length} existing task(s) in Notion.`);
        return { existing_tasks: existingTasks };

    } catch (error) {
        console.error('NOTION DB QUERY ERROR:', error.message);
        return { existing_tasks: [] };
    }
};

// --- AI AGENT 2 (STEP 4): TASK GENERATION/COMPARISON ---

const generateTaskList = async (normalizedData, notionContext) => {
    
    // 1. Flatten the hierarchical AI-extracted tasks into a single list
    const allAIExtractedTasks = normalizedData.extracted_entities.projects.flatMap(p => 
      p.tasks.map(t => ({
        title: t.task_title,
        project: p.project_name,
        // Use logic to handle empty AI fields with Defaults
        owner: t.owner && t.owner !== "" ? t.owner : "Unassigned", 
        priority: t.priority_level && t.priority_level !== "" ? t.priority_level : "Medium",
        linked_jtbd: t.linked_jtbd?.name && t.linked_jtbd.name !== "TBD" ? t.linked_jtbd.name : "TBD",
        proposal_type: t.proposal_type,
        notes: t.notes,
        status: t.status,
        // Pass through new fields
        start_date: t.start_date,
        due_date: t.due_date,
        focus_this_week: t.focus_this_week,
        
        transcript_id: normalizedData.transcript_id
      }))
    );
    
    const taskList = [];

    // 2. Identify and mark New Tasks
    for (const aiTask of allAIExtractedTasks) {
        const existingNotionTask = notionContext.existing_tasks.find(notionTask => 
            notionTask.title.toLowerCase().includes(aiTask.title.toLowerCase()) || 
            aiTask.title.toLowerCase().includes(notionTask.title.toLowerCase())
        );

        if (existingNotionTask) {
            // ACTION: UPDATE
            taskList.push({
                ...existingNotionTask,
                notes: aiTask.notes,
                priority: aiTask.priority, 
                owner: aiTask.owner,       
                linked_jtbd: aiTask.linked_jtbd,
                
                // Update dates/focus on existing task too
                start_date: aiTask.start_date,
                due_date: aiTask.due_date,
                focus_this_week: aiTask.focus_this_week,

                action: 'UPDATE',
                transcript_id: normalizedData.transcript_id
            });
            
            // Remove from search pool to avoid duplicates
            notionContext.existing_tasks = notionContext.existing_tasks.filter(
                t => t.task_id !== existingNotionTask.task_id
            );

        } else {
            // ACTION: CREATE
            taskList.push({
                temp_id: crypto.randomBytes(4).toString('hex'),
                title: aiTask.title,
                project: aiTask.project,
                action: 'CREATE',
                status: 'To do', 
                owner: aiTask.owner,       
                priority: aiTask.priority, 
                linked_jtbd: aiTask.linked_jtbd,
                notes: aiTask.notes,

                // New fields
                start_date: aiTask.start_date,
                due_date: aiTask.due_date,
                focus_this_week: aiTask.focus_this_week,

                transcript_id: normalizedData.transcript_id
            });
        }
    }
    
    return taskList;
};


// --- NOTION: LIST ALL DATABASES ---

const listAllNotionDatabases = async () => {
    try {
        console.log("\n[Notion] Listing all databases via Search API...");

        // FIX: Remove filter to handle Notion 2025 API changes gracefully
        const response = await notion.search({});

        let allDBs = [];
        if (response.results) {
            // Manually filter for Data Sources / Databases
            const databases = response.results.filter(item => item.object === 'database' || item.object === 'data_source');
            
            databases.forEach(item => {
                allDBs.push({
                    id: item.id,
                    title: item.title?.map(t => t.plain_text).join("") || "(No title)",
                    object: item.object
                });
            });
        }

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
    // FIX: Use 'dataSources.query' correctly
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

// --- NEW INTERACTIVE SLACK ENDPOINT (FIXED FOR DYNAMIC ID) ---
app.post('/api/v1/slack-interaction', async (req, res) => {
    try {
        const payload = JSON.parse(req.body.payload);
        const action = payload.actions[0];
        
        if (action.action_id === 'accept_task') {
            const taskData = JSON.parse(action.value);
            
            // --- DYNAMIC ID HANDLING ---
            // We use the ID that was passed in the button (from dbFinder)
            const sourceId = taskData.targetDbId || NOTION_TASK_DB_ID;

            // Helper: Build the Properties Object
            const notionProperties = {
                "Tasks": { title: [{ text: { content: taskData.title } }] },
                "Status": { status: { name: taskData.status || "To do" } },
                "Jobs": { rich_text: [{ text: { content: taskData.linked_jtbd || "" } }] },
                "Owner": { rich_text: [{ text: { content: taskData.owner || "" } }] },
                "Priority Level": { select: { name: taskData.priority || "Medium" } },
                "Source": { select: { name: "Virtual Meeting" } },
                "Notes": { rich_text: [{ text: { content: taskData.notes || "" } }] },
                "Focus This Week": { checkbox: taskData.focus_this_week === "Yes" }
            };

            if (taskData.start_date) notionProperties["Start Date"] = { date: { start: taskData.start_date } };
            if (taskData.due_date) notionProperties["Due Date"] = { date: { start: taskData.due_date } };

            // --- EXECUTE CREATE OR UPDATE ---

            if (taskData.action === 'CREATE') {
                console.log(`[Slack Action] Creating new task in Source ID: ${sourceId}`);
                
                // --- CRITICAL FIX FOR DYNAMIC ID ---
                // We MUST specify "type: 'data_source_id'" for the new API to accept the ID we found.
                await notion.pages.create({
                    parent: { 
                        type: "data_source_id", 
                        data_source_id: sourceId 
                    },
                    properties: notionProperties
                });
                
                res.status(200).json({
                    replace_original: "true",
                    text: `✅ *Created:* ${taskData.title} in Notion. \n_Focus: ${taskData.focus_this_week}_`
                });

            } else if (taskData.action === 'UPDATE') {
                // ... Update Logic ...
                let pageId = taskData.id; 
                if (!pageId && taskData.notion_url) {
                    const matches = taskData.notion_url.match(/([a-f0-9]{32})/);
                    if(matches) pageId = matches[0];
                }

                if (pageId) {
                    console.log(`[Slack Action] Updating Page ID: ${pageId}`);
                    notionProperties["Notes"] = { 
                        rich_text: [{ text: { content: (taskData.notes || "") + "\n[Updated via Slack]" } }] 
                    };

                    await notion.pages.update({
                        page_id: pageId,
                        properties: notionProperties
                    });

                    res.status(200).json({
                        replace_original: "true",
                        text: `✅ *Updated:* ${taskData.title} in Notion.`
                    });
                } else {
                     res.status(400).send("Could not determine Page ID for update.");
                }
            }

        } else if (action.action_id === 'skip_task') {
             res.status(200).json({
                replace_original: "true",
                text: `⏭️ *Skipped:* Task ignored.`
            });

        } else if (action.action_id === 'feedback_task') {
            res.status(200).json({
                replace_original: "false",
                text: `📝 Feedback noted. (Modal logic to be implemented)`
            });
        } else {
            res.status(200).send();
        }

    } catch (error) {
        console.error("Slack Interaction Error:", error.message);
        res.status(500).send("Error processing interaction");
    }
});


// ... (Legacy endpoint skipped) ...


app.post('/api/v1/normalize', async (req, res) => {
    const { transcript, source, source_id, meeting_title, participants, raw_transcript } = req.body; 
    
    if (!transcript) {
        return res.status(400).send({ message: "Transcript is required for normalization." });
    }

    try {
        const initialData = { source, source_id, meeting_title, participants };
        const normalizedJson = await normalizeTranscript(transcript, initialData);

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
        const actualNotionContext = await queryNotionDB(extractedProjects);
        const taskList = await generateTaskList(normalized_data, actualNotionContext);
        res.status(200).send({ message: 'Task list generated and sent to Slack for approval.' });
    } catch (error) {
        console.error('Task Generation process failed:', error.message);
        res.status(500).send({ message: 'Failed to generate task list.', error: error.message });
    }
});



// ----------------- PROCESS TRANSCRIPT ENDPOINT -----------------
// This is your MAIN Flow which uses Dynamic Extraction

app.post('/api/v1/process-transcript', async (req, res) => {
  try {
    const { transcript, source, source_id, meeting_title, participants, raw_transcript } = req.body;

    if (!transcript) return res.status(400).send({ error: "Transcript text is required." });

    // --- 1) Normalize with GPT ---
    const normalized = await normalizeTranscript(transcript, {
      source, source_id, meeting_title, participants
    });

    const projectBlock = normalized.extracted_entities.projects && normalized.extracted_entities.projects[0];
    const projectName = projectBlock && projectBlock.project_name ? projectBlock.project_name.trim() : null;

    if (!projectName) return res.status(400).send({ error: "No project name found in normalized data." });

   // --- 2) Load all Notion databases ---
    const allSources = await listAllNotionDatabases();
    if (!allSources || allSources.length === 0) return res.status(500).send({ error: "No Notion databases found." });

    // --- 3) DYNAMIC ID EXTRACTION (dbFinder) ---
    // This works perfectly! It finds the "Data Source ID" (e.g., ...44cc)
    let chosenTitle = await findBestDatabaseMatch(projectName, allSources);

    if (!chosenTitle) {
      chosenTitle = allSources.find(ds => ds.title.toLowerCase().includes(projectName.toLowerCase()))?.title;
    }

    if (!chosenTitle) return res.status(404).send({ error: "No matching Notion DB found." });

    const match = allSources.find(ds => ds.title === chosenTitle);

    console.log(`[Notion] Best DB match for project "${projectName}": "${match.title}" (ID: ${match.id})`);

    // --- 4) Get all rows from Notion (Dynamic Read) ---
    console.log(`[Notion] Fetching all rows from DB: ${match.id}`);
    const allPages = await fetchAllRowsInDataSource(match.id);

    const pages = allPages.map(simplifyAnyPage);
    console.log(`  -> Retrieved ${pages.length} pages from Notion DB.`);

    const existingTasks = pages.map(page => ({
        id: page.id || "",
        title: page.task || "",           
        status: page.status || "",
        notes: page.notes || "",         
        url: `https://www.notion.so/${(page.id || "").replace(/-/g, "")}`
    }));

    // --- 5) Build array of normalized proposals ---
    const proposals = normalized.extracted_entities.projects.flatMap(p =>
        p.tasks.map(t => ({
            title: t.task_title,
            project: p.project_name,
            notes: t.notes,
            status: t.status,
            owner: t.owner && t.owner !== "" ? t.owner : "Unassigned",
            priority: t.priority_level && t.priority_level !== "" ? t.priority_level : "Medium",
            linked_jtbd: t.linked_jtbd?.name || "TBD",
            start_date: t.start_date,
            due_date: t.due_date,
            focus_this_week: t.focus_this_week
        }))
    );


    // --- 6) Semantic compare with GPT for UPDATE vs CREATE ---
    const finalOutput = [];

    for (const proposal of proposals) {
      try {
       const comparePrompt = `
You are the Prouvé Sync Manager.
Decide whether the task proposal should be CREATED or UPDATED.

MATCHING RULES:
- UPDATE only if the proposal clearly refers to the SAME OUTCOME
- Match by meaning, not wording
- If multiple matches exist, choose the BEST ONE

FIELD PRESERVATION RULE:
- owner MUST be copied from proposal.owner
- priority MUST be copied from proposal.priority
- linked_jtbd MUST be copied from proposal.linked_jtbd
- start_date MUST be copied from proposal.start_date
- due_date MUST be copied from proposal.due_date
- focus_this_week MUST be copied from proposal.focus_this_week

STRICT OUTPUT RULES:
- If UPDATE:
  - notion_url MUST be copied EXACTLY from the matched existing task
  - status MUST come from the matched existing task
- If CREATE:
  - notion_url MUST be exactly "New Task"
  - status MUST come from proposal.status

TASK PROPOSAL:
${JSON.stringify(proposal)}

EXISTING NOTION TASKS:
${JSON.stringify(existingTasks)}

RETURN ONLY VALID JSON.
`;

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
                { role: "system", content: "You compare tasks and return strict JSON only." },
                { role: "user", content: comparePrompt }
              ],
              temperature: 0,
              response_format: { type: "json_object" } 
            }),
          }
        );

        const jsonResp = await gptResponse.json();
        const content = jsonResp.choices?.[0]?.message?.content;
        const parsed = JSON.parse(content);
        finalOutput.push(parsed);
      } catch (err) {
        console.error("Comparison error:", err);
      }
    }


    // --- 7) SEND TO SLACK WITH DYNAMIC ID ---
    // We pass 'match.id' here. This is the extracted Data Source ID.
    // This ID flows into the Slack button, and then back to the Interaction Handler.
    await sendTaskListToSlack(finalOutput, meeting_title || "Virtual Meeting", match.id);

    return res.status(200).send(finalOutput);
  } catch (error) {
    console.error("PROCESS ERROR:", error.message);
    return res.status(500).send({ error: error.message });
  }
});


// Start the server
const startServer = async () => {
    // We still connect to DB, but we rely on dynamic ID finding for Notion
    await connectDB();
    app.listen(PORT, () => {
        console.log(`🧠 MCP Server running on port ${PORT}`);
    });
};

startServer();