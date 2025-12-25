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

// Audio buffer for accumulating Ultravox audio
let audioBuffer = Buffer.alloc(0);
const FRAME_SIZE = 960; // 480 samples * 2 bytes = 960 bytes (10ms at 48kHz)

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
                const ultravoxCall = await createUltravoxCall(callerName);
                console.log("✅ Ultravox call:", ultravoxCall.callId);
                await setupBridge(whatsappOfferSdp, ultravoxCall.joinUrl);
            } catch (error) {
                console.error("❌ Setup failed:", error.message);
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
    whatsappPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    audioBuffer = Buffer.alloc(0);

    audioSource = new RTCAudioSource();
    const track = audioSource.createTrack();
    whatsappPc.addTrack(track);

    await connectToUltravox(ultravoxJoinUrl);

    whatsappPc.ontrack = (event) => {
        console.log("🎵 WhatsApp audio received");
        const audioTrack = event.streams[0]?.getAudioTracks()[0];
        if (audioTrack) {
            audioSink = new RTCAudioSink(audioTrack);
            audioSink.ondata = (data) => {
                if (ultravoxWs && ultravoxWs.readyState === WebSocket.OPEN) {
                    // Downsample from 48kHz to 8kHz
                    const samples = data.samples;
                    const ratio = 6; // 48000 / 8000
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

    await whatsappPc.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: whatsappOfferSdp
    }));
    console.log("✅ WhatsApp offer set");

    const answer = await whatsappPc.createAnswer();
    await whatsappPc.setLocalDescription(answer);
    const finalSdp = answer.sdp.replace("a=setup:actpass", "a=setup:active");
    console.log("✅ Answer created");

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
                // Audio from Ultravox (8kHz Int16) -> upsample to 48kHz for WhatsApp
                if (audioSource && data.length > 0) {
                    try {
                        const int16In = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
                        
                        // Upsample 8kHz to 48kHz (ratio 6)
                        const ratio = 6;
                        const upsampled = new Int16Array(int16In.length * ratio);
                        for (let i = 0; i < int16In.length; i++) {
                            for (let j = 0; j < ratio; j++) {
                                upsampled[i * ratio + j] = int16In[i];
                            }
                        }
                        
                        // Add to buffer
                        const newData = Buffer.from(upsampled.buffer);
                        audioBuffer = Buffer.concat([audioBuffer, newData]);
                        
                        // Send complete frames (960 bytes = 480 samples = 10ms at 48kHz)
                        while (audioBuffer.length >= FRAME_SIZE) {
                            const frame = audioBuffer.slice(0, FRAME_SIZE);
                            audioBuffer = audioBuffer.slice(FRAME_SIZE);
                            
                            const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
                            audioSource.onData({
                                samples: samples,
                                sampleRate: 48000,
                                bitsPerSample: 16,
                                channelCount: 1
                            });
                        }
                    } catch (e) {
                        console.error("Audio error:", e.message);
                    }
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

        ultravoxWs.on("close", (code) => {
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
    audioBuffer = Buffer.alloc(0);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`🎙️ Port ${PORT}`));
