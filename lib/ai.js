// Multi-provider AI client. All calls go directly from the extension to the
// chosen provider using the user's own API key, stored in chrome.storage.local.
import { getSettings } from "./storage.js";

export const PROVIDERS = {
  gemini: {
    label: "Google Gemini (free tier)",
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-2.0-flash"],
  },
  openai: {
    label: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
  },
  anthropic: {
    label: "Anthropic Claude",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-3-5-haiku-latest",
    models: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-sonnet-4-20250514", "claude-opus-4-20250514"],
  },
  groq: {
    label: "Groq (free, very fast)",
    keyUrl: "https://console.groq.com/keys",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct"],
  },
  openrouter: {
    label: "OpenRouter (many models, has free)",
    keyUrl: "https://openrouter.ai/keys",
    defaultModel: "google/gemini-2.0-flash-exp:free",
    models: [
      "google/gemini-2.0-flash-exp:free",
      "deepseek/deepseek-chat-v3.1:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o-mini",
    ],
  },
  mistral: {
    label: "Mistral (free tier)",
    keyUrl: "https://console.mistral.ai/api-keys",
    defaultModel: "mistral-small-latest",
    models: ["mistral-small-latest", "mistral-large-latest", "open-mistral-nemo"],
  },
  deepseek: {
    label: "DeepSeek",
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  together: {
    label: "Together AI",
    keyUrl: "https://api.together.xyz/settings/api-keys",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      "Qwen/Qwen2.5-72B-Instruct-Turbo",
    ],
  },
  perplexity: {
    label: "Perplexity",
    keyUrl: "https://www.perplexity.ai/settings/api",
    defaultModel: "sonar",
    models: ["sonar", "sonar-pro", "sonar-reasoning"],
  },
};

async function callGemini({ system, prompt, model, json }) {
  const { aiKey } = await getSettings();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${aiKey}`;
  const body = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, ...(json ? { responseMimeType: "application/json" } : {}) },
  };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
}

// OpenAI-compatible: OpenAI, Groq, OpenRouter, DeepSeek, Together, Perplexity, Mistral
async function callOpenAICompatible({ system, prompt, model, json, baseUrl, apiKey, extraHeaders = {} }) {
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify({
      model,
      messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
      ...(json ? { response_format: { type: "json_object" } } : {}),
      temperature: 0.4,
    }),
  });
  if (!r.ok) throw new Error(`${baseUrl} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic({ system, prompt, model, json }) {
  const { aiKey } = await getSettings();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": aiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: json ? `${system || ""}\nReturn ONLY valid JSON, no prose.` : system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.content?.map((p) => p.text).join("") ?? "";
}

export async function aiText(prompt, opts = {}) {
  const s = await getSettings();
  if (!s.aiKey) throw new Error("No AI key configured. Open Settings.");
  const provider = s.aiProvider || "gemini";
  const model = opts.model || s.aiModel || PROVIDERS[provider]?.defaultModel;
  const args = { ...opts, prompt, model };

  switch (provider) {
    case "gemini":     return callGemini(args);
    case "anthropic":  return callAnthropic(args);
    case "openai":     return callOpenAICompatible({ ...args, baseUrl: "https://api.openai.com/v1", apiKey: s.aiKey });
    case "groq":       return callOpenAICompatible({ ...args, baseUrl: "https://api.groq.com/openai/v1", apiKey: s.aiKey });
    case "openrouter": return callOpenAICompatible({ ...args, baseUrl: "https://openrouter.ai/api/v1", apiKey: s.aiKey, extraHeaders: { "HTTP-Referer": "https://sourcing-agent.local", "X-Title": "Sourcing Agent" } });
    case "mistral":    return callOpenAICompatible({ ...args, baseUrl: "https://api.mistral.ai/v1", apiKey: s.aiKey });
    case "deepseek":   return callOpenAICompatible({ ...args, baseUrl: "https://api.deepseek.com/v1", apiKey: s.aiKey });
    case "together":   return callOpenAICompatible({ ...args, baseUrl: "https://api.together.xyz/v1", apiKey: s.aiKey });
    case "perplexity": return callOpenAICompatible({ ...args, baseUrl: "https://api.perplexity.ai", apiKey: s.aiKey });
    default: throw new Error("Unknown AI provider: " + provider);
  }
}

export async function aiJson(prompt, opts = {}) {
  const text = await aiText(prompt, { ...opts, json: true });
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("AI did not return valid JSON: " + text.slice(0, 200));
  }
}

// Read a File/Blob as base64 (no data: prefix).
async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Extract plain text from a resume File. Supports text, PDF, DOCX.
// PDF/DOCX require an LLM that accepts file inputs (currently Gemini or OpenAI).
export async function extractResumeText(file) {
  const name = file.name || "resume";
  const lower = name.toLowerCase();
  const mime = file.type || "";

  // Plain text — read directly.
  if (lower.match(/\.(txt|md|text|csv|log)$/i) || mime.startsWith("text/")) {
    return await file.text();
  }

  const isPdf = lower.endsWith(".pdf") || mime === "application/pdf";
  const isDocx = lower.endsWith(".docx") || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (!isPdf && !isDocx) {
    // Try as text — last resort.
    try { return await file.text(); }
    catch { throw new Error(`Unsupported file type: ${name}`); }
  }

  const s = await getSettings();
  if (!s.aiKey) throw new Error("No AI key configured. Open Settings.");
  const provider = s.aiProvider || "gemini";
  const b64 = await fileToBase64(file);
  const fileMime = isPdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const instruction = "Extract ALL text content from this resume verbatim. Preserve section headers (Experience, Education, Skills, Projects). Do NOT summarize, paraphrase, or add commentary. Return only the raw text.";

  if (provider === "gemini") {
    const model = s.aiModel || PROVIDERS.gemini.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${s.aiKey}`;
    const body = {
      contents: [{
        role: "user",
        parts: [
          { inline_data: { mime_type: fileMime, data: b64 } },
          { text: instruction },
        ],
      }],
      generationConfig: { temperature: 0.1 },
    };
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  }

  if (provider === "openai") {
    // OpenAI Responses API accepts input_file with base64 PDF.
    const model = s.aiModel || PROVIDERS.openai.defaultModel;
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.aiKey}` },
      body: JSON.stringify({
        model,
        input: [{
          role: "user",
          content: [
            { type: "input_file", filename: name, file_data: `data:${fileMime};base64,${b64}` },
            { type: "input_text", text: instruction },
          ],
        }],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    if (data.output_text) return data.output_text;
    return (data.output || []).flatMap((o) => o.content || []).map((c) => c.text || "").join("\n");
  }

  throw new Error(`PDF/DOCX parsing requires Google Gemini or OpenAI as the AI provider. Current: ${provider}. Switch in Settings, or paste the resume text manually.`);
}
