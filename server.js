require("dotenv").config();
const express = require("express");
const axios = require("axios");
const http = require("http");
const WebSocket = require("ws");
const {
    RTCPeerConnection,
    RTCSessionDescription,
    nonstandard: { RTCAudioSink, RTCAudioSource }
} = require("@roamhq/wrtc");

const ICE_SERVERS = [{ urls: "stun:stun.relay.metered.ca:80" }];

const WHATSAPP_API_URL = `https://graph.facebook.com/v24.0/${process.env.HEALTHCARE_WHATSAPP_PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.HEALTHCARE_WHATSAPP_ACCESS_TOKEN}`;
const VERIFY_TOKEN = process.env.HEALTHCARE_WHATSAPP_VERIFY_TOKEN;
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;

const app = express();
const server = http.createServer(app);
app.use(express.json());

let whatsappPc = null;
let currentCallId = null;
let ultravoxWs = null;
let audioSource = null;
let audioSink = null;

console.log("🎙️  WhatsApp Voice + Ultravox AI");
console.log("Phone ID:", process.env.HEALTHCARE_WHATSAPP_PHONE_NUMBER_ID);
console.log("Ultravox:", ULTRAVOX_API_KEY ? "✅" : "❌");

app.get("/", (req, res) => res.json({ status: "ok" }));

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verified");
        res.send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post("/webhook", async (req, res) => {
    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const call = change?.value?.calls?.[0];
        const contact = change?.value?.contacts?.[0];

        if (!call || !call.id || !call.event) return res.sendStatus(200);

        currentCallId = call.id;

        if (call.event === "connect") {
            const whatsappOfferSdp = call?.session?.sdp;
            const callerName = contact?.profile?.name || "Unknown";
            const callerNumber = contact?.wa_id || "Unknown";

            console.log(`📞 Call from ${callerName} (${callerNumber})`);

            if (!ULTRAVOX_API_KEY) {
                await rejectCall(currentCallId);
                return res.sendStatus(200);
            }

            try {
                // Create Ultravox call with serverWebSocket medium
                const ultravoxCall = await createUltravoxCall(callerName);
                console.log("✅ Ultravox call:", ultravoxCall.callId);

                // Setup bridge
                await setupBridge(whatsappOfferSdp, ultravoxCall.joinUrl);
            } catch (error) {
                console.error("❌ Setup failed:", error.message);
                if (error.response) console.error("Response:", JSON.stringify(error.response.data));
                await rejectCall(currentCallId);
            }
        } else if (call.event === "terminate") {
            console.log(`📞 Call ended`);
            cleanup();
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("Webhook error:", err);
        res.sendStatus(500);
    }
});

async function createUltravoxCall(callerName) {
    // Use serverWebSocket medium for server-to-server audio
    const response = await axios.post(
        "https://api.ultravox.ai/api/calls",
        {
            systemPrompt: `You are a friendly healthcare assistant. The caller is ${callerName}. 
Help with booking diagnostic tests or ordering medicines. Be warm and conversational.
Start by saying "Hello! Welcome to our healthcare service. How can I help you today?"`,
            model: "fixie-ai/ultravox",
            voice: "Mark",
            temperature: 0.6,
            firstSpeaker: "FIRST_SPEAKER_AGENT",
            medium: {
                serverWebSocket: {
                    inputSampleRate: 8000,
                    outputSampleRate: 8000
                }
            }
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

async function setupBridge(whatsappOfferSdp, ultravoxJoinUrl) {
    // Setup WhatsApp WebRTC
    whatsappPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Audio source to send Ultravox audio to WhatsApp
    audioSource = new RTCAudioSource();
    const track = audioSource.createTrack();
    whatsappPc.addTrack(track);

    // Connect to Ultravox first
    await connectToUltravox(ultravoxJoinUrl);

    // Handle WhatsApp audio -> Ultravox
    whatsappPc.ontrack = (event) => {
        console.log("🎵 WhatsApp audio received");
        const audioTrack = event.streams[0]?.getAudioTracks()[0];
        if (audioTrack) {
            audioSink = new RTCAudioSink(audioTrack);
            audioSink.ondata = (data) => {
                if (ultravoxWs && ultravoxWs.readyState === WebSocket.OPEN) {
                    // Convert Float32 samples to Int16 PCM at 8kHz
                    // WhatsApp sends 48kHz, we need to downsample
                    const samples = data.samples;
                    const ratio = Math.floor(data.sampleRate / 8000);
                    const outLen = Math.floor(samples.length / ratio);
                    const int16 = new Int16Array(outLen);
                    
                    for (let i = 0; i < outLen; i++) {
                        const s = samples[i * ratio];
                        int16[i] = Math.max(-32768, Math.min(32767, Math.floor(s * 32767)));
                    }
                    
                    ultravoxWs.send(Buffer.from(int16.buffer));
                }
            };
        }
    };

    // Set WhatsApp offer
    await whatsappPc.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: whatsappOfferSdp
    }));
    console.log("✅ WhatsApp offer set");

    // Create answer
    const answer = await whatsappPc.createAnswer();
    await whatsappPc.setLocalDescription(answer);
    const finalSdp = answer.sdp.replace("a=setup:actpass", "a=setup:active");
    console.log("✅ Answer created");

    // Answer WhatsApp call
    const preOk = await answerWhatsAppCall(currentCallId, finalSdp, "pre_accept");
    if (preOk) {
        setTimeout(async () => {
            await answerWhatsAppCall(currentCallId, finalSdp, "accept");
            console.log("✅ Call connected!");
        }, 1000);
    }
}

async function connectToUltravox(joinUrl) {
    return new Promise((resolve, reject) => {
        console.log("🔌 Connecting to Ultravox...");
        ultravoxWs = new WebSocket(joinUrl);

        ultravoxWs.on("open", () => {
            console.log("✅ Ultravox connected");
            resolve();
        });

        ultravoxWs.on("message", (data) => {
            if (Buffer.isBuffer(data)) {
                // Audio from Ultravox (8kHz Int16 PCM) -> WhatsApp (48kHz)
                if (audioSource && data.length > 0) {
                    const int16 = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
                    
                    // Upsample from 8kHz to 48kHz
                    const ratio = 6;
                    const upsampled = new Int16Array(int16.length * ratio);
                    for (let i = 0; i < int16.length; i++) {
                        for (let j = 0; j < ratio; j++) {
                            upsampled[i * ratio + j] = int16[i];
                        }
                    }
                    
                    audioSource.onData({
                        samples: upsampled,
                        sampleRate: 48000,
                        bitsPerSample: 16,
                        channelCount: 1
                    });
                }
            } else {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === "transcript") {
                        console.log(`🗣️ ${msg.role}: ${msg.text}`);
                    } else if (msg.type === "state") {
                        console.log(`📊 State: ${msg.state}`);
                    }
                } catch (e) {}
            }
        });

        ultravoxWs.on("error", (err) => {
            console.error("❌ Ultravox error:", err.message);
            reject(err);
        });

        ultravoxWs.on("close", (code, reason) => {
            console.log(`🔌 Ultravox closed: ${code}`);
        });

        setTimeout(() => reject(new Error("Timeout")), 15000);
    });
}

async function answerWhatsAppCall(callId, sdp, action) {
    try {
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: "whatsapp",
            call_id: callId,
            action: action,
            session: { sdp_type: "answer", sdp: sdp }
        }, {
            headers: { Authorization: ACCESS_TOKEN, "Content-Type": "application/json" }
        });

        if (response.data?.success) {
            console.log(`✅ ${action} OK`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`❌ ${action}:`, error.response?.data || error.message);
        return false;
    }
}

async function rejectCall(callId) {
    try {
        await axios.post(WHATSAPP_API_URL, {
            messaging_product: "whatsapp",
            call_id: callId,
            action: "reject"
        }, { headers: { Authorization: ACCESS_TOKEN, "Content-Type": "application/json" } });
    } catch (e) {}
}

function cleanup() {
    if (ultravoxWs) { ultravoxWs.close(); ultravoxWs = null; }
    if (whatsappPc) { whatsappPc.close(); whatsappPc = null; }
    if (audioSink) { audioSink.stop(); audioSink = null; }
    audioSource = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`🎙️ Port ${PORT}`));
