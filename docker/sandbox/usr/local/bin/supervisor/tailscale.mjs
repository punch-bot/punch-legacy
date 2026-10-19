import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const TAILSCALE_KEY_FILE = "/data/tailscale_key.json";

export function handleTailscaleRoutes(req, res, url) {
  if (req.method === "POST" && url.pathname === "/tailscale/key") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { key } = JSON.parse(body);
        if (typeof key !== "string" || !key.trim()) {
          res.writeHead(400).end(JSON.stringify({ error: "Missing key" }));
          return;
        }
        const clean = key.trim();
        writeFileSync(TAILSCALE_KEY_FILE, JSON.stringify({ authkey: clean }));
        execFile("tailscale", ["up", `--authkey=${clean}`, "--accept-routes", "--accept-dns=false"], { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) {
            res.writeHead(500).end(JSON.stringify({ error: (stderr || err.message).trim() }));
            return;
          }
          res.writeHead(200).end(JSON.stringify({ success: true, output: stdout.trim() }));
        });
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/tailscale/login") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      let force = false;
      try {
        force = Boolean(JSON.parse(body || "{}").force);
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const args = ["login", "--accept-routes", "--accept-dns=false"];
      if (force) args.push("--force-reauth");
      const loginProcess = spawn("tailscale", args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let responded = false;
      let timer;
      const urlPattern = /(https:\/\/login\.tailscale\.com\/[^\s]+)/;
      const finish = (status, payload) => {
        if (responded) return;
        responded = true;
        clearTimeout(timer);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const scan = (chunk) => {
        output += chunk.toString();
        const match = output.match(urlPattern);
        if (match) {
          loginProcess.unref();
          finish(200, { success: true, url: match[1] });
        }
      };
      loginProcess.stdout.on("data", scan);
      loginProcess.stderr.on("data", scan);
      loginProcess.on("error", (err) => finish(500, { error: err.message }));
      loginProcess.on("close", (code) => {
        if (responded) return;
        const match = output.match(urlPattern);
        if (code !== 0 && !match) {
          finish(500, { error: output.trim() || `tailscale login exited with code ${code}` });
          return;
        }
        finish(200, match
          ? { success: true, url: match[1] }
          : { success: true, url: null, output: output.trim() });
      });
      timer = setTimeout(() => {
        if (responded) return;
        loginProcess.unref();
        finish(200, {
          success: true,
          url: null,
          output: output.trim() || "No login URL emitted (may already be authenticated).",
        });
      }, 12000);
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/tailscale/status") {
    execFile("tailscale", ["status", "--json"], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        res.writeHead(500).end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(stdout);
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/tailscale/down") {
    execFile("tailscale", ["down"], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        res.writeHead(500).end(JSON.stringify({ error: (stderr || err.message).trim() }));
        return;
      }
      writeFileSync(TAILSCALE_KEY_FILE, "{}");
      res.writeHead(200).end(JSON.stringify({ success: true }));
    });
    return true;
  }

  return false;
}
