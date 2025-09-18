import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  dynamicTool,
  jsonSchema,
  generateText,
  stepCountIs,
  experimental_createMCPClient as createMCPClient,
} from "ai";
import { openai } from "@ai-sdk/openai";
import dotenv from "dotenv";
dotenv.config();

const systemPrompt = `
## Persona
You are ${process.env.AGENT_NAME}, a casual meeting participant, joining as if you are another user in the room.  
Your speaking style is natural, friendly, and conversational, but always brief. You are not a formal assistant — you are simply another participant in the meeting.  

## Behavior
- Your responses are converted directly into speech and heard aloud by others in real time.  
- You speak only when explicitly addressed by your name: ${process.env.AGENT_NAME}.  
- When you do respond, you sound like a real participant: concise, to the point, and easy to follow.  
- You elaborate only when someone specifically asks you to explain or expand.  

## Rules
1. If you are **not** addressed by name, your entire response must be empty (\`""\` or a single space).  
2. Never output placeholders, explanations, or the word \`"SILENCE"\`.  
3. Keep your answers short and conversational, as if you are talking, not writing.  
4. Only provide more detail if explicitly asked.  
5. Always remember your output will be spoken aloud to others in the meeting.  
`;

interface Segment {
  text: string;
  start: number;
  end: number;
  speaker: string;
  role: string;
}

interface TranscriptData {
  segments: Segment[];
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

interface ResourceResponse {
  contents: ResourceContent[];
}

let client: Client;
let wrappedTools: Record<string, ReturnType<typeof dynamicTool>> = {};
// Define ToolDefinition type according to your SDK or use 'any' as a placeholder if unknown
type ToolDefinition = any;
let odooTools: Record<string, ToolDefinition> = {};
let mcp1: any;
let messages: Message[] = [];
let debounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_DELAY = 2500;

const mcp1url = new URL("https://nextjs-mcp-server-eta.vercel.app/api/mcp1/mcp");

async function onDebounceTrigger() {
  try {
    console.log("🤖 Generating AI response...");
    const { text } = await generateText({
      model: openai("gpt-5-nano"),
      system: systemPrompt,
      messages: messages,
      tools: { ...wrappedTools, ...odooTools },
      stopWhen: stepCountIs(10),
      onStepFinish: (step) => {
        console.log(`🤖 AI is speaking`);
        client.callTool({
          name: "speak_text",
          arguments: { text: step.text },
        });
      },
    });

    messages.push({ role: "assistant", content: text });

    // console.log(`🤖 AI is speaking`);
    // await client.callTool({
    //   name: "speak_text",
    //   arguments: { text: text },
    // })
    // console.log(`🤖 AI done speaking`);

    console.log(`🤖 Assistant: ${text}`);
  } catch (error) {
    console.error("Error generating AI response:", error);
  }
}

async function main() {
  // Connect to MCP server
  client = new Client(
    { name: "minimal-client", version: "1.0.0" },
    { capabilities: {} }
  );

  mcp1 = await createMCPClient({
    transport: new StreamableHTTPClientTransport(mcp1url, {
      sessionId: "session_123",
    }),
  });
  console.log("✅ Connected to weather and time MCP");

  odooTools = await mcp1.tools();

  const transport = new StreamableHTTPClientTransport(
    new URL(process.env.JOINLY_URL!)
  );

  await client.connect(transport);
  console.log("✅ Connected to Joinly MCP");

  const toolsResult = await client.listTools();
  wrappedTools = Object.fromEntries(
    toolsResult.tools.map((tool: any) => [
      tool.name,
      dynamicTool({
        description: tool.description,
        inputSchema: jsonSchema(
          (tool.inputSchema as any) || { type: "object" }
        ),
        execute: async (input) => {
          if (!client) {
            throw new Error("MCP client not connected");
          }
          return await client.callTool({
            name: tool.name,
            arguments: (input as any) || {},
          });
        },
      }),
    ])
  );
  // console.log("Available tools:", JSON.stringify(toolsResult));

  // const resources = await client.listResources();
  // console.log("Available resources:", resources);

  console.log("Joining meeting...");

  await client.callTool({
    name: "join_meeting",
    arguments: {
      meeting_url: process.env.MEETING_URL!,
      participant_name: "Nova",
    },
  });
  console.log("✅ Joined meeting");

  // Wait before starting to poll
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Poll transcript every 2 seconds
  let lastSegmentCount = 0;

  setInterval(async () => {
    try {
      const transcript = (await client.readResource({
        uri: "transcript://live",
      })) as ResourceResponse;

      // Parse the transcript JSON
      const transcriptData: TranscriptData = JSON.parse(
        transcript.contents[0].text
      );
      const segments = transcriptData.segments;

      // Check if new segments were added
      if (segments.length > lastSegmentCount) {
        // Get only the new segments
        const newSegments = segments.slice(lastSegmentCount);

        console.log(`📝 ${newSegments.length} new segment(s):`);

        // Add each new segment to messages array immediately
        newSegments.forEach((seg: Segment) => {
          console.log(`   [${seg.speaker}]: "${seg.text}"`);
          messages.push({
            role: "user",
            content: `${seg.speaker}:${seg.text}`,
          });
        });

        // Debounce logic
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          onDebounceTrigger();
        }, DEBOUNCE_DELAY);

        lastSegmentCount = segments.length;
      }
    } catch (error) {
      console.error("Error reading:", error);
    }
  }, 500);

  // Keep alive
  await new Promise(() => {});
}

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  if (client) {
    await client.callTool({
      name: "leave_meeting",
      arguments: {},
    });
    console.log("✅ Left the meeting");

    await client.close();
    console.log("✅ Disconnected from Joinly MCP");

    await mcp1.close();
    console.log("✅ Disconnected from weather and time MCP");
  }
  process.exit(0);
});

main().catch(console.error);
