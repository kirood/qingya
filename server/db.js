/* ============ 数据库（SQLite，Node 内置 node:sqlite，无需额外安装） + 认证 ============ */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, 'qingya.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, date)
  );
  CREATE TABLE IF NOT EXISTS plan_done (
    user_id INTEGER NOT NULL,
    dir TEXT NOT NULL,
    idx INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, dir, idx)
  );
  CREATE TABLE IF NOT EXISTS gad7 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    answers TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  /* ---- 同伴模块：焦虑主题聚合（只存主题，不对外展示原文） ---- */
  CREATE TABLE IF NOT EXISTS anxiety_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  /* 「我也是」匿名共鸣，一人一主题只算一次 */
  CREATE TABLE IF NOT EXISTS topic_pings (
    user_id INTEGER NOT NULL,
    topic TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(user_id, topic)
  );
  /* 匿名树洞 */
  CREATE TABLE IF NOT EXISTS whispers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS whisper_likes (
    whisper_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY(whisper_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS whisper_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    whisper_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  /* 用户自己写的成长计划（大方向 + 自定义具体内容） */
  CREATE TABLE IF NOT EXISTS plan_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    dir TEXT NOT NULL,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, dir, idx)
  );
`);

/* 兼容旧数据库：checkins 表若没有 content 列则补上 */
const checkinCols = db.prepare('PRAGMA table_info(checkins)').all();
if (!checkinCols.some(c => c.name === 'content')) {
  db.exec("ALTER TABLE checkins ADD COLUMN content TEXT NOT NULL DEFAULT ''");
}

/* 兼容旧数据库：users 表补 demo 列（标记「系统体验用户」，便于统计与说明） */
const userCols = db.prepare('PRAGMA table_info(users)').all();
if (!userCols.some(c => c.name === 'demo')) {
  db.exec('ALTER TABLE users ADD COLUMN demo INTEGER NOT NULL DEFAULT 0');
}

/* ---- 认证 ---- */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }

function createUser(username, password) {
  const salt = newSalt();
  const hash = hashPassword(password, salt);
  db.prepare('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)').run(username, salt, hash);
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}
function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function verifyUser(username, password) {
  const u = findUser(username);
  if (!u) return null;
  if (hashPassword(password, u.salt) !== u.hash) return null;
  return u;
}
function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const th = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO tokens (token_hash, user_id) VALUES (?, ?)').run(th, userId);
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const th = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(
    'SELECT t.user_id AS id, u.username FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?'
  ).get(th);
  return row || null;
}
function deleteToken(token) {
  if (!token) return;
  const th = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(th);
}

/* ---- 打卡（含用户自己写的打卡内容） ---- */
function addCheckin(userId, date, content = '') {
  db.prepare(`
    INSERT INTO checkins (user_id, date, content) VALUES (?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET content = excluded.content
  `).run(userId, date, content);
}
function getCheckinDates(userId) {
  return db.prepare('SELECT date FROM checkins WHERE user_id = ? ORDER BY date').all(userId).map(r => r.date);
}
function getCheckinRecords(userId, limit = 30) {
  return db.prepare('SELECT date, content FROM checkins WHERE user_id = ? ORDER BY date DESC LIMIT ?')
    .all(userId, limit);
}
function todayCheckinUsers(date) {
  return db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM checkins WHERE date = ?').get(date).n;
}

/* ---- 计划（旧的完成标记表，继续用于「勾选完成」） ---- */
function getPlanDone(userId) {
  const rows = db.prepare('SELECT dir, idx FROM plan_done WHERE user_id = ?').all(userId);
  const out = {};
  rows.forEach(r => { (out[r.dir] = out[r.dir] || []).push(r.idx); });
  return out;
}
function togglePlanDone(userId, dir, idx) {
  const existing = db.prepare('SELECT 1 FROM plan_done WHERE user_id = ? AND dir = ? AND idx = ?').get(userId, dir, idx);
  if (existing) {
    db.prepare('DELETE FROM plan_done WHERE user_id = ? AND dir = ? AND idx = ?').run(userId, dir, idx);
  } else {
    db.prepare('INSERT INTO plan_done (user_id, dir, idx) VALUES (?, ?, ?)').run(userId, dir, idx);
  }
}

/* ---- 计划：用户自己写的具体内容 ---- */
function listPlanTasks(userId, dir) {
  return db.prepare('SELECT idx, text FROM plan_tasks WHERE user_id = ? AND dir = ? ORDER BY idx')
    .all(userId, dir);
}
function addPlanTask(userId, dir, text) {
  const row = db.prepare('SELECT MAX(idx) AS m FROM plan_tasks WHERE user_id = ? AND dir = ?').get(userId, dir);
  const idx = row && row.m !== null ? row.m + 1 : 0;
  db.prepare('INSERT INTO plan_tasks (user_id, dir, idx, text) VALUES (?, ?, ?, ?)').run(userId, dir, idx, text);
  return idx;
}
function deletePlanTask(userId, dir, idx) {
  db.prepare('DELETE FROM plan_tasks WHERE user_id = ? AND dir = ? AND idx = ?').run(userId, dir, idx);
  db.prepare('DELETE FROM plan_done WHERE user_id = ? AND dir = ? AND idx = ?').run(userId, dir, idx);
}
function countPlanTasksDone() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM plan_tasks t
    JOIN plan_done d ON d.user_id = t.user_id AND d.dir = t.dir AND d.idx = t.idx
  `).get().n;
}

/* ---- GAD-7 ---- */
function addGad7(userId, score, answers) {
  db.prepare('INSERT INTO gad7 (user_id, score, answers) VALUES (?, ?, ?)').run(userId, score, JSON.stringify(answers));
}
function getGad7History(userId) {
  return db.prepare('SELECT score, answers, created_at FROM gad7 WHERE user_id = ? ORDER BY created_at').all(userId);
}
/* 每个用户的最新一次自测（用于群体分布 / 百分位） */
function gad7LatestPerUser() {
  const rows = db.prepare('SELECT user_id, score, id FROM gad7 ORDER BY user_id, id DESC').all();
  const seen = new Set();
  const out = [];
  rows.forEach(r => {
    if (seen.has(r.user_id)) return;
    seen.add(r.user_id);
    out.push(r);
  });
  return out;
}

/* ---- 同伴：焦虑主题 ---- */
function addAnxietyLog(userId, text, topic) {
  db.prepare('INSERT INTO anxiety_logs (user_id, text, topic) VALUES (?, ?, ?)').run(userId, text.slice(0, 300), topic || '');
}
function getMyTopic(userId) {
  const r = db.prepare("SELECT topic FROM anxiety_logs WHERE user_id = ? AND topic <> '' ORDER BY id DESC LIMIT 1").get(userId);
  return r ? r.topic : '';
}
/* 主题人数 = 写过该主题的同学 ∪ 点过「我也是」的同学（按人去重） */
function topicCounts() {
  const rows = db.prepare("SELECT DISTINCT topic, user_id FROM anxiety_logs WHERE topic <> ''").all()
    .concat(db.prepare('SELECT topic, user_id FROM topic_pings').all());
  const sets = {};
  rows.forEach(r => {
    if (!sets[r.topic]) sets[r.topic] = new Set();
    sets[r.topic].add(r.user_id);
  });
  const out = {};
  Object.keys(sets).forEach(k => { out[k] = sets[k].size; });
  return out;
}
function pingTopic(userId, topic) {
  db.prepare('INSERT OR IGNORE INTO topic_pings (user_id, topic) VALUES (?, ?)').run(userId, topic);
}
function getPingedTopics(userId) {
  return db.prepare('SELECT topic FROM topic_pings WHERE user_id = ?').all(userId).map(r => r.topic);
}

/* ---- 同伴：匿名树洞 ---- */
function addWhisper(userId, content) {
  const info = db.prepare('INSERT INTO whispers (user_id, content) VALUES (?, ?)').run(userId, content);
  return Number(info.lastInsertRowid);
}
function listWhispers(viewerId, limit = 30) {
  /* 只取最近 7 天，避免用户变多后旧内容无限堆积 */
  const rows = db.prepare(`
    SELECT id, user_id, content, created_at FROM whispers
    WHERE status = 'ok' AND created_at >= datetime('now', '-7 days')
    ORDER BY id DESC LIMIT ?
  `).all(limit);

  const likeMap = {};
  db.prepare('SELECT whisper_id, COUNT(*) AS n FROM whisper_likes GROUP BY whisper_id').all()
    .forEach(r => { likeMap[r.whisper_id] = r.n; });

  const likedSet = new Set();
  if (viewerId) {
    db.prepare('SELECT whisper_id FROM whisper_likes WHERE user_id = ?').all(viewerId)
      .forEach(r => likedSet.add(r.whisper_id));
  }

  const replyMap = {};
  db.prepare(`
    SELECT id, whisper_id, user_id, content, created_at FROM whisper_replies
    WHERE status = 'ok' ORDER BY id
  `).all().forEach(r => { (replyMap[r.whisper_id] = replyMap[r.whisper_id] || []).push(r); });

  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    content: r.content,
    createdAt: r.created_at,
    likes: likeMap[r.id] || 0,
    liked: likedSet.has(r.id),
    replies: (replyMap[r.id] || []).slice(-3),
  }));
}
function likeWhisper(whisperId, userId) {
  db.prepare('INSERT OR IGNORE INTO whisper_likes (whisper_id, user_id) VALUES (?, ?)').run(whisperId, userId);
}
function whisperExists(whisperId) {
  return !!db.prepare("SELECT 1 FROM whispers WHERE id = ? AND status = 'ok'").get(whisperId);
}
function addWhisperReply(whisperId, userId, content) {
  db.prepare('INSERT INTO whisper_replies (whisper_id, user_id, content) VALUES (?, ?, ?)').run(whisperId, userId, content);
}

/* ---- 同伴：成长坚持榜（返回原始打卡日期，streak 在 server 里算） ---- */
function boardData() {
  const users = db.prepare('SELECT id FROM users').all();
  const rows = db.prepare('SELECT user_id, date FROM checkins').all();
  const map = {};
  rows.forEach(r => { (map[r.user_id] = map[r.user_id] || []).push(r.date); });
  return users.map(u => ({ userId: u.id, dates: map[u.id] || [] }));
}

/* ---- 系统体验用户（让空产品也有真实感的数据，全部匿名展示） ---- */
const DEMO_USERS = [
  { topic: 'ai',     score: 9,  days: 9, tasks: 3 },
  { topic: 'study',  score: 12, days: 7, tasks: 2 },
  { topic: 'career', score: 6,  days: 6, tasks: 2 },
  { topic: 'lost',   score: 14, days: 5, tasks: 1 },
  { topic: 'social', score: 4,  days: 5, tasks: 1 },
  { topic: 'peer',   score: 11, days: 4, tasks: 2 },
  { topic: 'ai',     score: 8,  days: 4, tasks: 1 },
  { topic: 'study',  score: 3,  days: 3, tasks: 1 },
  { topic: 'career', score: 7,  days: 3, tasks: 0 },
  { topic: 'major',  score: 10, days: 2, tasks: 1 },
  { topic: 'lost',   score: 5,  days: 2, tasks: 0 },
  { topic: 'ai',     score: 16, days: 2, tasks: 0 },
  { topic: 'study',  score: 13, days: 1, tasks: 0 },
  { topic: 'peer',   score: 6,  days: 1, tasks: 0 },
  { topic: 'career', score: 2,  days: 1, tasks: 0 },
  { topic: 'social', score: 8,  days: 1, tasks: 0 },
  { topic: 'major',  score: 1,  days: 0, tasks: 0 },
  { topic: 'ai',     score: 7,  days: 0, tasks: 0 },
  { topic: 'study',  score: 9,  days: 0, tasks: 0 },
  { topic: 'lost',   score: 4,  days: 0, tasks: 0 },
];
const DEMO_ANXIETY = {
  ai: '最近总担心 AI 会不会替代我这个专业',
  study: '绩点和考试压力压得我有点喘不过气',
  career: '投了几份简历都没消息，担心毕业找不到工作',
  lost: '不知道自己以后要做什么，越想越迷茫',
  social: '身边的人好像都有自己的圈子，我插不进去',
  major: '越来越怀疑自己是不是选错了专业',
  peer: '看到同龄人那么优秀，总觉得自己落后了',
};
const DEMO_CHECKINS = [
  '背了 30 个雅思单词',
  '跑步 2 公里，出了点汗',
  '复习了两章专业课',
  '改完了一版简历',
  '练习了 20 分钟口语',
  '整理了本周的课堂笔记',
  '做了一组算法题',
  '和同学讨论了一次项目',
  '比平时早睡了 30 分钟',
  '读完了 10 页书',
];
const DEMO_PLAN_TEXTS = {
  tech: ['每天背 30 个雅思单词', '每周做 2 道算法题', '整理一份课程知识图谱'],
  express: ['每天跟读 10 分钟英语', '每周做一次 3 分钟口头表达', '给小组汇报做一次主讲'],
  create: ['每周画一张速写', '整理一个作品集页面', '拆解 3 个优秀设计案例'],
  career: ['本周改一版简历', '约一位学长做职业访谈', '投递 3 个实习岗位'],
  mind: ['每天 11 点半前睡觉', '每周运动 3 次', '每天留 10 分钟放空'],
};
const DEMO_WHISPERS = [
  '今天终于把拖了两周的任务做完了，原来看似难的事，开始就没那么难。',
  '第一次去学校的心理咨询，比想象中轻松，咨询师只是安静听我说了四十分钟。',
  '投了 12 份简历只回了 1 个，但我还是决定明天再改一版。',
  '原来我不需要变成别人家的孩子，只要比昨天的自己好一点就够了。',
];

/* 把分数拆成 7 道题的答案（用于生成体验用户的 GAD-7 记录） */
function splitScore(score) {
  const a = [0, 0, 0, 0, 0, 0, 0];
  let s = score;
  for (let i = 0; i < 7 && s > 0; i++) {
    const v = Math.min(3, s);
    a[i] = v;
    s -= v;
  }
  return a;
}
function dateOffset(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function seedDemoUsers() {
  const exists = db.prepare('SELECT COUNT(*) AS n FROM users WHERE demo = 1').get().n;
  if (exists > 0) return 0;

  const salt = 'demo-salt-fixed';
  const hash = hashPassword('demo1234', salt);
  const insUser = db.prepare('INSERT INTO users (username, salt, hash, demo) VALUES (?, ?, ?, 1)');
  const insCheckin = db.prepare('INSERT OR IGNORE INTO checkins (user_id, date, content) VALUES (?, ?, ?)');
  const insAnxiety = db.prepare('INSERT INTO anxiety_logs (user_id, text, topic) VALUES (?, ?, ?)');
  const insGad7 = db.prepare('INSERT INTO gad7 (user_id, score, answers) VALUES (?, ?, ?)');
  const insTask = db.prepare('INSERT INTO plan_tasks (user_id, dir, idx, text) VALUES (?, ?, ?, ?)');
  const insDone = db.prepare('INSERT OR IGNORE INTO plan_done (user_id, dir, idx) VALUES (?, ?, ?)');
  const dirs = Object.keys(DEMO_PLAN_TEXTS);

  const ids = [];
  DEMO_USERS.forEach((u, i) => {
    const num = String(i + 1).padStart(2, '0');
    insUser.run('demo_' + num, salt, hash);
    const id = db.prepare('SELECT id FROM users WHERE username = ?').get('demo_' + num).id;
    ids.push(id);

    // 焦虑主题
    insAnxiety.run(id, DEMO_ANXIETY[u.topic], u.topic);

    // 打卡（连续 u.days 天，含今天）
    for (let k = 0; k < u.days; k++) {
      insCheckin.run(id, dateOffset(k), DEMO_CHECKINS[(i + k) % DEMO_CHECKINS.length]);
    }

    // GAD-7
    insGad7.run(id, u.score, JSON.stringify(splitScore(u.score)));

    // 计划：用户自写内容 + 部分完成
    const dir = dirs[i % dirs.length];
    const texts = DEMO_PLAN_TEXTS[dir];
    for (let k = 0; k < Math.min(3, texts.length); k++) {
      insTask.run(id, dir, k, texts[k]);
    }
    for (let k = 0; k < u.tasks; k++) {
      insDone.run(id, dir, k);
    }
  });

  // 树洞：4 条 + 点赞 + 回应
  const insWhisper = db.prepare("INSERT INTO whispers (user_id, content, created_at) VALUES (?, ?, datetime('now', ?))");
  const insLike = db.prepare('INSERT OR IGNORE INTO whisper_likes (whisper_id, user_id) VALUES (?, ?)');
  const insReply = db.prepare("INSERT INTO whisper_replies (whisper_id, user_id, content, created_at) VALUES (?, ?, ?, datetime('now', ?))");
  const wid = [];
  DEMO_WHISPERS.forEach((txt, i) => {
    const info = insWhisper.run(ids[i], txt, '-' + (3 + i * 7) + ' hours');
    wid.push(Number(info.lastInsertRowid));
  });
  insLike.run(wid[0], ids[4]); insLike.run(wid[0], ids[7]); insLike.run(wid[0], ids[9]);
  insLike.run(wid[1], ids[0]); insLike.run(wid[1], ids[12]);
  insLike.run(wid[2], ids[3]);
  insReply.run(wid[0], ids[5], '我也是，拖到最后一天才敢开始。', '-2 hours');
  insReply.run(wid[1], ids[8], '谢谢你愿意说出来，我也想去试试。', '-20 hours');
  insReply.run(wid[2], ids[10], '我也是投了好多没回音，别急，慢慢来。', '-12 hours');

  return DEMO_USERS.length;
}

seedDemoUsers();

/* ---- 活用户：每天让一批体验用户产生新数据，保证社区看起来是"活的" ----
   幂等：同一天重复调用不会重复写入（打卡按 user+date 去重，树洞当天已有则跳过） */
const DAILY_WHISPERS = [
  '今天完成了本周第一个小目标，虽然很小，但心里踏实多了。',
  '早起跑了 3 公里，发现清晨的校园原来这么安静。',
  '把拖延了两周的论文大纲写完了，开始果然是最难的部分。',
  '情绪自测做了第二次，比上个月降了 2 分，慢慢来。',
  '跟学长聊了半小时职业方向，没那么迷茫了。',
  '坚持打卡第 5 天，原来习惯真的可以一点点养成。',
  '投了 3 份实习简历，不管结果如何，至少迈出了一步。',
  '试了番茄工作法，专注了 4 个番茄钟，效率翻倍。',
  '把「我要变好」换成「我今天做一件事」之后，焦虑少了一半。',
  '今天主动约了朋友吃饭，独处太久真的会内耗。',
];
const DAILY_REPLIES = [
  '我也是，开始之后就没那么难了。',
  '看到你在坚持，我也想试试。',
  '慢慢来，比昨天的自己好一点就够了。',
  '太棒了，向你学习。',
  '这句话我抄下来了。',
];

function ensureDailyActivity() {
  const ids = db.prepare('SELECT id FROM users WHERE demo = 1 ORDER BY id').all().map(r => r.id);
  if (!ids.length) return;
  const today = dateOffset(0);
  const doy = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);

  /* 1) 每天轮换 10-16 个体验用户打卡（带不同内容） */
  const insCheckin = db.prepare('INSERT OR IGNORE INTO checkins (user_id, date, content) VALUES (?, ?, ?)');
  const active = 10 + (doy % 7);
  for (let k = 0; k < active; k++) {
    const idx = (doy * 7 + k * 3) % ids.length;
    insCheckin.run(ids[idx], today, DEMO_CHECKINS[(idx + doy) % DEMO_CHECKINS.length]);
  }

  /* 2) 当天若还没有体验用户的树洞，补 1-2 条（含点赞、偶尔带回应） */
  const n = db.prepare(
    "SELECT COUNT(*) AS n FROM whispers w JOIN users u ON u.id = w.user_id WHERE u.demo = 1 AND date(w.created_at, '+8 hours') = date('now', '+8 hours')"
  ).get().n;
  if (n > 0) return;

  const count = 1 + (doy % 2);
  const insWhisper = db.prepare("INSERT INTO whispers (user_id, content, created_at) VALUES (?, ?, datetime('now', ?))");
  const insLike = db.prepare('INSERT OR IGNORE INTO whisper_likes (whisper_id, user_id) VALUES (?, ?)');
  const insReply = db.prepare('INSERT INTO whisper_replies (whisper_id, user_id, content) VALUES (?, ?, ?)');
  for (let k = 0; k < count; k++) {
    const author = ids[(doy * 5 + k * 9) % ids.length];
    const txt = DAILY_WHISPERS[(doy + k * 3) % DAILY_WHISPERS.length];
    const info = insWhisper.run(author, txt, '-' + (2 + k * 4) + ' hours');
    const wid = Number(info.lastInsertRowid);
    const likes = 1 + ((doy + k) % 3);
    for (let j = 0; j < likes; j++) insLike.run(wid, ids[(doy + k + j + 3) % ids.length]);
    if ((doy + k) % 3 === 0) {
      insReply.run(wid, ids[(doy + k + 7) % ids.length], DAILY_REPLIES[(doy + k) % DAILY_REPLIES.length]);
    }
  }
}

ensureDailyActivity();

/* ---- 落地数据（统计，供答辩/材料用） ---- */
function stats() {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const demoUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE demo = 1').get().n;
  const checkins = db.prepare('SELECT COUNT(*) AS n FROM checkins').get().n;
  const gad7 = db.prepare('SELECT COUNT(*) AS n FROM gad7').get().n;
  const plans = db.prepare('SELECT COUNT(*) AS n FROM plan_done').get().n;
  const whispers = db.prepare('SELECT COUNT(*) AS n FROM whispers').get().n;
  const topics = db.prepare('SELECT COUNT(*) AS n FROM anxiety_logs').get().n;
  return { users, demoUsers, realUsers: users - demoUsers, checkins, gad7, plans, whispers, topics };
}

module.exports = {
  db,
  createUser, findUser, verifyUser, createToken, userFromToken, deleteToken,
  addCheckin, getCheckinDates, getCheckinRecords, todayCheckinUsers,
  getPlanDone, togglePlanDone,
  listPlanTasks, addPlanTask, deletePlanTask, countPlanTasksDone,
  addGad7, getGad7History, gad7LatestPerUser,
  addAnxietyLog, getMyTopic, topicCounts, pingTopic, getPingedTopics,
  addWhisper, listWhispers, likeWhisper, whisperExists, addWhisperReply,
  boardData,
  stats,
  ensureDailyActivity,
};
