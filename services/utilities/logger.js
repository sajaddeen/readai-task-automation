const { WebClient } = require('@slack/web-api');

// Initialize Slack for error alerting
const slackToken = process.env.SLACK_BOT_TOKEN;
const slackChannel = process.env.SLACK_APPROVAL_CHANNEL; 
const slackClient = slackToken ? new WebClient(slackToken) : null;

const getTimestamp = () => new Date().toISOString();

const logger = {
    // 1. INFO: Standard logs for tracking flow
    info: (message, meta = {}) => {
        const traceTag = meta.traceId ? `[Trace: ${meta.traceId}]` : '';
        console.log(`[INFO]  ${getTimestamp()} ${traceTag} ${message}`);
    },

    // 2. WARN: Expected issues (missing data, validation failures)
    warn: (message, meta = {}) => {
        const traceTag = meta.traceId ? `[Trace: ${meta.traceId}]` : '';
        console.warn(`[WARN]  ${getTimestamp()} ${traceTag} ⚠️ ${message}`);
    },

    // 3. ERROR: Critical failures (Sends to Console + Slack)
    error: async (message, errorObj = null, meta = {}) => {
        const traceTag = meta.traceId ? `[Trace: ${meta.traceId}]` : '';
        const errorMessage = errorObj ? ` | ${errorObj.message}` : '';
        const stackTrace = errorObj && errorObj.stack ? `\n${errorObj.stack}` : '';
        
        // Print to Server Console
        console.error(`[ERROR] ${getTimestamp()} ${traceTag} ❌ ${message}${errorMessage}`);
        if (stackTrace) console.error(stackTrace);

        // --- ALERT: SEND TO SLACK ---
        if (slackClient && slackChannel) {
            try {
                await slackClient.chat.postMessage({
                    channel: slackChannel,
                    text: `🚨 *Server Error*\n*Message:* ${message}\n*Trace ID:* \`${meta.traceId || 'N/A'}\`\n*Error:* ${errorMessage}`,
                    blocks: [
                        {
                            type: "header",
                            text: { type: "plain_text", text: "🚨 Critical Error Detected" }
                        },
                        {
                            type: "section",
                            fields: [
                                { type: "mrkdwn", text: `*Message:*\n${message}` },
                                { type: "mrkdwn", text: `*Trace ID:*\n\`${meta.traceId || 'N/A'}\`` }
                            ]
                        },
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: `*Technical Detail:*\n\`\`\`${errorMessage}\`\`\``
                            }
                        }
                    ]
                });
            } catch (err) {
                console.error("Failed to send error alert to Slack:", err.message);
            }
        }
    }
};

module.exports = logger;