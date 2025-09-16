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
const DEBOUNCE_DELAY = 1000;

const mcp1url = new URL(
  "https://odoo-mcp-server.vercel.app/api/odoo-mcp/mcp"
);

async function onDebounceTrigger() {
  try {
    console.log("🤖 Generating AI response...");
    const { text } = await generateText({
      model: openai("gpt-5-nano"),
      system: `You are ${process.env.AGENT_NAME} a helpful Voice assistant. all your responses are streamed on speakers, format your responses as if you are speaking instead of writing.`,
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

  odooTools = await mcp1.tools();

  const transport = new StreamableHTTPClientTransport(
    new URL(process.env.JOINLY_URL!)
  );

  await client.connect(transport);

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
  console.log("Available tools:", JSON.stringify(toolsResult));

  const resources = await client.listResources();
  console.log("Available resources:", resources);

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
  }, 1000);

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
    console.log("✅ Disconnected from Oodo MCP");
  }
  process.exit(0);
});

main().catch(console.error);
