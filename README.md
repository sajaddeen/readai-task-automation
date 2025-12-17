# ReadAI Task Automation

**Automated Task Extraction and Management from Meeting Transcripts**  
A Node.js/Express application integrated with OpenAI, Notion, and Slack to extract, normalize, and manage tasks from meeting transcripts.

---

## Features

- **Transcript Normalization:** Uses OpenAI GPT API to parse meeting transcripts into structured, actionable tasks.
- **Task Management:** Checks existing tasks in Notion, creates new tasks, and updates existing ones.
- **Slack Integration:** Sends task proposals for approval and review via Slack.
- **Secure:** Sensitive keys are loaded via environment variables (`.env`) and never pushed to the repository.

---

## Tech Stack

- **Backend:** Node.js, Express
- **Database:** MongoDB
- **AI:** OpenAI GPT API
- **Integrations:** Notion API, Slack Web API
- **Other Tools:** Axios, Crypto, Mongoose

---

## Installation

1. Clone the repository:

```bash
git clone https://github.com/sajaddeen/readai-task-automation.git
cd readai-task-automation
npm install
npm run start:all



