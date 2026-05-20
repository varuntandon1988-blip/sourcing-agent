import { getAll } from "./lib/storage.js";

async function refresh() {
  const [queue, candidates, roles] = await Promise.all([
    getAll("queue", []),
    getAll("candidates", []),
    getAll("roles", []),
  ]);
  document.getElementById("q").textContent = queue.filter((j) => j.status === "queued").length;
  document.getElementById("r").textContent = queue.filter((j) => j.status === "running").length;
  document.getElementById("c").textContent = candidates.length;

  const sel = document.getElementById("role");
  if (sel.options.length !== roles.length) {
    const prev = sel.value;
    sel.innerHTML = "";
    if (!roles.length) {
      sel.appendChild(new Option("(create a role first)", ""));
    } else {
      for (const r of roles) sel.appendChild(new Option(r.title || "(untitled)", r.id));
      if (prev) sel.value = prev;
    }
  }
}

document.getElementById("open").onclick = () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
document.getElementById("kick").onclick = () => chrome.runtime.sendMessage({ type: "kick" });

const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("capture");
const agentBtn = document.getElementById("agent");

captureBtn.onclick = async () => {
  const roleId = document.getElementById("role").value;
  if (!roleId) { statusEl.textContent = "Pick a role first."; return; }
  captureBtn.disabled = true;
  statusEl.textContent = "Scraping current tab…";
  chrome.runtime.sendMessage({ type: "captureActiveTab", roleId }, (resp) => {
    captureBtn.disabled = false;
    if (!resp?.ok) { statusEl.textContent = "Error: " + (resp?.error || "unknown"); return; }
    statusEl.textContent = `Captured ${resp.saved} candidate(s) from ${resp.portal}.`;
    refresh();
  });
};

agentBtn.onclick = async () => {
  const roleId = document.getElementById("role").value;
  if (!roleId) { statusEl.textContent = "Pick a role first."; return; }
  const opts = {
    roleId,
    maxPages: Number(document.getElementById("pages").value) || 3,
    maxProfiles: Number(document.getElementById("max").value) || 20,
    deep: document.getElementById("deep").checked,
  };
  agentBtn.disabled = true;
  statusEl.textContent = "Agent starting…";
  chrome.runtime.sendMessage({ type: "runLinkedInAgent", opts }, (resp) => {
    agentBtn.disabled = false;
    if (!resp?.ok) { statusEl.textContent = "Error: " + (resp?.error || "unknown"); return; }
    statusEl.textContent = `Agent done. Saved ${resp.saved}.`;
    refresh();
  });
};

function wirePortalBtn(id, portal, label) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.onclick = () => {
    const roleId = document.getElementById("role").value;
    if (!roleId) { statusEl.textContent = "Pick a role first."; return; }
    btn.disabled = true;
    statusEl.textContent = `${label} agent starting…`;
    chrome.runtime.sendMessage({
      type: "runPortalAgent",
      opts: {
        roleId,
        portal,
        targetShortlist: Number(document.getElementById("max").value) || 20,
        hardCapPages: Number(document.getElementById("pages").value) || 10,
        maxProfiles: 0,  // unlimited — agent runs until targetShortlist is reached
      },
    }, (resp) => {
      btn.disabled = false;
      if (!resp?.ok) { statusEl.textContent = "Error: " + (resp?.error || "unknown"); return; }
      statusEl.textContent = `${label} done. Saved ${resp.saved}.`;
      refresh();
    });
  };
}
wirePortalBtn("agentNaukri", "naukri", "Naukri");
wirePortalBtn("agentInsta", "instahyre", "Instahyre");

// Live agent progress
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "agentProgress" && msg.state) {
    const s = msg.state;
    statusEl.textContent = `${s.status} (${s.processed}/${s.total || "?"})`;
  }
});

refresh();
setInterval(refresh, 1500);
