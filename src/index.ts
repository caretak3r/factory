export { Agent } from "./agent";

export default {
  async fetch(): Promise<Response> {
    return new Response("agentx-factory");
  },
};
