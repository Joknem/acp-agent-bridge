import { loadConfig } from "./config.js";
import { AgentManager } from "./acp/AgentManager.js";
import { FeishuBot } from "./feishu/FeishuBot.js";
import { createLogger } from "./logger.js";
import { QqBot } from "./qq/QqBot.js";
import { StateStore } from "./state/StateStore.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const stateStore = new StateStore(config.stateFile, logger);
  await stateStore.load();

  const agentManager = new AgentManager(config, logger, stateStore);

  await agentManager.startDefault();

  const bot = new FeishuBot(config, agentManager, stateStore, logger);
  bot.start();
  const qqBot = new QqBot(config, agentManager, stateStore, logger);
  await qqBot.start();

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info(`received ${signal}, shutting down`);
    qqBot.stop();
    await agentManager.stopAll();
    await stateStore.flush();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
