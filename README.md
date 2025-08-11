
# Ollama-With-Voice

Bring your local LLMs to life with voice interaction!

Ollama-With-Voice lets you interact with your locally hosted Large Language Models (LLMs) using your voice and receive spoken responses, all running entirely offline. It combines Ollama for LLMs and Piper for high-quality text-to-speech (TTS).

## Features

- **Voice-Enabled LLM Interaction:** Speak your queries and hear responses from your Ollama-powered models.
- **Real-time Audio Processing:** Uses Piper for efficient, real-time TTS.
- **Local and Private:** All processing happens on your machine for privacy and offline use.
- **Web Interface:** Access the voice agent at [http://localhost:3000](http://localhost:3000).
- **Configurable:** Supports local Piper voices, Google Cloud TTS, and Amazon Polly (with API keys).

## Getting Started

### 1. Prerequisites

- Node.js (v18+ recommended)
- Ollama installed and running locally
- Piper TTS binaries and voice models (see below)
- (Optional) Google Cloud or AWS credentials for cloud TTS

### 2. Install Dependencies

```powershell
npm install
```

### 3. Download Piper Voices

Use the provided PowerShell script to download voice models:

```powershell
./download_piper_voices.ps1
```

Or manually download voices from [https://huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) and place them in the `piper/voices/` directory.

### 4. Configure Environment

Copy `.env` and set your API keys as needed:

- For local Piper voices, no API keys are required.
- To enable Google or AWS TTS, set `ENABLE_GOOGLE_TTS=true` or `ENABLE_AWS_TTS=true` and provide the relevant keys.

Example `.env`:
```
OPENAI_KEY=your_openai_key
GEMINI_KEY=your_valid_google_cloud_tts_key
GROK_KEY=your_xai_grok_key
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=us-east-1
ENABLE_GOOGLE_TTS=false
ENABLE_AWS_TTS=false
```

### 5. Start the Server

```powershell
node server.js
```

The web interface will be available at [http://localhost:3000](http://localhost:3000).

### 6. Using the Web Interface

- Open your browser and go to [http://localhost:3000](http://localhost:3000).
- Use your microphone to ask questions.
- The LLM will respond with spoken answers.

## Notes

- All processing is local by default for privacy.
- You can add or update voices in the `piper/voices/` directory.
- For advanced configuration, edit environment variables in `.env`.

---