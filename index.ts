import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
  speaker: string | null;
}

interface Transcript {
  segments: TranscriptSegment[];
}

class MeetingAgent {
  private mcp: Client;
  private openai: OpenAI;
  private transport: StreamableHTTPClientTransport | null = null;
  private tools: any[] = [];
  private agentName: string;
  private lastProcessedTime: number = 0;
  private messages: any[] = [];
  private pollingInterval: NodeJS.Timeout | null = null;

  constructor(agentName: string = "AI Assistant") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    this.agentName = agentName;
    this.openai = new OpenAI({ apiKey });
    this.mcp = new Client(
      { name: "meeting-agent", version: "1.0.0" },
      { capabilities: {} }
    );

    // Initialize conversation with system message
    this.messages = [
      {
        role: "system",
        content: `You are ${agentName}, a helpful AI assistant participating in a meeting.

CORE GUIDELINES:
- Listen to the conversation and respond when:
  * Someone addresses you directly by name
  * You're asked a direct question
  * You have valuable information to add to the discussion
- Keep responses concise and natural
- Stay quiet during active discussions between others unless specifically involved
- Be helpful but not intrusive

CRITICAL TOOL USAGE RULES:
1. ALWAYS use speak_text after executing ANY other tool to verbally confirm what you did
2. When asked to leave the meeting, you MUST:
   - First use speak_text to say goodbye appropriately
   - Then immediately use the leave_meeting tool
3. Confirmation examples after tool actions:
   - After sending chat: "I've sent that message in the chat"
   - After getting transcript: "I've retrieved the meeting transcript"
   - After checking participants: "I can see who's in the meeting now"
   - After any action: Brief, clear confirmation of what was completed

MEETING BEHAVIOR:
- Always acknowledge when someone speaks to you
- Use speak_text as your primary way to communicate - this is how participants hear you
- If you use other tools (like send_chat_message, get_transcript, etc.), always follow up with speak_text to confirm the action
- When leaving, be polite but direct: say goodbye first, then leave

Remember: Participants can only hear you through speak_text. Always speak to confirm your actions so everyone knows what you've done.`,
      },
    ];
  }

  async connect(serverUrl: string) {
    try {
      // Set up transport with Joinly settings
      const url = new URL(serverUrl);
      this.transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: {
            "joinly-settings": JSON.stringify({
              name: this.agentName,
              language: "en",
            }),
          },
        },
      });

      // Set up transport event handlers
      this.transport.onclose = () => {
        // console.log("Connection closed");
        this.cleanup();
      };

      this.transport.onerror = (error) => {
        console.error("Transport error:", error);
      };

      // Connect to MCP server
      await this.mcp.connect(this.transport);
      console.log("Connected to Joinly MCP server");

      // Get available tools and convert to OpenAI format
      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));

      console.log(
        "Available tools:",
        this.tools.map((t) => t.function.name).join(", ")
      );
    } catch (error) {
      console.error("Connection failed:", error);
      throw error;
    }
  }

  async joinMeeting(meetingUrl: string) {
    // Join the meeting
    await this.mcp.callTool({
      name: "join_meeting",
      arguments: {
        meeting_url: meetingUrl,
        participant_name: this.agentName,
      },
    });

    console.log(`Joined meeting as ${this.agentName}`);

    // Introduce ourselves
    await this.mcp.callTool({
      name: "speak_text",
      arguments: {
        text: `Hello everyone, I'm ${this.agentName}, your AI assistant for this meeting.`,
      },
    });

    // Subscribe to transcript resource
    await this.mcp.subscribeResource({
      uri: "transcript://live",
    });

    // Start monitoring transcript
    this.startTranscriptMonitoring();
  }

  private startTranscriptMonitoring() {
    // Poll transcript resource every second
    this.pollingInterval = setInterval(async () => {
      try {
        const resource = await this.mcp.readResource({
          uri: "transcript://live",
        });

        if (resource.contents && resource.contents.length > 0) {
          const content = resource.contents[0];
          if (typeof content.text === "string") {
            const transcript: Transcript = JSON.parse(content.text);
            await this.processNewSegments(transcript.segments);
          }
        }
      } catch (error) {
        // Silently handle polling errors
      }
    }, 1000);
  }

  private validateMessages(): boolean {
    const messages = this.messages;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      if (message.role === "tool") {
        // Find the preceding assistant message with tool_calls
        let foundToolCall = false;

        for (let j = i - 1; j >= 0; j--) {
          const prevMessage = messages[j];

          if (prevMessage.role === "assistant" && prevMessage.tool_calls) {
            // Check if this tool message matches any of the tool calls
            const matchingCall = prevMessage.tool_calls.find(
              (call: any) => call.id === message.tool_call_id
            );
            if (matchingCall) {
              foundToolCall = true;
              break;
            }
          }

          // Stop looking if we hit another user message
          if (prevMessage.role === "user") break;
        }

        if (!foundToolCall) {
          console.warn(`Orphaned tool message found at index ${i}:`, message);
          return false;
        }
      }
    }

    return true;
  }

  private async makeOpenAIRequest(messages: any[], tools: any[]) {
    if (!this.validateMessages()) {
      console.error("Invalid message sequence detected, cleaning up...");
      // Remove orphaned tool messages
      this.messages = this.messages.filter((msg) => {
        if (msg.role === "tool") {
          // Check if this tool message has a valid preceding tool_call
          const messageIndex = this.messages.indexOf(msg);
          for (let i = messageIndex - 1; i >= 0; i--) {
            const prevMessage = this.messages[i];
            if (prevMessage.role === "assistant" && prevMessage.tool_calls) {
              const matchingCall = prevMessage.tool_calls.find(
                (call: any) => call.id === msg.tool_call_id
              );
              if (matchingCall) return true;
            }
            if (prevMessage.role === "user") break;
          }
          return false; // Remove this orphaned tool message
        }
        return true;
      });
    }

    return await this.openai.chat.completions.create({
      model: "gpt-4",
      messages: this.messages,
      tools: tools,
      tool_choice: "auto",
      temperature: 0.7,
    });
  }

  private truncateMessages() {
    if (this.messages.length <= 15) return;

    // Always keep the system message
    const systemMessage = this.messages[0];
    let messagesToKeep = this.messages.slice(1);

    // Find a safe truncation point
    let truncateIndex = messagesToKeep.length - 14; // Keep last 14 non-system messages

    // Move truncateIndex to avoid breaking tool call sequences
    while (truncateIndex > 0 && truncateIndex < messagesToKeep.length) {
      const messageAtIndex = messagesToKeep[truncateIndex];
      const prevMessage = messagesToKeep[truncateIndex - 1];

      // Don't truncate in the middle of a tool call sequence
      if (
        messageAtIndex.role === "tool" ||
        (prevMessage &&
          prevMessage.tool_calls &&
          prevMessage.tool_calls.length > 0)
      ) {
        truncateIndex--;
      } else {
        break;
      }
    }

    // Apply truncation
    messagesToKeep = messagesToKeep.slice(Math.max(0, truncateIndex));
    this.messages = [systemMessage, ...messagesToKeep];

    console.log(
      `Truncated message history to ${this.messages.length} messages`
    );
  }

  private async processNewSegments(segments: TranscriptSegment[]) {
    // Filter for new segments we haven't processed yet
    const newSegments = segments.filter(
      (seg) => seg.end > this.lastProcessedTime && seg.text.trim().length > 0
    );

    if (newSegments.length === 0) return;

    // Update last processed time
    this.lastProcessedTime = Math.max(...newSegments.map((s) => s.end));

    // Format the new transcript content
    const transcriptText = newSegments
      .map((seg) => `${seg.speaker || "Unknown"}: ${seg.text}`)
      .join("\n");

    console.log("\n--- New transcript ---");
    console.log(transcriptText);

    // Add to conversation history
    this.messages.push({
      role: "user",
      content: transcriptText,
    });

    // Use the improved truncation method
    this.truncateMessages();

    // Get AI response with validation
    try {
      const response = await this.makeOpenAIRequest(this.messages, this.tools);
      console.log("🔴", response);

      const message = response.choices[0].message;
      this.messages.push(message);

      // Execute any tool calls
      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          console.log(`\nExecuting: ${toolCall.function.name}`);

          try {
            const result = await this.mcp.callTool({
              name: toolCall.function.name,
              arguments: JSON.parse(toolCall.function.arguments),
            });

            // Add tool response to conversation history
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(
                result.content || "Tool executed successfully"
              ),
            });
          } catch (toolError) {
            console.error(
              `Error executing tool ${toolCall.function.name}:`,
              toolError
            );

            // Add error response to maintain conversation flow
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: "Tool execution failed" }),
            });
          }
        }

        // Get follow-up response
        try {
          const followUpResponse = await this.makeOpenAIRequest(
            this.messages,
            this.tools
          );
          const followUpMessage = followUpResponse.choices[0].message;
          this.messages.push(followUpMessage);

          // Execute follow-up tool calls
          if (followUpMessage.tool_calls) {
            for (const toolCall of followUpMessage.tool_calls) {
              console.log(`\nExecuting follow-up: ${toolCall.function.name}`);

              try {
                const result = await this.mcp.callTool({
                  name: toolCall.function.name,
                  arguments: JSON.parse(toolCall.function.arguments),
                });

                this.messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: JSON.stringify(
                    result.content || "Tool executed successfully"
                  ),
                });
              } catch (toolError) {
                console.error(
                  `Error executing follow-up tool ${toolCall.function.name}:`,
                  toolError
                );

                this.messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ error: "Tool execution failed" }),
                });
              }
            }
          }
        } catch (followUpError) {
          console.error("Error in follow-up response:", followUpError);
        }
      }
    } catch (error) {
      console.error("Error processing:", error);

      // If it's a message validation error, reset conversation state
      if (
        error instanceof Error &&
        error.message?.includes("messages with role 'tool'")
      ) {
        console.log("Resetting conversation due to message validation error");
        // Keep only system message and last user message
        this.messages = [
          this.messages[0], // system message
          this.messages[this.messages.length - 1], // last user message
        ];
      }
    }
  }

  async leaveMeeting() {
    await this.mcp.callTool({
      name: "speak_text",
      arguments: { text: "Thank you everyone, goodbye!" },
    });

    await this.mcp.callTool({
      name: "leave_meeting",
      arguments: {},
    });
  }

  async cleanup() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    await this.mcp.close();
  }
}

// Main execution
async function main() {
  const joinlyUrl = process.env.JOINLY_URL || "http://localhost:8000/mcp/";
  const meetingUrl = process.env.MEETING_URL;
  const agentName = process.env.AGENT_NAME || "AI Assistant";

  if (!meetingUrl) {
    console.error("Please set MEETING_URL environment variable");
    process.exit(1);
  }

  const agent = new MeetingAgent(agentName);

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down gracefully...");
    await agent.leaveMeeting();
    await agent.cleanup();
    process.exit(0);
  });

  try {
    console.log("=================================");
    console.log("Meeting Agent Starting");
    console.log(`Agent Name: ${agentName}`);
    console.log(`Joinly URL: ${joinlyUrl}`);
    console.log(`Meeting URL: ${meetingUrl}`);
    console.log("=================================\n");

    await agent.connect(joinlyUrl);
    await agent.joinMeeting(meetingUrl);

    console.log("\nAgent is active. Press Ctrl+C to exit.\n");

    // Keep the process running
    await new Promise(() => {});
  } catch (error) {
    console.error("Fatal error:", error);
    await agent.cleanup();
    process.exit(1);
  }
}

main();
