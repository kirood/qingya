/* ============ 青芽 · 后端入口 ============
   真实 AI 代理 + 账号 + 数据库 + 危机守护 + GAD-7
   运行：npm install && npm start
*/
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');

const data = require('./data.js');
const { callLLM, parseJSON } = require('./llm.js');
const store = require('./db.js');

const app = express();
app.use(express.json({ limit: '100kb' }));

/* CORS（前端与后端可能不同源） */
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* 认证中间件 */
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = store.userFromToken(t);
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = user;
  next();
}

/* 可选认证：登录了就带上身份（用于「我的主题 / 我的位置」等个性化字段） */
function optionalAuth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  req.user = store.userFromToken(t);
  next();
}

/* 匿名昵称：由用户 ID 稳定生成一个温暖的人称，不暴露用户名 */
const NICK_ADJ = ['不想早起的','正在赶路的','偷偷努力的','慢慢变好的','不慌不忙的','偶尔走神的',
  '三分钟热度的','晚睡冠军','认真生活的','温柔坚定的','刚刚开始的','有点慢热的'];
const NICK_NOUN = ['小橘猫','向日葵','蒲公英','云朵','小树苗','月亮','柠檬水','小台灯',
  '鲸鱼','小面包','风铃','薄荷糖','远山','小刺猬','橘子汽水','纸飞机'];
function nickOf(userId) {
  const id = Number(userId) || 0;
  const a = NICK_ADJ[id % NICK_ADJ.length];
  const b = NICK_NOUN[(id * 7 + 3) % NICK_NOUN.length];
  return a + b;
}
/* SQLite 的 created_at 是 UTC，这里转成北京时间展示 */
function fmtTime(s) {
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
}

/* ---------- 健康检查 / 状态 ---------- */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    name: '青芽后端',
    online: !!process.env.LLM_API_KEY, // 是否已接真实大模型
    time: new Date().toISOString(),
  });
});

/* ---------- 账号 ---------- */
app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名需 2-20 个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (store.findUser(username)) return res.status(409).json({ error: '用户名已存在' });
  const id = store.createUser(username, password);
  res.json({ token: store.createToken(id), username });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const u = store.verifyUser(username, password);
  if (!u) return res.status(401).json({ error: '用户名或密码错误' });
  res.json({ token: store.createToken(u.id), username });
});

app.post('/api/logout', auth, (req, res) => {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  store.deleteToken(t);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username });
});

/* ---------- 焦虑拆解（真 AI + 危机优先 + 离线兜底） ---------- */
const ANXIETY_SYS = '你是一名温和、专业、不说教的大学生成长教练，熟悉 CBT 认知行为疗法。请用中文、真诚口语、第二人称"你"，针对用户写的焦虑，输出严格的 JSON 对象（不要任何多余文字，不要 markdown 代码块），字段为：reframe（先用一句话回应用户具体担心的事，再换一个视角，2-3 句，禁止"焦虑是身体在提醒你"这类套话）、can（你能控制的，1-2 句）、cannot（你无法控制的，1-2 句）、next（一个具体、今天就能做的最小下一步行动，1 句）。如果用户写的是身高、外貌、健康等身体相关困扰，要给出贴合该话题的回应，不要泛泛谈学习或就业。';

app.post('/api/anxiety', async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: '请先写下让你焦虑的那句话' });

  // ① 危机优先：任何情况先兜底安全
  if (data.isCrisis(text)) return res.json(data.crisisPayload());

  // ② 匿名记录焦虑主题（只存主题，供「共鸣墙」聚合；原文不对外展示）
  const user = store.userFromToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (user) {
    try { store.addAnxietyLog(user.id, text, data.classifyTopic(text)); } catch (e) { /* 记录失败不影响主流程 */ }
  }

  // ③ 离线兜底（规则引擎）
  const fallback = data.matchAnxiety(text);

  // ④ 在线增强：真 AI 结构化输出；失败自动回退
  const ai = await callLLM(ANXIETY_SYS, '我的焦虑：' + text);
  const j = parseJSON(ai);
  if (j && j.reframe && j.next) {
    return res.json({
      crisis: false,
      source: 'ai',
      reframe: j.reframe,
      can: j.can || fallback.can,
      cannot: j.cannot || fallback.cannot,
      next: j.next,
    });
  }
  res.json({ crisis: false, source: 'rule', ...fallback });
});

/* ---------- 成长画像（真 AI + 打卡数据反哺 + 离线兜底） ---------- */
const PORTRAIT_SYS = '你是一名专业的大学生成长教练。请根据学生填写的专业、擅长、热爱、成就，用中文给出 3 条具体、可执行、今天就能开始的成长建议，每条以"- "开头，每条不超过 30 字，不要其他内容。';

app.post('/api/portrait', async (req, res) => {
  const fields = [
    String(req.body.major || '').trim(),
    String(req.body.good || '').trim(),
    String(req.body.like || '').trim(),
    String(req.body.win || '').trim(),
  ].filter(Boolean);
  if (fields.length === 0) return res.status(400).json({ error: '请至少填写一项真实信息' });

  // 打卡数据反哺画像
  let streak = 0;
  if (req.headers.authorization) {
    const t = req.headers.authorization.replace(/^Bearer\s+/i, '');
    const user = store.userFromToken(t);
    if (user) streak = data.calcStreak(store.getCheckinDates(user.id));
  }

  const base = data.buildPortrait(fields, streak);

  const ai = await callLLM(PORTRAIT_SYS,
    `专业/方向：${fields[0] || '未填'}；擅长：${fields[1] || '未填'}；热爱：${fields[2] || '未填'}；最近成就感：${fields[3] || '未填'}`);
  let aiSug = [];
  if (ai && ai.trim()) {
    aiSug = ai.trim().split(/\n+/).map(x => x.replace(/^[-•*]\s*/, '').trim()).filter(Boolean).slice(0, 3);
  }

  res.json({
    idx: base.idx,
    strong: base.strong,
    dims: base.dims,
    topLabel: base.topLabel,
    topKey: base.topKey,
    secondLabel: base.secondLabel,
    suggest: base.suggest,
    driveNote: base.driveNote,
    aiSug,
    source: aiSug.length ? 'ai' : 'rule',
  });
});

/* ---------- 打卡（每天由用户自己写「今天完成了什么」） ---------- */
app.get('/api/checkins', auth, (req, res) => {
  const dates = store.getCheckinDates(req.user.id);
  res.json({
    dates,
    streak: data.calcStreak(dates),
    records: store.getCheckinRecords(req.user.id, 30),
  });
});
app.post('/api/checkins', auth, (req, res) => {
  const date = String(req.body.date || '').trim();
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) return res.status(400).json({ error: '日期格式应为 YYYY-M-D' });
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '请写下今天完成了什么，让坚持有迹可循' });
  if (content.length > 120) return res.status(400).json({ error: '打卡内容请控制在 120 字以内' });
  store.addCheckin(req.user.id, date, content);
  const dates = store.getCheckinDates(req.user.id);
  res.json({
    dates,
    streak: data.calcStreak(dates),
    records: store.getCheckinRecords(req.user.id, 30),
  });
});

/* ---------- 计划 ---------- */
app.get('/api/plan', auth, (req, res) => {
  res.json({ done: store.getPlanDone(req.user.id) });
});
app.post('/api/plan', auth, (req, res) => {
  const dir = String(req.body.dir || '').trim();
  const idx = parseInt(req.body.index, 10);
  if (!data.PLANS[dir]) return res.status(400).json({ error: '未知的成长方向' });
  if (isNaN(idx) || idx < 0) return res.status(400).json({ error: '任务序号无效' });
  store.togglePlanDone(req.user.id, dir, idx);
  res.json({ done: store.getPlanDone(req.user.id) });
});

/* 计划：具体内容由用户自己写（大方向 + 自定义任务） */
app.get('/api/plan/tasks', auth, (req, res) => {
  const dir = String(req.query.dir || '').trim();
  if (!data.PLANS[dir]) return res.status(400).json({ error: '未知的成长方向' });
  const done = new Set(store.getPlanDone(req.user.id)[dir] || []);
  res.json({
    dir,
    tasks: store.listPlanTasks(req.user.id, dir).map(t => ({ ...t, done: done.has(t.idx) })),
  });
});
app.post('/api/plan/tasks', auth, (req, res) => {
  const dir = String(req.body.dir || '').trim();
  const text = String(req.body.text || '').trim();
  if (!data.PLANS[dir]) return res.status(400).json({ error: '未知的成长方向' });
  if (!text) return res.status(400).json({ error: '请写下你这一周真的会做的那件事' });
  if (text.length > 60) return res.status(400).json({ error: '一条计划请控制在 60 字以内，越具体越容易做到' });
  const idx = store.addPlanTask(req.user.id, dir, text);
  res.json({ ok: true, idx });
});
app.delete('/api/plan/tasks', auth, (req, res) => {
  const dir = String(req.query.dir || '').trim();
  const idx = parseInt(req.query.idx, 10);
  if (!data.PLANS[dir] || isNaN(idx)) return res.status(400).json({ error: '参数无效' });
  store.deletePlanTask(req.user.id, dir, idx);
  res.json({ ok: true });
});

/* ---------- GAD-7 焦虑量表 ---------- */
app.get('/api/gad7', auth, (req, res) => {
  res.json({ questions: data.GAD7, options: data.GAD7_OPTIONS, history: store.getGad7History(req.user.id) });
});
app.post('/api/gad7', auth, (req, res) => {
  const answers = Array.isArray(req.body.answers) ? req.body.answers.map(Number) : [];
  if (answers.length !== 7 || answers.some(n => isNaN(n) || n < 0 || n > 3)) {
    return res.status(400).json({ error: '请完整填写 7 题（每题 0-3 分）' });
  }
  const score = answers.reduce((a, b) => a + b, 0);
  store.addGad7(req.user.id, score, answers);
  res.json({ ...data.gad7Interpret(score), saved: true });
});

/* ---------- 同伴模块（第 7 个模块）：只做匿名聚合，不暴露原文与身份 ---------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/* 实时数据条：多少人在用 */
app.get('/api/community/overview', (req, res) => {
  const s = store.stats();
  const date = String(req.query.date || todayStr());
  res.json({
    users: s.users,
    demoUsers: s.demoUsers,
    realUsers: s.realUsers,
    todayCheckins: store.todayCheckinUsers(date),
    tasksDone: store.countPlanTasksDone(),
    checkins: s.checkins,
    whispers: s.whispers,
    topics: s.topics,
  });
});

/* 我的位置卡：百分位 + GAD-7 四级分布（不做焦虑排名） */
app.get('/api/community/position', auth, (req, res) => {
  const latest = store.gad7LatestPerUser();
  const n = latest.length;
  const mine = latest.find(x => x.user_id === req.user.id);
  if (!mine) return res.json({ hasScore: false, sample: n });

  const score = mine.score;
  const band = data.gad7Band(score);
  const below = latest.filter(x => x.score < score).length;
  const equal = latest.filter(x => x.score === score).length;
  const percentile = n ? Math.round(((below + equal / 2) / n) * 100) : 0;
  const distribution = data.GAD7_BANDS.map(b => {
    const count = latest.filter(x => x.score >= b.min && x.score <= b.max).length;
    return { key: b.key, label: b.label, count, pct: n ? Math.round((count / n) * 100) : 0 };
  });
  const bandPct = (distribution.find(d => d.key === band.key) || { pct: 0 }).pct;

  res.json({
    hasScore: true,
    score,
    level: band.label,
    bandKey: band.key,
    percentile,
    bandPct,
    sample: n,
    distribution,
  });
});

/* 焦虑共鸣墙：主题聚合 + 我的主题 + 「我也是」 */
app.get('/api/community/topics', optionalAuth, (req, res) => {
  const counts = store.topicCounts();
  const myKey = req.user ? store.getMyTopic(req.user.id) : '';
  const pinged = req.user ? store.getPingedTopics(req.user.id) : [];
  const topics = data.TOPICS.map(t => ({
    key: t.key,
    label: t.label,
    count: counts[t.key] || 0,
    mine: t.key === myKey,
    pinged: pinged.includes(t.key),
  })).sort((a, b) => b.count - a.count);
  const mineT = topics.find(t => t.mine);
  res.json({
    topics,
    mine: mineT ? { key: mineT.key, label: mineT.label, count: mineT.count } : null,
  });
});

app.post('/api/community/topics/:key/ping', auth, (req, res) => {
  const key = String(req.params.key || '');
  if (!data.TOPICS.some(t => t.key === key)) return res.status(400).json({ error: '未知的主题' });
  store.pingTopic(req.user.id, key);
  const counts = store.topicCounts();
  res.json({ ok: true, key, count: counts[key] || 0 });
});

/* 匿名树洞：发布 / 点赞 / 回应（含敏感词与隐私审核） */
app.get('/api/community/whispers', optionalAuth, (req, res) => {
  const items = store.listWhispers(req.user ? req.user.id : null, 30).map(w => ({
    id: w.id,
    nick: nickOf(w.userId),
    content: w.content,
    createdAt: fmtTime(w.createdAt),
    likes: w.likes,
    liked: w.liked,
    replies: w.replies.map(r => ({ nick: nickOf(r.user_id), content: r.content })),
  }));
  res.json({ items });
});

app.post('/api/community/whispers', auth, (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '写一句再发布吧' });
  if (content.length > 300) return res.status(400).json({ error: '树洞一句话请控制在 300 字以内' });
  const chk = data.checkText(content);
  if (chk.crisis) {
    return res.status(400).json({
      error: '你现在很辛苦，先照顾好自己，再回来也不迟',
      crisis: true,
      hotline: data.HOTLINE,
    });
  }
  if (!chk.ok) return res.status(400).json({ error: chk.reason });
  store.addWhisper(req.user.id, content);
  res.json({ ok: true });
});

app.post('/api/community/whispers/:id/like', auth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !store.whisperExists(id)) return res.status(404).json({ error: '这条树洞不存在或已删除' });
  store.likeWhisper(id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/community/whispers/:id/reply', auth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const content = String(req.body.content || '').trim();
  if (isNaN(id) || !store.whisperExists(id)) return res.status(404).json({ error: '这条树洞不存在或已删除' });
  if (!content) return res.status(400).json({ error: '写一句再回应吧' });
  if (content.length > 120) return res.status(400).json({ error: '回应请控制在 120 字以内' });
  const chk = data.checkText(content);
  if (chk.crisis) {
    return res.status(400).json({
      error: '你现在很辛苦，先照顾好自己，再回来也不迟',
      crisis: true,
      hotline: data.HOTLINE,
    });
  }
  if (!chk.ok) return res.status(400).json({ error: chk.reason });
  store.addWhisperReply(id, req.user.id, content);
  res.json({ ok: true });
});

/* 成长坚持榜：只展示积极行为，全部匿名昵称 */
app.get('/api/community/board', optionalAuth, (req, res) => {
  const rows = store.boardData()
    .map(u => ({ userId: u.userId, nick: nickOf(u.userId), streak: data.calcStreak(u.dates), total: u.dates.length }))
    .filter(x => x.total > 0)
    .sort((a, b) => b.streak - a.streak || b.total - a.total || a.userId - b.userId);

  const items = rows.slice(0, 20).map((x, i) => ({
    rank: i + 1,
    nick: x.nick,
    streak: x.streak,
    total: x.total,
    isMe: !!req.user && x.userId === req.user.id,
  }));

  let me = null;
  if (req.user) {
    const i = rows.findIndex(x => x.userId === req.user.id);
    if (i >= 0) me = { rank: i + 1, nick: rows[i].nick, streak: rows[i].streak, total: rows[i].total, inTop: i < 20 };
  }
  res.json({ items, me });
});

/* ---------- 数据导出 ---------- */
app.get('/api/export', auth, (req, res) => {
  res.json({
    username: req.user.username,
    checkins: store.getCheckinDates(req.user.id),
    plan: store.getPlanDone(req.user.id),
    gad7: store.getGad7History(req.user.id),
    exportedAt: new Date().toISOString(),
  });
});

/* ---------- 落地数据统计（材料/答辩用） ---------- */
app.get('/api/stats', (req, res) => res.json(store.stats()));

/* ---------- 可选：仅托管前端单文件（不暴露 server/ 目录与数据库） ---------- */
const FRONTEND = path.join(__dirname, '..', 'index.html');
app.get('/', (req, res) => {
  if (fs.existsSync(FRONTEND)) res.sendFile(FRONTEND);
  else res.json({ name: '青芽后端', tip: '请访问 /api/health 查看状态' });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`🌱 青芽后端已启动：http://localhost:${PORT}`);
  console.log(`   在线增强（真实大模型）：${process.env.LLM_API_KEY ? '已配置 ✓' : '未配置（走离线规则引擎）'}`);
  console.log(`   健康检查：http://localhost:${PORT}/api/health`);
});
