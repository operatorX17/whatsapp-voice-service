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

// Audio buffers
let outputBuffer = []; // Ultravox -> WhatsApp
const SAMPLES_PER_FRAME = 480; // 10ms at 48kHz

// Use 16kHz for Ultravox (better quality than 8kHz)
const ULTRAVOX_SAMPLE_RATE = 16000;
const WHATSAPP_SAMPLE_RATE = 48000;
const RESAMPLE_RATIO = WHATSAPP_SAMPLE_RATE / ULTRAVOX_SAMPLE_RATE; // 3

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
Help with booking diagnostic tests or ordering medicines. Be warm, conversational, and respond naturally.
Start by greeting them and asking how you can help.`,
            model: "fixie-ai/ultravox",
            voice: "Mark",
            temperature: 0.6,
            firstSpeaker: "FIRST_SPEAKER_AGENT",
            medium: {
                serverWebSocket: {
                    inputSampleRate: ULTRAVOX_SAMPLE_RATE,
                    outputSampleRate: ULTRAVOX_SAMPLE_RATE
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
    outputBuffer = [];

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
                sendAudioToUltravox(data);
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

// Send WhatsApp audio to Ultravox (downsample 48kHz -> 16kHz)
function sendAudioToUltravox(data) {
    if (!ultravoxWs || ultravoxWs.readyState !== WebSocket.OPEN) return;
    
    try {
        const samples = data.samples; // Float32Array from WhatsApp
        const inputRate = data.sampleRate || 48000;
        const ratio = Math.round(inputRate / ULTRAVOX_SAMPLE_RATE);
        
        // Downsample with simple averaging for better quality
        const outLen = Math.floor(samples.length / ratio);
        const int16 = new Int16Array(outLen);
        
        for (let i = 0; i < outLen; i++) {
            // Average multiple samples for smoother downsampling
            let sum = 0;
            for (let j = 0; j < ratio; j++) {
                sum += samples[i * ratio + j];
            }
            const avg = sum / ratio;
            int16[i] = Math.max(-32768, Math.min(32767, Math.round(avg * 32767)));
        }
        
        ultravoxWs.send(Buffer.from(int16.buffer));
    } catch (e) {
        // Ignore errors
    }
}

// Process Ultravox audio and send to WhatsApp (upsample 16kHz -> 48kHz)
function processUltravoxAudio(data) {
    if (!audioSource || data.length === 0) return;
    
    try {
        const inputSamples = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
        
        // Linear interpolation for smoother upsampling
        for (let i = 0; i < inputSamples.length; i++) {
            const currentSample = inputSamples[i];
            const nextSample = i < inputSamples.length - 1 ? inputSamples[i + 1] : currentSample;
            
            // Interpolate between samples
            for (let j = 0; j < RESAMPLE_RATIO; j++) {
                const t = j / RESAMPLE_RATIO;
                const interpolated = Math.round(currentSample * (1 - t) + nextSample * t);
                outputBuffer.push(interpolated);
            }
        }
        
        // Send complete frames
        while (outputBuffer.length >= SAMPLES_PER_FRAME) {
            const frame = new Int16Array(SAMPLES_PER_FRAME);
            for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
                frame[i] = outputBuffer.shift();
            }
            
            audioSource.onData({
                samples: frame,
                sampleRate: WHATSAPP_SAMPLE_RATE,
                bitsPerSample: 16,
                channelCount: 1
            });
        }
    } catch (e) {
        // Silently ignore
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
                processUltravoxAudio(data);
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
    outputBuffer = [];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`🎙️ Port ${PORT}`));
