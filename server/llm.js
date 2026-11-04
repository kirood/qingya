/* ============ 真实大模型代理调用（密钥只在服务器，不暴露给前端） ============ */

async function callLLM(system, user, timeout = 12000) {
  const base = (process.env.LLM_BASE_URL || '').trim();
  const key = (process.env.LLM_API_KEY || '').trim();
  const model = (process.env.LLM_MODEL || '').trim() || 'deepseek-chat';
  if (!base || !key) return null; // 未配置密钥 → 返回 null，由调用方回退规则引擎

  const url = base.replace(/\/+$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || null;
  } catch (e) {
    return null; // 网络错误 / 超时 → 回退
  } finally {
    clearTimeout(timer);
  }
}

function parseJSON(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

module.exports = { callLLM, parseJSON };
