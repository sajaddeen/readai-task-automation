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
const NOTION_TASK_DB_ID = process.env.NOTION_TASK_DB_ID;
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
                    value: buttonPayload
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
    if (!NOTION_TASK_DB_ID || !process.env.NOTION_API_KEY) {
        console.warn("\n⚠️ NOTION KEYS MISSING: Skipping Notion DB query.");
        return { existing_tasks: [] };
    }

    // REMOVED PROJECT FILTERING: Since 'Project' column might not exist, 
    // we will query the DB directly without filtering by Project name to prevent crashes.
    
    console.log(`\n[Notion] Querying database...`);
    
    try {
        const response = await notion.dataSources.query({
            data_source_id: NOTION_TASK_DB_ID,
            // Removed 'filter' so it doesn't crash on missing 'Project' column
            // We only ask for 'Tasks' and 'Status' properties
            properties: ['Tasks', 'Status'], 
        });

        const existingTasks = response.results.map(page => ({
            task_id: page.id,
            // FIX: Map from 'Tasks' property
            title: page.properties.Tasks?.title[0]?.plain_text || 'No Title',
            // Defaulting project to Unassigned since column is gone
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

// --- UPDATED: SLACK INTERACTION HANDLER (Accept, Skip, & Feedback Modal) ---
app.post('/api/v1/slack-interaction', async (req, res) => {
    try {
        const payload = JSON.parse(req.body.payload);

        // ---------------------------------------------------------
        // CASE 1: BUTTON CLICKS (Block Actions)
        // ---------------------------------------------------------
        if (payload.type === 'block_actions') {
            const action = payload.actions[0];
            
            // Acknowledge immediately (Slack requirement)
            if (action.action_id === 'feedback_task') {
                // For modals, we MUST open the view within 3 seconds, so we don't send a res.json() yet
                // We just proceed to open the modal.
            } else {
                 // For Accept/Skip, we return a 200 OK immediately and update the message later
                 // But strictly speaking, we can just await the logic and send JSON to update the message.
            }

            // --- 1. HANDLE "ACCEPT" (Direct Create/Update) ---
            if (action.action_id === 'accept_task') {
                const taskData = JSON.parse(action.value);
                const sourceId = taskData.targetDbId || NOTION_TASK_DB_ID;

                // Construct Notion Properties
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

                // Add Dates if present
                if (taskData.start_date) notionProperties["Start Date"] = { date: { start: taskData.start_date } };
                if (taskData.due_date) notionProperties["Due Date"] = { date: { start: taskData.due_date } };

                if (taskData.action === 'CREATE') {
                    console.log(`[Slack] Creating task: ${taskData.title}`);
                    await notion.pages.create({
                        parent: { type: "data_source_id", data_source_id: sourceId },
                        properties: notionProperties
                    });
                    
                    return res.status(200).json({
                        replace_original: "true",
                        text: `✅ *Created:* ${taskData.title} \n_Focus: ${taskData.focus_this_week}_`
                    });

                } else if (taskData.action === 'UPDATE') {
                    // (Same update logic as before...)
                    let pageId = taskData.id; 
                    if (!pageId && taskData.notion_url) {
                        const matches = taskData.notion_url.match(/([a-f0-9]{32})/);
                        if(matches) pageId = matches[0];
                    }

                    if (pageId) {
                        notionProperties["Notes"] = { 
                            rich_text: [{ text: { content: (taskData.notes || "") + "\n[Updated via Slack]" } }] 
                        };
                        await notion.pages.update({ page_id: pageId, properties: notionProperties });
                        
                        return res.status(200).json({
                            replace_original: "true",
                            text: `✅ *Updated:* ${taskData.title}`
                        });
                    }
                }
            } 
            
            // --- 2. HANDLE "SKIP" ---
            else if (action.action_id === 'skip_task') {
                return res.status(200).json({
                    replace_original: "true",
                    text: `⏭️ *Skipped*`
                });
            }

            // --- 3. HANDLE "FEEDBACK" (Open Modal) ---
            else if (action.action_id === 'feedback_task') {
                // We need to send a 200 OK *first* to acknowledge the button click, 
                // OR we can just allow the function to run. 
                // Best practice for modals: Send 200 OK immediately if using response_url, 
                // but for 'views.open' we just call the API.
                
                // We recover the data hidden in the "feedback" button value (if you stored it there)
                // OR simpler: The feedback button usually just has "feedback" as value. 
                // NOTE: To pre-fill the modal, we need the task data. 
                // *Fix:* Let's assume you updated sendTaskListToSlack to pass the FULL JSON in the feedback button too.
                // If not, we can't pre-fill. 
                
                // Let's assume the button value holds the JSON just like the 'accept' button.
                // You might need to update sendTaskListToSlack to ensure the feedback button has `value: buttonPayload` instead of "feedback".
                let taskData = {};
                try {
                     taskData = JSON.parse(action.value);
                } catch(e) {
                    console.log("Feedback button did not have JSON payload. Opening empty modal.");
                }

                // Call Slack API to open a modal
                await slackClient.views.open({
                    trigger_id: payload.trigger_id,
                    view: {
                        type: "modal",
                        callback_id: "feedback_submission",
                        // Pass hidden data (DB ID, Action Type, Notion ID) in private_metadata
                        private_metadata: JSON.stringify({
                            targetDbId: taskData.targetDbId || NOTION_TASK_DB_ID,
                            action: taskData.action || 'CREATE',
                            id: taskData.id || null, // For updates
                            notion_url: taskData.notion_url || null
                        }),
                        title: { type: "plain_text", text: "Edit Task Details" },
                        submit: { type: "plain_text", text: "Save to Notion" },
                        close: { type: "plain_text", text: "Cancel" },
                        blocks: [
                            {
                                type: "input",
                                block_id: "title_block",
                                element: {
                                    type: "plain_text_input",
                                    action_id: "title_input",
                                    initial_value: taskData.title || ""
                                },
                                label: { type: "plain_text", text: "Task Title" }
                            },
                            {
                                type: "input",
                                block_id: "notes_block",
                                element: {
                                    type: "plain_text_input",
                                    action_id: "notes_input",
                                    multiline: true,
                                    initial_value: taskData.notes || ""
                                },
                                label: { type: "plain_text", text: "Notes / Context" }
                            },
                             {
                                type: "input",
                                block_id: "owner_block",
                                optional: true,
                                element: {
                                    type: "plain_text_input",
                                    action_id: "owner_input",
                                    initial_value: taskData.owner || ""
                                },
                                label: { type: "plain_text", text: "Owner" }
                            }
                        ]
                    }
                });
                
                // We don't return JSON here because opening a modal is a separate API call. 
                // We just send 200 OK to say "we got the click".
                return res.status(200).send();
            }
        }

        // ---------------------------------------------------------
        // CASE 2: MODAL SUBMISSION (View Submission)
        // ---------------------------------------------------------
        if (payload.type === 'view_submission') {
            const view = payload.view;
            const values = view.state.values;
            
            // Extract metadata we hid in the modal
            const metadata = JSON.parse(view.private_metadata);
            const sourceId = metadata.targetDbId;

            // Extract User Edits
            const newTitle = values.title_block.title_input.value;
            const newNotes = values.notes_block.notes_input.value;
            const newOwner = values.owner_block.owner_input.value;

            console.log(`[Slack Modal] Submitting edited task: ${newTitle}`);

            // Construct Notion Properties (Merging edits)
            const notionProperties = {
                "Tasks": { title: [{ text: { content: newTitle } }] },
                "Notes": { rich_text: [{ text: { content: newNotes } }] },
                "Owner": { rich_text: [{ text: { content: newOwner } }] },
                // We keep defaults for fields not in the form (Status, Priority, etc.)
                // Or you can add inputs for them if you want.
            };

            // WRITE TO NOTION
            if (metadata.action === 'CREATE') {
                await notion.pages.create({
                    parent: { type: "data_source_id", data_source_id: sourceId },
                    properties: notionProperties
                });
            } else if (metadata.action === 'UPDATE' && metadata.id) {
                 await notion.pages.update({
                    page_id: metadata.id,
                    properties: notionProperties
                });
            }

            // Return empty 200 OK to close the modal
            // (Slack requires this to be instant)
            return res.status(200).json({ response_action: "clear" });
        }

    } catch (error) {
        console.error("Slack Interaction Error:", error.message);
        res.status(500).send("Error");
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
  // FIX: Using 'task' which is derived from 'simplifyAnyPage' mapping (make sure helper handles 'Tasks' col)
  title: page.task || "",           
  status: page.status || "",
  notes: page.notes || "",         
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
    linked_jtbd: t.linked_jtbd?.name || "TBD",
    // Pass new fields
    start_date: t.start_date,
    due_date: t.due_date,
    focus_this_week: t.focus_this_week
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
- start_date MUST be copied from proposal.start_date
- due_date MUST be copied from proposal.due_date
- focus_this_week MUST be copied from proposal.focus_this_week
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
  "status": "string",
  "start_date": "string or null",
  "due_date": "string or null",
  "focus_this_week": "string"
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
    // UPDATED CALL: Pass match.id (Target DB ID)
    await sendTaskListToSlack(finalOutput, meeting_title || "Virtual Meeting", match.id);

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
        console.warn("\n NOTION KEYS MISSING: Notion integration will be mocked.");
    }
    

    await connectDB();
    app.listen(PORT, () => {
        console.log(`🧠 MCP Server running on port ${PORT}`);
    });
};

startServer();