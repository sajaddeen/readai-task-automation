const express = require('express');
const bodyParser = require('body-parser');
const { connectDB } = require('@read-ai/shared-config');
const mongoose = require('mongoose');
const { Client } = require('@notionhq/client');
const { WebClient } = require('@slack/web-api');
const crypto = require('crypto');
const axios = require('axios');

// --- CUSTOM UTILITIES ---
const { simplifyAnyPage } = require('../utilities/notionHelper');
const { findBestDatabaseMatch } = require('../utilities/dbFinder');
const logger = require('../utilities/logger'); 

// --- CONFIGURATION ---
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

const SLACK_CHANNEL = process.env.SLACK_APPROVAL_CHANNEL;
const NOTION_TASK_DB_ID = process.env.NOTION_TASK_DB_ID; 
const PORT = process.env.MCP_PORT || 3001;
const app = express();

logger.info(`[Config Check] OpenAI API Key is loaded: ${!!process.env.OPENAI_API_KEY}`); 

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true })); 


// ==========================================================================
//  GLOBAL STATE: SESSIONS & QUEUES
// ==========================================================================

// 1. Feedback Sessions: Stores data while user edits in Modal
const feedbackSessions = new Map();

// 2. Proposal Queues: Stores the list of tasks to send sequentially
// Key: traceId | Value: { tasks: [], currentIndex: 0, meetingTitle: "", targetDbId: "" }
const proposalQueues = new Map();


// ==========================================================================
//  HELPER: SEND NEXT PROPOSAL IN QUEUE (Sequential Logic)
// ==========================================================================

const sendNextProposal = async (traceId) => {
    const session = proposalQueues.get(traceId);
    if (!session) {
        logger.warn("No active session found for this queue.", { traceId });
        return;
    }

    // Check if we are done
    if (session.currentIndex >= session.tasks.length) {
        // All done! Send a summary.
        await slackClient.chat.postMessage({
            channel: SLACK_CHANNEL,
            text: `🏁 *All proposals for "${session.meetingTitle}" have been processed.*`,
        });
        proposalQueues.delete(traceId); // Cleanup memory
        return;
    }

    // Get current task
    const task = session.tasks[session.currentIndex];
    const proposalCount = `${session.currentIndex + 1} of ${session.tasks.length}`;

    // Prepare JSON Payloads (CRITICAL FIX for SKIP button)
    // We attach the traceId so the interaction handler knows which queue to advance
    const basePayload = {
        ...task,
        targetDbId: session.targetDbId,
        traceId: traceId,
        queueIndex: session.currentIndex 
    };

    // Sanitize notes for payload size limits
    basePayload.notes = task.notes.length > 2000 ? task.notes.substring(0, 2000) + "..." : task.notes;

    const buttonPayloadJSON = JSON.stringify(basePayload);

    // --- BUILD BLOCKS ---
    const blocks = [];

    blocks.push({
        type: "header",
        text: { type: "plain_text", text: `Proposal ${proposalCount}`, emoji: true }
    });

    // Trace Context
    blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `_Ref: ${traceId}_ | Project: ${task.project}_` }]
    });

    const jtbdDisplay = task.linked_jtbd_url && task.linked_jtbd_url.startsWith('http') 
        ? `<${task.linked_jtbd_url}|${task.linked_jtbd}>`
        : task.linked_jtbd || "TBD";

    const existingTaskLine = task.action === 'UPDATE' && task.notion_url && task.notion_url !== "New Task"
        ? `*Existing task:* <${task.notion_url}|Open Notion Page>`
        : "";

    const typeLabel = task.action === 'CREATE' ? "Create new Task" : "Update existing Task";

    const detailsText = 
`*Task title:* ${task.title}
*Type:* ${typeLabel}

${existingTaskLine}
*Linked JTBD:* ${jtbdDisplay}

*Owner:* ${task.owner}
*Status:* ${task.status}
*Priority:* ${task.priority || "Medium"}
*Focus This Week?:* ${task.focus_this_week || "No"}
*Dates:* ${task.start_date || "—"} to ${task.due_date || "—"}

*Notes:*
${task.notes}`;

    blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: detailsText }
    });

    // Buttons
    const btnText = task.action === 'CREATE' ? "✅ Accept & Create" : "✅ Accept & Update";
    
    blocks.push({
        type: "actions",
        elements: [
            {
                type: "button",
                text: { type: "plain_text", text: btnText },
                style: "primary",
                action_id: "accept_task",
                value: buttonPayloadJSON
            },
            {
                type: "button",
                text: { type: "plain_text", text: "⏭️ Skip" },
                action_id: "skip_task",
                // FIX: Send full JSON object, not just string "skip"
                value: buttonPayloadJSON 
            },
            {
                type: "button",
                text: { type: "plain_text", text: "💬 Feedback" },
                action_id: "feedback_task",
                value: buttonPayloadJSON 
            }
        ]
    });

    try {
        await slackClient.chat.postMessage({
            channel: SLACK_CHANNEL,
            text: `New Proposal: ${task.title}`,
            blocks: blocks
        });
        logger.info(`Sent proposal ${session.currentIndex + 1}/${session.tasks.length} to Slack.`, { traceId });
    } catch (error) {
        logger.error("Failed to send Slack message", error, { traceId });
    }
};


// ==========================================================================
//  HELPER: SEND SINGLE/BULK TASK (Legacy Support & Loop Reposting)
// ==========================================================================
// This function is kept because the Feedback Loop uses it to repost the *refined* card.
const sendTaskListToSlack = async (taskList, meetingTitle, targetDbId, traceId) => {
    if (!SLACK_CHANNEL || !process.env.SLACK_BOT_TOKEN) {
        logger.warn("SLACK CONFIG MISSING: Skipping Slack notification.", { traceId });
        return;
    }

    const blocks = [];
    blocks.push({ type: "header", text: { type: "plain_text", text: `📝 Sync Report: ${meetingTitle}`, emoji: true } });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_Ref: ${traceId || 'N/A'}_` }] });
    blocks.push({ type: "divider" });

    taskList.forEach((task, index) => {
        const buttonPayload = JSON.stringify({
            ...task,
            targetDbId: targetDbId || NOTION_TASK_DB_ID,
            traceId: traceId, 
            notes: task.notes.length > 500 ? task.notes.substring(0, 500) + "..." : task.notes
        });

        const typeLabel = task.action === 'CREATE' ? "Create new Task" : "Update existing Task";
        const detailsText = `*Proposal (Refined)*\n*Project:* ${task.project}\n*Title:* ${task.title}\n*Notes:* ${task.notes}`;

        blocks.push({ type: "section", text: { type: "mrkdwn", text: detailsText } });

        const btnText = task.action === 'CREATE' ? "✅ Accept & Create" : "✅ Accept & Update";
        blocks.push({
            type: "actions",
            elements: [
                { type: "button", text: { type: "plain_text", text: btnText }, style: "primary", action_id: "accept_task", value: buttonPayload },
                { type: "button", text: { type: "plain_text", text: "⏭️ Skip" }, action_id: "skip_task", value: buttonPayload },
                { type: "button", text: { type: "plain_text", text: "💬 Feedback" }, action_id: "feedback_task", value: buttonPayload }
            ]
        });
        blocks.push({ type: "divider" });
    });

    try {
        await slackClient.chat.postMessage({ channel: SLACK_CHANNEL, text: `Refined Proposal: ${meetingTitle}`, blocks: blocks });
        logger.info(`Refined task sent to Slack.`, { traceId });
    } catch (error) {
        logger.error("Failed to send Slack message", error, { traceId });
    }
};


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
          {
            type: "input",
            block_id: "title_block",
            label: { type: "plain_text", text: "Task Title" },
            element: { type: "plain_text_input", action_id: "title", initial_value: task.title }
          },
          {
            type: "input",
            block_id: "notes_block",
            label: { type: "plain_text", text: "Notes / Context" },
            element: { type: "plain_text_input", action_id: "notes", multiline: true, initial_value: task.notes }
          },
          { type: "divider" },
          { type: "section", text: { type: "mrkdwn", text: "*Task Details*" } },
          {
            type: "input",
            block_id: "owner_block",
            label: { type: "plain_text", text: "Owner" },
            element: { type: "plain_text_input", action_id: "owner", initial_value: task.owner || "Unassigned" }
          },
          {
            type: "input",
            block_id: "project_block",
            label: { type: "plain_text", text: "Project" },
            element: { type: "plain_text_input", action_id: "project", initial_value: task.project || "General" }
          },
          {
            type: "input",
            block_id: "priority_block",
            label: { type: "plain_text", text: "Priority" },
            element: {
                type: "static_select",
                action_id: "priority",
                initial_option: { text: { type: "plain_text", text: task.priority || "Medium" }, value: task.priority || "Medium" },
                options: [
                    { text: { type: "plain_text", text: "High" }, value: "High" },
                    { text: { type: "plain_text", text: "Medium" }, value: "Medium" },
                    { text: { type: "plain_text", text: "Low" }, value: "Low" }
                ]
            }
          },
          {
            type: "input",
            block_id: "status_block",
            label: { type: "plain_text", text: "Status" },
            element: {
                type: "static_select",
                action_id: "status",
                initial_option: { text: { type: "plain_text", text: task.status || "To do" }, value: task.status || "To do" },
                options: [
                    { text: { type: "plain_text", text: "To do" }, value: "To do" },
                    { text: { type: "plain_text", text: "In progress" }, value: "In progress" },
                    { text: { type: "plain_text", text: "Done" }, value: "Done" }
                ]
            }
          },
          {
             type: "input",
             block_id: "start_date_block",
             optional: true,
             label: { type: "plain_text", text: "Start Date" },
             element: { type: "datepicker", action_id: "start_date", initial_date: task.start_date || undefined, placeholder: { type: "plain_text", text: "Select a date" } }
          },
          {
             type: "input",
             block_id: "due_date_block",
             optional: true,
             label: { type: "plain_text", text: "Due Date" },
             element: { type: "datepicker", action_id: "due_date", initial_date: task.due_date || undefined, placeholder: { type: "plain_text", text: "Select a date" } }
          },
          {
            type: "input",
            block_id: "focus_block",
            label: { type: "plain_text", text: "Focus This Week?" },
            element: {
                type: "static_select",
                action_id: "focus",
                initial_option: { text: { type: "plain_text", text: task.focus_this_week || "No" }, value: task.focus_this_week || "No" },
                options: [ { text: { type: "plain_text", text: "Yes" }, value: "Yes" }, { text: { type: "plain_text", text: "No" }, value: "No" } ]
            }
          },
          {
            type: "input",
            block_id: "jtbd_block",
            optional: true,
            label: { type: "plain_text", text: "Linked JTBD" },
            element: { type: "plain_text_input", action_id: "jtbd", initial_value: typeof task.linked_jtbd === 'string' ? task.linked_jtbd : (task.linked_jtbd?.name || "") }
          }
        ]
      }
    });
};


// ==========================================================================
//  HELPER: TRANSCRIPT NORMALIZATION
// ==========================================================================

const normalizeTranscript = async (transcript, initialData, traceId) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAI API Key is missing.");
    
   const jsonFormatSchema = {
  "transcript_id": traceId || "generated_id", 
  "source": initialData.source,
  "source_id": initialData.source_id,
  "meeting_title": initialData.meeting_title,
  "created_at": new Date().toISOString(),
  "start_time": new Date(Date.now() - 3600000).toISOString(),
  "participants": [{ "name": "string", "email": "string", "role": "string" }],
  "summary": { "generated_at": new Date().toISOString(), "key_points": ["string"], "action_items_count": "number", "decisions_count": "number" },
  "extracted_entities": {
    "dates": ["string"], "people": ["string"], "decisions": ["string"],
    "projects": [
      {
        "project_name": "Island Way | Ridge Oak | Unknown",
        "tasks": [
          {
            "task_title": "string", "proposal_type": "Create new Task | Update existing Task",
            "linked_jtbd": { "name": "string", "url": "string" },
            "owner": "string", "status": "In progress | Done | To do",
            "priority_level": "High | Medium | Low", "source": "Virtual Meeting",
            "start_date": "YYYY-MM-DD or null", "due_date": "YYYY-MM-DD or null",
            "focus_this_week": "Yes | No",
            "notes": "2–4 sentence paragraph explaining action, context, dependencies, next step"
          }
        ],
        "associated_decisions": ["string"]
      }
    ]
  },
  "source_specific": {},
  "quality_metrics": { "transcription_accuracy": 0.95, "normalization_confidence": "number" }
};

    const prompt = `
    You are an expert task-extraction AI working for Prouvé projects.
    Analyze the transcript and extract structured tasks.
    CRITICAL: Use "${traceId}" as the transcript_id in the output.
    TRANSCRIPT: ${transcript}
    OUTPUT JSON SCHEMA: ${JSON.stringify(jsonFormatSchema)}
    `;

    try {
        logger.info('Sending request to OpenAI for normalization...', { traceId });
        const fetchResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
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
        const normalizedJson = JSON.parse(completion.choices[0].message.content);
        normalizedJson.transcript_id = traceId;
        return normalizedJson;

    } catch (error) {
        logger.error("OpenAI Normalization Error", error, { traceId });
        throw error;
    }
};

// --- HELPER: NOTION UTILS ---

const queryNotionDB = async (extractedProjects) => {
    if (!NOTION_TASK_DB_ID || !process.env.NOTION_API_KEY) { return { existing_tasks: [] }; }
    
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
        return { existing_tasks: existingTasks };
    } catch (error) {
        logger.error('NOTION DB QUERY ERROR', error);
        return { existing_tasks: [] };
    }
};

const listAllNotionDatabases = async () => {
    try {
        let allDBs = [];
        let cursor = undefined;
        do {
            const response = await notion.search({ query: "", start_cursor: cursor, page_size: 100 });
            if (response.results) {
                const databases = response.results.filter(item => item.object === 'database' || item.object === 'data_source');
                databases.forEach(item => {
                    allDBs.push({ id: item.id, title: item.title?.map(t => t.plain_text).join("") || "(No title)", object: item.object });
                });
            }
            cursor = response.has_more ? response.next_cursor : undefined;
        } while (cursor);
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
    const response = await notion.dataSources.query({ data_source_id, start_cursor: cursor, page_size: 100 });
    allPages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return allPages;
};

// --- HELPER: GENERATE TASK LIST (LEGACY) ---
const generateTaskList = async (normalizedData, notionContext) => {
    const allAIExtractedTasks = normalizedData.extracted_entities.projects.flatMap(p => 
      p.tasks.map(t => ({
        title: t.task_title, project: p.project_name, owner: t.owner || "Unassigned", 
        priority: t.priority_level || "Medium", linked_jtbd: t.linked_jtbd?.name || "TBD",
        proposal_type: t.proposal_type, notes: t.notes, status: t.status,
        start_date: t.start_date, due_date: t.due_date, focus_this_week: t.focus_this_week,
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
            taskList.push({ ...existingNotionTask, ...aiTask, action: 'UPDATE' });
        } else {
            taskList.push({ ...aiTask, action: 'CREATE', temp_id: crypto.randomBytes(4).toString('hex') });
        }
    }
    return taskList;
};


// ==========================================================================
//  ENDPOINT: SLACK INTERACTION (SEQUENTIAL LOOP)
// ==========================================================================

// ==========================================================================
//  ENDPOINT: SLACK INTERACTION (ASYNC UPDATE FIX)
// ==========================================================================

app.post('/api/v1/slack-interaction', async (req, res) => {
    try {
        const payload = JSON.parse(req.body.payload);
        const responseUrl = payload.response_url; // <--- KEY: Url to update message later

        // -------------------------------------
        // CASE 1: BUTTON CLICKS (ACCEPT / SKIP)
        // -------------------------------------
        if (payload.type === 'block_actions') {
            const action = payload.actions[0];
            const taskData = JSON.parse(action.value);
            const traceId = taskData.traceId || "no_trace_id";

            // 1. ACKNOWLEDGE IMMEDIATELY (Fixes 3s Timeout)
            // We tell Slack "We got it, stop loading." We will update the UI later.
            res.status(200).send(); 

            // 2. PERFORM WORK IN BACKGROUND
            (async () => {
                try {
                    // --- A. ACCEPT ---
                    if (action.action_id === 'accept_task') {
                        const sourceId = taskData.targetDbId || NOTION_TASK_DB_ID;
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

                        let successMsg = "";

                        // -- Notion Operation --
                        if (taskData.action === 'CREATE') {
                            logger.info(`Creating task: ${taskData.title}`, { traceId });
                            await notion.pages.create({ parent: { type: "data_source_id", data_source_id: sourceId }, properties: notionProperties });
                            successMsg = `✅ *Successfully Created* \n${taskData.title}`;
                        } else if (taskData.action === 'UPDATE') {
                            let pageId = taskData.id; 
                            if (!pageId && taskData.notion_url) {
                                const matches = taskData.notion_url.match(/([a-f0-9]{32})/);
                                if(matches) pageId = matches[0];
                            }
                            if (pageId) {
                                logger.info(`Updating Page ID: ${pageId}`, { traceId });
                                notionProperties["Notes"] = { rich_text: [{ text: { content: (taskData.notes || "") + "\n[Updated via Slack]" } }] };
                                await notion.pages.update({ page_id: pageId, properties: notionProperties });
                                successMsg = `✅ *Successfully Updated* \n${taskData.title}`;
                            }
                        }

                        // 3. SEND SUCCESS BOX (VIA AXIOS)
                        // This updates the message *after* Notion is done
                        if (responseUrl) {
                            await axios.post(responseUrl, {
                                replace_original: true,
                                blocks: [
                                    {
                                        type: "section",
                                        text: { type: "mrkdwn", text: successMsg }
                                    }
                                ]
                            });
                        }

                        // 4. TRIGGER NEXT ITEM
                        const queue = proposalQueues.get(traceId);
                        if (queue) {
                            queue.currentIndex++; 
                            proposalQueues.set(traceId, queue);
                            await sendNextProposal(traceId);
                        }
                    } 
                    
                    // --- B. SKIP ---
                    else if (action.action_id === 'skip_task') {
                        logger.info(`Skipped task: ${taskData.title}`, { traceId });
                        
                        // Send Skip Box
                        if (responseUrl) {
                            await axios.post(responseUrl, {
                                replace_original: true,
                                blocks: [
                                    {
                                        type: "section",
                                        text: { type: "mrkdwn", text: `⏭️ *Skipped Task* \n~${taskData.title}~` }
                                    }
                                ]
                            });
                        }

                        // Trigger Next
                        const queue = proposalQueues.get(traceId);
                        if (queue) {
                            queue.currentIndex++; 
                            proposalQueues.set(traceId, queue);
                            await sendNextProposal(traceId);
                        }
                    }

                    // --- C. FEEDBACK (OPEN MODAL) ---
                    else if (action.action_id === 'feedback_task') {
                        const sessionId = crypto.randomUUID();
                        feedbackSessions.set(sessionId, { task: taskData, iteration: 1, traceId: traceId });
                        // We ack'd early, but trigger_id is still valid for 3 seconds. Open modal now.
                        await openFeedbackModal(payload.trigger_id, { ...taskData, iteration: 1 }, sessionId);
                    }

                } catch (err) {
                    logger.error("Async Interaction Failed", err, { traceId });
                }
            })();

            return;
        }

        // -------------------------------------
        // CASE 2: MODAL SUBMISSION
        // -------------------------------------
        if (payload.type === 'view_submission' && payload.view.callback_id === 'feedback_modal_submit') {
            // Modals expect a specific JSON response to close (response_action: clear).
            // We CANNOT ack immediately with empty 200 here. We must return the json at the end.
            
            const metadata = JSON.parse(payload.view.private_metadata);
            const session = feedbackSessions.get(metadata.sessionId);
            if (!session) return res.status(200).json({ response_action: "clear" }); 

            const v = payload.view.state.values;
            const getVal = (block, action) => v[block]?.[action]?.value;
            const getTxt = (block, action) => v[block]?.[action]?.selected_option?.text?.text;
            const getDate = (block, action) => v[block]?.[action]?.selected_date;

            const updatedTask = {
                ...session.task,
                title: getVal('title_block', 'title'),
                notes: getVal('notes_block', 'notes') + "\n(Refined by User)",
                owner: getVal('owner_block', 'owner'),
                project: getVal('project_block', 'project'),
                priority: getTxt('priority_block', 'priority'), 
                status: getTxt('status_block', 'status'),
                focus_this_week: getTxt('focus_block', 'focus'),
                start_date: getDate('start_date_block', 'start_date'),
                due_date: getDate('due_date_block', 'due_date'),
                linked_jtbd: getVal('jtbd_block', 'jtbd')
            };

            const queue = proposalQueues.get(session.traceId);
            if (queue) {
                // Update memory
                queue.tasks[queue.currentIndex] = updatedTask;
                proposalQueues.set(session.traceId, queue);
                
                // Repost the message (re-triggers the "sendNext" logic but keeps index same)
                setTimeout(() => sendNextProposal(session.traceId), 500); 
            }

            return res.status(200).json({ response_action: "clear" });
        }

    } catch (error) {
        logger.error("Slack Interaction Error", error);
        if (!res.headersSent) res.status(500).send("Error");
    }
});


// ==========================================================================
//  MAIN PROCESS ENDPOINT
// ==========================================================================

app.post('/api/v1/process-transcript', async (req, res) => {
  try {
    const { transcript, source, source_id, meeting_title, participants, raw_transcript, request_id } = req.body;
    const traceId = request_id || req.body.trace_id || crypto.randomUUID();
    logger.info(`🚀 Processing started for source: ${source}`, { traceId });

    if (!transcript) { return res.status(400).send({ error: "Transcript text is required." }); }

    // 1. Normalize
    const normalized = await normalizeTranscript(transcript, { source, source_id, meeting_title, participants }, traceId);

    // 2. DB Save
    try {
        const TranscriptModel = mongoose.model('NormalizedTranscript');
        const newTranscript = new TranscriptModel({
            transcript_id: traceId,
            source: source || "unknown", source_id: source_id || "unknown", meeting_title: meeting_title || "Untitled",
            participants: participants || [], raw_transcript: raw_transcript || transcript,
            normalized_data: { summary: normalized.summary, extracted_entities: normalized.extracted_entities, quality_metrics: normalized.quality_metrics, source_specific: normalized.source_specific || {} }
        });
        await newTranscript.save();
    } catch (dbError) { logger.error("DB Save Failed", dbError, { traceId }); }

    // 3. Project & DB Match
    const projectBlock = normalized.extracted_entities.projects?.[0];
    const projectName = projectBlock?.project_name?.trim();
    if (!projectName) { return res.status(400).send({ error: "No project name found." }); }

    const allSources = await listAllNotionDatabases();
    let chosenTitle = await findBestDatabaseMatch(projectName, allSources);
    if (!chosenTitle) chosenTitle = allSources.find(ds => ds.title.toLowerCase().includes(projectName.toLowerCase()))?.title;
    if (!chosenTitle) return res.status(404).send({ error: "No matching Notion DB found." });

    const match = allSources.find(ds => ds.title === chosenTitle);
    
    // 4. Context & Logic
    const allPages = await fetchAllRowsInDataSource(match.id);
    const existingTasks = allPages.map(simplifyAnyPage).map(page => ({
        id: page.id || "", title: page.task || "", status: page.status || "", notes: page.notes || "",         
        url: `https://www.notion.so/${(page.id || "").replace(/-/g, "")}`
    }));

    // 5. Generate Proposals
    const proposals = normalized.extracted_entities.projects.flatMap(p =>
        p.tasks.map(t => ({
            title: t.task_title, project: p.project_name, notes: t.notes, status: t.status,
            owner: t.owner || "Unassigned", priority: t.priority_level || "Medium",
            linked_jtbd: t.linked_jtbd?.name || "TBD", start_date: t.start_date, due_date: t.due_date, focus_this_week: t.focus_this_week
        }))
    );

    // 6. Semantic Compare (Create vs Update)
    const finalOutput = [];
    for (const proposal of proposals) {
      try {
       const comparePrompt = `
        You are the Prouvé Sync Manager. Decide CREATED or UPDATED.
        TASK PROPOSAL: ${JSON.stringify(proposal)}
        EXISTING NOTION TASKS: ${JSON.stringify(existingTasks)}
        RETURN JSON ONLY. { action: "CREATE" | "UPDATE", notion_url: "...", title: "...", ...all_fields }
        `;
        const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({ model: "gpt-5.2", messages: [{ role: "user", content: comparePrompt }], response_format: { type: "json_object" } }),
        });
        const jsonResp = await gptResponse.json();
        finalOutput.push(JSON.parse(jsonResp.choices[0].message.content));
      } catch (err) { logger.error("Comparison error", err, { traceId }); }
    }

    // 7. INITIALIZE QUEUE (Do NOT send all messages)
    proposalQueues.set(traceId, {
        tasks: finalOutput,
        currentIndex: 0,
        meetingTitle: meeting_title || "Virtual Meeting",
        targetDbId: match.id
    });

    // 8. SEND FIRST MESSAGE TO START LOOP
    await sendNextProposal(traceId);

    return res.status(200).send({ trace_id: traceId, result: finalOutput });

  } catch (error) {
    logger.error("PROCESS ERROR", error);
    return res.status(500).send({ error: error.message });
  }
});

// --- LEGACY ENDPOINTS (RESTORED) ---

app.get('/api/v1/notion-data-source-rows', async (req, res) => {
  try {
    const { db_id } = req.query;
    if (!db_id) return res.status(400).send({ message: "Missing query param: db_id" });
    const pages = await fetchAllRowsInDataSource(db_id);
    res.status(200).send({ count: pages.length, pages: pages.map(simplifyAnyPage) });
  } catch (error) {
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

app.post('/api/v1/slack-approved-tasks', async (req, res) => {
    const approvedTasks = req.body.tasks; 
    if (!approvedTasks || approvedTasks.length === 0) {
        return res.status(400).send({ message: "No tasks provided for update." });
    }
    res.status(200).send({ message: 'Legacy endpoint.' });
});

app.post('/api/v1/normalize', async (req, res) => {
    const { transcript, source, source_id, meeting_title, participants, raw_transcript } = req.body; 
    if (!transcript) return res.status(400).send({ message: "Transcript is required." });
    try {
        const traceId = crypto.randomUUID();
        const normalizedJson = await normalizeTranscript(transcript, { source, source_id, meeting_title, participants }, traceId);
        res.status(200).send({ normalized_json: normalizedJson });
    } catch (error) {
        logger.error('Normalization process failed', error);
        res.status(500).send({ message: `Normalization failed: ${error.message}` });
    }
});

app.post('/api/v1/generate-tasks', async (req, res) => {
    const { normalized_data } = req.body;
    try {
        const actualNotionContext = await queryNotionDB(normalized_data.extracted_entities.projects);
        const taskList = await generateTaskList(normalized_data, actualNotionContext);
        res.status(200).send({ message: 'Task list generated.' });
    } catch (error) {
        logger.error('Task Generation failed', error);
        res.status(500).send({ message: 'Failed to generate task list.', error: error.message });
    }
});

// --- DEBUG FUNCTION ---
const debugNotionAccess = async () => {
    try {
        const response = await notion.search({}); 
        const databases = response.results.filter(item => item.object === 'database' || item.object === 'data_source');
        console.log(`\n--- 📋 FOUND ${databases.length} DATABASES ---`);
    } catch (error) { logger.error("Notion Connection Error", error); }
};

const startServer = async () => {
    await debugNotionAccess(); 
    await connectDB();
    app.listen(PORT, () => { logger.info(`🧠 MCP Server running on port ${PORT}`); });
};

startServer();