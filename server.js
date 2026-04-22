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

const activeCalls = new Map();
const completedCalls = []; // In-memory fallback if filesystem resets

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

  const venueFile = (req.query.file || "venues-example").replace(/[^a-z0-9-]/gi, "");
  const venues = JSON.parse(fs.readFileSync(`data/${venueFile}.json`, "utf-8"));
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

    // Normalise UK numbers: 07... -> +447..., 020... -> +4420...
    let phone = venue.phone.replace(/\s+/g, "");
    if (phone.startsWith("0")) phone = "+44" + phone.slice(1);
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
  const afterStatuses = loadCallStatus();
  const toRetry = callable.filter(v => {
    const s = afterStatuses[v.id];
    return s && s.status === "no_answer" && (s.callCount || 0) <= 1;
  });

  if (toRetry.length > 0) {
    console.log(`[Retry] ${toRetry.length} venues — retrying in 5 minutes`);
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

// ── TwiML: tells Twilio to open a media stream to this server ─────────────

app.all("/outbound-twiml", (req, res) => {
  const { venueName = "", venueId = "", cuisine = "" } = req.query;

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

// ── Call status webhook ───────────────────────────────────────────────────

app.post("/call-status", (req, res) => {
  console.log(`[Status] ${req.body.CallSid}: ${req.body.CallStatus} (${req.body.CallDuration}s)`);
  res.sendStatus(200);
});

// ── Transcripts endpoint ──────────────────────────────────────────────────

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
    res.json({ count: completedCalls.length, transcripts: completedCalls, source: "in-memory" });
  }
});

// ── WebSocket bridge: Twilio <-> ElevenLabs ───────────────────────────────

const wss = new WebSocketServer({ server, path: "/media-stream" });

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
    else currentRun.results.no_answer++;
  }

  async function getSignedUrl() {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } }
    );
    const data = await res.json();
    return data.signed_url;
  }

  async function connectElevenLabs() {
    const signedUrl = await getSignedUrl();
    elevenLabsWs = new WebSocket(signedUrl);

    elevenLabsWs.on("open", () => {
      console.log(`[ElevenLabs] Connected — ${customParams?.venueName}`);

      // Pass per-call context to the agent
      // These fill {{variable_name}} placeholders in your ElevenLabs agent prompt
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
        const res = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
          { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } }
        );
        const fullData = await res.json();
        result.elevenLabsTranscript = fullData.transcript;
        result.callDuration = fullData.metadata?.call_duration_secs;
        result.analysis = fullData.analysis;
      } catch (err) {
        console.error(`[API] Transcript fetch failed: ${err.message}`);
      }
    }

    fs.mkdirSync("data/transcripts", { recursive: true });
    const filename = `data/transcripts/${result.venueId || "unknown"}_${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(result, null, 2));
    console.log(`[Saved] ${filename}`);

    completedCalls.push(result);
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
        connectElevenLabs();
        break;

      case "media":
        if (elevenLabsWs?.readyState === WebSocket.OPEN && elevenLabsReady) {
          elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
        } else {
          // Buffer audio while ElevenLabs connects (~1 second)
          if (audioQueue.length < 400) audioQueue.push(msg.media.payload);
        }
        break;

      case "stop":
        if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
        break;
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
