// notionHelpers.js

// Extracts task title from the Notion title property
const parseTitle = (prop) => {
  return prop?.title?.map(t => t.plain_text).join("") || "";
};

// Extracts status from the Notion status property
const parseStatus = (prop) => {
  return prop?.status?.name || "";
};

// Simplifies the Notion page into only id, task, and status
const simplifyAnyPage = (page) => {
  const props = page.properties || {};

  return {
    id: page.id,
    task: parseTitle(props.Tasks),
    status: parseStatus(props.Status)
  };
};

module.exports = {
  simplifyAnyPage
};
