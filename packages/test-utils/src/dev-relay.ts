import { MockRelay } from "./mock-relay.ts";

const port = Number(process.env.PORT ?? 7777);
const relay = await MockRelay.start({ port, maxMessageBytes: 131072 });
console.log(`RelayLLM dev relay listening on ${relay.url}`);
