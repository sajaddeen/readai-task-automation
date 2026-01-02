const findBestDatabaseMatch = async (projectName, allSources) => {
  if (!projectName || !Array.isArray(allSources) || allSources.length === 0) {
    return null;
  }

  // Build simple array of titles (we’ll send this to GPT)
  const dbTitles = allSources.map(ds => ds.title);

  const prompt = `
You are an expert project database matcher.
Given a project name and a list of Notion database titles, pick the ONE database title that best matches the project.

Project Name:
"${projectName}"

Available Notion DB Titles:
${JSON.stringify(dbTitles, null, 2)}

Return exactly the best matching database title.
If none matches with confidence, return an empty string.
`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-5.2",
      messages: [
        { role: "system", content: "You match project names to DB titles." },
        { role: "user", content: prompt }
      ],
      temperature: 0.0
    })
  });

  const json = await response.json();
  const text = json.choices?.[0]?.message?.content?.trim();

  // The model should return exactly one of the dbTitles, or empty string
  if (dbTitles.includes(text)) {
    return text;
  }
  return null;
};


module.exports = {
  findBestDatabaseMatch
};