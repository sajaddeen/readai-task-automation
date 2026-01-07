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
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const SLACK_CHANNEL = process.env.SLACK_APPROVAL_CHANNEL;
const NOTION_TASK_DB_ID = process.env.NOTION_TASK_DB_ID; // Fallback ID
const PORT = process.env.MCP_PORT || 3001;
const app = express();

console.log(`[Config Check] OpenAI API Key is loaded: ${!!process.env.OPENAI_API_KEY}`); 

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true })); 


// --- NEW: SLACK MESSAGING HELPER WITH BUTTONS ---

// --- UPDATED: SLACK MESSAGE WITH VERTICAL LIST FORMAT ---
const sendTaskListToSlack = async (taskList, meetingTitle, targetDbId) => {
    if (!SLACK_CHANNEL || !process.env.SLACK_BOT_TOKEN) {
        console.warn("\n⚠️ SLACK CONFIG MISSING: Skipping Slack notification.");
        return;
    }

    const newTasks = taskList.filter(t => t.action === 'CREATE');
    const updateTasks = taskList.filter(t => t.action === 'UPDATE');

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

    // --- HELPER: GENERATE VERTICAL LIST BLOCKS ---
    const generateTaskBlocks = (task) => {
        const taskBlocks = [];
        
        // Prepare Button Payload
        const buttonPayload = JSON.stringify({
            ...task,
            targetDbId: targetDbId || NOTION_TASK_DB_ID,
            notes: task.notes.length > 500 ? task.notes.substring(0, 500) + "..." : task.notes
        });

        const typeLabel = task.action === 'CREATE' ? "Create new Task" : "Update existing Task";

        // --- THE FORMATTING MAGIC IS HERE ---
        // We use \n for new lines. We add \n\n before Notes to give it breathing room.
        const detailsText = 
`*Proposal type:* ${typeLabel}
*Task title:* ${task.title}
*Linked JTBD:* ${task.linked_jtbd || "TBD"}
*Owner:* ${task.owner}
*Status:* ${task.status}
*Priority Level:* ${task.priority || "Medium"}
*Source:* Virtual Meeting

*Notes:* ${task.notes}`;

        // 1. Add the text block
        taskBlocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: detailsText
            }
        });

        // 2. Action Buttons
        const btnText = task.action === 'CREATE' ? "✅ Accept & Create" : "✅ Accept & Update";
        
        taskBlocks.push({
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

        // 3. Link for updates (Separate line at bottom)
        if (task.action === 'UPDATE' && task.notion_url && task.notion_url !== "New Task") {
            taskBlocks.push({
                type: "context",
                elements: [
                    { type: "mrkdwn", text: `🔗 <${task.notion_url}|Open Original Notion Page>` }
                ]
            });
        }

        taskBlocks.push({ type: "divider" });
        return taskBlocks;
    };

    // --- RENDER THE BLOCKS ---

    if (newTasks.length > 0) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `*✨ PROPOSED NEW TASKS (${newTasks.length})*` }
        });
        newTasks.forEach(task => blocks.push(...generateTaskBlocks(task)));
    }

    if (updateTasks.length > 0) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `*🔄 UPDATES TO EXISTING TASKS (${updateTasks.length})*` }
        });
        updateTasks.forEach(task => blocks.push(...generateTaskBlocks(task)));
    }

    if (newTasks.length === 0 && updateTasks.length === 0) {
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
        console.log(`✅ Detailed task report sent to Slack.`);
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

// --- AI AGENT 2 (STEP 4): TASK GENERATION/COMPARISON ---

// --- UPDATED: CAPTURE EXTRA FIELDS (Owner, Priority, JTBD) ---
// --- UPDATED: GENERATE TASK LIST (With Fallbacks for Missing Data) ---
const generateTaskList = async (normalizedData, notionContext) => {
    
    // 1. Flatten the hierarchical AI-extracted tasks into a single list
    const allAIExtractedTasks = normalizedData.extracted_entities.projects.flatMap(p => 
      p.tasks.map(t => ({
        title: t.task_title,
        project: p.project_name,
        // Use logic to handle empty AI fields
        owner: t.owner && t.owner !== "" ? t.owner : "Unassigned", 
        priority: t.priority_level && t.priority_level !== "" ? t.priority_level : "Medium",
        linked_jtbd: t.linked_jtbd?.name && t.linked_jtbd.name !== "TBD" ? t.linked_jtbd.name : "TBD",
        proposal_type: t.proposal_type,
        notes: t.notes,
        status: t.status,
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
                priority: aiTask.priority, // Pass the priority
                owner: aiTask.owner,       // Pass the owner
                linked_jtbd: aiTask.linked_jtbd,
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
                owner: aiTask.owner,       // Pass the owner
                priority: aiTask.priority, // Pass the priority
                linked_jtbd: aiTask.linked_jtbd,
                notes: aiTask.notes,
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

// --- REPLACED: NEW INTERACTIVE SLACK ENDPOINT ---
app.post('/api/v1/slack-interaction', async (req, res) => {
    try {
        // Slack sends the payload as a stringified JSON inside 'payload' body param
        const payload = JSON.parse(req.body.payload);
        const action = payload.actions[0];
        
        // IMPORTANT: Slack expects a 200 OK immediately, or it shows an error to user.
        // We will do the work, then send a response URL update if needed, but for now lets just await the work.
        
        if (action.action_id === 'accept_task') {
            const taskData = JSON.parse(action.value); // Recover the full data we hid in the button
            const dbId = taskData.targetDbId || NOTION_TASK_DB_ID;

            if (taskData.action === 'CREATE') {
                // Perform Notion CREATE
                console.log(`[Slack Action] Creating new task in Notion DB: ${dbId}`);
                await notion.pages.create({
                    parent: { database_id: dbId },
                    properties: {
                        // 1. Tasks
                        "Tasks": { 
                            tasks: [{ text: { content: taskData.tasks } }] 
                        },
                        
                        // 2. Status
                        "Status": { 
                            status: { name: taskData.status || "To do" } 
                        },
                        
                        // 3. Project
                        "Project": { 
                            rich_text: [{ text: { content: taskData.project || "General" } }] 
                        },
                        
                        // 4. Linked JTBD
                        "Jobs": { 
                            rich_text: [{ text: { content: taskData.linked_jtbd || "" } }] 
                        },

                        // 5. Owner
                        "Owner": { 
                            rich_text: [{ text: { content: taskData.owner || "" } }] 
                        },

                        // 6. Priority Level
                        "Priority Level": { 
                            select: { name: taskData.priority || "Medium" } 
                        },

                        // 7. Source
                        "Source": { 
                            select: { name: "Virtual Meeting" } 
                        },

                        // 8. Notes
                        "Notes": { 
                            rich_text: [{ text: { content: taskData.notes || "" } }] 
                        }
                    }
                });
                
                // Update Slack Message to show success
                res.status(200).json({
                    replace_original: "true",
                    text: `✅ *Created:* ${taskData.title} in Notion.`
                });

            } else if (taskData.action === 'UPDATE') {
                // Perform Notion UPDATE
                // We need the Page ID. For updates, we look at the notion_url or pass page_id in payload.
                // Assuming notion_url contains the ID (standard Notion format: notion.so/Title-ID)
                
                // Helper to extract ID from URL if not passed explicitly. 
                // However, our logic upstream passed the whole 'task' object.
                // If 'id' key exists in task object use it, else parse URL.
                let pageId = taskData.id; 
                
                if (!pageId && taskData.notion_url) {
                    // Quick regex to grab the 32 char hex at end of URL
                    const matches = taskData.notion_url.match(/([a-f0-9]{32})/);
                    if(matches) pageId = matches[0];
                }

                if (pageId) {
                    console.log(`[Slack Action] Updating Page ID: ${pageId}`);
                    await notion.pages.update({
                        page_id: pageId,
                        properties: {
                            // 1. Tasks
                            "Tasks": { 
                                tasks: [{ text: { content: taskData.tasks } }] 
                            },

                            // 2. Status (Using 'status' type as verified previously)
                            "Status": { 
                                status: { name: taskData.status } 
                            },

                            // 3. Linked JTBD (Assumed Rich Text)
                            "Jobs": { 
                                rich_text: [{ text: { content: taskData.linked_jtbd || "" } }] 
                            },

                            // 4. Owner (Assumed Rich Text. If 'Person' type, this needs to be a User ID)
                            "Owner": { 
                                rich_text: [{ text: { content: taskData.owner || "" } }] 
                            },

                            // 5. Priority Level (Assumed Select)
                            "Priority Level": { 
                                select: { name: taskData.priority || "Medium" } 
                            },

                            // 6. Source (Assumed Select or Multi-select)
                            "Source": { 
                                select: { name: "Virtual Meeting" } 
                            },

                            // 7. Notes (Appending update tag)
                            "Notes": { 
                                rich_text: [{ text: { content: (taskData.notes || "") + "\n[Updated via Slack]" } }] 
                            }
                        }
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
            // Handle Skip
             res.status(200).json({
                replace_original: "true",
                text: `⏭️ *Skipped:* Task ignored.`
            });

        } else if (action.action_id === 'feedback_task') {
            // Handle Feedback (Placeholder)
            res.status(200).json({
                replace_original: "false", // Don't delete the buttons yet
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


app.post('/api/v1/slack-approved-tasks', async (req, res) => {
    // This was your old endpoint for bulk approval, leaving it as requested.
    const approvedTasks = req.body.tasks; 
    
    if (!approvedTasks || approvedTasks.length === 0) {
        return res.status(400).send({ message: "No tasks provided for update." });
    }
    try {
        // await updateNotionDB(approvedTasks); // This function was mocked in your snippet
        res.status(200).send({ message: 'Legacy endpoint: Notion database update logic moved to interactive buttons.' });
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

        // await sendToSlackForApproval(taskList, normalized_data.meeting_title); 

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
let chosenTasks = await findBestDatabaseMatch(projectName, allSources);

// Fallback: simple contains match
if (!chosenTitle) {
  chosenTasks = allSources.find(ds =>
    ds.title.toLowerCase().includes(projectName.toLowerCase())
  )?.title;
}

if (!chosenTitle) {
  return res.status(404).send({ error: "No matching Notion DB found." });
}

const match = allSources.find(ds => ds.tasks === chosenTasks);

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
    owner: t.owner && t.owner !== "" ? t.owner : "Unassigned",
    priority: t.priority_level && t.priority_level !== "" ? t.priority_level : "Medium",
    linked_jtbd: t.linked_jtbd?.name || "TBD"
  }))
);


    // --- 5) Semantic compare with GPT for UPDATE vs CREATE ---
    const finalOutput = [];

    for (const proposal of proposals) {
      try {
        // Prompt tailored to your comparison rules
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
- Do NOT invent or erase these fields


STRICT OUTPUT RULES:
- If UPDATE:
  - notion_url MUST be copied EXACTLY from the matched existing task
  - status MUST come from the matched existing task
- If CREATE:
  - notion_url MUST be exactly "New Task"
  - status MUST come from proposal.status

DISPLAY LINE RULE:
- "✓ Task CREATED: <title>"
- "✓ Task UPDATED: <title>"

TASK PROPOSAL:
${JSON.stringify(proposal)}

EXISTING NOTION TASKS:
${JSON.stringify(existingTasks)}

RETURN ONLY VALID JSON
NO commentary
NO markdown

OUTPUT SCHEMA:
{
  "display_line": "string",
  "action": "CREATE | UPDATE",
  "notion_url": "string",
  "title": "string",
  "owner": "string",
  "priority": "string",
  "linked_jtbd": "string",
  "project": "string",
  "notes": "string",
  "status": "string"
}
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
console.log("🧠 GPT RAW OUTPUT:", content);

const parsed = JSON.parse(content);

if (parsed.action === "UPDATE" && parsed.notion_url === "New Task") {
  throw new Error("UPDATE action returned without Notion URL");
}


finalOutput.push(parsed);
      } catch (err) {
        console.error("Comparison error:", err);
      }
    }


    // --- 6) SEND TO SLACK WITH BUTTONS AND TARGET DB ID ---
    // UPDATED CALL: We now pass the match.id (Target DB ID) to the Slack helper
    await sendTaskListToSlack(finalOutput, meeting_tasks || "Virtual Meeting", match.id);

    // --- 7) Return results ---
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