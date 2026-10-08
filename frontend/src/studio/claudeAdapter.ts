// AG Studio adapter for Claude. Studio owns the agent loop, prompts and tool execution in the browser;
// each model turn is one POST to our API (/studio/llm), which holds the Anthropic key.
import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgAiToolSchema,
  AgLlmAdapter,
  AgLlmRequest,
  AgLlmResponse,
} from 'ag-studio';
import { getToken } from '@/lib/api';

// ---- Anthropic Messages API wire types (subset) ----
type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
type AnthropicMessage = { role: 'user' | 'assistant'; content: ContentBlock[] };
type AnthropicTool = { name: string; description: string; input_schema: Record<string, unknown> };
type AnthropicToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'none' } | { type: 'tool'; name: string };
export type ClaudeTurnRequest = {
  model?: string;
  system?: string;
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
};
// What the backend returns: the Anthropic message object, passed through.
type ClaudeTurnResponse = {
  id: string;
  model: string;
  stop_reason: string | null;
  content: Array<TextBlock | ToolUseBlock | { type: string }>;
  usage?: { input_tokens: number; output_tokens: number };
};

const safeJson = (s: string): unknown => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

/** Studio conversation items (Responses-API style) -> Anthropic messages + extra system text. */
export function toAnthropicMessages(items: AgAiConversationItem[]): { system: string[]; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', block: ContentBlock) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of items) {
    if (item.type === 'message' && item.kind === 'input') {
      const text = item.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
      if (!text) continue;
      if (item.role === 'system') system.push(text);
      else push('user', { type: 'text', text });
    } else if (item.type === 'message' && item.kind === 'output') {
      const text = item.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
      if (text) push('assistant', { type: 'text', text });
    } else if (item.type === 'function_call') {
      push('assistant', { type: 'tool_use', id: item.callId, name: item.name, input: safeJson(item.arguments) });
    } else if (item.type === 'function_call_output') {
      push('user', { type: 'tool_result', tool_use_id: item.callId, content: item.output });
    }
    // 'reasoning' items are dropped.
  }
  return { system, messages };
}

export function toAnthropicTools(tools: AgAiToolSchema[] = []): AnthropicTool[] {
  return tools
    .filter((t) => t.kind !== 'provided' && t.kind !== 'server')
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object', properties: {}, ...(t.parameters as Record<string, unknown>) },
    }));
}

function toToolChoice(choice: AgLlmRequest['toolChoice']): AnthropicToolChoice | undefined {
  if (choice == null || choice === 'auto') return undefined;
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  return { type: 'tool', name: choice.name };
}

/** Anthropic response -> AG-UI content events (for the panel) + AgLlmResponse (for the loop). */
function fromAnthropic(res: ClaudeTurnResponse): { events: AgAiEvent[]; response: AgLlmResponse } {
  const events: AgAiEvent[] = [];
  const output: AgAiOutputItem[] = [];
  res.content.forEach((block, i) => {
    if (block.type === 'text') {
      const { text } = block as TextBlock;
      const messageId = `${res.id}-t${i}`;
      events.push({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
      events.push({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text });
      events.push({ type: 'TEXT_MESSAGE_END', messageId });
      output.push({
        id: messageId,
        kind: 'output',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'text', text, annotations: [] }],
      });
    } else if (block.type === 'tool_use') {
      const { id, name, input } = block as ToolUseBlock;
      const args = JSON.stringify(input ?? {});
      events.push({ type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name });
      events.push({ type: 'TOOL_CALL_ARGS', toolCallId: id, delta: args });
      events.push({ type: 'TOOL_CALL_END', toolCallId: id });
      // The loop reads tool calls from `output` (function_call items), not from the stream.
      output.push({ id, kind: 'output', type: 'function_call', callId: id, name, arguments: args, status: 'completed' });
    }
  });
  const incomplete = res.stop_reason === 'max_tokens';
  return {
    events,
    response: {
      id: res.id,
      createdAt: Date.now(),
      status: incomplete ? 'incomplete' : 'completed',
      incompleteDetails: incomplete ? { reason: 'max_output_tokens' } : undefined,
      output,
      model: res.model,
      usage: res.usage ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } : undefined,
    },
  };
}

export function claudeProxyAdapter({ endpoint }: { endpoint: string }): AgLlmAdapter {
  return {
    executeTurn(request, options) {
      const { system, messages } = toAnthropicMessages(request.input);
      const body: ClaudeTurnRequest = {
        model: request.model?.id, // only set when `models` is configured; backend applies its default
        system: [request.instructions, ...system].filter(Boolean).join('\n\n') || undefined,
        messages,
        tools: toAnthropicTools(request.tools),
        tool_choice: toToolChoice(request.toolChoice),
      };
      const result = fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
        body: JSON.stringify(body),
        signal: options?.signal,
      }).then(async (r) => {
        if (!r.ok) {
          const detail = await r.json().then((j) => j.detail).catch(() => r.statusText);
          throw new Error(typeof detail === 'string' ? detail : `Claude proxy error ${r.status}`);
        }
        return fromAnthropic((await r.json()) as ClaudeTurnResponse);
      });
      return {
        // Failures surface via `complete` (status 'failed'), not as stream events.
        stream: {
          async *[Symbol.asyncIterator]() {
            const turn = await result.catch(() => null);
            if (turn) yield* turn.events;
          },
        },
        complete: result.then(
          (turn) => turn.response,
          (error: unknown): AgLlmResponse => ({
            id: `err-${Date.now()}`,
            createdAt: Date.now(),
            status: options?.signal?.aborted ? 'cancelled' : 'failed',
            error: { code: 'proxy_error', message: error instanceof Error ? error.message : String(error) },
            output: [],
          }),
        ),
      };
    },
  };
}
