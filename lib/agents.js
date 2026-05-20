// High-level AI tasks: parse JD, generate search strings, refine boolean, score candidate.
// Written from the POV of a *Principal Recruiter* at a FAANG / top internet company.
import { aiJson, aiText } from "./ai.js";

const FAANG_SYSTEM = [
  "You are a Principal Recruiter at a top FAANG / internet-scale company (Google, Meta, Amazon, Apple, Netflix, Uber, Airbnb, Stripe, Snowflake, Linkedin, Microsoft).",
  "You source like a senior practitioner, NOT a keyword bot:",
  "1) Skill selection: pick the core role-defining skills with the right BREADTH — not too narrow (one library), not too generic ('software'). Infer adjacent skills strong candidates likely have even if not literally in the JD.",
  "2) Exclusions: actively exclude irrelevant skills, outdated tech, and unrelated titles (e.g. for an IC backend role exclude 'manager', 'sales', 'marketing', 'support', 'qa', 'intern', 'fresher', 'student', 'teacher').",
  "3) Target companies: ALWAYS honour the provided target-company list. Never bypass it. Prefer it as the primary signal of pedigree.",
  "4) Location: weight the JD location heavily; only relax if the JD is explicitly remote / location-agnostic.",
  "5) Titles: include the exact role family + true synonyms across seniority (Senior / Staff / Principal / Lead). Exclude titles that don't match the level or function.",
  "Output is precise, structured, no fluff. Prefer high signal over breadth.",
].join(" ");

export async function parseJD(jdText) {
  const prompt = `Read this job description and return JSON with:
{
  "title": string,
  "seniority": string,
  "mustHaveSkills": string[],
  "niceToHaveSkills": string[],
  "experienceMin": number,
  "experienceMax": number,
  "locations": string[],
  "summary": string,
  "targetCompaniesSuggested": string[]
}

Job description:
"""
${jdText.slice(0, 12000)}
"""

Return only the JSON.`;
  return aiJson(prompt, { system: FAANG_SYSTEM });
}

// Build/refine a single LinkedIn Recruiter boolean string for the role.
// Returns full strategy: titles in/out, skills in/out, companies, location, and final boolean.
export async function refineBoolean({
  role,
  companies = [],
  mustHaveKeywords = [],
  excludeKeywords = [],
  excludeCompaniesHard = [],
  idealResumeExcerpts = "",
}) {
  const companyList = companies.slice(0, 60).join(", ");
  const hasCompanies = companies.length > 0;
  const mustList = (mustHaveKeywords || []).filter(Boolean);
  const exKw = (excludeKeywords || []).filter(Boolean);
  const exCo = (excludeCompaniesHard || []).filter(Boolean);
  const resumesBlock = idealResumeExcerpts
    ? `\n\nIDEAL PROFILE RESUMES (mine these for real-world title variants, tool synonyms, and adjacent skills — prefer phrasing seen here over generic JD wording):\n"""\n${String(idealResumeExcerpts).slice(0, 6000)}\n"""\n`
    : "";

  const prompt = `Act as a Principal Recruiter. Build the sourcing strategy + ONE LinkedIn Recruiter boolean for this role.

Return JSON exactly:
{
  "titlesInclude": string[],     // 4-6 true title synonyms across right seniority
  "titlesExclude": string[],     // titles to suppress (wrong level/function)
  "skillsInclude": string[],     // 4-7 core role-defining skills (with adjacent inferred skills)
  "skillsExclude": string[],     // outdated / irrelevant / loosely connected skills to suppress
  "companiesPriority": string[], // up to 20 target companies, picked from the provided list, ordered by relevance
  "companiesExclude": string[],  // companies that MUST be excluded (echo back the hard list verbatim + any others you'd add)
  "location": string,            // primary location to target (or "remote")
  "boolean": string,             // single-line LinkedIn Recruiter boolean, see shape below
  "rationale": string            // 1-2 sentences on why these choices
}

Boolean shape (single line, parentheses around every OR group, multi-word phrases quoted):
("Title1" OR "Title2" OR "Title3" OR "Title4")
AND ("must1" OR "must1-syn") AND ("must2" OR "must2-syn")     // one AND-group per HARD MUST-HAVE
AND ("skill1" OR "skill1-syn") AND ("skill2" OR "skill2-syn")
${hasCompanies ? "AND (\"Company1\" OR \"Company2\" ... up to 15 from companiesPriority)  // MUST be present, non-negotiable" : "[AND (company OR clause) only if pedigree is critical]"}
NOT ("intern" OR "fresher" OR "student" OR <titlesExclude> OR <excludeKeywords> OR <excludeCompaniesHard quoted>)

Hard rules:
- Every term in HARD MUST-HAVES MUST appear as its own AND-group with 1-2 AI-picked synonyms. Never drop one.
- 3-4 skill AND-groups max BEYOND the must-haves (don't over-AND or recall collapses).
- Each skill group has 2-3 synonyms (e.g. ("kubernetes" OR "k8s"), ("golang" OR "go"), ("react" OR "reactjs")).
- Title group covers right seniority only.
- NOT clause MUST include: titlesExclude + obvious noise (intern/student/fresher; manager/director if IC; sales/marketing/support if engineering) + EVERY term in HARD EXCLUDE KEYWORDS + EVERY company in HARD EXCLUDE COMPANIES (quoted exactly).
- ${hasCompanies ? "Company OR clause MUST appear and use companies ONLY from the supplied target-company list." : ""}
- No markdown, no commentary outside the JSON.

Role title: ${role.title}
Seniority: ${role.parsed?.seniority || ""}
Must-have skills (from JD): ${(role.skills || []).join(", ")}
Nice-to-have: ${(role.parsed?.niceToHaveSkills || []).join(", ")}
Experience: ${role.expMin ?? ""}-${role.expMax ?? ""} years
Locations (JD): ${(role.locations || []).join(", ")}
Target-company list (use ONLY these for the company clause): ${companyList || "(none provided)"}

HARD MUST-HAVES (each becomes its own AND-group, never drop): ${mustList.join(", ") || "(none)"}
HARD EXCLUDE KEYWORDS (must appear in NOT clause): ${exKw.join(", ") || "(none)"}
HARD EXCLUDE COMPANIES (must appear in NOT clause, quoted): ${exCo.join(", ") || "(none)"}
${resumesBlock}
JD summary: ${(role.parsed?.summary || role.jdText || "").slice(0, 2500)}

Return only the JSON.`;
  return aiJson(prompt, { system: FAANG_SYSTEM });
}

// Naukri Resdex boolean — DIFFERENT discipline from LinkedIn:
// - Naukri's keyword field searches RESUME TEXT, not structured profile fields.
// - Title, location, experience, active-in are entered in SEPARATE form fields, so
//   the boolean must NOT include them (waste of the 500-char budget).
// - Target-company AND clause hurts recall (most resumes don't list every target).
// - Budget is 500 chars HARD. Aim for ~420 to leave room for safety-net injection.
// - Recruiters on Naukri rely on must-have skills + 1-2 differentiators + NOT noise.
export async function refineBooleanNaukri({
  role,
  mustHaveKeywords = [],
  excludeKeywords = [],
  excludeCompaniesHard = [],
  idealResumeExcerpts = "",
}) {
  const mustList = (mustHaveKeywords || []).filter(Boolean);
  const exKw = (excludeKeywords || []).filter(Boolean);
  const exCo = (excludeCompaniesHard || []).filter(Boolean);
  // Tight excerpt — Naukri prompt is small on purpose.
  const resumesBlock = idealResumeExcerpts
    ? `\n\nIDEAL RESUME EXCERPTS (mine for the EXACT phrasing Indian candidates write on Naukri — tool acronyms, framework variants, certification names):\n"""\n${String(idealResumeExcerpts).slice(0, 3000)}\n"""\n`
    : "";

  const prompt = `Act as a Principal Recruiter sourcing on Naukri Resdex. Build ONE boolean for the KEYWORDS field only.

CONTEXT — Naukri-specific rules you MUST follow:
- The KEYWORDS field searches RESUME TEXT. Title, location, experience, and active-in are ENTERED IN SEPARATE FIELDS and MUST NOT appear in the boolean.
- HARD LIMIT: 500 characters. AIM FOR <= 420. Every char counts.
- Resumes in India use acronyms ("k8s", "GCP", "RDBMS") more than full forms. Prefer the acronym + 1 long form, not 3 synonyms.
- Do NOT add a target-company AND clause (kills recall on resume text).
- Do NOT add title synonyms (handled by Naukri's "Keywords in Designation" / role field separately).
- Use uppercase AND / OR / NOT. Quote EVERY term (single or multi-word) in double quotes. Parentheses around every OR group AND every must-have group.
- The output MUST be a SINGLE LINE of pure boolean syntax. NO bullet points, NO numbering, NO line breaks, NO markdown, NO commentary, NO labels like "Must-haves:" — just the boolean string.
- Structure (in this order, all on one line, joined by AND):
    ("must1" OR "must1-syn") AND ("must2" OR "must2-syn") ... [each HARD MUST-HAVE as its own AND-group, max 2 synonyms, ALWAYS wrapped in parens even if single term]
    AND ("diff1" OR "diff2" OR "diff3")   [ONE optional differentiator group of 3-5 high-signal skills, only if budget allows]
    NOT ("intern" OR "fresher" OR "trainee" OR <excludeKeywords quoted> OR <excludeCompaniesHard quoted>)
- Example shape: ("react" OR "reactjs") AND ("node" OR "nodejs") AND ("typescript" OR "ts") AND ("aws" OR "gcp" OR "azure") NOT ("intern" OR "fresher" OR "trainee" OR "TCS" OR "Infosys")
- If must-haves alone push you near 420 chars, DROP the optional differentiator group entirely. Must-haves and NOT are non-negotiable.
- Keep the NOT clause LEAN: standard noise (intern/fresher/trainee) + every HARD EXCLUDE keyword + every HARD EXCLUDE COMPANY (quoted). If still tight, keep companies but drop one or two of the standard noise terms.

Return JSON exactly:
{
  "boolean": string,                // single line, <=500 chars
  "mustHaveCoverage": string[],     // echo each HARD MUST-HAVE you placed in the boolean
  "differentiators": string[],      // skills you put in the optional group (or [])
  "droppedForBudget": string[],     // anything you wanted to add but couldn't fit
  "charCount": number,              // length of boolean
  "rationale": string               // 1-2 sentences on the trade-offs
}

Role: ${role.title}
Seniority: ${role.parsed?.seniority || ""}
JD must-have skills: ${(role.skills || []).join(", ")}
Nice-to-have: ${(role.parsed?.niceToHaveSkills || []).join(", ")}
HARD MUST-HAVES (each becomes its own AND-group, never drop): ${mustList.join(", ") || "(none)"}
HARD EXCLUDE KEYWORDS (must be in NOT): ${exKw.join(", ") || "(none)"}
HARD EXCLUDE COMPANIES (must be in NOT, quoted; drop lowest-priority ones only if over 500 chars): ${exCo.join(", ") || "(none)"}
${resumesBlock}
JD summary: ${(role.parsed?.summary || role.jdText || "").slice(0, 1500)}

Return only the JSON. The boolean MUST be <=500 chars.`;
  return aiJson(prompt, { system: FAANG_SYSTEM });
}

// =====================================================================
// PRINCIPAL-RECRUITER SOURCING STRATEGY ENGINE
// One AI call returns a full strategy: hiring thesis + ideal-profile pattern
// detection + company intelligence + 12 booleans (4 modes × 3 portals) with
// reasoning, suggested filters, and an optimization score per boolean.
// =====================================================================
export async function generateSourcingStrategy({
  role,
  companies = [],
  categorized = null,
  mustHaveKeywords = [],
  excludeKeywords = [],
  excludeCompaniesHard = [],
  idealResumeExcerpts = "",
  recruiterNotes = "",
  companyStage = "",
}) {
  const companyList = (companies || []).slice(0, 80).join(", ");
  const mustList = (mustHaveKeywords || []).filter(Boolean);
  const exKw = (excludeKeywords || []).filter(Boolean);
  const exCo = (excludeCompaniesHard || []).filter(Boolean);
  const resumesBlock = idealResumeExcerpts
    ? `\n\nIDEAL PROFILE RESUMES (mine these for REAL title variants, tool acronyms, adjacent skills, trajectory & scale signals — these are the gold standard, prefer them over JD wording):\n"""\n${String(idealResumeExcerpts).slice(0, 8000)}\n"""\n`
    : "";
  const notesBlock = recruiterNotes
    ? `\n\nRECRUITER NOTES (additional human context — weight heavily):\n"""\n${String(recruiterNotes).slice(0, 2000)}\n"""\n`
    : "";
  const catBlock = (categorized && categorized.categories && categorized.categories.length)
    ? `\n\nRECRUITER-SELECTED TARGET COMPANY CATEGORIES (THIS IS THE PRIMARY COMPANY-INTELLIGENCE INPUT — every precision and expansion boolean MUST include companies drawn from this list, treat the category names as the talent thesis):\n${categorized.categories.map((c) => `• ${c.name}: ${(c.companies || []).slice(0, 40).join(", ")}`).join("\n")}${categorized.customCompanies && categorized.customCompanies.length ? `\n• Custom: ${categorized.customCompanies.join(", ")}` : ""}\n`
    : "";

  const SYSTEM = `${FAANG_SYSTEM}
You are NOT a keyword combiner. You are a Principal Recruiter doing strategic talent mapping. You MUST combine JD + ideal profiles + recruiter-selected companies + recruiter notes + portal-specific behavior. NEVER generate booleans purely from the JD. Reward trajectory, scope growth, complexity handled, transferable backgrounds. Distinguish builders from maintainers, operators from strategists. Aggressively reduce false positives (inflated titles, support-heavy, consultant-heavy, low-ownership, keyword-stuffed resumes).`;

  const prompt = `Build a complete sourcing strategy for this role and return ONE JSON object (no markdown, no commentary).

REQUIRED JSON SHAPE:
{
  "thesis": {
    "businessProblem": string,
    "mustWinCompetencies": string[],
    "nonNegotiables": string[],
    "seniorityExpectations": string,
    "builderVsOperator": "builder" | "operator" | "mixed",
    "domainComplexity": string,
    "scaleExpectations": string,
    "successIndicators": string[],
    "falsePositives": string[],
    "transferableBackgrounds": string[],
    "adjacentTalentPools": string[]
  },
  "idealProfilePatterns": {
    "highSignalTitles": string[],
    "adjacentTitles": string[],
    "recurringSkills": string[],
    "recurringCompanies": string[],
    "trajectoryPatterns": string[],
    "weakSignals": string[],
    "noiseSignals": string[]
  },
  "companyIntelligence": {
    "exactTargets": string[],
    "adjacentCompanies": string[],
    "transferablePools": string[],
    "competitivePools": string[]
  },
  "portals": {
    "linkedin":  { "precision": <ModeBlock>, "expansion": <ModeBlock>, "highPotential": <ModeBlock>, "hiddenGem": <ModeBlock> },
    "naukri":    { "precision": <ModeBlock>, "expansion": <ModeBlock>, "highPotential": <ModeBlock>, "hiddenGem": <ModeBlock> },
    "instahyre": { "precision": <ModeBlock>, "expansion": <ModeBlock>, "highPotential": <ModeBlock>, "hiddenGem": <ModeBlock> }
  },
  "sourcingStrategy": string  // 2-4 sentence narrative the recruiter can act on
}

ModeBlock shape:
{
  "boolean": string,                 // single line, valid boolean syntax (see portal rules)
  "charCount": number,               // length of boolean string
  "signalsPrioritized": string[],    // which signals you weighted (e.g. "scale handled", "payments domain")
  "adjacentPoolsAdded": string[],    // adjacent talent pools mixed in (empty for precision)
  "exclusionsApplied": string[],     // notable exclusions in NOT clause
  "suggestedFilters": {              // recruiter-side platform filters (NOT in boolean)
    "location": string,
    "yearsMin": number,
    "yearsMax": number,
    "seniority": string[],
    "currentCompanies": string[]
  },
  "rationale": string,               // 1-2 sentences on WHY this boolean is shaped this way; reference ideal-profile + company patterns
  "patternsUsed": string[],          // which idealProfilePatterns / companyIntelligence buckets you drew from
  "optimizationScore": number        // 0-100, your honest self-assessment of portal fit
}

PORTAL-SPECIFIC BOOLEAN RULES (HARD):
- LinkedIn: 250-400 chars ideal, 600 hard cap. Use exact phrase titles. Shallow nesting. Title cluster + skills + (optional) company OR + NOT. DO NOT stuff location/years/seniority into the boolean — surface those in suggestedFilters.
- Naukri: 500 char HARD cap. Resume-text optimised. Use acronyms + 1 long form (e.g. "k8s" OR "kubernetes"). NO title AND-clause (Naukri has a separate Designation field). NO company AND-clause (kills recall on resume text). Companies/titles go in suggestedFilters. Keep NOT clause lean.
- Instahyre: 500-800 chars. Skill+context pairing (e.g. "react" AND "typescript"). Include startup/scaleup context terms when relevant ("startup", "B2B SaaS", "platform", "product engineering"). Keep structure clean.

MODE RULES:
- precision: tight, exact-fit, exact titles + target companies + core domain + must-haves; strong exclusions.
- expansion: add adjacent titles, adjacent domains, transferable systems, related operating environments. Avoid excessive narrowing.
- highPotential: prioritize trajectory, scale exposure, growth-stage companies, builder cultures, execution-heavy profiles. Reduce dependence on pedigree.
- hiddenGem: avoid over-indexing on top brands; reward fast growth, ownership, complexity handled, strong trajectory at underrated companies.

UNIVERSAL HARD RULES (apply to EVERY mode in EVERY portal):
- Every term in HARD MUST-HAVES MUST appear (with 1-2 synonyms) — its own AND-group. Never drop one.
- Every term in HARD EXCLUDE KEYWORDS MUST appear in the NOT clause, quoted.
- Every company in HARD EXCLUDE COMPANIES MUST appear in the NOT clause, quoted.
- Single line. Uppercase AND / OR / NOT. Every term quoted. Parentheses around every group.
- No markdown, no bullets, no commentary inside the boolean.

TARGET COMPANY CATEGORY RULES (CRITICAL — the recruiter selected these categories on purpose):
- precision: include a (companyA OR companyB OR ...) AND-group drawn ONLY from the selected categories (LinkedIn 10-15, Instahyre 8-12). Naukri: do NOT put companies inside the boolean — list them in suggestedFilters.currentCompanies instead.
- expansion: include category companies plus 3-5 ADJACENT companies you infer from the category names (e.g. "FAANG" → adjacent unicorn product cos). Naukri: same — filters only.
- highPotential: do NOT lock to the category list (focus on trajectory/scale at growth-stage cos), but mention the category names in patternsUsed.
- hiddenGem: deliberately AVOID the category list inside the boolean (recruiter already covered the obvious pool); pick underrated cos in adjacent spaces. Mention the avoided category names in rationale.
- For EVERY mode and portal, populate suggestedFilters.currentCompanies with the recruiter's selected category companies (top 25) so the recruiter can paste them into the platform's company filter.

INPUTS:
Role title: ${role.title}
Seniority: ${role.parsed?.seniority || ""}
Experience: ${role.expMin ?? ""}-${role.expMax ?? ""} years
Locations (JD): ${(role.locations || []).join(", ")}
Work mode: ${role.workMode || ""}
Company stage preference: ${companyStage || "any"}
Must-have skills (from JD): ${(role.skills || []).join(", ")}
Nice-to-have: ${(role.parsed?.niceToHaveSkills || []).join(", ")}
Recruiter-selected target companies (flat list): ${companyList || "(none provided)"}
${catBlock}
HARD MUST-HAVES (each its own AND-group, every mode): ${mustList.join(", ") || "(none)"}
HARD EXCLUDE KEYWORDS (every NOT clause): ${exKw.join(", ") || "(none)"}
HARD EXCLUDE COMPANIES (every NOT clause, quoted): ${exCo.join(", ") || "(none)"}
${notesBlock}${resumesBlock}
JD summary: ${(role.parsed?.summary || role.jdText || "").slice(0, 3000)}

Return only the JSON.`;
  return aiJson(prompt, { system: SYSTEM });
}

export async function generateSearchStrings({ role, companies }) {
  const companyList = companies.slice(0, 60).join(", ");
  const prompt = `Build sourcing search queries for one role. Return JSON:
{
  "linkedin": "<LinkedIn boolean: see shape below>",
  "naukri": "<Naukri keywords (space separated, OR/AND)>",
  "instahyre": "<Instahyre keywords, comma separated>"
}

Role title: ${role.title}
Must-have skills: ${(role.skills || []).join(", ")}
Locations: ${(role.locations || []).join(", ")}
Experience: ${role.expMin ?? ""}-${role.expMax ?? ""} years
Target companies (use most relevant 10-15):
${companyList}

JD summary:
${(role.parsed?.summary || role.jdText || "").slice(0, 3000)}

LinkedIn boolean shape: ("Title A" OR "Title B" OR "Title C") AND ("skill1" OR "skill1-syn") AND ("skill2" OR "skill2-syn") AND ("Company1" OR "Company2" OR ...) NOT ("intern" OR "manager" OR ...). Single line, multi-word phrases quoted. Return only the JSON.`;
  return aiJson(prompt, { system: FAANG_SYSTEM });
}

export async function scoreCandidate({ role, candidate, workMode = "", targetCompanies = [], excludeCompaniesHard = [], mustHaveKeywords = [], idealResumeExcerpts = "" }) {
  const mode = (workMode || role.workMode || "").toLowerCase(); // "remote" | "hybrid" | "onsite" | ""
  const isRemote = /remote/.test(mode);
  // Weighting bands per requirement.
  const wResume = isRemote ? 85 : 78;        // Resume/JD match: 75-85
  const wLocation = isRemote ? 8 : 15;        // Location match: 10-15 (lower if remote)
  const wDiversity = 7;                       // Diversity (only if compliantly provided): 5-7
  const targetCo = (targetCompanies || []).slice(0, 30).join(", ");
  const exCo = (excludeCompaniesHard || []).filter(Boolean);
  const musts = (mustHaveKeywords || []).filter(Boolean);
  const idealBlock = idealResumeExcerpts
    ? `\nIdeal-profile resume excerpts (use as the gold standard for skill/title/company fit):\n"""\n${String(idealResumeExcerpts).slice(0, 1500)}\n"""\n`
    : "";

  const prompt = `Act as a Principal Recruiter. Score this candidate using a WEIGHTED model. Return JSON:
{
  "score": number,                  // final 0-100, computed using the weights below
  "subscores": {
    "resumeJdMatch": number,        // 0-100: core skills + JD fit + relevant experience + title relevance + company relevance
    "locationMatch": number,        // 0-100: see location rubric
    "diversity": number             // 0-100: ONLY if compliant diversity data is explicitly provided; otherwise 0 (and weight is reallocated)
  },
  "weightsUsed": { "resumeJd": number, "location": number, "diversity": number },
  "matchedSkills": string[],
  "gaps": string[],
  "titleFit": string,               // 1 line: how the candidate's title maps to the role / seniority
  "companyFit": string,             // 1 line: pedigree vs. target-company list & FAANG/internet-scale
  "locationFit": string,            // 1 line: city distance, relocation signal, hybrid/onsite/remote fit
  "diversityNote": string,          // "" if no compliant data; otherwise short note on the compliant signal used
  "rationale": string               // 2-3 sentences explaining WHY ranked here: skill match, company, title, location, any compliant weighting
}

Weights to use (sum = 100):
- resumeJd: ${wResume}
- location: ${wLocation}
- diversity: ${wDiversity}
Compute: score = round(resumeJdMatch*resumeJd/100 + locationMatch*location/100 + diversityMatch*diversity/100).
If no compliant diversity data is provided, set diversity subscore to 0 AND reallocate its weight proportionally to resumeJd and location (so total stays 100). Reflect the actual weights used in "weightsUsed".

Resume/JD match rubric (single 0-100 for resumeJdMatch, internally reflecting):
- Core skills & JD fit
- Relevant years of experience
- Title relevance / seniority match
- Company relevance (prefers target-company list, FAANG, internet-scale, product/SaaS, high-growth)

Location rubric (work mode = "${mode || "unspecified"}"):
- Same city as preferred location  -> 95-100
- Within ~50km / nearby metro      -> 80-90
- Same country, different metro, with relocation/openness signal in profile -> 60-75
- Different country / no relocation signal -> 20-50
- Fully remote role -> location matters less; a candidate in a reasonable timezone can score 80+ even if not in the city.
- Hybrid/onsite role -> location is a STRONG ranking factor; out-of-city without relocation signal should drag the final score noticeably.

Diversity rubric (LEGAL / COMPLIANT USE ONLY):
- Use ONLY if diversity data is explicitly provided through a compliant, approved source (e.g. a self-declared field on the candidate object). 
- Do NOT infer protected characteristics from name, photo, gender, ethnicity, religion, caste, age, disability, pronouns guessed from a name, or any other sensitive personal data.
- If no compliant data, diversity subscore = 0 and reallocate weight as described.

Banding for the FINAL score:
- 80-100: Auto-shortlist.
- 70-79: Recruiter review.
- <70: Reject.

HARD CAPS (apply BEFORE banding):
- If candidate's current company (or most recent) matches any in HARD EXCLUDE COMPANIES (case-insensitive substring match), CAP final score at 40 and explain in rationale.
- Track HARD MUST-HAVE coverage: list which musts are present vs missing in the rationale. If any HARD MUST-HAVE is missing, CAP final score at 55.

Role: ${role.title}
Seniority: ${role.parsed?.seniority || ""}
Must-have (from JD): ${(role.skills || []).join(", ")}
HARD MUST-HAVES (recruiter-set, non-negotiable): ${musts.join(", ") || "(none)"}
HARD EXCLUDE COMPANIES (auto-cap if matched): ${exCo.join(", ") || "(none)"}
Experience: ${role.expMin ?? ""}-${role.expMax ?? ""} years
Preferred locations: ${(role.locations || []).join(", ")}
Work mode: ${mode || "unspecified"}
Target companies (pedigree signal): ${targetCo || "(none provided)"}
JD summary: ${(role.parsed?.summary || role.jdText || "").slice(0, 1500)}
${idealBlock}
Candidate:
Name: ${candidate.name}
Headline: ${candidate.headline}
Current company: ${candidate.currentCompany || candidate.company || ""}
Previous company: ${candidate.previousCompany || ""}
Total experience: ${candidate.expYears != null ? `${candidate.expYears}y ${candidate.expMonths || 0}m` : ""}
Current CTC (Lacs): ${candidate.ctcLacs ?? ""}
Location: ${candidate.location}
Preferred locations: ${(candidate.prefLocations || []).join(", ")}
Education: ${candidate.education || ""}
College: ${candidate.college || ""}
Actively applying: ${candidate.activelyApplying ? "yes" : "no"}
Last active: ${candidate.lastActive || ""}
About: ${(candidate.about || "").slice(0, 800)}
Experience: ${(candidate.experienceText || "").slice(0, 1200)}
Key skills: ${(candidate.keySkills || candidate.skillsList || []).join(", ")}
May also know: ${(candidate.mayAlsoKnow || []).join(", ")}
Snippet: ${candidate.snippet}
Compliant diversity data (if any): ${candidate.diversitySelfDeclared || "(none)"}

Be strict. Only list matched skills you can defend from the evidence. Keep rationale to 2-3 sentences and explicitly mention skill match (with must-have coverage), company background (note any HARD EXCLUDE match), title fit, location fit, and any compliant additional weighting.`;
  return aiJson(prompt, { system: FAANG_SYSTEM });
}
