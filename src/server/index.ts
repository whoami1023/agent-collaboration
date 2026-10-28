import { join } from "node:path";
import { createApp } from "./app";
import { AuthService } from "../auth/auth-service";
import { WorkspaceRegistry } from "../workspace/workspace";

const root = process.cwd();
const dataDir = join(root, "data");

async function main(): Promise<void> {
  const auth = new AuthService(join(dataDir, "auth.json"));
  await auth.init();

  const workspaces = new WorkspaceRegistry(join(dataDir, "workspaces"));
  const app = createApp({
    auth,
    workspaces,
    webDist: join(root, "web", "dist"),
  });

  const port = Number(process.env["PORT"] ?? 8788);
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`agent-collaboration 已启动：http://127.0.0.1:${port}`);
    console.log(
      auth.needsSetup()
        ? "尚未创建管理员账号，请在登录页完成初始化。"
        : `已有 ${auth.listUsers().length} 个账号，登录后进入各自的作战室。`,
    );
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用，可能还有一个旧服务在运行（可用 PORT 换端口）。`);
    } else {
      console.error("服务启动失败", err);
    }
    process.exit(1);
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`收到 ${signal}，正在保存并退出…`);
    server.close();
    await workspaces.closeAll().catch((err) => console.error("关闭工作区失败", err));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
