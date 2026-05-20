// Curated list of Indian / global IT-services & staff-augmentation firms.
// Used to hard-exclude from boolean searches (LinkedIn + Naukri) unless the
// recruiter explicitly opts in via the per-role "Include IT services" toggle.
// Single source of truth — imported by lib/agents.js (prompt) and background.js
// (post-AI safety-net injector + Naukri trimmer fallback).
//
// Order matters: highest-volume offenders first. Naukri's 500-char boolean
// budget can force us to truncate to the top ~10.

export const IT_SERVICES_EXCLUDE = [
  "TCS",
  "Infosys",
  "Wipro",
  "Cognizant",
  "Accenture",
  "HCL",
  "Tech Mahindra",
  "Capgemini",
  "LTIMindtree",
  "Mphasis",
  "Mindtree",
  "Hexaware",
  "Persistent Systems",
  "Coforge",
  "Birlasoft",
  "Genpact",
  "Sutherland",
  "Cyient",
  "Zensar",
  "NTT Data",
  "DXC",
  "IBM India",
  "L&T Infotech",
  "KPIT",
  "Mastek",
  "Happiest Minds",
  "Virtusa",
  "Atos",
  "Fujitsu Consulting",
  "Tata Consultancy Services",
];

// Compact subset for tight boolean budgets (e.g. Naukri after trimming).
export const IT_SERVICES_EXCLUDE_TOP = IT_SERVICES_EXCLUDE.slice(0, 10);
