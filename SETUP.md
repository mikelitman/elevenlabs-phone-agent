# Twilio + ElevenLabs: Complete Guide to Building a Voice Agent That Calls People

**A guide for Than from Mike.** Everything, start to finish: what accounts you need, how to configure each service, the full architecture, every line of code that matters, gotchas from production, and how to automate it.

---

## What this builds

You write a prompt. You give it a list of phone numbers. It calls them one by one, has a real spoken conversation using an AI voice, listens to responses, transcribes everything, and saves structured results. It can navigate phone menus (IVR), detect voicemail, retry failed calls, and hand transcripts to Claude for classification.

Mike runs three live projects on this exact stack:

| Project | Calls | Asks |
|---------|-------|------|
| **First Order London** | London restaurants | "What should someone order on their very first visit?" |
| **Buggy Smart** | London cafes | "Is your space accessible for prams and buggies?" |
| **Queue Index** | London restaurants | "What's the current wait time for a walk-in table?" |

---

## Accounts and services

| Service | Role | Cost at ~175 calls/day |
|---------|------|------------------------|
| **Twilio** | Phone numbers, outbound calling, audio streaming | ~$1/day |
| **ElevenLabs** | AI voice agent, speech synthesis, transcription | ~£263/month |
| **Railway** | Hosts the Node.js server 24/7 | ~$5/month (free tier works) |
| **GitHub** | Code + GitHub Actions for scheduling | Free |
| **Anthropic** (optional) | Post-call classification with Claude Haiku | Tiny |
| **Slack** (optional) | Run notifications | Free |

---

## Part 1: Service setup

### 1.1 ElevenLabs — create your agent

1. Log in at **elevenlabs.io** → left sidebar → **Conversational AI** → **Agents**
2. Click **Create Agent**
3. Under **Agent Settings**:
   - **First message**: what the agent says first when the call connects ("Hi, I'm calling from...")
   - **System prompt**: the full instructions (see below)
   - **Voice**: pick any ElevenLabs voice
   - **Language**: English (UK for UK calls)
4. Under **Advanced settings**:
   - Turn on **Dynamic Variables** — this lets you pass per-call context (venue name etc.) at runtime
   - Set **End call phrases** if you want the agent to hang up on certain responses
   - **Response latency**: lower is better for phone calls; "Turbo" mode if available
5. Copy the **Agent ID** from the URL: `https://elevenlabs.io/app/conversational-ai/agents/YOUR_AGENT_ID_HERE`
6. Go to **Profile** → **API Keys** → create a key → copy it

**Example system prompt (First Order London pattern):**
```
You are Alice, calling {{venue_name}} on behalf of First Order London.
You have one question: what dish would you recommend someone order 
on their very first visit?

When a human answers:
- Introduce yourself warmly: "Hi, I'm Alice from First Order London."
- Ask your question directly.
- Thank them and hang up once you have an answer.

When you hit an IVR (automated menu):
- Navigate it to reach a human.
- If the menu says "press 1 for reservations", output [PRESS 1] exactly.
- Keep navigating until you reach a person.

If you reach voicemail or no one answers after 30 seconds:
- Say nothing. Hang up.
```

`{{venue_name}}` is a dynamic variable — you pass the actual value per call at runtime.

**Dynamic variable setup in ElevenLabs dashboard:**
Under the agent's **Advanced** settings, add a variable: `venue_name` with a default value like `the restaurant`. The agent will use whatever value you send at call time if provided, otherwise falls back to the default.

---

### 1.2 Twilio — buy a number and get credentials

1. Create account at **twilio.com** → verify your phone number
2. Go to **Phone Numbers** → **Buy a Number**
   - For UK numbers: filter by Country = United Kingdom, search for +447 numbers
   - Cost: ~$1/month per number
   - **Each project gets its own number.** Never share a number between projects — call logs and billing become a mess.
3. You do NOT need to configure the number's webhook in Twilio. The server handles everything dynamically via the `url` parameter when making calls.
4. Copy from **Account Info** on the Twilio dashboard:
   - **Account SID** (starts with `AC...`)
   - **Auth Token**
   - Your purchased phone number (e.g. `+447401269150`)
5. (Optional) Enable **Geographic Permissions** under Voice → Settings if you're calling non-UK numbers. By default UK-registered accounts can call UK numbers fine.

**Note on Twilio's Answering Machine Detection:**
Twilio can detect voicemail vs human automatically with `machineDetection: "Enable"` and `asyncAmd: "true"`. Mike uses this on Buggy Smart. It adds a webhook callback (`/amd-status`) that tells you if Twilio thinks it hit a machine. Useful but not required for the basic setup.

---

### 1.3 Railway — the server host

Railway is the right host for this because:
- Your server needs a persistent, reachable URL over HTTPS and WSS (Twilio requires this)
- It auto-deploys from GitHub on every push
- It gives you logs in real time
- The free tier handles this workload fine

1. Go to **railway.app** → sign in with GitHub
2. **New Project** → **Deploy from GitHub repo**
3. Select your repo
4. Railway detects `package.json` and runs `npm start` automatically
5. Go to **Settings** → **Networking** → **Generate Domain** — this gives you your public URL (e.g. `your-app.up.railway.app`)
6. Add all your environment variables under the **Variables** tab

**Railway filesystem warning:** Railway's filesystem is ephemeral — it can be wiped on redeploy or restart. Transcripts and call-status saved to disk will vanish. Solutions:
- Back up `call-status.json` to a GitHub repo and restore on startup (Mike does this)
- Use a persistent database (Supabase, Turso) instead of flat files
- Accept the loss and rely on the ElevenLabs transcript API as the source of truth

---

## Part 2: Architecture

### How the audio bridge works

This is the part nobody explains clearly. Twilio and ElevenLabs don't connect to each other directly. Your Node.js server sits in the middle:

```
Caller (phone)
     │
     ▼ voice call
  Twilio
     │ WebSocket (audio stream, ~8kHz mulaw)
     ▼
  Your server  ←── the bridge ───►  ElevenLabs agent
     │                                    │
     │   user audio (base64 chunks) ───► │
     │                                    │  agent thinks, generates speech
     │ ◄── agent audio (base64 chunks) ─  │
     ▼
  Twilio
     │
     ▼ plays audio to caller
Caller hears the agent
```

Two WebSocket connections run simultaneously inside your server:
1. **Twilio → Server**: Twilio streams the caller's voice as base64-encoded audio chunks
2. **Server → ElevenLabs**: You forward those chunks to the ElevenLabs agent
3. **ElevenLabs → Server**: ElevenLabs sends back the agent's voice as base64 chunks
4. **Server → Twilio**: You forward those back to Twilio to play on the call

Both directions are JSON messages wrapping base64 audio. The audio format is mulaw (G.711) at 8kHz, 8-bit — standard phone audio.

### The call lifecycle

```
1. Your code calls Twilio REST API: "call this number, fetch TwiML from /outbound-twiml"
2. Twilio dials the number
3. When answered, Twilio fetches your TwiML via HTTP GET/POST
4. TwiML says: open a media stream WebSocket to wss://your-server/media-stream
5. Twilio connects to your server over WebSocket
6. Server receives "start" event with callSid, streamSid, and custom parameters
7. Server fetches a signed URL from ElevenLabs REST API
8. Server opens second WebSocket to ElevenLabs using the signed URL
9. Server sends conversation_initiation_client_data with dynamic variables (venue name etc.)
10. ElevenLabs responds with conversation_initiation_metadata (includes conversation_id)
11. ElevenLabs agent sends its first message as audio chunks
12. Server forwards audio to Twilio → caller hears it
13. Caller speaks → Twilio sends audio chunks → server forwards to ElevenLabs
14. ElevenLabs transcribes, generates response, sends audio back
15. Loop continues until call ends
16. On WebSocket close: server fetches full transcript from ElevenLabs API
17. Server saves transcript JSON to disk
```

### The signed URL

ElevenLabs doesn't let you connect to an agent WebSocket directly with your API key. Instead, you ask for a **signed URL** via a REST call, then connect to that URL. The signed URL is short-lived and single-use — you fetch a new one for every call.

```javascript
// Fetch a signed URL for this conversation
const res = await fetch(
  `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
  { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } }
);
const { signed_url } = await res.json();
// signed_url looks like: wss://api.elevenlabs.io/v1/convai/conversation?token=...
const elevenLabsWs = new WebSocket(signed_url);
```

### The audio queue

There's a race condition: Twilio starts sending audio almost immediately, but your ElevenLabs WebSocket takes ~1 second to open. You need to buffer early audio or the agent misses the first thing the caller says.

```javascript
let elevenLabsReady = false;
let audioQueue = [];

// In Twilio message handler:
case "media":
  if (elevenLabsWs?.readyState === WebSocket.OPEN && elevenLabsReady) {
    elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
  } else {
    if (audioQueue.length < 400) audioQueue.push(msg.media.payload); // ~5s of audio
  }

// In ElevenLabs open handler:
elevenLabsReady = true;
for (const chunk of audioQueue) {
  elevenLabsWs.send(JSON.stringify({ user_audio_chunk: chunk }));
}
audioQueue = [];
```

Cap the queue at ~400 chunks (about 5 seconds). If ElevenLabs takes longer than that to connect, you've got bigger problems.

---

## Part 3: The full server code

**`package.json`:**
```json
{
  "name": "voice-agent",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "twilio": "^5.0.0",
    "ws": "^8.16.0",
    "express": "^4.18.0",
    "dotenv": "^16.4.0"
  }
}
```

**`.env`:**
```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_PHONE_NUMBER=+447xxxxxxxxx
ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ELEVENLABS_AGENT_ID=your_agent_id_here
SERVER_URL=https://your-app.up.railway.app
TRIGGER_SECRET=any_random_string_you_choose
PORT=3000

# Optional
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
ANTHROPIC_API_KEY=sk-ant-...
```

**`server.js`:**
```javascript
import "dotenv/config";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import twilio from "twilio";

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);

// Track active calls (callSid → metadata)
const activeCalls = new Map();

// In-memory fallback if Railway wipes the filesystem mid-run
const completedCalls = [];

// Track the current call run
let currentRun = {
  active: false,
  total: 0,
  completed: 0,
  startedAt: null,
  results: { answered: 0, no_answer: 0, error: 0 },
};


// ── State helpers ─────────────────────────────────────────────────────────

const STATUS_FILE = "data/call-status.json";

function loadCallStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8")); } catch { return {}; }
}

function saveCallStatus(statuses) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(statuses, null, 2));
}


// ── Railway startup: restore state from GitHub backup if filesystem wiped ─
// Railway restarts wipe the filesystem. This restores call-status from GitHub
// so you don't re-call venues you've already completed.
async function restoreCallStatusIfEmpty() {
  const current = loadCallStatus();
  if (Object.keys(current).length > 0) return;

  try {
    const url = "https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/data/call-status-backup.json";
    const resp = await fetch(url);
    if (resp.ok) {
      const backup = await resp.json();
      if (Object.keys(backup).length > 0) {
        saveCallStatus(backup);
        console.log(`[State] Restored ${Object.keys(backup).length} entries from GitHub backup`);
      }
    }
  } catch (err) {
    console.log(`[State] Restore failed: ${err.message} — starting fresh`);
  }
}
restoreCallStatusIfEmpty();


// ── Health check ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "running", activeCalls: activeCalls.size, run: currentRun });
});


// ── Auth helper ───────────────────────────────────────────────────────────
function requireSecret(req, res) {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== process.env.TRIGGER_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}


// ── Trigger a batch of calls ──────────────────────────────────────────────
app.post("/trigger-calls", async (req, res) => {
  if (!requireSecret(req, res)) return;

  if (currentRun.active) {
    return res.status(409).json({ error: "A run is already active", run: currentRun });
  }

  const venueFile = (req.query.file || "venues").replace(/[^a-z0-9-]/gi, "");
  const venues = JSON.parse(fs.readFileSync(`data/${venueFile}.json`, "utf-8"));
  const statuses = loadCallStatus();

  // Skip venues that already answered (or have been called twice already)
  const callable = venues.filter(v => {
    if (!v.phone) return false;
    const s = statuses[v.id];
    if (!s) return true;                          // Never called
    if (s.status === "answered") return false;    // Already got a good answer
    if ((s.callCount || 0) >= 2) return false;    // Max retries reached
    return true;
  }).slice(0, parseInt(req.query.limit || "50"));

  if (callable.length === 0) {
    return res.json({ status: "nothing_to_call" });
  }

  currentRun = {
    active: true,
    total: callable.length,
    completed: 0,
    startedAt: new Date().toISOString(),
    results: { answered: 0, no_answer: 0, error: 0 },
  };

  res.json({ status: "started", count: callable.length });

  // Fire calls in sequence with delay between each
  const SERVER_URL = process.env.SERVER_URL;
  let delay = 30_000; // 30s between calls — avoids Twilio rate limits

  for (let i = 0; i < callable.length; i++) {
    const venue = callable[i];
    let phone = venue.phone.replace(/\s+/g, "");
    if (phone.startsWith("0")) phone = "+44" + phone.slice(1); // UK normalisation
    if (!phone.startsWith("+")) phone = "+44" + phone;

    try {
      const twimlUrl = new URL(`${SERVER_URL}/outbound-twiml`);
      twimlUrl.searchParams.set("venueName", venue.name);
      twimlUrl.searchParams.set("venueId", venue.id);
      twimlUrl.searchParams.set("cuisine", venue.cuisine || "");

      await twilioClient.calls.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
        url: twimlUrl.toString(),
        timeout: 25,    // Ring for 25 seconds, then give up
        timeLimit: 60,  // Max call duration: 60 seconds
        statusCallback: `${SERVER_URL}/call-status`,
        statusCallbackEvent: ["completed"],

        // Optional: detect voicemail automatically
        // machineDetection: "Enable",
        // asyncAmd: "true",
        // asyncAmdStatusCallback: `${SERVER_URL}/amd-status`,
      });

      console.log(`[Call ${i + 1}/${callable.length}] ${venue.name}`);
      delay = 30_000; // Reset delay on success
    } catch (err) {
      console.error(`[Error] ${venue.name}: ${err.message}`);
      currentRun.results.error++;

      // Back off if rate-limited
      if (err.status === 429 || err.message?.includes("rate")) {
        delay = Math.min(delay * 2, 120_000);
      }
    }

    currentRun.completed = i + 1;
    if (i < callable.length - 1) await new Promise(r => setTimeout(r, delay));
  }

  console.log("[Run] All calls dispatched. Waiting 60s for final transcripts...");
  await new Promise(r => setTimeout(r, 60_000));

  // Auto-retry venues that didn't answer (once, after 5 minutes)
  const afterStatuses = loadCallStatus();
  const toRetry = callable.filter(v => {
    const s = afterStatuses[v.id];
    return s && s.status === "no_answer" && (s.callCount || 0) <= 1;
  });

  if (toRetry.length > 0) {
    console.log(`[Retry] ${toRetry.length} venues failed — retrying in 5 minutes`);
    await new Promise(r => setTimeout(r, 300_000));

    for (const venue of toRetry) {
      let phone = venue.phone.replace(/\s+/g, "");
      if (phone.startsWith("0")) phone = "+44" + phone.slice(1);

      const twimlUrl = new URL(`${SERVER_URL}/outbound-twiml`);
      twimlUrl.searchParams.set("venueName", venue.name);
      twimlUrl.searchParams.set("venueId", venue.id);

      try {
        await twilioClient.calls.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone,
          url: twimlUrl.toString(),
          timeout: 25,
          timeLimit: 60,
          statusCallback: `${SERVER_URL}/call-status`,
          statusCallbackEvent: ["completed"],
        });
      } catch (err) {
        console.error(`[Retry Error] ${venue.name}: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 30_000));
    }

    await new Promise(r => setTimeout(r, 60_000));
  }

  currentRun.active = false;
  console.log("[Run] Complete.");
});


// ── TwiML: tells Twilio to stream audio to our WebSocket ─────────────────
// Twilio fetches this URL when the call connects
app.all("/outbound-twiml", (req, res) => {
  const { venueName = "", venueId = "", cuisine = "" } = req.query;

  // The Stream URL must be WSS (not WS) — Railway provides HTTPS which includes WSS
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="venueName" value="${venueName}" />
      <Parameter name="venueId" value="${venueId}" />
      <Parameter name="cuisine" value="${cuisine}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});


// ── Call status webhook: Twilio posts here when call ends ────────────────
app.post("/call-status", (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(`[Status] ${CallSid}: ${CallStatus} (${CallDuration}s)`);
  res.sendStatus(200);
});


// ── AMD webhook: Twilio posts here if machineDetection is enabled ─────────
app.post("/amd-status", (req, res) => {
  const { CallSid, AnsweredBy } = req.body;
  // AnsweredBy: "human", "machine_start", "machine_end_beep", "fax", "unknown"
  console.log(`[AMD] ${CallSid}: ${AnsweredBy}`);
  if (AnsweredBy && AnsweredBy !== "human" && AnsweredBy !== "unknown") {
    // Voicemail — could hang up here if you want
    console.log(`[AMD] Voicemail detected — call will timeout naturally`);
  }
  res.sendStatus(200);
});


// ── Transcripts endpoint: returns saved transcripts (for GitHub Actions) ──
app.get("/transcripts", (req, res) => {
  if (!requireSecret(req, res)) return;

  const dir = "data/transcripts";
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    const transcripts = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")); } catch { return null; }
    }).filter(Boolean);
    res.json({ count: transcripts.length, transcripts });
  } catch {
    // Fallback to in-memory if filesystem wiped
    res.json({ count: completedCalls.length, transcripts: completedCalls, source: "in-memory" });
  }
});


// ── WebSocket bridge: Twilio <-> ElevenLabs ───────────────────────────────
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  // Per-call state
  let streamSid = null;
  let callSid = null;
  let customParams = null;
  let elevenLabsWs = null;
  let conversationId = null;
  let elevenLabsReady = false;
  let audioQueue = [];
  let transcript = [];
  let gotHumanResponse = false;
  let humanResponseCount = 0;

  // Safety timeout: hang up if no human answers within 120 seconds
  // (IVR navigation can take 60+ seconds, so don't set this lower than 90s)
  const safetyTimeout = setTimeout(() => {
    if (!gotHumanResponse) {
      console.log(`[Timeout] No human response — hanging up on ${customParams?.venueName}`);
      updateCallStatus(customParams?.venueId, "no_answer", null);
      if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
      twilioWs.close();
    }
  }, 120_000);

  // Audio flow monitor — alerts if audio stops mid-call (useful for debugging)
  let lastAudioSent = Date.now();
  const audioMonitor = setInterval(() => {
    if (elevenLabsReady && Date.now() - lastAudioSent > 8000) {
      console.log(`[Bridge] Warning: no audio sent to ElevenLabs for 8s`);
    }
  }, 5000);


  // ── State tracking ─────────────────────────────────────────────────
  function updateCallStatus(venueId, status, convId) {
    if (!venueId) return;
    const statuses = loadCallStatus();
    statuses[venueId] = {
      status,
      callCount: (statuses[venueId]?.callCount || 0) + 1,
      lastCalled: new Date().toISOString(),
      conversationId: convId || statuses[venueId]?.conversationId,
    };
    saveCallStatus(statuses);
    if (status === "answered") currentRun.results.answered++;
    else if (status === "no_answer") currentRun.results.no_answer++;
  }


  // ── ElevenLabs signed URL ───────────────────────────────────────────
  async function getSignedUrl() {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } }
    );
    const data = await res.json();
    return data.signed_url;
  }


  // ── Connect to ElevenLabs ───────────────────────────────────────────
  async function connectElevenLabs() {
    const signedUrl = await getSignedUrl();
    elevenLabsWs = new WebSocket(signedUrl);

    elevenLabsWs.on("open", () => {
      console.log(`[ElevenLabs] Connected — ${customParams?.venueName}`);

      // Pass per-call context to the agent via dynamic variables
      // These match the {{variable_name}} placeholders in your ElevenLabs prompt
      elevenLabsWs.send(JSON.stringify({
        type: "conversation_initiation_client_data",
        dynamic_variables: {
          venue_name: customParams?.venueName || "the restaurant",
          cuisine: customParams?.cuisine || "",
        },
      }));

      // Flush buffered audio from while we were connecting
      elevenLabsReady = true;
      for (const chunk of audioQueue) {
        elevenLabsWs.send(JSON.stringify({ user_audio_chunk: chunk }));
        lastAudioSent = Date.now();
      }
      audioQueue = [];
    });

    elevenLabsWs.on("message", (data) => {
      const msg = JSON.parse(data);

      switch (msg.type) {

        // Conversation created — save the ID for transcript lookup later
        case "conversation_initiation_metadata":
          conversationId = msg.conversation_initiation_metadata_event?.conversation_id;
          console.log(`[ElevenLabs] Conversation: ${conversationId}`);
          break;

        // Agent speaking — forward audio to Twilio so caller hears it
        case "audio": {
          const payload = msg.audio?.chunk || msg.audio_event?.audio_base_64;
          if (payload && streamSid) {
            try {
              twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload },
              }));
            } catch (err) {
              console.error(`[Bridge] Failed to forward audio: ${err.message}`);
            }
          }
          break;
        }

        // Caller interrupted agent — clear Twilio's audio buffer so agent stops
        case "interruption":
          twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
          break;

        // Keep-alive
        case "ping":
          elevenLabsWs.send(JSON.stringify({
            type: "pong",
            event_id: msg.ping_event?.event_id,
          }));
          break;

        // What the caller said (ElevenLabs transcribes it)
        case "user_transcript": {
          const userText = msg.user_transcription_event?.user_transcript || "";
          transcript.push({ role: "user", text: userText });
          console.log(`[User] ${userText}`);

          // Detect voicemail/IVR so we don't count those as human responses
          const isIVR = /leave a message|press \d|please hold|after the tone|voicemail|automated|visit our website|book online|opening hours/i.test(userText);

          if (userText.replace(/\./g, "").trim().length > 3 && !isIVR) {
            humanResponseCount++;
            if (humanResponseCount >= 1) {
              gotHumanResponse = true;
              clearTimeout(safetyTimeout); // Real human — cancel the timeout
            }
          }
          break;
        }

        // What the agent said
        case "agent_response": {
          const agentText = msg.agent_response_event?.agent_response || "";
          transcript.push({ role: "agent", text: agentText });
          console.log(`[Agent] ${agentText}`);

          // DTMF: if agent outputs [PRESS 1], send touch-tones to navigate IVR
          // Example: agent says "To speak to someone, [PRESS 1]"
          const dtmfMatch = agentText.match(/\[PRESS\s+([0-9*#]+)\]/i);
          if (dtmfMatch && streamSid) {
            console.log(`[DTMF] Pressing "${dtmfMatch[1]}"`);
            try {
              for (const digit of dtmfMatch[1]) {
                twilioWs.send(JSON.stringify({
                  event: "dtmf",
                  streamSid,
                  dtmf: { digit },
                }));
              }
            } catch (err) {
              console.error(`[DTMF] Failed: ${err.message}`);
            }
          }
          break;
        }
      }
    });

    elevenLabsWs.on("close", () => {
      console.log(`[ElevenLabs] Disconnected — ${customParams?.venueName}`);
      saveCallResult();
    });

    elevenLabsWs.on("error", (err) => {
      console.error(`[ElevenLabs] Error: ${err.message}`);
    });
  }


  // ── Save the call result ────────────────────────────────────────────
  async function saveCallResult() {
    clearInterval(audioMonitor);

    const result = {
      venueId: customParams?.venueId,
      venueName: customParams?.venueName,
      cuisine: customParams?.cuisine || "",
      conversationId,
      callSid,
      timestamp: new Date().toISOString(),
      transcript,      // Local transcript (built during call)
      gotHumanResponse,
    };

    // Wait 3 seconds, then fetch the full transcript from ElevenLabs API.
    // This is more reliable than the local transcript — includes timings, analysis, etc.
    if (conversationId) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
          { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } }
        );
        const fullData = await res.json();
        result.elevenLabsTranscript = fullData.transcript;         // Array of {role, message}
        result.callDuration = fullData.metadata?.call_duration_secs;
        result.analysis = fullData.analysis;                       // ElevenLabs' own analysis
      } catch (err) {
        console.error(`[API] Failed to fetch transcript: ${err.message}`);
      }
    }

    // Save to file
    fs.mkdirSync("data/transcripts", { recursive: true });
    const filename = `data/transcripts/${result.venueId || "unknown"}_${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(result, null, 2));
    console.log(`[Saved] ${filename}`);

    // Also push to in-memory fallback (survives filesystem wipes)
    completedCalls.push(result);

    // Update call status
    updateCallStatus(result.venueId, gotHumanResponse ? "answered" : "no_answer", conversationId);
    activeCalls.delete(callSid);
  }


  // ── Handle messages from Twilio ─────────────────────────────────────
  twilioWs.on("message", (message) => {
    const msg = JSON.parse(message);

    switch (msg.event) {

      // Call connected — Twilio sends stream metadata and our custom parameters
      case "start":
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        customParams = msg.start.customParameters; // venueName, venueId, cuisine etc.
        console.log(`[Twilio] Call started — ${customParams?.venueName} (${callSid})`);
        activeCalls.set(callSid, { venueName: customParams?.venueName });
        connectElevenLabs(); // Start ElevenLabs connection now
        break;

      // Caller audio chunk — forward to ElevenLabs
      case "media":
        if (elevenLabsWs?.readyState === WebSocket.OPEN && elevenLabsReady) {
          elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
          lastAudioSent = Date.now();
        } else {
          // Buffer while ElevenLabs connects
          if (audioQueue.length < 400) audioQueue.push(msg.media.payload);
        }
        break;

      // Call ended
      case "stop":
        console.log(`[Twilio] Stream stopped — ${customParams?.venueName}`);
        if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
        break;
    }
  });

  twilioWs.on("close", () => {
    clearTimeout(safetyTimeout);
    clearInterval(audioMonitor);
    if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
  });

  twilioWs.on("error", (err) => {
    console.error(`[Twilio WS] Error: ${err.message}`);
  });
});


// ── Start server ─────────────────────────────────────────────────────────
server.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
```

---

## Part 4: Venue data format

**`data/venues.json`:**
```json
[
  {
    "id": "restaurant-abc-e1",
    "name": "Restaurant ABC",
    "phone": "020 7123 4567",
    "cuisine": "Italian",
    "borough": "shoreditch"
  },
  {
    "id": "cafe-xyz-n1",
    "name": "Cafe XYZ",
    "phone": "07712 345678",
    "cuisine": "Cafe",
    "borough": "islington"
  }
]
```

The `id` field is what gets used as the key in `call-status.json` and in transcript filenames. Make them stable and unique. Slug format works well (`venue-name-postcode`).

Phone normalisation (done in the server):
- `07712 345678` → `+447712345678`
- `020 7123 4567` → `+442071234567`
- Numbers that already start with `+` are left alone

---

## Part 5: Deploy to Railway

### First deploy

```bash
# Push code to GitHub
git init
git add .
git commit -m "initial"
gh repo create your-voice-agent --public --push --source .

# In Railway dashboard:
# 1. New Project → Deploy from GitHub → select your repo
# 2. Variables tab → add all your .env variables
# 3. Settings → Networking → Generate Domain
# 4. Copy the URL (e.g. your-app.up.railway.app)
# 5. Back to Variables → set SERVER_URL=https://your-app.up.railway.app
```

Railway will auto-deploy every time you push to `main`.

### Verify it's running

```bash
curl https://your-app.up.railway.app/
# Should return: {"status":"running","activeCalls":0}
```

```bash
# Test the TwiML endpoint
curl "https://your-app.up.railway.app/outbound-twiml?venueName=Test+Cafe&venueId=test-1"
# Should return XML with <Stream url="wss://..."> 
```

---

## Part 6: Trigger your first call

```bash
curl -X POST "https://your-app.up.railway.app/trigger-calls?secret=your_trigger_secret&limit=1"
```

Watch Railway logs. You should see (within 5-10 seconds):
```
[Call 1/1] Test Restaurant
[Twilio] Call started — Test Restaurant (CAxxxxxxxx)
[ElevenLabs] Connected — Test Restaurant
[ElevenLabs] Conversation: conv_01jxxxxxxxxxxxxxxx
[User] Hello?
[Agent] Hi, I'm calling from First Order London...
[User] Yes, the pasta is fantastic here.
[Agent] Perfect, thank you so much. Goodbye!
[ElevenLabs] Disconnected — Test Restaurant
[Saved] data/transcripts/test-restaurant-1_1713780000000.json
```

---

## Part 7: Transcript format

Each call saves a JSON file like:

```json
{
  "venueId": "restaurant-abc-e1",
  "venueName": "Restaurant ABC",
  "cuisine": "Italian",
  "conversationId": "conv_01jxxxxxxxxxxxxxxx",
  "callSid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "timestamp": "2026-04-22T14:23:11.000Z",
  "gotHumanResponse": true,
  "callDuration": 28,
  "transcript": [
    { "role": "user", "text": "Hello?" },
    { "role": "agent", "text": "Hi, I'm Alice from First Order London..." },
    { "role": "user", "text": "The tagliatelle is incredible, honestly." },
    { "role": "agent", "text": "Amazing, thank you! Goodbye!" }
  ],
  "elevenLabsTranscript": [...],
  "analysis": {
    "evaluation_criteria_results": {},
    "data_collection_results": {}
  }
}
```

The `elevenLabsTranscript` field is from the ElevenLabs API and is more structured than your local `transcript` array. Both are useful.

---

## Part 8: ElevenLabs message types (full reference)

Every message from ElevenLabs over WebSocket has a `type` field. Here's what each one is:

| Type | When it fires | What to do with it |
|------|--------------|---------------------|
| `conversation_initiation_metadata` | First message, confirms connection | Save `conversation_id` for transcript lookup |
| `audio` | Agent speaks | Extract `audio.chunk` or `audio_event.audio_base_64`, forward to Twilio |
| `user_transcript` | ElevenLabs recognised what caller said | Log it, check for IVR patterns, decide if human |
| `agent_response` | Agent's text response (before audio) | Log it, check for [PRESS X] DTMF instructions |
| `interruption` | Caller interrupted agent mid-speech | Send `{event: "clear", streamSid}` to Twilio to stop playing |
| `ping` | Keep-alive (every ~30s) | Respond with `{type: "pong", event_id: ...}` |
| `conversation_initiation_client_data` | You send this (not receive) | Sent by you on open to pass dynamic variables |

---

## Part 9: Automation with GitHub Actions

### Schedule calls twice a day

**`.github/workflows/call-batch.yml`:**
```yaml
name: Call batch
on:
  schedule:
    - cron: "45 9 * * 1-5"   # 10:45am BST (Mon-Fri)
    - cron: "45 13 * * 1-5"  # 2:45pm BST (Mon-Fri)
  workflow_dispatch:           # Also allows manual trigger from GitHub UI

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger calls
        run: |
          curl -f -X POST \
            "${{ secrets.SERVER_URL }}/trigger-calls?secret=${{ secrets.TRIGGER_SECRET }}&limit=50"
```

Go to GitHub → Settings → Secrets → add `SERVER_URL` and `TRIGGER_SECRET`.

**Timezone note:** GitHub Actions cron runs in UTC. UK is UTC+1 in summer (BST) and UTC+0 in winter. `9:45 UTC = 10:45 BST`. Adjust accordingly.

### Fetch and process transcripts after calls

```yaml
      - name: Wait for calls to complete
        run: sleep 300  # 5 minutes for calls to finish

      - name: Fetch transcripts
        run: |
          curl -o transcripts.json \
            "${{ secrets.SERVER_URL }}/transcripts?secret=${{ secrets.TRIGGER_SECRET }}"

      - name: Process with Claude
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          node scripts/classify-transcripts.js transcripts.json
```

---

## Part 10: Post-call classification with Claude (optional)

If you want to extract structured data from transcripts — whether they got an answer, what the answer was, how confident — Claude Haiku is cheap and fast.

```javascript
import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic();

async function classifyTranscript(venueName, transcript) {
  const callText = transcript.map(t => `${t.role.toUpperCase()}: ${t.text}`).join("\n");

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `Call transcript from ${venueName}:

${callText}

Did the agent get a dish recommendation? Extract the key information.
Reply with JSON only:
{
  "got_answer": true/false,
  "dish": "name of dish or null",
  "quote": "best verbatim quote from the human or null",
  "confidence": "high/medium/low",
  "notes": "anything else relevant"
}`
    }]
  });

  return JSON.parse(msg.content[0].text);
}
```

---

## Part 11: Slack notifications

Add a Slack webhook and call `postSlack()` at key moments:

```javascript
async function postSlack(text) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// Example usage
await postSlack(`*First Order* — Run complete: ${answered} answers from ${total} calls`);
```

Get the webhook URL: Slack → Apps → Incoming Webhooks → Add to Slack → choose channel.

---

## Part 12: ElevenLabs credits check

Before a run, you can check whether you have quota left:

```javascript
async function checkElevenLabsCredits() {
  const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });
  const data = await res.json();
  const used = data.character_count || 0;
  const limit = (data.character_limit || 0) + (data.max_character_limit_extension || 0);
  return { remaining: Math.max(0, limit - used), limit, tier: data.tier };
}

// Before trigger-calls runs:
const credits = await checkElevenLabsCredits();
if (credits.remaining === 0) {
  await postSlack("ElevenLabs quota exhausted — skipping calls");
  return;
}
if (credits.remaining < 200_000) {
  await postSlack(`Low ElevenLabs credits: ${credits.remaining.toLocaleString()} remaining`);
}
```

---

## Part 13: File and folder structure

```
your-project/
├── server.js                        # Everything above
├── package.json
├── .env                             # NEVER commit this
├── .env.example                     # Commit this (variable names, no values)
├── .gitignore                       # Include: .env, data/transcripts/, node_modules/
│
├── data/
│   ├── venues.json                  # Your list of numbers to call
│   ├── call-status.json             # Tracks status per venue: answered/no_answer
│   ├── call-status-backup.json      # Backup version (committed, restored on Railway restart)
│   └── transcripts/
│       ├── venue-id_1713780000000.json
│       └── ...
│
├── scripts/
│   └── classify-transcripts.js      # Claude classification (optional)
│
└── .github/
    └── workflows/
        └── call-batch.yml           # Scheduling
```

**`.gitignore` additions:**
```
.env
data/transcripts/
node_modules/
```

Commit `data/call-status.json` (or a backup copy of it) so Railway can restore after restarts.

---

## Part 14: Common problems

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| Calls connect but caller hears nothing | ElevenLabs connection failing silently | Check Railway logs for ElevenLabs errors; verify agent ID is correct |
| Agent doesn't hear the caller | Audio not forwarding to ElevenLabs | Add `console.log` in the `media` case handler; check `elevenLabsReady` is true |
| All calls go to voicemail | Safety timeout too short | Raise from 120s to 180s — some IVR systems are very slow |
| "Signed URL" error | Agent ID wrong | Agent ID is in the ElevenLabs URL: `elevenlabs.io/app/conversational-ai/agents/AGENT_ID_HERE` |
| Calls ring but instantly disconnect | TwiML URL not reachable from Twilio | `curl` your `/outbound-twiml` endpoint manually |
| TwiML error: "stream URL must be WSS" | Using HTTP instead of HTTPS | Railway provides HTTPS/WSS — make sure `SERVER_URL` starts with `https://` |
| Twilio 429 rate limit errors | Calling too fast | Increase delay between calls (currently 30s, try 45s) |
| Transcripts disappear after deploy | Railway ephemeral filesystem | Implement the GitHub restore pattern (Part 5), or use a database |
| Agent sounds choppy | High latency server | Railway US West is often fastest for UK calls — try different regions |
| `[PRESS 1]` not working | DTMF format wrong | Must be exactly `[PRESS 1]` — check your prompt uses this exact format |

---

## Part 15: Costs

Estimates at 175 calls/day, ~30 seconds average:

| Service | Rate | Daily | Monthly |
|---------|------|-------|---------|
| Twilio outbound UK | $0.013/min | ~$1.14 | ~$34 |
| ElevenLabs (convai minutes) | Included in plan up to limit | — | £263/mo plan |
| Railway | Free tier | $0 | $0-5 |
| Anthropic (Claude Haiku, classification) | $0.25/1M tokens | ~$0.01 | ~$0.30 |

For testing: 10 calls costs less than $0.10. Start small.

---

## Part 16: Things that look obvious but aren't

**On the signed URL:** You must fetch a new one for every call. The URL expires in minutes and is single-use. Don't cache it.

**On the WSS vs WS:** Twilio requires HTTPS and WSS — it won't connect to plain HTTP. Railway gives you this automatically.

**On the `streamSid` vs `callSid`:** Twilio gives you both. `callSid` identifies the call (CA...). `streamSid` identifies the media stream (MZ...). You need `streamSid` for sending audio back and DTMF tones. You need `callSid` for call management (ending calls programmatically, looking up status).

**On the audio format:** Twilio sends mulaw audio at 8000Hz. ElevenLabs handles this natively — you just pass the base64 payload through unchanged. You don't need to decode or transcode.

**On IVR navigation:** The key insight is that the agent outputs `[PRESS 1]` as text in its response, and your server intercepts that text and sends DTMF tones. The agent doesn't need to know how DTMF works — it just needs to output the right text pattern. Works surprisingly well.

**On the transcript endpoint:** After calls, your GitHub Actions can `curl /transcripts` to get everything. This is cleaner than trying to commit transcripts from Railway.

---

*Stack used in production at Mike Litman's Cultural Capital Labs across three live projects: First Order London, Buggy Smart, and Queue Index. Last verified April 2026.*
