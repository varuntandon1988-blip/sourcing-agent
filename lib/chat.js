// Chat agent: takes a user message + current candidate list and returns
// either a filter (to mark candidates as shortlisted) or a plain answer.
import { aiJson } from "./ai.js";

export async function chatShortlist({ message, candidates, role }) {
  const compact = candidates.slice(0, 200).map((c) => ({
    id: c.id,
    name: c.name,
    headline: c.headline,
    company: c.company,
    location: c.location,
    score: c.score,
    skills: c.matchedSkills,
    portal: c.portal,
    shortlisted: !!c.shortlisted,
  }));

  const prompt = `You are a recruiter assistant working with a candidate list.

Role: ${role?.title || "(none)"}
Must-have skills: ${(role?.skills || []).join(", ")}

User says: "${message}"

Candidates (id + key fields):
${JSON.stringify(compact)}

Decide what to do. Return JSON:
{
  "action": "shortlist" | "unshortlist" | "answer",
  "ids": [string],            // candidate ids to act on (only for shortlist/unshortlist)
  "reply": string             // short message back to the user explaining what you did
}

Rules:
- "shortlist" = add these ids to the shortlist
- "unshortlist" = remove these ids
- "answer" = just answer the question, no list change
- Be strict: only include candidates that clearly match the user's criteria.
- Keep reply under 2 sentences.`;
  return aiJson(prompt, { system: "You convert recruiter requests into shortlist actions." });
}
