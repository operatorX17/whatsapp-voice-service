require("dotenv").config();
const express = require("express");
const axios = require("axios");
const http = require("http");
const WebSocket = require("ws");
const {
    RTCPeerConnection,
    RTCSessionDescription,
    MediaStream,
    nonstandard: { RTCAudioSink, RTCAudioSource }
} = require("@roamhq/wrtc");

// STUN server for NAT traversal
const ICE_SERVERS = [{ urls: "stun:stun.relay.metered.ca:80" }];

const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${process.env.HEALTHCARE_WHATSAPP_PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.HEALTHCARE_WHATSAPP_ACCESS_TOKEN}`;
const VERIFY_TOKEN = process.env.HEALTHCARE_WHATSAPP_VERIFY_TOKEN;
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;

const app = express();
const server = http.createServer(app);

app.use(express.json());

// State per call
let whatsappPc = null;
let whatsappStream = null;
let currentCallId = null;
let ultravoxWs = null;
let audioSource = null;
let audioSink = null;

console.log("🎙️  WhatsApp Voice Calling with Ultravox AI");
console.log("Phone ID:", process.env.HEALTHCARE_WHATSAPP_PHONE_NUMBER_ID);
console.log("Ultravox API:", ULTRAVOX_API_KEY ? "✅ Configured" : "❌ Missing");

// Health check
app.get("/", (req, res) => {
    res.json({ status: "ok", service: "whatsapp-voice-ultravox", ultravox: !!ULTRAVOX_API_KEY });
});

// Webhook verification
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verified");
        res.send(challenge);
    } else {
        console.log("❌ Webhook verification failed");
        res.sendStatus(403);
    }
});

// Handle WhatsApp call events
app.post("/webhook", async (req, res) => {
    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const call = change?.value?.calls?.[0];
        const contact = change?.value?.contacts?.[0];

        if (!call || !call.id || !call.event) {
            return res.sendStatus(200);
        }

        currentCallId = call.id;

        if (call.event === "connect") {
            const whatsappOfferSdp = call?.session?.sdp;
            const callerName = contact?.profile?.name || "Unknown";
            const callerNumber = contact?.wa_id || "Unknown";

            console.log(`📞 Incoming call from ${callerName} (${callerNumber})`);

            if (!ULTRAVOX_API_KEY) {
                console.log("⚠️  Ultravox not configured, rejecting call");
                await rejectCall(currentCallId);
                return res.sendStatus(200);
            }

            try {
                // Step 1: Create Ultravox call and get WebSocket URL
                const ultravoxCall = await createUltravoxCall(callerName);
                console.log("✅ Ultravox call created:", ultravoxCall.callId);

                // Step 2: Setup WebRTC with WhatsApp
                await setupWhatsAppWebRTC(whatsappOfferSdp, ultravoxCall.joinUrl);
                
            } catch (error) {
                console.error("❌ Failed to setup call:", error.message);
                await rejectCall(currentCallId);
            }

        } else if (call.event === "terminate") {
            console.log(`📞 Call terminated: ${call.id}`);
            cleanup();
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("Webhook error:", err);
        res.sendStatus(500);
    }
});

async function createUltravoxCall(callerName) {
    const response = await axios.post(
        "https://api.ultravox.ai/api/calls",
        {
            systemPrompt: `You are a friendly healthcare assistant for a WhatsApp bot. 
The caller's name is ${callerName}. 
Help them with:
- Booking diagnostic lab tests (blood tests like CBC, LFT, RFT, thyroid, etc.)
- Ordering medicines from pharmacy
- Answering general healthcare questions

Be conversational, helpful, and concise. Ask clarifying questions when needed.
When they want to book a test or order medicine, collect the details and confirm.`,
            voice: "Mark",
            temperature: 0.7,
            firstSpeaker: "FIRST_SPEAKER_AGENT",
            initialOutputMedium: "MESSAGE_MEDIUM_VOICE"
        },
        {
            headers: {
                "X-API-Key": ULTRAVOX_API_KEY,
                "Content-Type": "application/json"
            }
        }
    );

    return response.data;
}

async function setupWhatsAppWebRTC(whatsappOfferSdp, ultravoxJoinUrl) {
    // Setup WhatsApp peer connection
    whatsappPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Create audio source for sending audio to WhatsApp
    audioSource = new RTCAudioSource();
    const track = audioSource.createTrack();
    whatsappPc.addTrack(track);

    // Handle incoming audio from WhatsApp
    whatsappPc.ontrack = (event) => {
        console.log("🎵 Audio track received from WhatsApp");
        whatsappStream = event.streams[0];
        
        // Create audio sink to capture WhatsApp audio
        const audioTrack = whatsappStream.getAudioTracks()[0];
        if (audioTrack) {
            audioSink = new RTCAudioSink(audioTrack);
            audioSink.ondata = (data) => {
                // Send audio to Ultravox
                if (ultravoxWs && ultravoxWs.readyState === WebSocket.OPEN) {
                    // Convert to base64 and send
                    const base64Audio = Buffer.from(data.samples.buffer).toString('base64');
                    ultravoxWs.send(JSON.stringify({
                        type: "input_audio",
                        audio: base64Audio
                    }));
                }
            };
        }
    };

    // Set WhatsApp offer
    await whatsappPc.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: whatsappOfferSdp
    }));
    console.log("✅ WhatsApp SDP offer set");

    // Create answer
    const answer = await whatsappPc.createAnswer();
    await whatsappPc.setLocalDescription(answer);
    const finalSdp = answer.sdp.replace("a=setup:actpass", "a=setup:active");
    console.log("✅ WhatsApp SDP answer created");

    // Connect to Ultravox WebSocket
    await connectToUltravox(ultravoxJoinUrl);

    // Answer WhatsApp call
    const preAcceptOk = await answerWhatsAppCall(currentCallId, finalSdp, "pre_accept");
    if (preAcceptOk) {
        setTimeout(async () => {
            const acceptOk = await answerWhatsAppCall(currentCallId, finalSdp, "accept");
            if (acceptOk) {
                console.log("✅ Call connected! AI is ready to talk.");
            }
        }, 1000);
    }
}

async function connectToUltravox(joinUrl) {
    return new Promise((resolve, reject) => {
        console.log("🔌 Connecting to Ultravox WebSocket...");
        ultravoxWs = new WebSocket(joinUrl);

        ultravoxWs.on("open", () => {
            console.log("✅ Connected to Ultravox");
            resolve();
        });

        ultravoxWs.on("message", (data) => {
            try {
                const msg = JSON.parse(data);
                
                if (msg.type === "audio") {
                    // Received audio from Ultravox AI, send to WhatsApp
                    const audioBuffer = Buffer.from(msg.audio, 'base64');
                    if (audioSource) {
                        // Convert to Int16Array for RTCAudioSource
                        const samples = new Int16Array(audioBuffer.buffer);
                        audioSource.onData({
                            samples: samples,
                            sampleRate: 16000,
                            bitsPerSample: 16,
                            channelCount: 1
                        });
                    }
                } else if (msg.type === "transcript") {
                    console.log(`🗣️ ${msg.role}: ${msg.text}`);
                }
            } catch (e) {
                // Binary audio data
                if (audioSource && data instanceof Buffer) {
                    const samples = new Int16Array(data.buffer);
                    audioSource.onData({
                        samples: samples,
                        sampleRate: 16000,
                        bitsPerSample: 16,
                        channelCount: 1
                    });
                }
            }
        });

        ultravoxWs.on("error", (err) => {
            console.error("❌ Ultravox WebSocket error:", err.message);
            reject(err);
        });

        ultravoxWs.on("close", () => {
            console.log("🔌 Ultravox WebSocket closed");
        });

        setTimeout(() => reject(new Error("Ultravox connection timeout")), 10000);
    });
}

async function answerWhatsAppCall(callId, sdp, action) {
    try {
        const response = await axios.post(
            WHATSAPP_API_URL,
            {
                messaging_product: "whatsapp",
                call_id: callId,
                action: action,
                session: { sdp_type: "answer", sdp: sdp }
            },
            {
                headers: {
                    Authorization: ACCESS_TOKEN,
                    "Content-Type": "application/json"
                }
            }
        );

        if (response.data?.success) {
            console.log(`✅ WhatsApp ${action} successful`);
            return true;
        }
        console.warn(`⚠️ WhatsApp ${action} not successful:`, response.data);
        return false;
    } catch (error) {
        console.error(`❌ Failed to ${action}:`, error.response?.data || error.message);
        return false;
    }
}

async function rejectCall(callId) {
    try {
        await axios.post(
            WHATSAPP_API_URL,
            {
                messaging_product: "whatsapp",
                call_id: callId,
                action: "reject"
            },
            {
                headers: {
                    Authorization: ACCESS_TOKEN,
                    "Content-Type": "application/json"
                }
            }
        );
        console.log(`✅ Call rejected: ${callId}`);
    } catch (error) {
        console.error("❌ Reject failed:", error.message);
    }
}

function cleanup() {
    if (ultravoxWs) {
        ultravoxWs.close();
        ultravoxWs = null;
    }
    if (whatsappPc) {
        whatsappPc.close();
        whatsappPc = null;
    }
    if (audioSink) {
        audioSink.stop();
        audioSink = null;
    }
    audioSource = null;
    whatsappStream = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🎙️  Voice service running on port ${PORT}`);
});
