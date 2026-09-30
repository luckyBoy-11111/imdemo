# 近语 · 简单 IM

网页端一对一文字聊天。前端为 Vue 3 + TypeScript + Vite，后端为 Express + Socket.IO + Prisma，数据存储于 MySQL。

## 本地运行

需要 Node.js 22+、pnpm 11+ 和 MySQL 8。项目中的 `server/.env.example` 不含真实密码。

1. 若还没有数据库，在 MySQL 中创建 UTF-8 数据库和专用账号（将示例密码换成自己的强密码）：

   ```sql
   CREATE DATABASE simple_im CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'im_user'@'localhost' IDENTIFIED BY 'replace_with_a_strong_password';
   GRANT ALL PRIVILEGES ON simple_im.* TO 'im_user'@'localhost';
   ```

2. 复制 `server/.env.example` 为 `server/.env`，填写 `MYSQL_USER` 和 `MYSQL_PASSWORD` 的原始值；已有数据库时也填写实际的 `MYSQL_DATABASE`。连接 URL 由项目自动生成，密码中的 `@` 等特殊字符无需手动编码。本机已检测到 MySQL 服务配置端口为 `3306`。
3. 在项目根目录执行：

   ```bash
   pnpm install
   pnpm --filter im-server db:generate
   pnpm --filter im-server db:migrate
   pnpm dev
   ```

4. 打开 <http://localhost:5173>，分别在两个浏览器窗口注册账号并开始聊天。

检查命令：`pnpm typecheck`、`pnpm build`。服务端运行时可执行 `pnpm --filter im-server test:integration`，测试会创建临时账号并在结束后删除。构建后的前端可用 `pnpm --filter im-client preview --port 5173` 预览。

## 部署

使用 MySQL 8，数据库与连接需支持 `utf8mb4`。服务端环境变量：`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_DATABASE`、`CLIENT_ORIGIN`（网站的 HTTPS 来源）、`NODE_ENV=production`、可选 `PORT`。先执行 `pnpm --filter im-server db:migrate`，再启动 `pnpm --filter im-server start`。前端执行 `pnpm --filter im-client build` 后，将 `client/dist` 作为静态站点发布。

网站必须使用 HTTPS，反向代理把 `/api/` 与 `/socket.io/` 转发到 Node 服务，并支持 WebSocket 升级；同源代理使安全会话 Cookie 同时用于 HTTP 和 Socket.IO。可参考 [Nginx 示例](deploy/nginx.conf.example)。

单台 Node 实例即可运行。若部署多个后端实例，需要增加 Socket.IO 共享适配器并处理粘性会话。

## 接口与行为

- `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`
- `GET /api/users?q=`、`GET/POST /api/conversations`
- `GET /api/conversations/:id/messages?before=ID` 加载更早消息，`?after=ID` 补拉后续消息；每页最多 50 条。
- Socket.IO `message:send` 发送 `{ conversationId, clientMessageId, content }`，确认含已保存消息；`message:new` 推送给双方。发送失败可使用原 `clientMessageId` 重试。

登录会话存储于数据库，浏览器仅持有 HttpOnly Cookie。消息 ID 用于稳定排序，发送者与客户端消息 ID 唯一约束保证重试幂等。
