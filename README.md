# elevenlabs-phone-agent

A Node.js server that connects Twilio and ElevenLabs Conversational AI to make outbound AI phone calls at scale.

Give it a list of phone numbers. It calls them, has a real spoken conversation using your ElevenLabs agent, transcribes everything, and saves structured results. Handles IVR navigation, voicemail detection, automatic retries, and post-call transcript fetching.

Built and battle-tested across four live projects:
- **[First Order London](https://first-order-london.netlify.app)** — calls restaurants to ask what dish to order on a first visit
- **[Buggy Smart](https://buggysmart.app)** — calls cafes to verify pram and buggy accessibility
- **[Queue Index](https://queue-index.netlify.app)** — calls restaurants for live walk-in wait times
- **[With Moshi](https://withmoshi.com)** — AI phone answering for UK restaurants

15,000+ conversations logged. This is the exact stack.

---

## How it works

Twilio and ElevenLabs don't talk to each other directly. This server sits in the middle and bridges audio both ways in real time:

```
Phone call → Twilio → [this server] → ElevenLabs agent
                   ←               ←  (agent speaks back)
```

Two WebSocket connections run simultaneously: one to Twilio's media stream, one to ElevenLabs. Audio chunks flow in both directions as base64-encoded JSON messages.

---

## What you need

| Service | Role |
|---------|------|
| [Twilio](https://twilio.com) | Phone numbers + outbound calling |
| [ElevenLabs](https://elevenlabs.io) | Conversational AI agent + voice |
| [Railway](https://railway.app) | Hosts this server (needs HTTPS + WSS) |

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/mikelitman/elevenlabs-phone-agent.git
cd elevenlabs-phone-agent
npm install
```

### 2. Create your ElevenLabs agent

1. Go to [elevenlabs.io](https://elevenlabs.io) → Conversational AI → Agents → Create Agent
2. Write your system prompt. Use `{{venue_name}}` for per-call context (see example below)
3. Enable **Dynamic Variables** under Advanced settings
4. Copy your **Agent ID** from the URL

**Example prompt:**
```
You are calling {{venue_name}} to ask one question: what dish would 
you recommend someone order on their very first visit?

When a human answers, introduce yourself briefly and ask your question.
When you hit an IVR menu, navigate it. If you need to press a number,
output [PRESS 1] exactly — this triggers the dial tone automatically.
If you reach voicemail, hang up.
```

### 3. Buy a Twilio number

1. [twilio.com](https://twilio.com) → Phone Numbers → Buy a Number
2. Copy your **Account SID**, **Auth Token**, and the phone number

### 4. Configure environment variables

```bash
cp .env.example .env
# Fill in your values
```

### 5. Deploy to Railway

```bash
# Push to GitHub, then:
# railway.app → New Project → Deploy from GitHub
# Add all .env variables in the Railway dashboard
# Settings → Networking → Generate Domain
# Update SERVER_URL in Railway variables to your new domain
```

### 6. Add your venues

Edit `data/venues-example.json` with real phone numbers, or create `data/venues.json`:

```json
[
  { "id": "venue-slug", "name": "Venue Name", "phone": "020 7123 4567" }
]
```

UK numbers are normalised automatically (`07...` → `+447...`).

### 7. Trigger a call batch

```bash
curl -X POST "https://your-app.up.railway.app/trigger-calls?limit=5" \
  -H "X-Trigger-Secret: your_trigger_secret"
```

> **Security note:** pass the secret via the `X-Trigger-Secret` header, not a query parameter. Query params appear in Railway logs, Twilio call records, and any CDN access logs.

Watch Railway logs. You should see the call connect, ElevenLabs join, conversation happen, and transcript save.

---

## Automate with GitHub Actions

```yaml
# .github/workflows/call-batch.yml
name: Call batch
on:
  schedule:
    - cron: "45 9 * * 1-5"   # 10:45am BST (Mon-Fri)
    - cron: "45 13 * * 1-5"  # 2:45pm BST

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger calls
        run: |
          curl -f -X POST \
            "${{ secrets.SERVER_URL }}/trigger-calls?limit=50" \
            -H "X-Trigger-Secret: ${{ secrets.TRIGGER_SECRET }}"
```

---

## Key features

**IVR navigation** — Add `[PRESS 1]` to your agent prompt. The server intercepts the text and sends actual DTMF tones to Twilio. Your agent navigates phone menus automatically.

**Voicemail detection** — Regex pattern matches common voicemail/IVR phrases. Calls with no human response time out after 120 seconds.

**Auto-retry** — Failed calls are retried once after a 5-minute delay.

**Skip already-answered** — `call-status.json` tracks every venue. Venues that already answered are skipped on subsequent runs.

**Full transcript** — After each call, the server fetches the complete transcript from the ElevenLabs API including timings, analysis, and call duration.

**Audio buffering** — ElevenLabs takes ~1 second to connect. Early audio from the caller is buffered and flushed once the connection is ready.

---

## Transcript format

Each call saves a JSON file to `data/transcripts/`:

```json
{
  "venueId": "restaurant-abc",
  "venueName": "Restaurant ABC",
  "conversationId": "conv_01j...",
  "callSid": "CA...",
  "timestamp": "2026-04-23T09:00:00.000Z",
  "gotHumanResponse": true,
  "callDuration": 28,
  "transcript": [
    { "role": "user", "text": "Hello?" },
    { "role": "agent", "text": "Hi, I'm calling from First Order London..." },
    { "role": "user", "text": "The tagliatelle is incredible, honestly." }
  ]
}
```

---

## Project structure

```
elevenlabs-phone-agent/
├── server.js                 # Everything
├── package.json
├── .env.example
└── data/
    ├── venues-example.json   # Template — copy to venues.json
    ├── call-status.json      # Auto-generated: tracks call history
    └── transcripts/          # Auto-generated: one file per call
```

---

## Common problems

| Problem | Fix |
|---------|-----|
| Calls connect but no audio | Check `SERVER_URL` starts with `https://` — Twilio requires WSS |
| "Signed URL" error | Agent ID is in the ElevenLabs URL, not the agent name |
| All calls go to voicemail | Raise the safety timeout — IVRs can take 60+ seconds |
| Twilio 429 errors | Increase the delay between calls (default: 30 seconds) |
| Transcripts disappear on redeploy | Railway resets the filesystem — back up `call-status.json` to GitHub |

---

## Full setup guide

Detailed architecture, all ElevenLabs WebSocket message types, GitHub Actions post-processing, Claude classification, Slack notifications, and cost breakdown:

[SETUP.md](SETUP.md)

---

Built by [Mike Litman](https://mikelitman.me) at Cultural Capital Labs.
