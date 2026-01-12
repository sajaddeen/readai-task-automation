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
const logger = require('../utilities/logger'); // <--- LOGGER INTEGRATED

// --- CONFIGURATION ---
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

const SLACK_CHANNEL = process.env.SLACK_APPROVAL_CHANNEL;
const NOTION_TASK_DB_ID = process.env.NOTION_TASK_DB_ID; // Fallback ID
const PORT = process.env.MCP_PORT || 3001;
const app = express();

logger.info(`[Config Check] OpenAI API Key is loaded: ${!!process.env.OPENAI_API_KEY}`); 

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true })); 


// ==========================================================================
//  GLOBAL STATE: FEEDBACK SESSIONS
// ==========================================================================
// Stores task data while the user is editing it in the modal loop
// Key: sessionId (UUID) | Value: { task, iteration, aiSuggestion, traceId }
const feedbackSessions = new Map();


// ==========================================================================
//  HELPER: OPEN FEEDBACK MODAL (ALL FIELDS)
// ==========================================================================
const openFeedbackModal = async (triggerId, task, sessionId) => {
    await slackClient.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "feedback_modal_submit",
        private_metadata: JSON.stringify({ sessionId }), 
        title: { type: "plain_text", text: "Feedback Form" },
        submit: { type: "plain_text", text: "Submit Feedback" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          // --- TITLE ---
          {
            type: "input",
            block_id: "title_block",
            label: { type: "plain_text", text: "Task Title" },
            element: {
              type: "plain_text_input",
              action_id: "title",
              initial_value: task.title
            }
          },
          // --- NOTES ---
          {
            type: "input",
            block_id: "notes_block",
            label: { type: "plain_text", text: "Notes / Context" },
            element: {
              type: "plain_text_input",
              action_id: "notes",
              multiline: true,
              initial_value: task.notes
            }
          },
          { type: "divider" },
          { type: "section", text: { type: "mrkdwn", text: "*Task Details*" } },
          
          // --- OWNER & PROJECT ---
          {
            type: "input",
            block_id: "owner_block",
            label: { type: "plain_text", text: "Owner" },
            element: {
              type: "plain_text_input",
              action_id: "owner",
              initial_value: task.owner || "Unassigned"
            }
          },
          {
            type: "input",
            block_id: "project_block",
            label: { type: "plain_text", text: "Project" },
            element: {
              type: "plain_text_input",
              action_id: "project",
              initial_value: task.project || "General"
            }
          },

          // --- PRIORITY ---
          {
            type: "input",
            block_id: "priority_block",
            label: { type: "plain_text", text: "Priority" },
            element: {
                type: "static_select",
                action_id: "priority",
                initial_option: {
                    text: { type: "plain_text", text: task.priority || "Medium" },
                    value: task.priority || "Medium"
                },
                options: [
                    { text: { type: "plain_text", text: "High" }, value: "High" },
                    { text: { type: "plain_text", text: "Medium" }, value: "Medium" },
                    { text: { type: "plain_text", text: "Low" }, value: "Low" }
                ]
            }
          },

          // --- STATUS ---
          {
            type: "input",
            block_id: "status_block",
            label: { type: "plain_text", text: "Status" },
            element: {
                type: "static_select",
                action_id: "status",
                initial_option: {
                    text: { type: "plain_text", text: task.status || "To do" },
                    value: task.status || "To do"
                },
                options: [
                    { text: { type: "plain_text", text: "To do" }, value: "To do" },
                    { text: { type: "plain_text", text: "In progress" }, value: "In progress" },
                    { text: { type: "plain_text", text: "Done" }, value: "Done" }
                ]
            }
          },

          // --- DATES ---
          {
             type: "input",
             block_id: "start_date_block",
             optional: true,
             label: { type: "plain_text", text: "Start Date" },
             element: {
                 type: "datepicker",
                 action_id: "start_date",
                 initial_date: task.start_date || undefined,
                 placeholder: { type: "plain_text", text: "Select a date" }
             }
          },
          {
             type: "input",
             block_id: "due_date_block",
             optional: true,
             label: { type: "plain_text", text: "Due Date" },
             element: {
                 type: "datepicker",
                 action_id: "due_date",
                 initial_date: task.due_date || undefined,
                 placeholder: { type: "plain_text", text: "Select a date" }
             }
          },

          // --- FOCUS & JTBD ---
          {
            type: "input",
            block_id: "focus_block",
            label: { type: "plain_text", text: "Focus This Week?" },
            element: {
                type: "static_select",
                action_id: "focus",
                initial_option: {
                    text: { type: "plain_text", text: task.focus_this_week || "No" },
                    value: task.focus_this_week || "No"
                },
                options: [
                    { text: { type: "plain_text", text: "Yes" }, value: "Yes" },
                    { text: { type: "plain_text", text: "No" }, value: "No" }
                ]
            }
          },
          {
            type: "input",
            block_id: "jtbd_block",
            optional: true,
            label: { type: "plain_text", text: "Linked JTBD" },
            element: {
              type: "plain_text_input",
              action_id: "jtbd",
              initial_value: typeof task.linked_jtbd === 'string' ? task.linked_jtbd : (task.linked_jtbd?.name || "")
            }
          }
        ]
      }
    });
};


// ==========================================================================
//  HELPER: SLACK MESSAGING (With Logger + Trace ID)
// ==========================================================================

const sendTaskListToSlack = async (taskList, meetingTitle, targetDbId, traceId) => {
    if (!SLACK_CHANNEL || !process.env.SLACK_BOT_TOKEN) {
        logger.warn("SLACK CONFIG MISSING: Skipping Slack notification.", { traceId });
        return;
    }

    const blocks = [];

    // --- MAIN HEADER ---
    blocks.push({
        type: "header",
        text: { type: "plain_text", text: `📝 Sync Report: ${meetingTitle}`, emoji: true }
    });
    
    // Trace ID Context (Small footer)
    blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `_Ref: ${traceId || 'N/A'}_` }]
    });

    blocks.push({ type: "divider" });

    // --- GENERATE PROPOSAL CARDS ---
    
    // We iterate through ALL tasks to maintain the "X of Y" count
    taskList.forEach((task, index) => {
        const proposalCount = `${index + 1} of ${taskList.length}`;
        
        // Prepare Button Payload 
        // We persist targetDbId and traceId so the next action knows the context
        const buttonPayload = JSON.stringify({
            ...task,
            targetDbId: targetDbId || NOTION_TASK_DB_ID,
            traceId: traceId, 
            notes: task.notes.length > 500 ? task.notes.substring(0, 500) + "..." : task.notes
        });

        // Formats
        const jtbdDisplay = task.linked_jtbd_url && task.linked_jtbd_url.startsWith('http') 
            ? `<${task.linked_jtbd_url}|${task.linked_jtbd}>`
            : task.linked_jtbd || "TBD";

        const existingTaskLine = task.action === 'UPDATE' && task.notion_url && task.notion_url !== "New Task"
            ? `*Existing task:* <${task.notion_url}|Open Notion Page>`
            : "";

        const typeLabel = task.action === 'CREATE' ? "Create new Task" : "Update existing Task";

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
            text: { type: "mrkdwn", text: detailsText }
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
        logger.info(`Detailed task report sent to Slack (${taskList.length} proposals).`, { traceId });
    } catch (error) {
        logger.error("Failed to send Slack message", error, { traceId });
    }
};


// ==========================================================================
//  HELPER: TRANSCRIPT NORMALIZATION (With Trace ID)
// ==========================================================================

const normalizeTranscript = async (transcript, initialData, traceId) => {
    
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        throw new Error("OpenAI API Key is missing from environment variables.");
    }
    
    // Schema definition
   const jsonFormatSchema = {
  "transcript_id": traceId || "generated_id", // FORCE TRACE ID
  "source": initialData.source,
  "source_id": initialData.source_id,
  "meeting_title": initialData.meeting_title,
  "created_at": new Date().toISOString(),
  "start_time": new Date(Date.now() - 3600000).toISOString(),

  "participants": [
    { "name": "string", "email": "string", "role": "string" }
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
            "linked_jtbd": { "name": "string", "url": "string" },
            "owner": "string",
            "status": "In progress | Done | To do",
            "priority_level": "High | Medium | Low",
            "source": "Virtual Meeting",
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
    Analyze the transcript and extract structured tasks.
    
    CRITICAL: Use "${traceId}" as the transcript_id in the output.

    CRITICAL RULES:
    - Every task must belong to EXACTLY ONE project (Island Way or Ridge Oak).
    - If unsure of project → choose the MOST LIKELY one.

    CRITICAL NEW RULES (DATES & FOCUS):
    1. **Dates**: Extract 'start_date' and 'due_date' (YYYY-MM-DD). If unknown, use null.
    2. **Focus This Week**: "Yes" ONLY if urgent/"this week". Otherwise "No".

    TASK QUALITY:
    - Task titles must be concise.
    - Notes must be 2–4 sentences explaining context and next steps.

    JTBD LINKING:
    - Always try to link JTBD. If unknown: { "name": "TBD", "url": "TBD" }

    Output MUST be valid JSON matching the schema.

    Transcript:
    ${transcript}

    Output JSON Schema:
    ${JSON.stringify(jsonFormatSchema)}
    `;

    try {
        logger.info('Sending request to OpenAI for normalization...', { traceId });
        
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
        if (!completion?.choices?.[0]?.message?.content) {
             throw new Error("OpenAI returned an empty object.");
        }
        
        const normalizedJson = JSON.parse(completion.choices[0].message.content);
        
        normalizedJson.transcript_id = traceId;
        return normalizedJson;

    } catch (error) {
        logger.error("OpenAI Normalization Error", error, { traceId });
        throw error;
    }
};

// ==========================================================================
//  HELPER: QUERY NOTION DB (Legacy Support)
// ==========================================================================

const queryNotionDB = async (extractedProjects) => {
    if (!NOTION_TASK_DB_ID || !process.env.NOTION_API_KEY) {
        return { existing_tasks: [] };
    }
    
    logger.info(`Querying Notion database...`);
    
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

        logger.info(`Found ${existingTasks.length} existing task(s) in Notion.`);
        return { existing_tasks: existingTasks };

    } catch (error) {
        logger.error('NOTION DB QUERY ERROR', error);
        return { existing_tasks: [] };
    }
};

// ==========================================================================
//  HELPER: GENERATE TASK LIST (Legacy Support)
// ==========================================================================

const generateTaskList = async (normalizedData, notionContext) => {
    
    const allAIExtractedTasks = normalizedData.extracted_entities.projects.flatMap(p => 
      p.tasks.map(t => ({
        title: t.task_title,
        project: p.project_name,
        owner: t.owner && t.owner !== "" ? t.owner : "Unassigned", 
        priority: t.priority_level && t.priority_level !== "" ? t.priority_level : "Medium",
        linked_jtbd: t.linked_jtbd?.name && t.linked_jtbd.name !== "TBD" ? t.linked_jtbd.name : "TBD",
        proposal_type: t.proposal_type,
        notes: t.notes,
        status: t.status,
        start_date: t.start_date,
        due_date: t.due_date,
        focus_this_week: t.focus_this_week,
        transcript_id: normalizedData.transcript_id
      }))
    );
    
    const taskList = [];

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
                start_date: aiTask.start_date,
                due_date: aiTask.due_date,
                focus_this_week: aiTask.focus_this_week,
                action: 'UPDATE',
                transcript_id: normalizedData.transcript_id
            });
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
                start_date: aiTask.start_date,
                due_date: aiTask.due_date,
                focus_this_week: aiTask.focus_this_week,
                transcript_id: normalizedData.transcript_id
            });
        }
    }
    return taskList;
};


// ==========================================================================
//  HELPER: LIST NOTION DATABASES
// ==========================================================================

const listAllNotionDatabases = async () => {
    try {
        logger.info("Listing all databases via Search API...");
        let allDBs = [];
        let cursor = undefined;
        do {
            const response = await notion.search({
                query: "", 
                start_cursor: cursor,
                page_size: 100
            });
            if (response.results) {
                const databases = response.results.filter(item => item.object === 'database' || item.object === 'data_source');
                databases.forEach(item => {
                    allDBs.push({
                        id: item.id,
                        title: item.title?.map(t => t.plain_text).join("") || "(No title)",
                        object: item.object
                    });
                });
            }
            cursor = response.has_more ? response.next_cursor : undefined;
        } while (cursor);
        
        logger.info(`Found ${allDBs.length} databases.`);
        return allDBs;
    } catch (error) {
        logger.error("Failed to list databases", error);
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

// --- LEGACY ENDPOINT: GET ROWS ---
app.get('/api/v1/notion-data-source-rows', async (req, res) => {
  try {
    const { db_id } = req.query;
    if (!db_id) return res.status(400).send({ message: "Missing query param: db_id" });
    const pages = await fetchAllRowsInDataSource(db_id);
    res.status(200).send({ count: pages.length, pages: pages.map(simplifyAnyPage) });
  } catch (error) {
    logger.error("Error fetching rows", error);
    res.status(500).send({ error: error.message });
  }
});

// --- LEGACY ENDPOINT: LIST DBs ---
app.get('/api/v1/list-notion-databases', async (req, res) => {
    try {
        const databases = await listAllNotionDatabases();
        res.status(200).send({ databases });
    } catch (error) {
        logger.error("Error listing databases", error);
        res.status(500).send({ error: error.message });
    }
});


// ==========================================================================
//  ENDPOINT: SLACK INTERACTION (BUTTONS + MODAL + CHAT LOOP)
// ==========================================================================

app.post('/api/v1/slack-interaction', async (req, res) => {
    try {
        const payload = JSON.parse(req.body.payload);

        // ---------------------------------------------------------
        // CASE 1: BUTTON CLICKS (Block Actions)
        // ---------------------------------------------------------
        if (payload.type === 'block_actions') {
            const action = payload.actions[0];
            const taskData = JSON.parse(action.value);
            const traceId = taskData.traceId || "no_trace_id"; // Recover Trace ID

            // --- A. HANDLE "ACCEPT" (Direct Create/Update) ---
            if (action.action_id === 'accept_task') {
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

                if (taskData.start_date) notionProperties["Start Date"] = { date: { start: taskData.start_date } };
                if (taskData.due_date) notionProperties["Due Date"] = { date: { start: taskData.due_date } };

                if (taskData.action === 'CREATE') {
                    logger.info(`Creating task: ${taskData.title}`, { traceId });
                    
                    // FIX: Using correct parent structure for 2025 API
                    await notion.pages.create({
                        parent: { type: "data_source_id", data_source_id: sourceId },
                        properties: notionProperties
                    });
                    
                    return res.status(200).json({
                        replace_original: "true",
                        text: `✅ *Created:* ${taskData.title} \n_Focus: ${taskData.focus_this_week}_`
                    });

                } else if (taskData.action === 'UPDATE') {
                    let pageId = taskData.id; 
                    if (!pageId && taskData.notion_url) {
                        const matches = taskData.notion_url.match(/([a-f0-9]{32})/);
                        if(matches) pageId = matches[0];
                    }

                    if (pageId) {
                        logger.info(`Updating Page ID: ${pageId}`, { traceId });
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
            } 
            
            // --- B. HANDLE "SKIP" ---
            else if (action.action_id === 'skip_task') {
                logger.info(`Task skipped: ${taskData.title}`, { traceId });
                return res.status(200).json({
                    replace_original: "true",
                    text: `⏭️ *Skipped*`
                });
            }

            // --- C. HANDLE "FEEDBACK" (Open Modal) ---
            else if (action.action_id === 'feedback_task') {
                const sessionId = crypto.randomUUID();

                // Store in memory with trace ID
                feedbackSessions.set(sessionId, {
                    task: taskData,
                    iteration: 1,
                    aiSuggestion: taskData,
                    traceId: traceId
                });

                // Open the modal
                await openFeedbackModal(
                    payload.trigger_id,
                    { ...taskData, iteration: 1 },
                    sessionId
                );

                // Acknowledge click immediately
                return res.status(200).send();
            }
        }

        // ---------------------------------------------------------
        // CASE 2: MODAL SUBMISSION (Refine & Post NEW Card)
        // ---------------------------------------------------------
        if (payload.type === 'view_submission' && payload.view.callback_id === 'feedback_modal_submit') {
            
            // 1. Recover Session
            const metadata = JSON.parse(payload.view.private_metadata);
            const sessionId = metadata.sessionId;
            const session = feedbackSessions.get(sessionId);

            if (!session) {
                // Failsafe if session lost
                return res.status(200).json({ response_action: "clear" }); 
            }

            // 2. Extract ALL Values
            const v = payload.view.state.values;
            // Helpers to safe-get
            const getVal = (block, action) => v[block]?.[action]?.value;
            const getSel = (block, action) => v[block]?.[action]?.selected_option?.value;
            const getTxt = (block, action) => v[block]?.[action]?.selected_option?.text?.text;
            const getDate = (block, action) => v[block]?.[action]?.selected_date;

            // 3. Update Task Data
            const updatedTask = {
                ...session.task, // preserve IDs & Trace ID
                title: getVal('title_block', 'title'),
                notes: getVal('notes_block', 'notes') + "\n(Refined by User)",
                owner: getVal('owner_block', 'owner'),
                project: getVal('project_block', 'project'),
                linked_jtbd: getVal('jtbd_block', 'jtbd'),
                
                // Selects return the value field
                priority: getTxt('priority_block', 'priority'), 
                status: getTxt('status_block', 'status'),
                focus_this_week: getTxt('focus_block', 'focus'), // Yes/No
                
                // Dates
                start_date: getDate('start_date_block', 'start_date'),
                due_date: getDate('due_date_block', 'due_date')
            };

            // 4. Update Session
            session.iteration += 1;
            session.task = updatedTask;
            feedbackSessions.set(sessionId, session);

            const targetDbId = updatedTask.targetDbId || NOTION_TASK_DB_ID;
            const traceId = session.traceId || "unknown_trace";
            
            logger.info(`Feedback submitted. Posting v${session.iteration} to chat.`, { traceId });
            
            // 5. THE LOOP: Send a NEW Slack Message with the updated task
            await sendTaskListToSlack(
                [updatedTask], 
                `Refined Proposal (v${session.iteration})`, 
                targetDbId,
                traceId // Keep the trace ID going!
            );
            
            // 6. Close Modal
            return res.status(200).json({ response_action: "clear" });
        }

    } catch (error) {
        logger.error("Slack Interaction Error", error);
        res.status(500).send("Error");
    }
});

// --- LEGACY ENDPOINT ---
app.post('/api/v1/slack-approved-tasks', async (req, res) => {
    // This was your old endpoint for bulk approval, leaving it as requested.
    const approvedTasks = req.body.tasks; 
    if (!approvedTasks || approvedTasks.length === 0) {
        return res.status(400).send({ message: "No tasks provided for update." });
    }
    // await updateNotionDB(approvedTasks); // Mocked legacy call
    res.status(200).send({ message: 'Legacy endpoint: Notion database update logic moved to interactive buttons.' });
});


// --- LEGACY ENDPOINT ---
app.post('/api/v1/normalize', async (req, res) => {
    const { transcript, source, source_id, meeting_title, participants, raw_transcript } = req.body; 
    
    if (!transcript) {
        return res.status(400).send({ message: "Transcript is required for normalization." });
    }

    try {
        const traceId = crypto.randomUUID(); // Generate local trace
        const initialData = { source, source_id, meeting_title, participants };
        
        const normalizedJson = await normalizeTranscript(transcript, initialData, traceId);

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
        
        logger.info(`Saved normalized data to DB: ${normalizedJson.transcript_id}`, { traceId });

        res.status(200).send({ normalized_json: normalizedJson });
    } catch (error) {
        logger.error('Normalization process failed', error);
        res.status(500).send({ message: `Normalization failed: ${error.message}` });
    }
});

// --- LEGACY ENDPOINT ---
app.post('/api/v1/generate-tasks', async (req, res) => {
    const { normalized_data } = req.body;
    const extractedProjects = normalized_data.extracted_entities.projects || [];

    try {
        const actualNotionContext = await queryNotionDB(extractedProjects);
        const taskList = await generateTaskList(normalized_data, actualNotionContext);
        res.status(200).send({ message: 'Task list generated and sent to Slack for approval.' });
    } catch (error) {
        logger.error('Task Generation process failed', error);
        res.status(500).send({ message: 'Failed to generate task list.', error: error.message });
    }
});



// ==========================================================================
//  MAIN PROCESS ENDPOINT (TRACE ENABLED)
// ==========================================================================

app.post('/api/v1/process-transcript', async (req, res) => {
  try {
    const { transcript, source, source_id, meeting_title, participants, raw_transcript, request_id } = req.body;

    // 1. Trace ID Handling
    // Accept from webhook, or generate new one.
    const traceId = request_id || req.body.trace_id || crypto.randomUUID();
    
    // START LOGGING WITH TRACE
    logger.info(`🚀 Processing started for source: ${source}`, { traceId });

    if (!transcript) {
      logger.warn("Missing transcript.", { traceId });
      return res.status(400).send({ error: "Transcript text is required." });
    }

    // 2. Normalize with GPT (Pass Trace ID)
    const normalized = await normalizeTranscript(transcript, {
      source,
      source_id,
      meeting_title,
      participants
    }, traceId);

    // --- DB Saving (With Trace ID) ---
    try {
        const TranscriptModel = mongoose.model('NormalizedTranscript');
        const transcriptDocument = {
            transcript_id: traceId, // Use trace ID as primary key
            source: source || "unknown",
            source_id: source_id || "unknown",
            meeting_title: meeting_title || "Untitled",
            participants: participants || [],
            raw_transcript: raw_transcript || transcript,
            normalized_data: { 
                summary: normalized.summary,
                extracted_entities: normalized.extracted_entities,
                quality_metrics: normalized.quality_metrics,
                source_specific: normalized.source_specific || {},
            }
        };
        const newTranscript = new TranscriptModel(transcriptDocument);
        await newTranscript.save();
        logger.info("Saved transcript to DB.", { traceId });
    } catch (dbError) {
        logger.error("DB Save Failed", dbError, { traceId });
        // Don't fail the whole process if DB fails, continue to Notion/Slack
    }

    // 3. Project Matching
    const projectBlock = normalized.extracted_entities.projects && normalized.extracted_entities.projects[0];
    const projectName = projectBlock && projectBlock.project_name ? projectBlock.project_name.trim() : null;

    if (!projectName) {
        logger.warn("No project name found in data.", { traceId });
        return res.status(400).send({ error: "No project name found in normalized data." });
    }

    // 4. Load Notion DBs
    const allSources = await listAllNotionDatabases();
    if (!allSources || allSources.length === 0) return res.status(500).send({ error: "No Notion databases found." });

    let chosenTitle = await findBestDatabaseMatch(projectName, allSources);
    if (!chosenTitle) {
      chosenTitle = allSources.find(ds => ds.title.toLowerCase().includes(projectName.toLowerCase()))?.title;
    }

    if (!chosenTitle) {
      return res.status(404).send({ error: "No matching Notion DB found." });
    }

    const match = allSources.find(ds => ds.title === chosenTitle);
    logger.info(`Best DB match: "${match.title}" (ID: ${match.id})`, { traceId });

    // 5. Get Existing Context
    logger.info("Fetching existing rows for context...", { traceId });
    const allPages = await fetchAllRowsInDataSource(match.id);
    const pages = allPages.map(simplifyAnyPage);
    const existingTasks = pages.map(page => ({
        id: page.id || "",
        title: page.task || "",           
        status: page.status || "",
        notes: page.notes || "",         
        url: `https://www.notion.so/${(page.id || "").replace(/-/g, "")}`
    }));

    // 6. Generate Proposals
    const proposals = normalized.extracted_entities.projects.flatMap(p =>
        p.tasks.map(t => ({
            title: t.task_title,
            project: p.project_name,
            notes: t.notes,
            status: t.status,
            owner: t.owner || "Unassigned",
            priority: t.priority_level || "Medium",
            linked_jtbd: t.linked_jtbd?.name || "TBD",
            start_date: t.start_date,
            due_date: t.due_date,
            focus_this_week: t.focus_this_week
        }))
    );

    // 7. Semantic Compare (Create vs Update)
    const finalOutput = [];
    for (const proposal of proposals) {
      try {
       const comparePrompt = `
        You are the Prouvé Sync Manager. Decide CREATED or UPDATED.
        
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
        - If UPDATE: notion_url MUST be copied EXACTLY from matched existing task
        - If CREATE: notion_url MUST be exactly "New Task"

        TASK PROPOSAL:
        ${JSON.stringify(proposal)}

        EXISTING NOTION TASKS:
        ${JSON.stringify(existingTasks)}

        RETURN ONLY VALID JSON. 
        Structure: { action: "CREATE" | "UPDATE", notion_url: "...", title: "...", ...all_fields }
        `;

        const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({
              model: "gpt-5.2",
              messages: [{ role: "user", content: comparePrompt }],
              response_format: { type: "json_object" } 
            }),
        });

        const jsonResp = await gptResponse.json();
        const content = jsonResp.choices?.[0]?.message?.content;
        const parsed = JSON.parse(content);
        
        if (parsed.action === "UPDATE" && parsed.notion_url === "New Task") {
            // Safety check
            throw new Error("UPDATE action returned without Notion URL");
        }

        finalOutput.push(parsed);
      } catch (err) {
        logger.error("Comparison error", err, { traceId });
      }
    }

    // 8. Send to Slack (Pass Trace ID!)
    await sendTaskListToSlack(finalOutput, meeting_title || "Virtual Meeting", match.id, traceId);

    // 9. Return Result
    return res.status(200).send({ trace_id: traceId, result: finalOutput });

  } catch (error) {
    logger.error("PROCESS ERROR", error);
    return res.status(500).send({ error: error.message });
  }
});


// --- DEBUG FUNCTION: CORRECTED ---
const debugNotionAccess = async () => {
    try {
        logger.info("🔍 Checking Notion Access...");
        
        // FIX: Removed the 'filter' parameter completely to avoid the validation error.
        // We will fetch everything and filter for databases manually below.
        const response = await notion.search({}); 
        
        // Manually filter the results to find only Databases
        const databases = response.results.filter(item => item.object === 'database');
        
        console.log("\n--- 📋 DATABASES YOUR BOT CAN SEE ---");
        if (databases.length === 0) {
            console.log("❌ NONE! The bot is connected, but it cannot see any databases.");
            console.log("👉 ACTION: Go to your Notion Database -> Click '...' -> Connections -> Add your Bot.");
        } else {
            databases.forEach(db => {
                const title = db.title[0]?.plain_text || "Untitled";
                console.log(`✅ Name: "${title}" | ID: ${db.id}`);
            });
        }
        console.log("---------------------------------------\n");
    } catch (error) {
        logger.error("Notion Connection Error", error);
    }
};

// Start the server
const startServer = async () => {
    if (!NOTION_TASK_DB_ID || !process.env.NOTION_API_KEY) {
        logger.warn("NOTION KEYS MISSING: Notion integration will be mocked.");
    }
    
    // CALL THE DEBUG FUNCTION HERE
    await debugNotionAccess(); 

    await connectDB();
    app.listen(PORT, () => {
        logger.info(`🧠 MCP Server running on port ${PORT}`);
    });
};

startServer();