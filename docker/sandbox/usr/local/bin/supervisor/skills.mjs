// Instruction-skill routes for the sandbox supervisor.
import { listProposals, listSkills, inspectSkill, proposeSkill, reviewProposal, setSkillEnabled } from "/usr/local/lib/skills-manager.mjs";

/** Markdown skills are discovered by Pi on session load or resource reload. Returns true if handled. */
export function handleSkillsRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/skills") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ skills: listSkills() }));
    return true;
  }

  const skillMatch = url.pathname.match(/^\/skills\/([a-z0-9][a-z0-9_-]{0,63})$/i);
  if (req.method === "GET" && skillMatch) {
    const skill = inspectSkill(skillMatch[1]);
    if (!skill) { res.writeHead(404); res.end(JSON.stringify({ error: "Skill not found" })); return true; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ skill }));
    return true;
  }

  if (req.method === "POST" && skillMatch) {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { enabled } = JSON.parse(body || "{}");
        if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
        const skill = setSkillEnabled(skillMatch[1], enabled);
        if (!skill) { res.writeHead(404); res.end(JSON.stringify({ error: "Skill not found" })); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ skill }));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/skills/proposals") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ proposals: listProposals() })); return true;
  }

  if (req.method === "POST" && url.pathname === "/skills/proposals") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 45_000) req.destroy(); });
    req.on("end", () => {
      try { const proposal = proposeSkill(JSON.parse(body || "{}")); res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ proposal })); }
      catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return true;
  }

  const proposalMatch = url.pathname.match(/^\/skills\/proposals\/([a-z0-9-]{6,80})$/i);
  if (req.method === "POST" && proposalMatch) {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (typeof parsed.approve !== "boolean") {
          res.writeHead(400); res.end(JSON.stringify({ error: "approve must be boolean" })); return;
        }
        const result = reviewProposal(proposalMatch[1], parsed.approve); if (!result) { res.writeHead(404); res.end(JSON.stringify({ error: "Proposal not found" })); return; } res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result })); }
      catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return true;
  }

  return false;
}
