require("dotenv").config();
const express = require("express");
const axios = require("axios");
const http = require("http");
const socketIO = require("socket.io");
const {
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceCandidate,
    MediaStream,
} = require("@roamhq/wrtc");

// STUN server for NAT traversal
const ICE_SERVERS = [{ urls: "stun:stun.relay.metered.ca:80" }];

const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${process.env.HEALTHCARE_WHATSAPP_PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.HEALTHCARE_WHATSAPP_ACCESS_TOKEN}`;
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());

// State per call
let ultravoxPc = null;
let ultravoxStream = null;
let whatsappPc = null;
let whatsappStream = null;
let ultravoxOfferSdp = null;
let whatsappOfferSdp = null;
let ultravoxSocket = null;
let currentCallId = null;

console.log("🎙️  WhatsApp Voice Calling with Ultravox AI");
console.log("Phone ID:", process.env.HEALTHCARE_WHATSAPP_PHONE_NUMBER_ID);
console.log("Ultravox API:", ULTRAVOX_API_KEY ? "✅ Configured" : "❌ Missing");

// Socket.IO for Ultravox WebRTC connection
io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on("ultravox-offer", async (sdp) => {
        console.log("Received SDP offer from Ultravox");
        ultravoxOfferSdp = sdp;
        ultravoxSocket = socket;
        await bridgeWebRTC();
    });

    socket.on("ultravox-candidate", async (candidate) => {
        if (ultravoxPc) {
            await ultravoxPc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });
});

// Webhook verification
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.HEALTHCARE_WHATSAPP_VERIFY_TOKEN) {
        console.log("✅ Webhook verified");
        res.send(challenge);
    } else {
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
            whatsappOfferSdp = call?.session?.sdp;
            const callerName = contact?.profile?.name || "Unknown";
            const callerNumber = contact?.wa_id || "Unknown";

            console.log(`📞 Incoming call from ${callerName} (${callerNumber})`);
            
            if (!ULTRAVOX_API_KEY) {
                console.log("⚠️  Ultravox not configured, rejecting");
                await rejectCall(currentCallId);
            } else {
                // Create Ultravox AI call
                await createUltravoxCall(callerName);
                await bridgeWebRTC();
            }

        } else if (call.event === "terminate") {
            console.log(`📞 Call terminated: ${call.id}`);
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("Webhook error:", err);
        res.sendStatus(500);
    }
});

async function createUltravoxCall(callerName) {
    try {
        const response = await axios.post(
            "https://api.ultravox.ai/api/calls",
            {
                systemPrompt: `You are a healthcare assistant. The caller is ${callerName}. Help with booking lab tests or ordering medicines. Be friendly and concise.`,
                voice: "Mark",
                model: "fixie-ai/ultravox-v0_2",
                temperature: 0.7,
                maxDuration: 600
            },
            {
                headers: {
                    "X-Ultravox-Api-Key": ULTRAVOX_API_KEY,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log(`✅ Ultravox call created: ${response.data.callId}`);
        console.log(`Join URL: ${response.data.joinUrl}`);
        
        // Ultravox will connect via Socket.IO and send offer
        
    } catch (error) {
        console.error("Failed to create Ultravox call:", error.response?.data || error.message);
        throw error;
    }
}

async function bridgeWebRTC() {
    if (!ultravoxOfferSdp || !whatsappOfferSdp || !ultravoxSocket) return;

    console.log("🌉 Bridging WebRTC between Ultravox and WhatsApp...");

    // Setup Ultravox peer connection
    ultravoxPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    ultravoxStream = new MediaStream();

    ultravoxPc.ontrack = (event) => {
        console.log("🎵 Audio from Ultravox");
        event.streams[0].getTracks().forEach(track => ultravoxStream.addTrack(track));
    };

    ultravoxPc.onicecandidate = (event) => {
        if (event.candidate) {
            ultravoxSocket.emit("ultravox-candidate", event.candidate);
        }
    };

    await ultravoxPc.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: ultravoxOfferSdp
    }));

    // Setup WhatsApp peer connection
    whatsappPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const waTrackPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject("WhatsApp track timeout"), 10000);
        whatsappPc.ontrack = (event) => {
            clearTimeout(timeout);
            console.log("🎵 Audio from WhatsApp");
            whatsappStream = event.streams[0];
            resolve();
        };
    });

    await whatsappPc.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: whatsappOfferSdp
    }));

    // Forward Ultravox audio to WhatsApp
    ultravoxStream?.getAudioTracks().forEach(track => {
        whatsappPc.addTrack(track, ultravoxStream);
    });

    // Wait for WhatsApp audio
    await waTrackPromise;

    // Forward WhatsApp audio to Ultravox
    whatsappStream?.getAudioTracks().forEach(track => {
        ultravoxPc.addTrack(track, whatsappStream);
    });

    // Create answers
    const ultravoxAnswer = await ultravoxPc.createAnswer();
    await ultravoxPc.setLocalDescription(ultravoxAnswer);
    ultravoxSocket.emit("ultravox-answer", ultravoxAnswer.sdp);

    const waAnswer = await whatsappPc.createAnswer();
    await whatsappPc.setLocalDescription(waAnswer);
    const finalWaSdp = waAnswer.sdp.replace("a=setup:actpass", "a=setup:active");

    // Answer WhatsApp call
    const preAcceptOk = await answerWhatsAppCall(currentCallId, finalWaSdp, "pre_accept");
    
    if (preAcceptOk) {
        setTimeout(async () => {
            await answerWhatsAppCall(currentCallId, finalWaSdp, "accept");
            console.log("✅ Call connected!");
        }, 1000);
    }

    // Reset
    ultravoxOfferSdp = null;
    whatsappOfferSdp = null;
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
        return false;
    } catch (error) {
        console.error(`Failed to ${action}:`, error.response?.data || error.message);
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
        console.error("Reject failed:", error.message);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🎙️  Voice service running on port ${PORT}`);
});
