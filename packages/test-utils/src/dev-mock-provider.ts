import { MockProvider } from "./mock-provider.ts";

const port = Number(process.env.PORT ?? 1299);
const p = await MockProvider.start({
  port,
  tokenDelayMs: 30,
  reply: (m) =>
    `You said: **${m.filter((x) => x.role === "user").at(-1)?.content ?? ""}**\n\nHere is some code:\n\n\`\`\`ts\nconst answer = 42;\nconsole.log(answer);\n\`\`\`\n\nThis reply came from the RelayLLM mock provider.`,
});
console.log(`Mock OpenAI-compatible provider at ${p.baseUrl}`);
