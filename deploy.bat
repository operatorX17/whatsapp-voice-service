@echo off
echo Setting environment variables...
railway variables --set "HEALTHCARE_WHATSAPP_PHONE_NUMBER_ID=974059042449578"
railway variables --set "HEALTHCARE_WHATSAPP_ACCESS_TOKEN=EAALZBYsZByha4BQHMi5kQqQwo1k4a4z9uDBsvW1ZA1HdSIVCsdylBJJwZB8GZAhq41HZCbojiXq7PTbLIqWnhduFiftq6siUIo9lG91xSx4JJWX7zSqoZCvRrQV3NAGyP2zkLZAFj64B40XhOX8bW5Ha7ybj4Q4FOAkkeLU7sAaH623oV0OezYG1Xz6xycZBGCs4TTgZDZD"
railway variables --set "HEALTHCARE_WHATSAPP_VERIFY_TOKEN=AK47"
railway variables --set "ULTRAVOX_API_KEY=jz9cep2B.vkVyyIWeM4RIuK8hxqydGAsX2paJJwTe"
echo Deploying...
railway up
echo Done! Check Railway dashboard for deployment URL
