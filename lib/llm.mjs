// llm.mjs — chat client for the text side of the product.
//
// DeepSeek drives summarisation, minutes and translation. The client speaks
// the OpenAI chat-completions dialect, so pointing a role at Xiaomi MiMo (or
// anything else OpenAI-compatible) is a config change, not a code change.

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pull a JSON object out of a model reply that may be fenced or chatty. */
export function extractJson(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/^\s*```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to brace scanning */
  }
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export class Llm {
  constructor(config, creds) {
    this.config = config;
    this.creds = creds;
    this.stats = { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, ms: 0 };
  }

  resolve(roleName) {
    const roles = this.config.llm.roles;
    const role = roles[roleName] || roles.summary;
    const provider = this.config.llm.providers[role.provider];
    if (!provider) throw new Error('unknown llm provider: ' + role.provider);
    if (provider.enabled === false) throw new Error('文本引擎尚未启用：' + provider.label);
    const key = this.creds[provider.keyRef] || '';
    if (!key && !provider.noAuth) {
      throw new Error(
        'llm provider "' + role.provider + '" has no credential ' + provider.keyRef +
          ' — add it to ~/.dsh/.credentials.yaml',
      );
    }
    return { providerName: role.provider, provider, model: role.model, key };
  }

  async call(roleName, messages, opts) {
    const o = opts || {};
    const { provider, model, key } = this.resolve(roleName);
    const body = {
      model,
      messages,
      temperature: o.temperature === undefined ? 0.3 : o.temperature,
    };
    if (o.maxTokens) body.max_tokens = o.maxTokens;
    if (o.json) body.response_format = { type: 'json_object' };
    if (o.stream) body.stream = true;

    const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const started = Date.now();
    let lastErr;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(600 * attempt);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key ? { authorization: 'Bearer ' + key } : {}),
          },
          body: JSON.stringify(body),
          signal: o.signal || AbortSignal.timeout(o.timeoutMs || 180000),
        });
      } catch (err) {
        lastErr = err;
        continue;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // Some deployments reject response_format; retry once without it.
        if (o.json && res.status === 400 && body.response_format) {
          delete body.response_format;
          continue;
        }
        if (RETRY_STATUS.has(res.status) && attempt < 2) {
          lastErr = new Error('HTTP ' + res.status + ': ' + detail.slice(0, 300));
          continue;
        }
        throw new Error(
          provider.label + ' HTTP ' + res.status + ': ' + detail.slice(0, 400),
        );
      }

      if (!o.stream) {
        const json = await res.json();
        const choice = json.choices?.[0];
        const text = choice?.message?.content ?? '';
        const finish = choice?.finish_reason ?? null;
        const usage = json.usage || {};

        // deepseek-flash / deepseek-v4-pro are reasoning models: thinking
        // tokens are billed against max_tokens. If the budget runs out
        // mid-thought the API returns a perfectly valid 200 with an EMPTY
        // message and finish_reason "length". Retrying with more room is the
        // difference between a blank summary and a working one.
        if (!text.trim() && finish === 'length' && body.max_tokens && attempt < 2) {
          body.max_tokens = Math.min(body.max_tokens * 3, 32000);
          lastErr = new Error(
            '模型把 token 预算全部用于推理，已提高到 ' + body.max_tokens + ' 重试',
          );
          continue;
        }

        this.stats.calls++;
        this.stats.promptTokens += usage.prompt_tokens || 0;
        this.stats.completionTokens += usage.completion_tokens || 0;
        this.stats.reasoningTokens += usage.completion_tokens_details?.reasoning_tokens || 0;
        this.stats.ms += Date.now() - started;
        return {
          text,
          finish,
          usage,
          ms: Date.now() - started,
          provider: provider.label,
          model,
        };
      }

      // Streaming: forward deltas, accumulate the whole answer.
      let text = '';
      let usage = null;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let j;
          try {
            j = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            if (o.onDelta) o.onDelta(delta, text);
          }
          if (j.usage) usage = j.usage;
        }
      }
      this.stats.calls++;
      this.stats.promptTokens += usage?.prompt_tokens || 0;
      this.stats.completionTokens += usage?.completion_tokens || 0;
      this.stats.reasoningTokens += usage?.completion_tokens_details?.reasoning_tokens || 0;
      this.stats.ms += Date.now() - started;
      return { text, finish: null, usage, ms: Date.now() - started, provider: provider.label, model };
    }
    throw lastErr || new Error('llm call failed');
  }

  async json(roleName, messages, opts) {
    const res = await this.call(roleName, messages, { ...(opts || {}), json: true });
    const parsed = extractJson(res.text);
    if (parsed === null) {
      const hint =
        'Your previous reply was not valid JSON. Reply with a single JSON object and nothing else.';
      const retry = await this.call(
        roleName,
        [...messages, { role: 'assistant', content: res.text }, { role: 'user', content: hint }],
        { ...(opts || {}), json: true },
      );
      const second = extractJson(retry.text);
      if (second === null) throw new Error('model did not return JSON: ' + res.text.slice(0, 300));
      return { data: second, raw: retry.text, ms: res.ms + retry.ms };
    }
    return { data: parsed, raw: res.text, ms: res.ms };
  }
}

export function createLlm(config, creds) {
  return new Llm(config, creds);
}
