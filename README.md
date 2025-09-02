# Joinly Client

A client application for connecting to Joinly meetings with AI assistance.

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Docker (for running the Joinly server)
- ngrok (for exposing the local server)

## Installation

### Step 1: Clone the Joinly Client Repository

```bash
git clone https://github.com/SohaibTaqat/joinly_ai_client.git
cd joinly_client
npm install
```

### Step 2: Set up the Joinly Server

1. Clone the Joinly server repository:
```bash
git clone https://github.com/joinly-ai/joinly.git
cd joinly
```

2. Create a `.env` file in the joinly directory and add your Deepgram API key:
```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
```

3. Run the Joinly server using Docker:
```bash
docker run --env-file .env -p 8000:8000 ghcr.io/joinly-ai/joinly:latest --stt deepgram --tts deepgram
```

### Step 3: Expose the Server with ngrok

In a new terminal, expose the Joinly server to the internet:
```bash
ngrok http 8000
```

Copy the generated ngrok URL (e.g., `https://xxxxxx.ngrok-free.app`).

### Step 4: Configure the Client

1. Navigate back to the joinly_client directory
2. Copy the `.env.example` file to `.env`:
```bash
cp .env.example .env
```

3. Edit the `.env` file with your configuration:
```env
# OpenAI API Key (required)
OPENAI_API_KEY=your_openai_api_key_here

# Joinly MCP Server URL (use your ngrok URL)
JOINLY_URL=https://xxxxxx.ngrok-free.app/mcp/

# Agent name
AGENT_NAME=AI Assistant

# Meeting link URL (required)
MEETING_URL=your_meeting_link_here
```

## Running the Client

Once everything is configured, run the client:

```bash
npx tsx index.ts
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | Your OpenAI API key for AI functionality | Yes |
| `JOINLY_URL` | The URL of your Joinly MCP server (ngrok URL + /mcp/) | No (defaults to http://localhost:8000/mcp/) |
| `AGENT_NAME` | Name of the AI assistant | No |
| `MEETING_URL` | The meeting link to join | Yes |

## Architecture

This client connects to a Joinly server that handles real-time meeting interactions with speech-to-text (STT) and text-to-speech (TTS) capabilities using Deepgram.

## Known Issues

⚠️ **Note**: This project is currently in development and may experience stability issues or crashes during operation.

## Troubleshooting

- **Server not accessible**: Ensure ngrok is running and the URL in `.env` is correct
- **Authentication errors**: Verify your API keys are correct and active
- **Connection issues**: Check that the Joinly server is running on port 8000
- **Docker issues**: Make sure Docker is running and you have pulled the latest Joinly image

