import "dotenv/config";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import twilio from "twilio";

const { VoiceResponse } = twilio.twiml;

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const app = express();

// urlencoded must be global so Twilio webhook validation can read the body
app.use(express.urlencoded({ extended: true }));
// Default JSON limit for all routes; /trigger-calls gets a higher limit below
app.use(express.json());

const server = http.createServer(app);

const activeCalls = new Map();
const MAX_COMPLETED_CALLS = 200;
const completedCalls = [];

let currentRun = {
  active: false,
  total: 0,
  completed: 0,
  startedAt: null,
  results: { answered: 0, no_answer: 0, error: 0 },
};

// ── State helpers ─────────────────────────────────────────────────────────

const STATUS_FILE = "data/call-status.json";
let statusCache = null;

function loadCallStatus() {
  if (statusCache) return statusCache;
  try {
    statusCache = JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    statusCache = {};
  }
  return statusCache;
}

// Mutates the in-memory cache synchronously; flushes to disk async
function updateCallStatus(venueId, status, convId) {
  if (!venueId) return;
  loadCallStatus();
  statusCache[venueId] = {
    status,
    callCount: (statusCache[venueId]?.callCount || 0) + 1,
    lastCalled: new Date().toISOString(),
    conversationId: convId || statusCache[venueId]?.conversationId,
  };
  fs.promises.writeFile(STATUS_FILE, JSON.stringify(statusCache, null, 2))
    .catch(err => console.error(`[Status] Write failed: ${err.message}`));
  if (status === "answered") currentRun.results.answered++;
  else if (status === "no_answer") currentRun.results.no_answer++;
}

// ── Twilio webhook validation ─────────────────────────────────────────────
// Validates X-Twilio-Signature on inbound webhooks. Skipped in dev when
// TWILIO_AUTH_TOKEN is absent (e.g. local testing without a tunnel).

const validateTwilio = process.env.TWILIO_AUTH_TOKEN
  ? twilio.webhook(process.env.TWILIO_AUTH_TOKEN)
  : (req, res, next) => next();

// ── Auth helper ───────────────────────────────────────────────────────────
// Prefer X-Trigger-Secret header over query/body param (query params appear
// in Twilio's call logs, Railway logs, and any CDN access logs).

function requireSecret(req, res) {
  const secret = req.headers["x-trigger-secret"] || req.query.secret || req.body?.secret;
  if (secret !== process.env.TRIGGER_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── Phone normalisation ───────────────────────────────────────────────────

function normaliseUKPhone(phone) {
  phone = phone.replace(/\s+/g, "");
  if (phone.startsWith("0")) return "+44" + phone.slice(1);
  if (!phone.startsWith("+")) return "+44" + phone;
  return phone;
}

// ── Request logging ───────────────────────────────────────────────────────

app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// ── Health check ──────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "running", activeCalls: activeCalls.size, run: currentRun });
});

// ── Trigger a batch of calls ──────────────────────────────────────────────

const ALLOWED_VENUE_FILES = new Set(["venues-example", "venues", "venues-buggy-smart"]);

app.post("/trigger-calls", express.json({ limit: "10mb" }), async (req, res) => {
  if (!requireSecret(req, res)) return;

  if (currentRun.active) {
    return res.status(409).json({ error: "A run is already active", run: currentRun });
  }

  const venueFile = req.query.file || "venues-example";
  if (!ALLOWED_VENUE_FILES.has(venueFile)) {
    return res.status(400).json({ error: "Invalid venue file" });
  }

  let venues;
  try {
    const content = await fs.promises.readFile(`data/${venueFile}.json`, "utf-8");
    venues = JSON.parse(content);
  } catch {
    return res.status(400).json({ error: "Venue file not found or invalid" });
  }

  const statuses = loadCallStatus();

  const callable = venues.filter(v => {
    if (!v.phone) return false;
    const s = statuses[v.id];
    if (!s) return true;
    if (s.status === "answered") return false;
    if ((s.callCount || 0) >= 2) return false;
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

  const SERVER_URL = process.env.SERVER_URL;
  let delay = 30_000;

  for (let i = 0; i < callable.length; i++) {
    const venue = callable[i];
    const phone = normaliseUKPhone(venue.phone);

    try {
      const twimlUrl = new URL(`${SERVER_URL}/outbound-twiml`);
      twimlUrl.searchParams.set("venueName", venue.name);
      twimlUrl.searchParams.set("venueId", venue.id);
      twimlUrl.searchParams.set("cuisine", venue.cuisine || "");

      await twilioClient.calls.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
        url: twimlUrl.toString(),
        timeout: 25,
        timeLimit: 60,
        statusCallback: `${SERVER_URL}/call-status`,
        statusCallbackEvent: ["completed"],
      });

      console.log(`[Call ${i + 1}/${callable.length}] ${venue.name}`);
      delay = 30_000;
    } catch (err) {
      console.error(`[Error] ${venue.name}: ${err.message}`);
      currentRun.results.error++;
      if (err.status === 429 || err.message?.includes("rate")) {
        delay = Math.min(delay * 2, 120_000);
      }
    }

    currentRun.completed = i + 1;
    if (i < callable.length - 1) await new Promise(r => setTimeout(r, delay));
  }

  console.log("[Run] Calls dispatched. Waiting 60s for final transcripts...");
  await new Promise(r => setTimeout(r, 60_000));

  // Auto-retry venues that didn't answer (once, after 5 minutes)
  const toRetry = callable.filter(v => {
    const s = statusCache?.[v.id];
    return s && s.status === "no_answer" && (s.callCount || 0) <= 1;
  });

  if (toRetry.length > 0) {
    console.log(`[Retry] ${toRetry.length} venues — retrying in 5 minutes`);
    await new Promise(r => setTimeout(r, 300_000));

    for (const venue of toRetry) {
      const phone = normaliseUKPhone(venue.phone);
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

// ── TwiML: tells Twilio to open a media stream to this server ─────────────

app.all("/outbound-twiml", validateTwilio, (req, res) => {
  const { venueName = "", venueId = "", cuisine = "" } = req.query;

  const serverWsUrl = new URL(process.env.SERVER_URL);
  serverWsUrl.protocol = serverWsUrl.protocol === "https:" ? "wss:" : "ws:";
  serverWsUrl.pathname = "/media-stream";

  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({ url: serverWsUrl.toString() });
  stream.parameter({ name: "venueName", value: venueName });
  stream.parameter({ name: "venueId", value: venueId });
  stream.parameter({ name: "cuisine", value: cuisine });

  res.type("text/xml").send(twiml.toString());
});

// ── Call status webhook ───────────────────────────────────────────────────

app.post("/call-status", validateTwilio, (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(`[Status] ${CallSid}: ${CallStatus} (${CallDuration}s)`);
  res.sendStatus(200);
});

// ── Transcripts endpoint ──────────────────────────────────────────────────

app.get("/transcripts", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const page = Math.max(1, parseInt(req.query.page || "1"));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50")));
  const dir = "data/transcripts";

  try {
    const allFiles = (await fs.promises.readdir(dir)).filter(f => f.endsWith(".json"));
    const total = allFiles.length;
    const pageFiles = allFiles
      .sort()
      .reverse()
      .slice((page - 1) * limit, page * limit);

    const transcripts = (await Promise.all(
      pageFiles.map(async f => {
        try {
          const content = await fs.promises.readFile(path.join(dir, f), "utf-8");
          return JSON.parse(content);
        } catch {
          return null;
        }
      })
    )).filter(Boolean);

    res.json({ total, page, limit, count: transcripts.length, transcripts });
  } catch {
    res.json({ count: completedCalls.length, transcripts: completedCalls, source: "in-memory" });
  }
});

// ── WebSocket bridge: Twilio <-> ElevenLabs ───────────────────────────────

const wss = new WebSocketServer({ server, path: "/media-stream" });

const MAX_QUEUED_AUDIO_FRAMES = 400; // ~3.5 seconds of audio at 8kHz mulaw

wss.on("connection", (twilioWs) => {
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

  // Hang up if no human answers within 120 seconds
  const safetyTimeout = setTimeout(() => {
    if (!gotHumanResponse) {
      console.log(`[Timeout] No human response — hanging up on ${customParams?.venueName}`);
      updateCallStatus(customParams?.venueId, "no_answer", null);
      if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
      twilioWs.close();
    }
  }, 120_000);

  async function getSignedUrl() {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } }
    );
    if (!response.ok) {
      throw new Error(`ElevenLabs signed URL failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.signed_url) throw new Error("ElevenLabs: no signed_url in response");
    return data.signed_url;
  }

  async function connectElevenLabs() {
    const signedUrl = await getSignedUrl();
    elevenLabsWs = new WebSocket(signedUrl);

    elevenLabsWs.on("open", () => {
      console.log(`[ElevenLabs] Connected — ${customParams?.venueName}`);

      // Pass per-call context to the agent.
      // These fill {{variable_name}} placeholders in your ElevenLabs agent prompt.
      elevenLabsWs.send(JSON.stringify({
        type: "conversation_initiation_client_data",
        dynamic_variables: {
          venue_name: customParams?.venueName || "the venue",
          cuisine: customParams?.cuisine || "",
        },
      }));

      // Flush audio that arrived while ElevenLabs was connecting
      elevenLabsReady = true;
      for (const chunk of audioQueue) {
        elevenLabsWs.send(JSON.stringify({ user_audio_chunk: chunk }));
      }
      audioQueue = [];
    });

    elevenLabsWs.on("message", (data) => {
      const msg = JSON.parse(data);

      switch (msg.type) {

        // Save conversation ID for transcript lookup after the call
        case "conversation_initiation_metadata":
          conversationId = msg.conversation_initiation_metadata_event?.conversation_id;
          console.log(`[ElevenLabs] Conversation: ${conversationId}`);
          break;

        // Agent speaking — forward audio to Twilio so the caller hears it
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
              console.error(`[Bridge] Audio forward failed: ${err.message}`);
            }
          }
          break;
        }

        // Caller interrupted — clear Twilio audio buffer so agent stops mid-sentence
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

        // What the caller said (transcribed by ElevenLabs)
        case "user_transcript": {
          const userText = msg.user_transcription_event?.user_transcript || "";
          transcript.push({ role: "user", text: userText });
          console.log(`[User] ${userText}`);

          const isIVR = /leave a message|press \d|please hold|after the tone|voicemail|automated|visit our website|book online|opening hours/i.test(userText);
          if (userText.replace(/\./g, "").trim().length > 3 && !isIVR) {
            humanResponseCount++;
            if (humanResponseCount >= 1) {
              gotHumanResponse = true;
              clearTimeout(safetyTimeout);
            }
          }
          break;
        }

        // What the agent said
        case "agent_response": {
          const agentText = msg.agent_response_event?.agent_response || "";
          transcript.push({ role: "agent", text: agentText });
          console.log(`[Agent] ${agentText}`);

          // DTMF: if agent outputs [PRESS 1], send the tone to navigate IVR menus
          const dtmfMatch = agentText.match(/\[PRESS\s+([0-9*#]+)\]/i);
          if (dtmfMatch && streamSid) {
            console.log(`[DTMF] Pressing "${dtmfMatch[1]}"`);
            for (const digit of dtmfMatch[1]) {
              try {
                twilioWs.send(JSON.stringify({
                  event: "dtmf",
                  streamSid,
                  dtmf: { digit },
                }));
              } catch (err) {
                console.error(`[DTMF] Failed: ${err.message}`);
              }
            }
          }
          break;
        }

        default:
          console.log(`[ElevenLabs] Unknown message type: ${msg.type}`);
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

  async function saveCallResult() {
    clearTimeout(safetyTimeout);

    const result = {
      venueId: customParams?.venueId,
      venueName: customParams?.venueName,
      cuisine: customParams?.cuisine || "",
      conversationId,
      callSid,
      timestamp: new Date().toISOString(),
      transcript,
      gotHumanResponse,
    };

    // Fetch the full transcript from ElevenLabs API (more complete than local)
    if (conversationId) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const response = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
          { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } }
        );
        if (response.ok) {
          const fullData = await response.json();
          result.elevenLabsTranscript = fullData.transcript;
          result.callDuration = fullData.metadata?.call_duration_secs;
          result.analysis = fullData.analysis;
        }
      } catch (err) {
        console.error(`[API] Transcript fetch failed: ${err.message}`);
      }
    }

    await fs.promises.mkdir("data/transcripts", { recursive: true });
    const filename = `data/transcripts/${result.venueId || "unknown"}_${Date.now()}.json`;
    await fs.promises.writeFile(filename, JSON.stringify(result, null, 2));
    console.log(`[Saved] ${filename}`);

    completedCalls.push(result);
    if (completedCalls.length > MAX_COMPLETED_CALLS) completedCalls.shift();

    updateCallStatus(result.venueId, gotHumanResponse ? "answered" : "no_answer", conversationId);
    activeCalls.delete(callSid);
  }

  // ── Handle messages from Twilio ─────────────────────────────────────────

  twilioWs.on("message", (message) => {
    const msg = JSON.parse(message);

    switch (msg.event) {

      case "start":
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        customParams = msg.start.customParameters;
        console.log(`[Twilio] Call started — ${customParams?.venueName} (${callSid})`);
        activeCalls.set(callSid, { venueName: customParams?.venueName });
        connectElevenLabs().catch(err => {
          console.error(`[ElevenLabs] Failed to connect: ${err.message}`);
          updateCallStatus(customParams?.venueId, "no_answer", null);
          twilioWs.close();
        });
        break;

      case "media":
        if (elevenLabsWs?.readyState === WebSocket.OPEN && elevenLabsReady) {
          elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
        } else {
          // Buffer audio while ElevenLabs connects (~1 second)
          if (audioQueue.length < MAX_QUEUED_AUDIO_FRAMES) audioQueue.push(msg.media.payload);
        }
        break;

      case "stop":
        if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
        break;

      default:
        console.log(`[Twilio] Unknown event: ${msg.event}`);
    }
  });

  twilioWs.on("close", () => {
    clearTimeout(safetyTimeout);
    if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
  });

  twilioWs.on("error", (err) => {
    console.error(`[Twilio WS] Error: ${err.message}`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────

server.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
