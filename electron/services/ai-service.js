/**
 * AI Service — Multi-provider AI integration (Claude, DeepSeek, OpenAI)
 * Handles communication with AI providers for terminal assistance
 */

const https = require('https');
const os = require('os');

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
        buildBody: (model, system, messages) => ({
          model,
          max_tokens: 4096,
          system,
          messages,
        }),
        parseResponse: (data) => data.content?.[0]?.text || '',
      },
      'deepseek': {
        url: 'https://api.deepseek.com/chat/completions',
        buildHeaders: (apiKey) => ({
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        }),
        buildBody: (model, system, messages) => ({
          model,
          max_tokens: 4096,
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
          max_tokens: 4096,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
        parseResponse: (data) => data.choices?.[0]?.message?.content || '',
      },
    };
  }

  /**
   * Send a message and get a response (supports Claude, DeepSeek, OpenAI)
   */
  async chat({ apiKey, messages, terminalContext, model = 'claude-sonnet-4-20250514', provider = 'claude-api' }) {
    if (!apiKey) throw new Error('API key not configured. Go to Settings → AI Assistant to add your API key.');

    const systemPrompt = this._buildSystemPrompt(terminalContext);
    const providerConfig = this.PROVIDERS[provider] || this.PROVIDERS['claude-api'];

    const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));
    const body = JSON.stringify(providerConfig.buildBody(model, systemPrompt, apiMessages));

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
  async chatStream({ apiKey, messages, terminalContext, model = 'claude-sonnet-4-20250514', provider = 'claude-api', onChunk }) {
    if (!apiKey) throw new Error('API key not configured. Go to Settings → AI Assistant to add your API key.');

    const systemPrompt = this._buildSystemPrompt(terminalContext);
    const providerConfig = this.PROVIDERS[provider] || this.PROVIDERS['claude-api'];
    const isClaude = provider === 'claude-api';

    const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));
    const bodyObj = { ...providerConfig.buildBody(model, systemPrompt, apiMessages), stream: true };
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
                  if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                    accumulated += parsed.delta.text;
                    if (onChunk) onChunk(parsed.delta.text);
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
   * Build system prompt with terminal context and OS info
   */
  _buildSystemPrompt(terminalContext) {
    const platform = process.platform;
    const arch = process.arch;
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const shell = process.env.SHELL || 'unknown';

    let prompt = `You are an AI terminal assistant integrated into Termilab. You have access to the user's terminal context below. When suggesting commands, always wrap them in \`\`\`bash code blocks so the user can execute them with one click. After a command is executed, you will receive the terminal output. Analyze it and suggest next steps if needed. Be concise and practical.

## System Info:
- OS: ${platform} (${arch})
- Hostname: ${hostname}
- User: ${username}
- Shell: ${shell}

## Rules:
1. When you want to suggest a command to execute, wrap it in a code block with the language "bash" and add a special marker:
   \`\`\`bash:run
   command here
   \`\`\`
2. For commands that are informational only (don't need execution), use regular code blocks:
   \`\`\`bash
   example command
   \`\`\`
3. Be concise and practical. Focus on actionable steps.
4. When performing multi-step tasks, execute one command at a time and wait for the output before proceeding.
5. Always explain what each command does before suggesting it.
6. For dangerous commands (rm -rf, format, drop database, etc.), add a warning ⚠️ and explain the risk.
7. Respond in the same language the user writes in.
8. When you see terminal output with errors, proactively suggest fixes.`;

    if (terminalContext) {
      prompt += `\n\n## Current Terminal Context:\n\`\`\`\n${terminalContext}\n\`\`\``;
    }

    return prompt;
  }

  /**
   * Extract executable commands from Claude's response
   */
  _extractCommands(text) {
    const commands = [];
    // Match ```bash:run blocks
    const regex = /```bash:run\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const cmd = match[1].trim();
      if (cmd) {
        commands.push({
          command: cmd,
          index: match.index,
          dangerous: this._isDangerous(cmd),
        });
      }
    }
    return commands;
  }

  /**
   * Check if a command is potentially dangerous
   */
  _isDangerous(cmd) {
    const dangerous = [
      /rm\s+(-rf?|--recursive)\s/i,
      /mkfs/i,
      /dd\s+if=/i,
      /:\(\)\s*\{/i, // fork bomb
      />\s*\/dev\/sd/i,
      /chmod\s+777/i,
      /drop\s+(database|table)/i,
      /truncate\s+table/i,
      /shutdown/i,
      /reboot/i,
      /init\s+0/i,
      /systemctl\s+(stop|disable)/i,
    ];
    return dangerous.some(r => r.test(cmd));
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
