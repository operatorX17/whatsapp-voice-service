# WhatsApp Voice Calling Service

Separate Node.js service to handle WhatsApp voice calls.

## Deployment to Railway

### Option 1: Deploy from Root Directory (Recommended)

1. In Railway dashboard, create a new service
2. Connect to your GitHub repo
3. Set **Root Directory** to: `voice-service`
4. Railway will auto-detect Dockerfile and deploy

### Option 2: Deploy as Separate Repo

1. Copy `voice-service` folder to a new repo
2. Create new Railway service
3. Connect to the new repo

## Environment Variables

Add these in Railway:

```
HEALTHCARE_WHATSAPP_PHONE_NUMBER_ID=974059042449578
HEALTHCARE_WHATSAPP_ACCESS_TOKEN=your_access_token
HEALTHCARE_WHATSAPP_VERIFY_TOKEN=AK47
```

## Webhook Configuration

In Meta Developer Console:

1. Go to WhatsApp → Configuration
2. Add webhook URL: `https://your-voice-service-url.railway.app/webhook`
3. Verify token: `AK47`
4. Subscribe to **calls** field

## Testing

```bash
# Health check
curl https://your-voice-service-url.railway.app/

# Webhook verification
curl "https://your-voice-service-url.railway.app/webhook?hub.mode=subscribe&hub.verify_token=AK47&hub.challenge=test123"
```

## What It Does

- Receives incoming WhatsApp voice calls
- Rejects calls politely
- Sends text message explaining to use text chat instead
- Logs all call events

## Future Enhancement

To enable actual voice AI:
- Integrate Ultravox API
- Add WebRTC handling
- Implement call answering logic
