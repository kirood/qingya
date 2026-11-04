# 青芽 · 后端

对应评审报告「系统升级」的后端部分：**真实 AI 代理（密钥只在服务器） + 账号 + 数据库 + 危机守护 + GAD-7 量表**。

## 技术栈
- Node.js ≥ 22.5（自带 `node:sqlite`，数据库无需额外安装）
- Express（唯一依赖）
- SQLite 单文件数据库 `qingya.db`

## 启动

```bash
cd server
npm install
copy .env.example .env   # Windows；Linux/macOS 用 cp
# 编辑 .env，填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm start
```

不填 `LLM_API_KEY` 也能跑：此时焦虑拆解、成长画像走**离线规则引擎**（与前端离线版一致），其它功能（账号、打卡、计划、GAD-7）不受影响。

## 接口

| 方法 | 路径 | 说明 | 需要登录 |
|---|---|---|---|
| GET | /api/health | 状态（`online` 表示是否接了真 AI） | 否 |
| POST | /api/register | 注册 `{username,password}` → token | 否 |
| POST | /api/login | 登录 → token | 否 |
| POST | /api/logout | 退出 | 是 |
| GET | /api/me | 当前用户 | 是 |
| POST | /api/anxiety | 焦虑拆解 `{text}` → 拆解结果（危机优先） | 否 |
| POST | /api/portrait | 成长画像 `{major,good,like,win}` | 否（登录可反哺打卡） |
| GET/POST | /api/checkins | 打卡 | 是 |
| GET/POST | /api/plan | 7 天计划完成情况 | 是 |
| GET/POST | /api/gad7 | GAD-7 量表 | 是 |
| GET | /api/export | 导出个人全部数据 | 是 |
| GET | /api/stats | 落地数据统计（注册/打卡/量表数） | 否 |

## 安全要点
- 大模型密钥只存在服务器环境变量 `.env`，**前端永远拿不到**。
- 密码用 `scrypt` 加盐哈希存储；登录用随机 token（只存哈希）。
- 焦虑文本先做**危机词识别**，命中立即返回援助热线，不调用大模型。

## 部署
- 前端（`青芽.html` 所在的上级目录）已通过 `express.static` 一并托管，`npm start` 后直接访问 `http://localhost:3000` 即为完整应用。
- 上线：把整个 `原型` 目录推到任意支持 Node 的平台（Render / Railway / 腾讯云 / 自建服务器），设好 `.env` 环境变量即可。
