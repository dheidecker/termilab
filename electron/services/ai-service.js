/**
 * AI Service — Multi-provider AI integration (Claude, DeepSeek, OpenAI)
 * Handles communication with AI providers for terminal assistance
 */

const https = require('https');
const os = require('os');

const { DEFAULT_MODELS, DEFAULT_EFFORT } = require('./ai-models');
const { classifyCommand } = require('./command-safety');

const MAX_TOKENS = 8192;

class AIService {
  constructor() {
    this.API_URL = 'https://api.anthropic.com/v1/messages';
    this.API_VERSION = '2023-06-01';
    this.conversations = new Map();

    this.PROVIDERS = {
      'claude-api': {
        url: 'https://api.anthropic.com/v1/messages',
        buildHeaders: (apiKey) => ({
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': this.API_VERSION,
        }),
        // The Claude 5 family thinks by default and rejects temperature/top_p,
        // so effort is the knob for depth-vs-latency. Low keeps replies snappy.
        buildBody: (model, system, messages, { effort = DEFAULT_EFFORT } = {}) => ({
          model,
          max_tokens: MAX_TOKENS,
          output_config: { effort },
          system,
          messages,
        }),
        // Thinking blocks come before the answer, so content[0] is not the text.
        parseResponse: (data) =>
          (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || '',
      },
      'deepseek': {
        url: 'https://api.deepseek.com/chat/completions',
        buildHeaders: (apiKey) => ({
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        }),
        buildBody: (model, system, messages) => ({
          model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
        parseResponse: (data) => data.choices?.[0]?.message?.content || '',
      },
      'openai': {
        url: 'https://api.openai.com/v1/chat/completions',
        buildHeaders: (apiKey) => ({
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        }),
        buildBody: (model, system, messages) => ({
          model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
        parseResponse: (data) => data.choices?.[0]?.message?.content || '',
      },
    };
  }

  /**
   * Send a message and get a response (supports Claude, DeepSeek, OpenAI)
   */
  async chat({ apiKey, messages, terminalContext, model, provider = 'claude-api', effort, mode }) {
    if (!apiKey) throw new Error('API key not configured. Go to Settings → AI Assistant to add your API key.');

    const systemPrompt = this._buildSystemPrompt(terminalContext, mode);
    const providerConfig = this.PROVIDERS[provider] || this.PROVIDERS['claude-api'];
    const resolvedModel = model || DEFAULT_MODELS[provider] || DEFAULT_MODELS['claude-api'];

    const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));
    const body = JSON.stringify(
      providerConfig.buildBody(resolvedModel, systemPrompt, apiMessages, { effort })
    );

    return new Promise((resolve, reject) => {
      const url = new URL(providerConfig.url);
      const headers = providerConfig.buildHeaders(apiKey);
      headers['Content-Length'] = Buffer.byteLength(body);

      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== 200) {
              const errMsg = parsed.error?.message || parsed.message || parsed.detail || JSON.stringify(parsed);
              reject(new Error(errMsg));
              return;
            }
            // Claude returns HTTP 200 with empty content when safety
            // classifiers decline — surface it instead of an empty reply.
            if (parsed.stop_reason === 'refusal') {
              reject(new Error(
                'The model declined this request' +
                (parsed.stop_details?.explanation ? `: ${parsed.stop_details.explanation}` : '.')
              ));
              return;
            }
            const text = providerConfig.parseResponse(parsed);
            resolve({
              content: text,
              commands: this._extractCommands(text),
              usage: parsed.usage,
            });
          } catch (err) {
            reject(new Error(`Failed to parse API response: ${err.message} — Raw: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
      req.setTimeout(60000, () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Send a message and get a streaming response.
   * Calls onChunk(textFragment) for each piece of text received.
   * Returns a Promise that resolves with the full accumulated text + extracted commands.
   */
  async chatStream({ apiKey, messages, terminalContext, model, provider = 'claude-api', effort, mode, onChunk }) {
    if (!apiKey) throw new Error('API key not configured. Go to Settings → AI Assistant to add your API key.');

    const systemPrompt = this._buildSystemPrompt(terminalContext, mode);
    const providerConfig = this.PROVIDERS[provider] || this.PROVIDERS['claude-api'];
    const isClaude = provider === 'claude-api';
    const resolvedModel = model || DEFAULT_MODELS[provider] || DEFAULT_MODELS['claude-api'];

    const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));
    const bodyObj = {
      ...providerConfig.buildBody(resolvedModel, systemPrompt, apiMessages, { effort }),
      stream: true,
    };
    const body = JSON.stringify(bodyObj);

    return new Promise((resolve, reject) => {
      const url = new URL(providerConfig.url);
      const headers = providerConfig.buildHeaders(apiKey);
      headers['Content-Length'] = Buffer.byteLength(body);

      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers,
      };

      const req = https.request(options, (res) => {
        // If we get a non-2xx status, collect the body and reject
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let errData = '';
          res.on('data', chunk => { errData += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(errData);
              const errMsg = parsed.error?.message || parsed.message || parsed.detail || JSON.stringify(parsed);
              reject(new Error(errMsg));
            } catch {
              reject(new Error(`API error (${res.statusCode}): ${errData.slice(0, 300)}`));
            }
          });
          return;
        }

        let accumulated = '';
        let buffer = '';
        let refused = false;

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          // Keep the last incomplete line in the buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();

            if (isClaude) {
              // Claude: stop on message_stop event
              if (trimmed === 'event: message_stop') {
                continue; // stream will end naturally
              }
              if (trimmed.startsWith('data: ')) {
                const jsonStr = trimmed.slice(6);
                try {
                  const parsed = JSON.parse(jsonStr);
                  // Only text deltas — thinking deltas carry `delta.thinking`.
                  if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                    accumulated += parsed.delta.text;
                    if (onChunk) onChunk(parsed.delta.text);
                  }
                  if (parsed.type === 'message_delta' && parsed.delta?.stop_reason === 'refusal') {
                    refused = true;
                  }
                } catch {
                  // Skip non-JSON lines
                }
              }
            } else {
              // OpenAI / DeepSeek
              if (trimmed === 'data: [DONE]') {
                continue; // stream is done
              }
              if (trimmed.startsWith('data: ')) {
                const jsonStr = trimmed.slice(6);
                try {
                  const parsed = JSON.parse(jsonStr);
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) {
                    accumulated += content;
                    if (onChunk) onChunk(content);
                  }
                } catch {
                  // Skip non-JSON lines
                }
              }
            }
          }
        });

        res.on('end', () => {
          if (refused) {
            reject(new Error('The model declined this request.'));
            return;
          }
          resolve({
            content: accumulated,
            commands: this._extractCommands(accumulated),
          });
        });
      });

      req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('Stream request timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Build the system prompt: identity, hard safety rules, working style,
   * command format, execution mode, and terminal context.
   */
  _buildSystemPrompt(terminalContext, mode) {
    const platform = process.platform;
    const arch = process.arch;
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const shell = process.env.SHELL || 'unknown';

    const MODE_NOTES = {
      'ask': 'The user manually reviews and runs every command you suggest.',
      'auto-approve': 'Safe commands from your response run automatically and their output is sent back to you. Destructive commands always pause and wait for the user.',
      'autonomous': 'You operate in a loop with minimal supervision: safe commands run automatically, their output is sent back to you, and you continue until the task is done. Destructive commands are NEVER auto-executed — they pause the loop until the user approves. Be conservative and verify every step.',
    };

    let prompt = `You are the AI assistant built into Termilab, an SSH and terminal client. You help the user operate local shells and remote servers by suggesting shell commands and interpreting their output.

## Command format
1. A command meant to be executed goes in its own fenced block with the \`bash:run\` marker, ONE command per block:
   \`\`\`bash:run
   command here
   \`\`\`
2. Purely illustrative commands (not meant to run now) use plain \`\`\`bash blocks.
3. Never chain a destructive operation with other commands using &&, ; or pipes — keep it isolated in its own block so it can be approved individually.

## Safety rules (these override everything else)
1. NEVER delete, overwrite, or destroy data without first telling the user exactly what will be affected and why. This covers rm, find -delete, truncate, dd, mkfs, git reset --hard, git clean, docker rm/prune, package removal, DROP/DELETE in databases, killing processes, stopping services, and anything comparable.
2. Termilab enforces this in code: commands it classifies as destructive are never auto-executed — they always pause and wait for the user's explicit approval, in every mode. Do NOT attempt to bypass this by hiding destructive actions inside scripts, shell functions, aliases, encoded strings, command substitution, or files that are written and then executed.
3. Before proposing a destructive step, first show what would be affected using read-only commands (ls, du, git status, --dry-run / -n variants), and prefer reversible alternatives when practical: move to a backup location instead of deleting, copy before overwriting.
4. Use non-interactive flags (-y, --yes) only for safe operations like package installs — never to skip a confirmation on something destructive.
5. Inspect before you mutate: start with read-only commands and change as little as possible.

## Working style
- One step at a time: propose a command, wait for its output, and verify it actually succeeded — error text in the output matters more than optimism. Then decide the next step.
- If a command failed, say so plainly and diagnose it. Never claim success you have not seen in the terminal output.
- Be brief: one short sentence on what the next command does and why, then the block. No filler.
- When the task is complete, state the outcome clearly and stop emitting bash:run blocks. If you are blocked on information only the user has, ask.
- The terminal may be a local shell or an SSH session on a remote host. Infer the target OS and distro from the terminal context below — the app host info is where Termilab runs, not necessarily where commands execute.
- Respond in the same language the user writes in.

## App host (where Termilab runs)
- OS: ${platform} (${arch}) · Host: ${hostname} · User: ${username} · Shell: ${shell}

## Execution mode
${MODE_NOTES[mode] || MODE_NOTES['ask']}`;

    if (terminalContext) {
      prompt += `\n\n## Current terminal context\n\`\`\`\n${terminalContext}\n\`\`\``;
    }

    return prompt;
  }

  /**
   * Extract executable commands from Claude's response, classified for safety.
   * The `dangerous` flag here is what gates auto-execution in the renderer —
   * it comes from command-safety.js, the single source of truth.
   */
  _extractCommands(text) {
    const commands = [];
    // Match ```bash:run blocks
    const regex = /```bash:run\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const cmd = match[1].trim();
      if (cmd) {
        const { destructive, reason } = classifyCommand(cmd);
        commands.push({
          command: cmd,
          index: match.index,
          dangerous: destructive,
          reason,
        });
      }
    }
    return commands;
  }

  /**
   * Manage conversation history
   */
  getConversation(id) {
    return this.conversations.get(id) || [];
  }

  addToConversation(id, role, content) {
    if (!this.conversations.has(id)) {
      this.conversations.set(id, []);
    }
    this.conversations.get(id).push({ role, content });
  }

  clearConversation(id) {
    this.conversations.delete(id);
  }

  clearAll() {
    this.conversations.clear();
  }
}

module.exports = new AIService();
